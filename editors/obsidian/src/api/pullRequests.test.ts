import { describe, expect, it } from "vitest";
import { pullRequestDescription, pullRequestReference, pullRequestState } from "./pullRequests";

describe("pull request labels", () => {
  const pr = { url: "https://github.com/o/r/pull/42", number: 42, title: "Fix login", state: "OPEN" };

  it("reads the stored lifecycle", () => {
    expect(pullRequestState(pr)).toBe("open");
    expect(pullRequestState({ ...pr, is_draft: true })).toBe("draft");
    expect(pullRequestState({ ...pr, state: "merged" })).toBe("merged");
    expect(pullRequestState({ ...pr, state: "CLOSED" })).toBe("closed");
    expect(pullRequestState({ ...pr, state: null })).toBe("unknown");
  });

  it("uses the provider's wording and number prefix", () => {
    expect(pullRequestDescription({ ...pr, state: "MERGED" })).toBe("Pull request #42 (merged): Fix login");
    const gitlab = { ...pr, state: null, title: null, provider_display: { request_name: "Merge request", number_prefix: "!" } };
    expect(pullRequestReference(gitlab)).toBe("!42");
    expect(pullRequestDescription(gitlab)).toBe("Merge request !42");
  });
});
