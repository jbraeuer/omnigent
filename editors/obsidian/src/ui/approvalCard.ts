/** Approval card body shared by the session view and the inbox. */
import { Notice } from "obsidian";
import type { InboxItem } from "@/lib/inbox";

export interface ApprovalAnswer {
  action: "accept" | "decline";
  content?: Record<string, unknown>;
}

/** Forms and URL-mode prompts need the full web UI. */
export function needsFullUi(item: InboxItem): boolean {
  return item.elicitation.mode === "url" || Object.keys(item.elicitation.requestedSchema ?? {}).length > 0;
}

/** Answers a simple prompt offers; Claude's directory prompts can also allow those directories. */
export function approvalChoices(item: InboxItem): { label: string; answer: ApprovalAnswer; cls: string }[] {
  const choices = [{ label: "Approve", answer: { action: "accept" } as ApprovalAnswer, cls: "mod-cta" }];
  if (item.elicitation.permissionDirectories?.length) {
    choices.push({
      label: "Approve & allow directories for this session",
      answer: { action: "accept", content: { allow_directories: true } },
      cls: "",
    });
  }
  choices.push({ label: "Deny", answer: { action: "decline" }, cls: "mod-warning" });
  return choices;
}

/**
 * Render the prompt and, unless it needs the full web UI, its answer buttons; returns
 * the actions row for caller buttons. A rejected `answer` re-enables the buttons.
 */
export function renderApprovalCard(
  card: HTMLElement,
  item: InboxItem,
  fallbackTitle: string,
  answer: (answer: ApprovalAnswer) => Promise<void>,
): HTMLElement {
  card.createDiv({ cls: "omnigent-approval-title", text: item.elicitation.message || fallbackTitle });
  if (item.elicitation.contentPreview) {
    card.createEl("pre", { cls: "omnigent-pre" }).createEl("code", { text: item.elicitation.contentPreview });
  }
  const directories = item.elicitation.permissionDirectories ?? [];
  if (directories.length > 0) {
    card.createDiv({ cls: "omnigent-approval-detail", text: "Requested directory access:" });
    const list = card.createEl("ul", { cls: "omnigent-approval-directories" });
    for (const directory of directories) list.createEl("li").createEl("code", { text: directory });
  }
  const actions = card.createDiv({ cls: "omnigent-approval-actions" });
  if (needsFullUi(item)) return actions;
  const buttons = approvalChoices(item).map((choice) => {
    const button = actions.createEl("button", { cls: choice.cls || undefined, text: choice.label });
    button.addEventListener("click", () => {
      for (const other of buttons) other.disabled = true;
      answer(choice.answer).catch((error: unknown) => {
        for (const other of buttons) other.disabled = false;
        new Notice(`Could not answer the approval: ${error instanceof Error ? error.message : String(error)}`);
      });
    });
    return button;
  });
  return actions;
}
