import { describe, expect, it } from "vitest";
import type { ElicitationBlock } from "@/lib/blocks";
import { attachmentNames, elicitationSummary, splitSystemReminders, systemReminderTitle } from "./renderBlocks";

describe("splitSystemReminders", () => {
  it("moves injected reminders out of the typed text", () => {
    const text =
      "<system-reminder>\nCodebase and user instructions are shown below.\n# CLAUDE.md\n</system-reminder>\n" +
      "<system-reminder>Attribution note</system-reminder>\n\nWhy is this here?";
    expect(splitSystemReminders(text)).toEqual({
      text: "Why is this here?",
      reminders: ["Codebase and user instructions are shown below.\n# CLAUDE.md", "Attribution note"],
    });
  });

  it("leaves messages without reminders untouched", () => {
    expect(splitSystemReminders("  plain message ")).toEqual({ text: "  plain message ", reminders: [] });
  });
});

describe("systemReminderTitle", () => {
  it("titles the section with the reminder's first line, shortened", () => {
    expect(systemReminderTitle("Attribution note\nmore")).toBe("System reminder: Attribution note");
    expect(systemReminderTitle("x".repeat(200))).toHaveLength("System reminder: ".length + 80);
    expect(systemReminderTitle("")).toBe("System reminder");
  });
});

describe("elicitationSummary", () => {
  const block = (extra: Partial<ElicitationBlock>) =>
    ({ type: "elicitation", message: "Claude wants to call AskUserQuestion", contentPreview: "", status: "resolved", response: null, ...extra }) as ElicitationBlock;
  const questions = [
    { question: "Prefix?", multiSelect: false, options: [{ label: "Every DM" }] },
    { question: "Groups?", multiSelect: true, options: [{ label: "A" }, { label: "B" }] },
  ];

  it("lists each submitted answer", () => {
    const summary = elicitationSummary(
      block({ askUserQuestion: { questions }, response: { action: "accept", content: { "Prefix?": "Every DM", "Groups?": ["A", "B"] } } }),
    );
    expect(summary).toBe("Answered:\nPrefix? → Every DM\nGroups? → A, B");
  });

  it("names plan reviews and plain approvals", () => {
    expect(elicitationSummary(block({ exitPlanMode: { plan: "x" }, response: { action: "decline" } }))).toBe("Plan rejected");
    expect(elicitationSummary(block({ message: "Run ls", response: { action: "accept" } }))).toBe("Approval accept: Run ls");
  });
});

describe("attachmentNames", () => {
  it("names attached images and files, skipping text", () => {
    expect(
      attachmentNames([
        { type: "input_text", text: "Add these colors" },
        { type: "input_image", file_id: "file_1", filename: "calendar.png" },
        { type: "input_image", image_url: "data:image/png;base64,AA==" },
        { type: "input_file", file_id: "file_2", filename: "notes.pdf" },
      ]),
    ).toEqual(["calendar.png", "image", "notes.pdf"]);
  });
});
