/**
 * Credential providers for the Omnigent server.
 *
 * Local servers need none. Remote servers reuse what the Omnigent CLI already
 * stored (`omnigent login` → `~/.omnigent/auth_tokens.json`, see
 * `omnigent/cli_auth.py`), mint a Databricks workspace bearer through the
 * Databricks CLI, or use a token pasted into the plugin settings.
 */
import type { Headers } from "../transport/http";
import { profilesForHost } from "./databricksConfig";

export interface AuthProvider {
  /** Short label for the settings/status UI, e.g. `"Databricks CLI"`. */
  readonly label: string;
  /** Headers to attach to every request and WebSocket handshake. */
  headers(): Promise<Headers>;
  /** Drop any cached credential (after a 401) so the next call re-mints. */
  invalidate(): void;
}

export type RunCommand = (file: string, args: string[]) => Promise<string>;
export type ReadFile = (path: string) => Promise<string>;

/** Workspace-routing header recorded by `omnigent login https://<host>/?o=<id>`. */
export const DATABRICKS_ORG_ID_HEADER = "X-Databricks-Org-Id";

/** Re-mint this long before a token's stated expiry. */
const EXPIRY_SKEW_MS = 5 * 60_000;

export class NoAuth implements AuthProvider {
  readonly label = "None (local server)";
  async headers(): Promise<Headers> {
    return {};
  }
  invalidate(): void {}
}

export class StaticTokenAuth implements AuthProvider {
  readonly label = "Access token";
  constructor(private readonly token: string) {}
  async headers(): Promise<Headers> {
    return { Authorization: `Bearer ${this.token}` };
  }
  invalidate(): void {}
}

/** Paths where the Databricks CLI usually lives; GUI apps on macOS don't inherit the shell PATH. */
export const DATABRICKS_CLI_CANDIDATES = [
  "/opt/homebrew/bin/databricks",
  "/usr/local/bin/databricks",
  "databricks",
];

interface DatabricksTokenOutput {
  access_token?: unknown;
  expiry?: unknown;
}

export interface DatabricksCliAuthOptions {
  workspaceHost: string;
  cliCandidates: string[];
  runCommand: RunCommand;
  /** `~/.databrickscfg` content, or `null` when there is none. */
  readConfig: () => Promise<string | null>;
  /** Explicit profile from the settings; skips host matching. */
  profile?: string;
  /** `DATABRICKS_CONFIG_PROFILE`, preferred among host matches. */
  envProfile?: string;
  extraHeaders?: Headers;
  now?: () => number;
}

/** Cache lifetime for a profile's stored PAT, which carries no expiry. */
const PAT_CACHE_MS = 60 * 60_000;

/**
 * Mints workspace bearers through the Databricks CLI.
 *
 * `databricks auth token --host` fails when several `~/.databrickscfg`
 * profiles share the host, so matching profiles are tried by name in the
 * Omnigent CLI's preference order; the host lookup is the fallback when no
 * profile matches.
 */
export class DatabricksCliAuth implements AuthProvider {
  readonly label = "Databricks CLI";
  private cached: { token: string; expiresAtMs: number } | null = null;
  private inflight: Promise<string> | null = null;
  private readonly now: () => number;

  constructor(private readonly options: DatabricksCliAuthOptions) {
    this.now = options.now ?? Date.now;
  }

  async headers(): Promise<Headers> {
    return { ...this.options.extraHeaders, Authorization: `Bearer ${await this.token()}` };
  }

  invalidate(): void {
    this.cached = null;
  }

  private async token(): Promise<string> {
    if (this.cached && this.cached.expiresAtMs - EXPIRY_SKEW_MS > this.now()) return this.cached.token;
    this.inflight ??= this.mint().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** Argument lists to try, most-preferred first; a stored PAT short-circuits the CLI. */
  private async attempts(): Promise<{ pat?: string; label: string; args?: string[] }[]> {
    const { profile, workspaceHost } = this.options;
    if (profile) return [{ label: `profile ${profile}`, args: ["auth", "token", "--profile", profile] }];
    const config = await this.options.readConfig().catch(() => null);
    const profiles = config ? profilesForHost(config, workspaceHost, this.options.envProfile) : [];
    if (profiles.length === 0) {
      return [{ label: `host ${workspaceHost}`, args: ["auth", "token", "--host", workspaceHost] }];
    }
    return profiles.map((candidate) =>
      candidate.token
        ? { label: `profile ${candidate.name}`, pat: candidate.token }
        : { label: `profile ${candidate.name}`, args: ["auth", "token", "--profile", candidate.name] },
    );
  }

  private async mint(): Promise<string> {
    const failures: string[] = [];
    const attempts = await this.attempts();
    for (const attempt of attempts) {
      if (attempt.pat) {
        this.cached = { token: attempt.pat, expiresAtMs: this.now() + PAT_CACHE_MS };
        return attempt.pat;
      }
      for (const cli of this.options.cliCandidates) {
        let output: string;
        try {
          output = await this.options.runCommand(cli, attempt.args!);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // A missing binary says nothing about the profile; try the next location.
          if (/ENOENT/.test(message)) continue;
          failures.push(`${attempt.label}: ${message}`);
          break;
        }
        const parsed = parseDatabricksTokenOutput(output);
        this.cached = { token: parsed.token, expiresAtMs: parsed.expiresAtMs ?? this.now() + 30 * 60_000 };
        return parsed.token;
      }
    }
    if (failures.length === 0) {
      throw new Error(
        `Databricks CLI not found (tried ${this.options.cliCandidates.join(", ")}). Set its path in the Omnigent settings.`,
      );
    }
    const loginHint = this.options.profile
      ? `databricks auth login --profile ${this.options.profile}`
      : `databricks auth login --host ${this.options.workspaceHost}`;
    throw new Error(
      `Could not get a Databricks token for ${this.options.workspaceHost}. Run \`${loginHint}\` in a terminal. ` +
        `(${failures.join("; ")})`,
    );
  }
}

/** Parse `databricks auth token` JSON output. */
export function parseDatabricksTokenOutput(output: string): { token: string; expiresAtMs?: number } {
  let parsed: DatabricksTokenOutput;
  try {
    parsed = JSON.parse(output) as DatabricksTokenOutput;
  } catch {
    throw new Error("Databricks CLI did not print JSON");
  }
  if (typeof parsed.access_token !== "string" || parsed.access_token === "") {
    throw new Error("Databricks CLI output has no access_token");
  }
  const expiresAtMs = typeof parsed.expiry === "string" ? Date.parse(parsed.expiry) : Number.NaN;
  return {
    token: parsed.access_token,
    expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : undefined,
  };
}

/** One record of `~/.omnigent/auth_tokens.json`, keyed by server URL. */
export interface CliTokenRecord {
  token?: string;
  expires_at?: number;
  auth_type?: string;
  workspace_host?: string;
  org_id?: string;
}

/** Look up the CLI's record for a server URL (keys are stored without trailing slashes). */
export function findCliTokenRecord(fileContent: string, serverUrl: string): CliTokenRecord | null {
  let data: unknown;
  try {
    data = JSON.parse(fileContent);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const record = (data as Record<string, unknown>)[serverUrl.replace(/\/+$/, "")];
  return typeof record === "object" && record !== null ? (record as CliTokenRecord) : null;
}

/** Whether a server URL is hosted inside a Databricks workspace (`https://<ws>/api/2.0/omnigent`). */
export function isWorkspaceHostedUrl(serverUrl: string): boolean {
  try {
    return /\/api\/2\.0\/omnigent\/?$/.test(new URL(serverUrl).pathname);
  } catch {
    return false;
  }
}

export function isLoopbackUrl(serverUrl: string): boolean {
  try {
    const host = new URL(serverUrl).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  } catch {
    return false;
  }
}

export type AuthMode = "auto" | "none" | "token" | "databricks-cli";

export interface AuthSettings {
  mode: AuthMode;
  /** Used when `mode === "token"`. */
  token: string;
  /** Explicit CLI path; empty tries {@link DATABRICKS_CLI_CANDIDATES}. */
  databricksCliPath: string;
  /** `~/.databrickscfg` profile; empty picks among the profiles for the host. */
  databricksProfile?: string;
}

export interface AuthDeps {
  runCommand: RunCommand;
  readFile: ReadFile;
  cliTokenFilePath: string;
  databricksConfigPath: string;
  /** `DATABRICKS_CONFIG_PROFILE` from the environment, if any. */
  envProfile?: string;
}

/**
 * Pick the provider for a server.
 *
 * `auto`: loopback → none; a stored `omnigent login` session token → that token;
 * a Databricks pointer record or a workspace-hosted URL → Databricks CLI.
 */
export async function resolveAuth(
  serverUrl: string,
  settings: AuthSettings,
  deps: AuthDeps,
): Promise<AuthProvider> {
  const candidates = settings.databricksCliPath ? [settings.databricksCliPath] : DATABRICKS_CLI_CANDIDATES;
  const databricksFor = (host: string, extraHeaders: Headers = {}) =>
    new DatabricksCliAuth({
      workspaceHost: host,
      cliCandidates: candidates,
      runCommand: deps.runCommand,
      readConfig: () => deps.readFile(deps.databricksConfigPath),
      profile: settings.databricksProfile?.trim() || undefined,
      envProfile: deps.envProfile,
      extraHeaders,
    });
  switch (settings.mode) {
    case "none":
      return new NoAuth();
    case "token":
      return new StaticTokenAuth(settings.token.trim());
    case "databricks-cli":
      return databricksFor(new URL(serverUrl).origin);
    case "auto":
      break;
  }
  if (isLoopbackUrl(serverUrl)) return new NoAuth();
  let record: CliTokenRecord | null = null;
  try {
    record = findCliTokenRecord(await deps.readFile(deps.cliTokenFilePath), serverUrl);
  } catch {
    // No CLI login stored on this machine.
  }
  const orgHeaders: Headers = record?.org_id ? { [DATABRICKS_ORG_ID_HEADER]: record.org_id } : {};
  if (record?.token && (record.expires_at === undefined || record.expires_at * 1000 > Date.now())) {
    return new StaticTokenAuth(record.token);
  }
  if (record?.auth_type === "databricks" && record.workspace_host) {
    return databricksFor(record.workspace_host, orgHeaders);
  }
  if (isWorkspaceHostedUrl(serverUrl)) return databricksFor(new URL(serverUrl).origin, orgHeaders);
  return new NoAuth();
}
