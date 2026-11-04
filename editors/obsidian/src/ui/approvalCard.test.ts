import { describe, expect, it } from "vitest";
import type { InboxItem } from "@/lib/inbox";
import { approvalChoices, needsFullUi } from "./approvalCard";

const item = (elicitation: Partial<InboxItem["elicitation"]>) => ({ elicitation }) as InboxItem;

describe("approval choices", () => {
  it("offers approve and deny for a plain prompt", () => {
    expect(approvalChoices(item({})).map((choice) => choice.answer)).toEqual([{ action: "accept" }, { action: "decline" }]);
  });

  it("can also allow the directories Claude asked for", () => {
    const choices = approvalChoices(item({ permissionDirectories: ["/repo/out"] }));
    expect(choices.map((choice) => choice.label)).toEqual([
      "Approve",
      "Approve & allow directories for this session",
      "Deny",
    ]);
    expect(choices[1]?.answer).toEqual({ action: "accept", content: { allow_directories: true } });
  });

  it("sends forms and URL prompts to the full web UI", () => {
    expect(needsFullUi(item({ mode: "url" }))).toBe(true);
    expect(needsFullUi(item({ requestedSchema: { type: "object" } }))).toBe(true);
    expect(needsFullUi(item({ requestedSchema: {} }))).toBe(false);
  });
});
