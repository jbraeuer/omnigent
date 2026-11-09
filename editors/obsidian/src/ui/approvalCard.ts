/** Approval card body shared by the session view and the inbox. */
import { Notice } from "obsidian";
import { askUserQuestionPayloadOf, exitPlanModePlan, type ClaudeQuestion } from "@/lib/askUserQuestion";
import type { InboxItem } from "@/lib/inbox";
import {
  allowsCustomAnswer,
  answerFor,
  chooseCustom,
  chooseOption,
  collectAnswers,
  formatAnswer,
  initialDraft,
  questionKey,
  type QuestionDraft,
} from "./questionAnswers";

export interface ApprovalAnswer {
  action: "accept" | "decline";
  content?: Record<string, unknown>;
  /** Verdict metadata the server reads from `_meta`, e.g. a native delivery attempt. */
  meta?: Record<string, unknown>;
}

/** What a pending prompt asks of the user, which decides the card it gets. */
export type ApprovalKind = "question" | "plan" | "full-ui" | "approval";

export function approvalKind(item: InboxItem): ApprovalKind {
  if (askUserQuestionPayloadOf(item.elicitation)) return "question";
  if (exitPlanModePlan(item.elicitation.exitPlanMode)) return "plan";
  if (item.elicitation.mode === "url" || Object.keys(item.elicitation.requestedSchema ?? {}).length > 0) {
    return "full-ui";
  }
  return "approval";
}

/** Forms and URL-mode prompts need the full web UI. */
export function needsFullUi(item: InboxItem): boolean {
  return approvalKind(item) === "full-ui";
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

/** Native terminal harnesses match a verdict to the delivery attempt the prompt advertised. */
export function withNativeDelivery(item: InboxItem, answer: ApprovalAnswer): ApprovalAnswer {
  const attempt = item.elicitation.nativeDelivery?.attempt;
  if (!attempt) return answer;
  return { ...answer, meta: { ...answer.meta, native_delivery_attempt: attempt } };
}

export interface ApprovalCardOptions {
  fallbackTitle: string;
  answer: (answer: ApprovalAnswer) => Promise<void>;
  /** Renders agent-authored markdown, e.g. a plan, into `el`. */
  renderMarkdown: (el: HTMLElement, markdown: string) => void;
}

/**
 * Render the prompt and, unless it needs the full web UI, its controls; returns
 * the actions row for caller buttons. A rejected `answer` re-enables the controls.
 */
export function renderApprovalCard(card: HTMLElement, item: InboxItem, options: ApprovalCardOptions): HTMLElement {
  const kind = approvalKind(item);
  const send = async (answer: ApprovalAnswer) => options.answer(withNativeDelivery(item, answer));
  if (kind === "question") {
    const payload = askUserQuestionPayloadOf(item.elicitation);
    return renderQuestions(card, payload?.questions ?? [], send);
  }
  if (kind === "plan") {
    return renderPlan(card, exitPlanModePlan(item.elicitation.exitPlanMode) ?? "", send, options.renderMarkdown);
  }
  card.createDiv({ cls: "omnigent-approval-title", text: item.elicitation.message || options.fallbackTitle });
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
  if (kind === "full-ui") return actions;
  const buttons = approvalChoices(item).map((choice) => {
    const button = actions.createEl("button", { cls: choice.cls || undefined, text: choice.label });
    button.addEventListener("click", () => submitWith(buttons, () => send(choice.answer)));
    return button;
  });
  return actions;
}

/** Disable `controls` while `submit` runs; re-enable them if it fails. */
function submitWith(controls: { disabled: boolean }[], submit: () => Promise<void>): void {
  for (const control of controls) control.disabled = true;
  submit().catch((error: unknown) => {
    for (const control of controls) control.disabled = false;
    new Notice(`Could not answer the agent: ${error instanceof Error ? error.message : String(error)}`);
  });
}

/** One question per step, then a review of every answer before submitting, like the web wizard. */
function renderQuestions(
  card: HTMLElement,
  questions: ClaudeQuestion[],
  send: (answer: ApprovalAnswer) => Promise<void>,
): HTMLElement {
  card.addClass("omnigent-question");
  const draft = initialDraft(questions);
  const body = card.createDiv();
  const actions = card.createDiv({ cls: "omnigent-approval-actions" });
  // Steps rebuild only their own buttons; callers may append to `actions`.
  const stepActions = actions.createSpan({ cls: "omnigent-approval-step-actions" });
  // A single question submits from its own step; several end on a review step.
  const reviewStep = questions.length > 1 ? questions.length : -1;
  let step = 0;

  const render = (): void => {
    body.empty();
    stepActions.empty();
    const controls: { disabled: boolean }[] = [];
    const button = (text: string, cls: string | undefined, onClick: () => void): HTMLButtonElement => {
      const el = stepActions.createEl("button", { cls, text });
      el.addEventListener("click", onClick);
      controls.push(el);
      return el;
    };
    const go = (next: number) => () => {
      step = next;
      render();
    };
    const submit = (): void => {
      const answers = collectAnswers(questions, draft);
      if (answers) submitWith(controls, () => send({ action: "accept", content: answers }));
    };

    const counter = questions.length > 1 ? ` (${Math.min(step + 1, questions.length)}/${questions.length})` : "";
    body.createDiv({ cls: "omnigent-approval-title", text: `The agent has a question${counter}` });
    if (step === reviewStep) {
      const list = body.createEl("dl", { cls: "omnigent-question-review" });
      questions.forEach((question, index) => {
        const term = list.createEl("dt");
        term.createEl("a", { text: question.question, href: "#" }).addEventListener("click", (event) => {
          event.preventDefault();
          go(index)();
        });
        list.createEl("dd", { text: formatAnswer(answerFor(question, draft)) });
      });
      button("Back", undefined, go(step - 1));
      const submitButton = button("Submit answers", "mod-cta", submit);
      submitButton.disabled = collectAnswers(questions, draft) === null;
    } else {
      const question = questions[step]!;
      if (step > 0) button("Back", undefined, go(step - 1));
      const last = step === questions.length - 1;
      const next =
        last && reviewStep < 0
          ? button("Submit answer", "mod-cta", submit)
          : button(last ? "Review" : "Next", "mod-cta", go(step + 1));
      renderQuestion(body, question, draft, () => {
        next.disabled = answerFor(question, draft) === null;
      });
    }
    button("Dismiss", "mod-warning", () => submitWith(controls, () => send({ action: "decline" })));
  };
  render();
  return actions;
}

/** Options as radios (single-select) or checkboxes, plus the free-text row when allowed. */
function renderQuestion(body: HTMLElement, question: ClaudeQuestion, draft: QuestionDraft, changed: () => void): void {
  const key = questionKey(question);
  if (question.header) body.createSpan({ cls: "omnigent-question-header", text: question.header });
  body.createDiv({ cls: "omnigent-question-text", text: question.question });
  const type = question.multiSelect ? "checkbox" : "radio";
  const name = `omnigent-question-${Math.random().toString(36).slice(2)}`;
  const list = body.createDiv({ cls: "omnigent-question-options" });
  const inputs: HTMLInputElement[] = [];
  const sync = (): void => {
    question.options.forEach((option, index) => {
      inputs[index]!.checked = (draft.selected[key] ?? []).includes(option.label);
    });
    if (customToggle) customToggle.checked = draft.customSelected[key] ?? false;
    changed();
  };
  for (const option of question.options) {
    const row = list.createEl("label", { cls: "omnigent-question-option" });
    const input = row.createEl("input", { type, attr: { name } });
    inputs.push(input);
    input.addEventListener("change", () => {
      chooseOption(draft, question, option.label);
      sync();
    });
    const text = row.createDiv();
    text.createDiv({ cls: "omnigent-question-label", text: option.label });
    if (option.description) text.createDiv({ cls: "omnigent-approval-detail", text: option.description });
  }
  let customToggle: HTMLInputElement | null = null;
  if (allowsCustomAnswer(question)) {
    const row = list.createEl("label", { cls: "omnigent-question-option" });
    if (!question.textInput) {
      customToggle = row.createEl("input", { type, attr: { name } });
      customToggle.addEventListener("change", () => {
        chooseCustom(draft, question, customToggle!.checked);
        sync();
      });
    }
    const field = row.createEl("input", {
      type: question.isSecret ? "password" : "text",
      cls: "omnigent-question-custom",
      attr: { placeholder: question.textInput ? "Your answer" : "Other…" },
    });
    field.value = draft.customText[key] ?? "";
    field.addEventListener("input", () => {
      draft.customText[key] = field.value;
      if (!question.textInput && field.value.trim() && !draft.customSelected[key]) {
        chooseCustom(draft, question, true);
      }
      sync();
    });
  }
  sync();
}

/** Claude finished planning: approve (optionally switching to auto mode) or reject with feedback. */
function renderPlan(
  card: HTMLElement,
  plan: string,
  send: (answer: ApprovalAnswer) => Promise<void>,
  renderMarkdown: (el: HTMLElement, markdown: string) => void,
): HTMLElement {
  card.createDiv({ cls: "omnigent-approval-title", text: "The agent finished planning and wants to proceed" });
  renderMarkdown(card.createDiv({ cls: "omnigent-plan" }), plan);
  const feedback = card.createEl("textarea", {
    cls: ["omnigent-input", "omnigent-hidden"],
    attr: { rows: "3", placeholder: "What should change about the plan? (optional)" },
  });
  const actions = card.createDiv({ cls: "omnigent-approval-actions" });
  const controls: HTMLButtonElement[] = [];
  const button = (text: string, cls: string | undefined, onClick: () => void): HTMLButtonElement => {
    const el = actions.createEl("button", { cls, text });
    el.addEventListener("click", onClick);
    controls.push(el);
    return el;
  };
  // `allow_all_edits` on a plan approval asks the server to switch Claude to auto mode.
  button("Yes, and use auto mode", "mod-cta", () =>
    submitWith(controls, () => send({ action: "accept", content: { allow_all_edits: true } })),
  );
  button("Yes, manually approve edits", undefined, () => submitWith(controls, () => send({ action: "accept" })));
  const reject = button("Reject with feedback", "mod-warning", () => {
    if (feedback.hasClass("omnigent-hidden")) {
      feedback.removeClass("omnigent-hidden");
      reject.setText("Reject plan");
      feedback.focus();
      return;
    }
    const text = feedback.value.trim();
    submitWith(controls, () => send({ action: "decline", content: text ? { feedback: text } : undefined }));
  });
  return actions;
}
