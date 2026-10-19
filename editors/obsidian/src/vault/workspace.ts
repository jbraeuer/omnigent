/**
 * Vault as workspace: new sessions run on this machine's host with the vault
 * (or a folder in it) as working directory, so agent edits land in the vault.
 */
import * as path from "node:path";
import type { Host } from "../api/types";
import type { WorkspaceMode } from "../settings";

/** Absolute working directory for new sessions, or `undefined` for the agent default. */
export function resolveWorkspacePath(
  vaultBasePath: string | null,
  mode: WorkspaceMode,
  folder: string,
): string | undefined {
  if (mode === "none" || !vaultBasePath) return undefined;
  if (mode === "folder" && folder) {
    const resolved = path.resolve(vaultBasePath, folder);
    // A folder setting like "../elsewhere" must not escape the vault.
    if (resolved !== vaultBasePath && !resolved.startsWith(vaultBasePath + path.sep)) {
      throw new Error(`Working folder "${folder}" is outside the vault`);
    }
    return resolved;
  }
  return vaultBasePath;
}

/** `~/.omnigent/daemons/*.json` record written by `omnigent host`. */
interface HostDaemonRecord {
  host_id?: unknown;
  server_url?: unknown;
  target?: unknown;
}

/** This machine's host id for a server, from the host daemon records. */
export function localHostIdForServer(daemonRecordContents: string[], serverUrl: string): string | null {
  const wanted = serverUrl.replace(/\/+$/, "");
  for (const content of daemonRecordContents) {
    let record: HostDaemonRecord;
    try {
      record = JSON.parse(content) as HostDaemonRecord;
    } catch {
      continue;
    }
    const urls = [record.server_url, record.target].filter((value): value is string => typeof value === "string");
    if (typeof record.host_id === "string" && urls.some((url) => url.replace(/\/+$/, "") === wanted)) {
      return record.host_id;
    }
  }
  return null;
}

/**
 * Host for a new session: the configured one, else this machine's, else the only
 * online user host. `null` lets the server pick (local single-host setups).
 */
export function pickHost(hosts: Host[], configuredHostId: string, localHostId: string | null): Host | null {
  const userHosts = hosts.filter((host) => !host.sandbox_provider);
  const byId = (id: string) => userHosts.find((host) => host.host_id === id) ?? null;
  if (configuredHostId) return byId(configuredHostId);
  if (localHostId) {
    const local = byId(localHostId);
    if (local) return local;
  }
  const online = userHosts.filter((host) => host.status === "online");
  return online.length === 1 ? online[0]! : null;
}
