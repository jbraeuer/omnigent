import { describe, expect, it } from "vitest";
import type { ClaudeQuestion } from "@/lib/askUserQuestion";
import { answerFor, chooseCustom, chooseOption, collectAnswers, initialDraft } from "./questionAnswers";

const single: ClaudeQuestion = {
  question: "How should people be identified?",
  multiSelect: false,
  options: [{ label: "Phone number" }, { label: "Signal username" }],
};
const multi: ClaudeQuestion = {
  id: "groups",
  question: "Which groups?",
  multiSelect: true,
  options: [{ label: "Family" }, { label: "Work" }],
};

describe("question answers", () => {
  it("starts single-select on the first option and multi-select empty, like the web form", () => {
    const draft = initialDraft([single, multi]);
    expect(answerFor(single, draft)).toBe("Phone number");
    expect(answerFor(multi, draft)).toBeNull();
    expect(collectAnswers([single, multi], draft)).toBeNull();
  });

  it("keys answers by id, else question text, with multi-select as a list", () => {
    const draft = initialDraft([single, multi]);
    chooseOption(draft, single, "Signal username");
    chooseOption(draft, multi, "Work");
    chooseOption(draft, multi, "Family");
    chooseOption(draft, multi, "Work");
    expect(collectAnswers([single, multi], draft)).toEqual({
      "How should people be identified?": "Signal username",
      groups: ["Family"],
    });
  });

  it("uses typed text for the Other row and needs it to be non-empty", () => {
    const draft = initialDraft([single, multi]);
    chooseCustom(draft, single, true);
    expect(answerFor(single, draft)).toBeNull();
    draft.customText[single.question] = "  email  ";
    expect(answerFor(single, draft)).toBe("email");
    chooseOption(draft, multi, "Work");
    chooseCustom(draft, multi, true);
    draft.customText.groups = "Work";
    expect(answerFor(multi, draft)).toEqual(["Work"]);
  });

  it("answers a text-input question with its exact text, even empty", () => {
    const text: ClaudeQuestion = { question: "Name?", multiSelect: false, options: [], textInput: { default: "" } };
    expect(collectAnswers([text], initialDraft([text]))).toEqual({ "Name?": "" });
  });
});
