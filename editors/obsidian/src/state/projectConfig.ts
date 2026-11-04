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

/**
 * A project's default model and reasoning effort for a new session. They belong to
 * the project's configured agent, so another picked agent keeps its harness defaults.
 */
export function projectLaunchOverrides(
  config: ProjectConfig | undefined,
  agentId: string,
): { model_override?: string; reasoning_effort?: string } {
  if (!config?.agent_id || config.agent_id !== agentId) return {};
  const model = typeof config.model === "string" ? config.model.trim() : "";
  const effort = typeof config.effort === "string" ? config.effort.trim() : "";
  return { ...(model ? { model_override: model } : {}), ...(effort ? { reasoning_effort: effort } : {}) };
}
