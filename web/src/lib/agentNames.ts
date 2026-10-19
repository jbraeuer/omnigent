/**
 * React-free agent display-name helpers, shared by the stream reducers and
 * the composers (re-exported from `agentLabels.ts`).
 */

/**
 * Capitalize the first letter of an agent name for display, e.g.
 * ``"polly"`` → ``"Polly"``. Server agent names are lowercase slugs;
 * both composers show them capital-first.
 */
export function capitalizeAgentName(name: string): string {
  if (name.length === 0) return name;
  return name.charAt(0).toUpperCase() + name.slice(1);
}
