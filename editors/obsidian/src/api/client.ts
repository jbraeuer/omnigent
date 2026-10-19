/**
 * Typed client for the Omnigent server's `/v1` API.
 *
 * Stream parsing reuses the web client's `parseSseStream` so the plugin and the
 * web UI agree on every event shape.
 */
import WebSocket from "ws";
import type { ConversationItem } from "@/lib/conversationItems";
import type { StreamEvent } from "@/lib/events";
import { parseSseStream, type SseStreamResult } from "@/lib/sse";
import { isWorkspaceHostedUrl, type AuthProvider } from "../auth/auth";
import { HttpError, joinUrl, openByteStream, requestJson, type Headers, type RequestOptions } from "../transport/http";
import { HostRouting, WRONG_REPLICA_WS_CLOSE, hostScopeForPath, isWrongReplicaBody } from "./routing";
import {
  listData,
  type Agent,
  type CreateSessionRequest,
  type Host,
  type PostEventResponse,
  type Project,
  type ProjectConfig,
  type ProjectOrder,
  type SessionList,
  type SessionListItem,
  type SessionSnapshot,
  type TerminalResource,
} from "./types";

export interface ListSessionsOptions {
  searchQuery?: string;
  includeArchived?: boolean;
  limit?: number;
  after?: string;
}

/** Text content block for a user message. */
export interface InputText {
  type: "input_text";
  text: string;
}

export class OmnigentClient {
  readonly routing: HostRouting;
  private readonly hostResolves = new Map<string, Promise<void>>();

  constructor(
    readonly baseUrl: string,
    readonly auth: AuthProvider,
  ) {
    this.routing = new HostRouting(isWorkspaceHostedUrl(baseUrl));
  }

  /** Send with auth headers; a minted bearer may be revoked early, so retry once on 401. */
  private async withAuth<T>(send: (authHeaders: Headers) => Promise<T>): Promise<T> {
    try {
      return await send(await this.auth.headers());
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) {
        this.auth.invalidate();
        return send(await this.auth.headers());
      }
      throw error;
    }
  }

  /**
   * Send a request scoped by `path` with replica routing: key it by its host,
   * re-address keyless once on `wrong_replica`, or re-resolve the session's
   * host after a keyless miss.
   */
  private async routed<T>(path: string, send: (headers: Headers) => Promise<T>): Promise<T> {
    const scope = hostScopeForPath(path);
    if (!this.routing.enabled || scope.kind === "none") return this.withAuth(send);
    if (scope.kind === "session") await this.resolveSessionHost(scope.sessionId);
    const hostId = this.routing.hostFor(scope);
    const keyed = this.routing.headersFor(hostId);
    try {
      return await this.withAuth((authHeaders) => send({ ...authHeaders, ...keyed }));
    } catch (error) {
      if (!(error instanceof HttpError) || !isWrongReplicaBody(error.status, error.body)) throw error;
      if (hostId && Object.keys(keyed).length > 0) {
        const result = await this.withAuth(send);
        this.routing.markKeyless(hostId);
        return result;
      }
      if (scope.kind !== "session") throw error;
      await this.resolveSessionHost(scope.sessionId, true);
      const resolved = this.routing.hostFor(scope);
      if (!resolved) throw error;
      this.routing.clearKeyless(resolved);
      return this.withAuth((authHeaders) => send({ ...authHeaders, ...this.routing.headersFor(resolved) }));
    }
  }

  /** Learn a session's host from its host-agnostic snapshot; concurrent callers share one lookup. */
  private resolveSessionHost(sessionId: string, force = false): Promise<void> {
    if (!force && this.routing.knows(sessionId)) return Promise.resolve();
    let pending = this.hostResolves.get(sessionId);
    if (!pending) {
      pending = this.getSession(sessionId)
        .then(() => undefined)
        .catch(() => undefined)
        .finally(() => this.hostResolves.delete(sessionId));
      this.hostResolves.set(sessionId, pending);
    }
    return pending;
  }

  private learnSession<T extends Pick<SessionListItem, "id" | "host_id">>(session: T): T {
    this.routing.learn(session.id, session.host_id ?? null);
    return session;
  }

  private async request<T>(
    path: string,
    options: RequestOptions & { params?: Record<string, unknown> } = {},
  ): Promise<T> {
    const url = joinUrl(this.baseUrl, path, options.params);
    return this.routed(path, (headers) => requestJson<T>(url, { ...options, headers: { ...headers, ...options.headers } }));
  }

  health(): Promise<unknown> {
    return this.request("/health", { timeoutMs: 5_000 });
  }

  me(): Promise<{ user_id?: string | null; email?: string | null }> {
    return this.request("/v1/me");
  }

  async listProjects(): Promise<Project[]> {
    return listData<Project>(await this.request("/v1/projects"));
  }

  createProject(name: string): Promise<Project> {
    return this.request("/v1/projects", { method: "POST", body: { name } });
  }

  /** `config` replaces the stored defaults wholesale; omit a field to keep it. */
  updateProject(projectId: string, patch: { name?: string; config?: ProjectConfig }): Promise<Project> {
    return this.request(`/v1/projects/${encodeURIComponent(projectId)}`, { method: "PATCH", body: patch });
  }

  /** Delete a project; its sessions become unfiled. */
  async deleteProject(projectId: string): Promise<void> {
    await this.request(`/v1/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" });
  }

  getProjectOrder(): Promise<ProjectOrder> {
    return this.request("/v1/projects/order");
  }

  setProjectOrder(orderedProjectIds: string[]): Promise<ProjectOrder> {
    return this.request("/v1/projects/order", { method: "PUT", body: { ordered_project_ids: orderedProjectIds } });
  }

  async listSessions(options: ListSessionsOptions = {}): Promise<SessionList> {
    const list = await this.request<SessionList>("/v1/sessions", {
      params: {
        visibility: options.includeArchived ? "all" : "mine",
        include_archived: options.includeArchived ? "true" : undefined,
        search_query: options.searchQuery,
        limit: options.limit ?? 100,
        after: options.after,
        order: "desc",
      },
    });
    for (const row of list.data) this.learnSession(row);
    return list;
  }

  /** Session state and pending prompts; the transcript comes from {@link listSessionItems}. */
  async getSession(sessionId: string): Promise<SessionSnapshot> {
    return this.learnSession(
      await this.request<SessionSnapshot>(`/v1/sessions/${encodeURIComponent(sessionId)}`, {
        params: { include_items: "false" },
      }),
    );
  }

  /** The newest `limit` committed items, oldest first (flat items, ready for `itemsToBlocks`). */
  async listSessionItems(sessionId: string, limit = 200): Promise<{ items: ConversationItem[]; hasMore: boolean }> {
    const page = await this.request<{ data: ConversationItem[]; has_more?: boolean }>(
      `/v1/sessions/${encodeURIComponent(sessionId)}/items`,
      { params: { limit, order: "desc" } },
    );
    return { items: [...page.data].reverse(), hasMore: page.has_more ?? false };
  }

  async createSession(body: CreateSessionRequest): Promise<SessionSnapshot> {
    // A create naming a host must reach the replica holding that host's tunnel.
    const headers = this.routing.headersFor(body.host_id ?? null);
    return this.learnSession(
      await this.request<SessionSnapshot>("/v1/sessions", { method: "POST", body, timeoutMs: 60_000, headers }),
    );
  }

  /** `PATCH /v1/sessions/{id}`, e.g. `{title}`, `{archived: true}` or `{project_id}`. */
  updateSession(sessionId: string, patch: Record<string, unknown>): Promise<SessionSnapshot> {
    return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}`, { method: "PATCH", body: patch });
  }

  sendMessage(sessionId: string, content: InputText[]): Promise<PostEventResponse> {
    return this.postEvent(sessionId, { type: "message", data: { role: "user", content } });
  }

  interrupt(sessionId: string): Promise<PostEventResponse> {
    return this.postEvent(sessionId, { type: "interrupt", data: {} });
  }

  private postEvent(sessionId: string, event: Record<string, unknown>): Promise<PostEventResponse> {
    return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/events`, {
      method: "POST",
      body: event,
      // Host-bound sessions may wait for a runner to launch before accepting.
      timeoutMs: 90_000,
    });
  }

  resolveElicitation(
    sessionId: string,
    elicitationId: string,
    action: "accept" | "decline" | "cancel",
    content?: Record<string, unknown>,
  ): Promise<PostEventResponse> {
    return this.request(
      `/v1/sessions/${encodeURIComponent(sessionId)}/elicitations/${encodeURIComponent(elicitationId)}/resolve`,
      { method: "POST", body: content ? { action, content } : { action } },
    );
  }

  async listHosts(): Promise<Host[]> {
    return listData<Host>(await this.request("/v1/hosts"));
  }

  async listAgents(): Promise<Agent[]> {
    return listData<Agent>(await this.request("/v1/agents", { params: { limit: 100 } }));
  }

  async listTerminals(sessionId: string): Promise<TerminalResource[]> {
    return listData<TerminalResource>(
      await this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/resources/terminals`),
    );
  }

  /**
   * Subscribe to a session's live event stream (`GET /v1/sessions/{id}/stream`).
   * Live tail only: callers reconcile history through {@link getSession}.
   */
  async *streamSession(
    sessionId: string,
    signal: AbortSignal,
    result?: SseStreamResult,
  ): AsyncIterable<StreamEvent> {
    const path = `/v1/sessions/${encodeURIComponent(sessionId)}/stream`;
    const url = joinUrl(this.baseUrl, path);
    const body = await this.routed(path, (headers) => openByteStream(url, { headers, signal }));
    yield* parseSseStream(body, result);
  }

  /** `WS /v1/sessions/updates` — live list rows for a watch-set. */
  async openSessionUpdates(): Promise<WebSocket> {
    return this.openSocket("/v1/sessions/updates");
  }

  /** `WS …/terminals/{id}/attach` — binary terminal output; text frames carry resize control. */
  async openTerminal(sessionId: string, terminalId: string, readOnly: boolean): Promise<WebSocket> {
    return this.openSocket(
      `/v1/sessions/${encodeURIComponent(sessionId)}/resources/terminals/${encodeURIComponent(terminalId)}/attach`,
      { read_only: readOnly ? "true" : undefined },
    );
  }

  /**
   * Open a WebSocket keyed for replica routing. A wrong-replica attach closes
   * with {@link WRONG_REPLICA_WS_CLOSE}; that host is then dialed keyless, so the
   * caller's reconnect lands on the default replica.
   */
  private async openSocket(path: string, query?: Record<string, unknown>): Promise<WebSocket> {
    const url = joinUrl(this.baseUrl, path, query);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const scope = hostScopeForPath(path);
    if (this.routing.enabled && scope.kind === "session") await this.resolveSessionHost(scope.sessionId);
    const hostId = this.routing.enabled ? this.routing.hostFor(scope) : null;
    const keyed = this.routing.headersFor(hostId);
    const socket = new WebSocket(url, { headers: { ...(await this.auth.headers()), ...keyed } });
    if (hostId && Object.keys(keyed).length > 0) {
      socket.once("close", (code) => {
        if (code === WRONG_REPLICA_WS_CLOSE) this.routing.markKeyless(hostId);
      });
    }
    return socket;
  }

  /** Browser URL of the web UI for a route, e.g. `/c/conv_123` or `/inbox`. */
  webUrl(route: string): string {
    return webUiBaseUrl(this.baseUrl) + route;
  }
}

/**
 * Web UI base for a server API base. Workspace-hosted servers serve the API at
 * `https://<ws>/api/2.0/omnigent` and the UI at `https://<ws>/omnigent`.
 */
export function webUiBaseUrl(serverUrl: string): string {
  const trimmed = serverUrl.replace(/\/+$/, "");
  return trimmed.replace(/\/api\/2\.0\/omnigent$/, "/omnigent");
}

export function sessionTitle(session: Pick<SessionListItem, "title" | "agent_name" | "id">): string {
  return session.title?.trim() || (session.agent_name ? `New ${session.agent_name} session` : session.id);
}
