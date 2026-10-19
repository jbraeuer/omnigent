/**
 * Wire shapes for the REST endpoints the plugin uses (snake_case, as served).
 *
 * Only the fields the plugin reads are declared; see `omnigent/server/API.md`
 * and `omnigent/server/schemas.py` for the full models.
 */
export type SessionStatus = "idle" | "launching" | "running" | "waiting" | "failed";

/** `SessionListItem` from `GET /v1/sessions` and `WS /v1/sessions/updates`. */
export interface SessionListItem {
  id: string;
  title?: string | null;
  agent_id?: string | null;
  agent_name?: string | null;
  status?: SessionStatus | null;
  created_at?: number | null;
  updated_at?: number | null;
  archived?: boolean | null;
  project_id?: string | null;
  host_id?: string | null;
  workspace?: string | null;
  git_branch?: string | null;
  pending_elicitations_count?: number | null;
  viewer_unread?: boolean | null;
  parent_session_id?: string | null;
  runner_online?: boolean | null;
  host_online?: boolean | null;
}

export interface SessionList {
  data: SessionListItem[];
  has_more?: boolean;
  last_id?: string | null;
}

/** `SessionResponse` from `GET /v1/sessions/{id}`. */
export interface SessionSnapshot extends SessionListItem {
  /** Raw `response.elicitation_request` event dicts still awaiting a verdict. */
  pending_elicitations?: Record<string, unknown>[];
  terminal_pending?: boolean;
}

/** Stored new-session defaults of a project (`ProjectConfig` in the web client). */
export interface ProjectConfig {
  agent_id?: string;
  host_id?: string;
  workspace?: string;
  [key: string]: unknown;
}

export interface Project {
  id: string;
  name: string;
  created_at?: number;
  updated_at?: number | null;
  config?: ProjectConfig;
}

/** `GET/PUT /v1/projects/order`. */
export interface ProjectOrder {
  sort_mode: "alphabetical" | "manual";
  ordered_project_ids: string[] | null;
}

/** Row of `GET /v1/hosts` (`{"hosts": [...]}`). */
export interface Host {
  host_id: string;
  name?: string | null;
  status?: "online" | "offline" | string | null;
  /** Non-null for server-managed sandbox hosts, which aren't user-pickable. */
  sandbox_provider?: string | null;
}

export interface Agent {
  id: string;
  name: string;
  description?: string | null;
  harness?: string | null;
}

export interface TerminalResource {
  id: string;
  name?: string | null;
  type?: string;
  metadata?: Record<string, unknown> | null;
}

export interface CreateSessionRequest {
  agent_id: string;
  title?: string;
  project_id?: string;
  host_id?: string;
  workspace?: string;
  initial_items?: unknown[];
}

export interface PostEventResponse {
  queued: boolean;
  item_id?: string;
  pending_id?: string;
}

/** Frames on `WS /v1/sessions/updates` (server → client). */
export type SessionUpdatesFrame =
  | { type: "snapshot"; items: SessionListItem[] }
  | { type: "changed"; items: SessionListItem[] }
  | { type: "removed"; ids: string[] }
  | { type: "heartbeat" };

/** Accept either `{data: [...]}` lists or bare arrays (some list routes are untyped). */
export function listData<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === "object") {
    const data = (payload as { data?: unknown }).data;
    if (Array.isArray(data)) return data as T[];
    for (const key of ["hosts", "projects", "agents", "resources", "terminals"]) {
      const value = (payload as Record<string, unknown>)[key];
      if (Array.isArray(value)) return value as T[];
    }
  }
  return [];
}
