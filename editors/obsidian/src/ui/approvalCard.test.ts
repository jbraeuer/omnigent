import { describe, expect, it } from "vitest";
import type { InboxItem } from "@/lib/inbox";
import { approvalChoices, approvalKind, needsFullUi, withNativeDelivery } from "./approvalCard";

const item = (elicitation: Partial<InboxItem["elicitation"]>) =>
  ({ elicitation: { contentPreview: "", ...elicitation } }) as InboxItem;

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

  it("answers Claude's questions and plan reviews in place", () => {
    const questions = [{ question: "Prefix?", multiSelect: false, options: [{ label: "Every DM" }] }];
    expect(approvalKind(item({ askUserQuestion: { questions } }))).toBe("question");
    expect(approvalKind(item({ contentPreview: `AskUserQuestion(${JSON.stringify({ questions })})` }))).toBe("question");
    expect(approvalKind(item({ exitPlanMode: { plan: "# Plan" } }))).toBe("plan");
    expect(approvalKind(item({ exitPlanMode: { plan: "" } }))).toBe("approval");
  });

  it("echoes the native delivery attempt a terminal harness is waiting for", () => {
    const answer = { action: "accept" as const };
    expect(withNativeDelivery(item({}), answer)).toBe(answer);
    expect(withNativeDelivery(item({ nativeDelivery: { state: "unconfirmed", attempt: "a1", action: "accept" } }), answer)).toEqual({
      action: "accept",
      meta: { native_delivery_attempt: "a1" },
    });
  });
});
