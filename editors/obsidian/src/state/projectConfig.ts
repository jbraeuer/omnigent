import type { ProjectConfig } from "../api/types";

/** Merge edited defaults into the stored config: cleared fields are removed, other keys kept. */
export function mergeProjectConfig(
  stored: ProjectConfig | undefined,
  edits: { agent_id: string; host_id: string; workspace: string },
): ProjectConfig {
  const config: ProjectConfig = { ...(stored ?? {}) };
  for (const key of ["agent_id", "host_id", "workspace"] as const) {
    const value = edits[key].trim();
    if (value) config[key] = value;
    else delete config[key];
  }
  // A workspace is only meaningful on a host.
  if (!config.host_id) delete config.workspace;
  return config;
}
