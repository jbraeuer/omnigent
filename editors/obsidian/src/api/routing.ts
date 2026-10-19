/**
 * Replica routing for host-sharded (workspace-hosted) servers.
 *
 * A host's runner tunnels live on one replica, keyed by `host_id`, so requests
 * scoped to a session or host must carry `X-Databricks-Omnigent-Slice-Key`.
 * Mirrors the web client (`authenticatedFetch` in `web/src/lib/identity.ts`):
 * key by the request's own host, retry keyless once on `wrong_replica`, and
 * remember hosts whose tunnels turned out to live on the default replica.
 */

export const SLICE_KEY_HEADER = "X-Databricks-Omnigent-Slice-Key";
export const WRONG_REPLICA_CODE = "wrong_replica";
/** WebSocket close code the server uses for a wrong-replica attach. */
export const WRONG_REPLICA_WS_CLOSE = 4400;

export type HostScope = { kind: "host"; hostId: string } | { kind: "session"; sessionId: string } | { kind: "none" };

/** Which host an API path is scoped to: `/v1/hosts/{id}/…` or a session sub-path `/v1/sessions/{id}/…`. */
export function hostScopeForPath(path: string): HostScope {
  const host = /^\/v1\/hosts\/([^/?#]+)/.exec(path);
  if (host) return { kind: "host", hostId: decodeURIComponent(host[1]!) };
  // The bare snapshot `/v1/sessions/{id}` is host-agnostic (it is how a host is resolved).
  const session = /^\/v1\/sessions\/([^/?#]+)\/[^?#]/.exec(path);
  if (session && session[1] !== "updates") return { kind: "session", sessionId: decodeURIComponent(session[1]!) };
  return { kind: "none" };
}

/** Whether an error body is the server's structured wrong-replica signal. */
export function isWrongReplicaBody(status: number, body: string): boolean {
  if (status !== 400) return false;
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown }; code?: unknown };
    return parsed.error?.code === WRONG_REPLICA_CODE || parsed.code === WRONG_REPLICA_CODE;
  } catch {
    return false;
  }
}

/** Session → host map plus hosts proven to route keyless. */
export class HostRouting {
  private readonly sessionHosts = new Map<string, string | null>();
  private readonly keylessHosts = new Set<string>();

  constructor(readonly enabled: boolean) {}

  /** Record a session's host from any session-shaped payload. */
  learn(sessionId: string, hostId: string | null | undefined): void {
    if (hostId !== undefined) this.sessionHosts.set(sessionId, hostId);
  }

  knows(sessionId: string): boolean {
    return this.sessionHosts.has(sessionId);
  }

  hostFor(scope: HostScope): string | null {
    if (scope.kind === "host") return scope.hostId;
    if (scope.kind === "session") return this.sessionHosts.get(scope.sessionId) ?? null;
    return null;
  }

  /** Headers for the first attempt: the host key unless the host is known to route keyless. */
  headersFor(hostId: string | null): Record<string, string> {
    if (!this.enabled || !hostId || this.keylessHosts.has(hostId)) return {};
    return { [SLICE_KEY_HEADER]: hostId };
  }

  markKeyless(hostId: string): void {
    this.keylessHosts.add(hostId);
  }

  clearKeyless(hostId: string): void {
    this.keylessHosts.delete(hostId);
  }
}
