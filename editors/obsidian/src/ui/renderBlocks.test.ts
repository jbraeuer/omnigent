import { describe, expect, it } from "vitest";
import { splitSystemReminders, systemReminderTitle } from "./renderBlocks";

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
