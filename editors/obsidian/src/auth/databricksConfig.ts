/**
 * `~/.databrickscfg` profile selection for a workspace host.
 *
 * `databricks auth token --host` refuses to choose when several profiles share
 * a host, so the plugin picks one itself, in the same order the Omnigent CLI
 * uses (`_order_profiles_by_identity_preference` in
 * `omnigent/inner/databricks_executor.py`): the `DATABRICKS_CONFIG_PROFILE`
 * profile, then user (U2M/PAT) profiles, then service principals.
 */

export type ConfigSections = Map<string, Record<string, string>>;

/** Minimal INI parse: `[section]` headers and `key = value` lines; `#`/`;` comments. */
export function parseDatabricksConfig(content: string): ConfigSections {
  const sections: ConfigSections = new Map();
  let current: Record<string, string> | null = null;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      current = {};
      sections.set(header[1]!.trim(), current);
      continue;
    }
    const separator = line.search(/[=:]/);
    if (current && separator > 0) {
      current[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
    }
  }
  return sections;
}

const USER_AUTH_TYPES = new Set(["databricks-cli", "external-browser", "pat", "runtime"]);
const MACHINE_AUTH_TYPES = new Set([
  "oauth-m2m",
  "azure-client-secret",
  "azure-msi",
  "github-oidc",
  "github-oidc-azure",
  "env-oidc",
  "file-oidc",
  "metadata-service",
  "google-credentials",
  "google-id",
]);

export function isServicePrincipal(options: Record<string, string>): boolean {
  const authType = (options.auth_type ?? "").toLowerCase();
  if (USER_AUTH_TYPES.has(authType)) return false;
  if (MACHINE_AUTH_TYPES.has(authType)) return true;
  return Boolean(
    (options.client_id && options.client_secret) || (options.azure_client_id && options.azure_client_secret),
  );
}

function normalizeHost(value: string): string {
  return value.trim().replace(/\/+$/, "").replace(/^[a-z]+:\/\//i, "").toLowerCase();
}

export interface DatabricksProfile {
  name: string;
  /** Personal access token stored in the profile, usable without the CLI. */
  token?: string;
}

/** Profiles whose host is `host`, most-preferred first. Named sections inherit `[DEFAULT]`'s host. */
export function profilesForHost(content: string, host: string, envProfile = ""): DatabricksProfile[] {
  const sections = parseDatabricksConfig(content);
  const wanted = normalizeHost(host);
  const defaultHost = sections.get("DEFAULT")?.host ?? "";
  const matches: string[] = [];
  for (const [name, options] of sections) {
    if (name === "DEFAULT") continue;
    if (normalizeHost(options.host ?? defaultHost) === wanted) matches.push(name);
  }
  if (defaultHost && normalizeHost(defaultHost) === wanted) matches.push("DEFAULT");
  const isSp = (name: string) => isServicePrincipal(sections.get(name)!);
  const ordered = [
    ...matches.filter((name) => name === envProfile),
    ...matches.filter((name) => name !== envProfile && !isSp(name)),
    ...matches.filter((name) => name !== envProfile && isSp(name)),
  ];
  return ordered.map((name) => {
    const token = sections.get(name)!.token;
    return token ? { name, token } : { name };
  });
}
