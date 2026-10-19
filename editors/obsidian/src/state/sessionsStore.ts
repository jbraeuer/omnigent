/**
 * Live list of projects and sessions for the navigator and inbox.
 *
 * Loads `GET /v1/projects` + `GET /v1/sessions`, then keeps rows fresh through
 * `WS /v1/sessions/updates` (watch-set diffs plus push discovery of new
 * sessions), reconnecting with backoff.
 */
import type WebSocket from "ws";
import { sessionTitle, type OmnigentClient } from "../api/client";
import type { Project, ProjectOrder, SessionListItem, SessionUpdatesFrame } from "../api/types";
import { Observable } from "./observable";

export type ConnectionState =
  | { kind: "disconnected" }
  | { kind: "connecting" }
  | { kind: "connected" }
  | { kind: "error"; message: string };

const MAX_BACKOFF_MS = 30_000;

/** Apply one updates-socket frame to the row map; returns whether anything changed. */
export function applyUpdatesFrame(rows: Map<string, SessionListItem>, frame: SessionUpdatesFrame): boolean {
  switch (frame.type) {
    case "snapshot":
    case "changed": {
      for (const item of frame.items) {
        // Streamed rows carry explicit nulls for cleared fields; overlay them.
        rows.set(item.id, { ...rows.get(item.id), ...item });
      }
      return frame.items.length > 0;
    }
    case "removed": {
      let changed = false;
      for (const id of frame.ids) changed = rows.delete(id) || changed;
      return changed;
    }
    case "heartbeat":
      return false;
  }
}

/** Top-level sessions newest first (sub-agent children are reached through their parent). */
export function sortedTopLevelSessions(rows: Iterable<SessionListItem>, includeArchived: boolean): SessionListItem[] {
  return [...rows]
    .filter((row) => !row.parent_session_id && (includeArchived || !row.archived))
    .sort((a, b) => (b.updated_at ?? b.created_at ?? 0) - (a.updated_at ?? a.created_at ?? 0));
}

/** Case-insensitive title/agent match for the sidebar filter. */
export function matchesFilter(session: SessionListItem, query: string): boolean {
  if (!query) return true;
  const haystack = `${sessionTitle(session)} ${session.agent_name ?? ""}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

/** Projects in the server's order: manual ranking first (unranked appended by name), else by name. */
export function orderProjects(projects: Project[], order: ProjectOrder | null): Project[] {
  const byName = [...projects].sort((a, b) => a.name.localeCompare(b.name));
  if (order?.sort_mode !== "manual" || !order.ordered_project_ids) return byName;
  const rank = new Map(order.ordered_project_ids.map((id, index) => [id, index]));
  return byName
    .map((project, index) => ({ project, key: rank.get(project.id) ?? order.ordered_project_ids!.length + index }))
    .sort((a, b) => a.key - b.key)
    .map(({ project }) => project);
}

export type MoveDirection = "up" | "down" | "top" | "bottom";

/** Ids after moving `id` one step or to an end. */
export function moveId(ids: string[], id: string, direction: MoveDirection): string[] {
  const rest = ids.filter((candidate) => candidate !== id);
  const index = ids.indexOf(id);
  if (index < 0) return ids;
  const target =
    direction === "top" ? 0 : direction === "bottom" ? rest.length : direction === "up" ? Math.max(0, index - 1) : Math.min(rest.length, index + 1);
  return [...rest.slice(0, target), id, ...rest.slice(target)];
}

/** Total approvals waiting across active sessions (the Inbox badge). */
export function pendingApprovalCount(rows: Iterable<SessionListItem>): number {
  let total = 0;
  for (const row of rows) if (!row.archived) total += row.pending_elicitations_count ?? 0;
  return total;
}

/** Close a socket without leaving an unhandled `error` (ws emits one when closed mid-handshake). */
export function closeQuietly(socket: WebSocket | null): void {
  if (!socket) return;
  socket.removeAllListeners();
  socket.on("error", () => {});
  socket.close();
}

export class SessionsStore extends Observable {
  readonly sessions = new Map<string, SessionListItem>();
  projects: Project[] = [];
  state: ConnectionState = { kind: "disconnected" };

  private client: OmnigentClient | null = null;
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = 1_000;
  private generation = 0;

  /** (Re)connect to a server; replaces any previous connection. */
  async connect(client: OmnigentClient): Promise<void> {
    if (client !== this.client) this.clear();
    this.teardown();
    const generation = ++this.generation;
    this.client = client;
    this.setState({ kind: "connecting" });
    try {
      await this.refresh();
      if (generation !== this.generation) return;
      this.setState({ kind: "connected" });
      this.backoffMs = 1_000;
      await this.openSocket(generation);
    } catch (error) {
      if (generation !== this.generation) return;
      this.setState({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      this.scheduleReconnect(generation);
    }
  }

  disconnect(): void {
    this.teardown();
    this.clear();
    this.client = null;
    this.setState({ kind: "disconnected" });
  }

  /** Disconnect and show `message` (e.g. a server that couldn't be resolved). */
  fail(message: string): void {
    this.teardown();
    this.clear();
    this.client = null;
    this.setState({ kind: "error", message });
  }

  private teardown(): void {
    this.generation++;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    closeQuietly(this.socket);
    this.socket = null;
  }

  private clear(): void {
    this.sessions.clear();
    this.projects = [];
  }

  /** Reload projects and the first page of sessions. */
  async refresh(): Promise<void> {
    const client = this.requireClient();
    const [projects, sessions, order] = await Promise.all([
      client.listProjects(),
      client.listSessions({ limit: 200 }),
      client.getProjectOrder().catch(() => null),
    ]);
    this.projects = orderProjects(projects, order);
    this.sessions.clear();
    for (const row of sessions.data) this.sessions.set(row.id, row);
    this.emit();
    this.sendWatch();
  }

  /** Merge a row the caller fetched or created (e.g. right after creating a session). */
  upsert(row: SessionListItem): void {
    this.sessions.set(row.id, { ...this.sessions.get(row.id), ...row });
    this.emit();
    this.sendWatch();
  }

  /** Move a project in the sidebar and persist the manual order. */
  async moveProject(projectId: string, direction: MoveDirection): Promise<void> {
    const ids = moveId(
      this.projects.map((project) => project.id),
      projectId,
      direction,
    );
    const byId = new Map(this.projects.map((project) => [project.id, project]));
    this.projects = ids.map((id) => byId.get(id)!);
    this.emit();
    await this.requireClient().setProjectOrder(ids);
  }

  get inboxCount(): number {
    return pendingApprovalCount(this.sessions.values());
  }

  private requireClient(): OmnigentClient {
    if (!this.client) throw new Error("Not connected to an Omnigent server");
    return this.client;
  }

  private async openSocket(generation: number): Promise<void> {
    const socket = await this.requireClient().openSessionUpdates();
    if (generation !== this.generation) {
      closeQuietly(socket);
      return;
    }
    this.socket = socket;
    socket.on("open", () => this.sendWatch());
    socket.on("message", (data) => {
      let frame: SessionUpdatesFrame;
      try {
        frame = JSON.parse(data.toString()) as SessionUpdatesFrame;
      } catch {
        return;
      }
      if (frame.type === "snapshot" || frame.type === "changed") {
        for (const item of frame.items) this.client?.routing.learn(item.id, item.host_id);
      }
      if (applyUpdatesFrame(this.sessions, frame)) this.emit();
      // A pushed new session must join the watch-set to keep receiving deltas.
      if (frame.type === "changed") this.sendWatch();
    });
    socket.on("close", () => {
      if (generation === this.generation) this.scheduleReconnect(generation);
    });
    socket.on("error", () => {
      // `close` follows and drives the reconnect.
    });
  }

  private sendWatch(): void {
    if (this.socket?.readyState !== 1) return;
    this.socket.send(JSON.stringify({ type: "watch", session_ids: [...this.sessions.keys()] }));
  }

  private scheduleReconnect(generation: number): void {
    const client = this.client;
    if (!client || this.reconnectTimer) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (generation !== this.generation) return;
      void this.connect(client);
    }, delay);
  }

  private setState(state: ConnectionState): void {
    this.state = state;
    this.emit();
  }
}
