import type { SessionPullRequestSummary } from "./types";

export type PullRequestState = "open" | "draft" | "merged" | "closed" | "unknown";

/** Lifecycle of a session's stored PR summary; `unknown` until its host fetched the state. */
export function pullRequestState(pr: Pick<SessionPullRequestSummary, "state" | "is_draft">): PullRequestState {
  const state = pr.state?.toUpperCase();
  if (state === "MERGED") return "merged";
  if (state === "CLOSED") return "closed";
  if (state === "OPEN") return pr.is_draft ? "draft" : "open";
  return "unknown";
}

/** Short reference such as `#42`, or `!42` for providers that number merge requests that way. */
export function pullRequestReference(pr: Pick<SessionPullRequestSummary, "number" | "provider_display">): string {
  return `${pr.provider_display?.number_prefix ?? "#"}${pr.number}`;
}

/** Accessible description, e.g. `Pull request #42 (merged): Fix login`. */
export function pullRequestDescription(pr: SessionPullRequestSummary): string {
  const kind = pr.provider_display?.request_name ?? "Pull request";
  const state = pullRequestState(pr);
  const title = pr.title?.trim();
  return `${kind} ${pullRequestReference(pr)}${state === "unknown" ? "" : ` (${state})`}${title ? `: ${title}` : ""}`;
}
