/**
 * Answer state for an agent's multiple-choice questions (Claude's `AskUserQuestion`
 * and harnesses that reuse its shape). Mirrors the web `AskUserQuestionForm`, so
 * the server gets the same `{[question]: label | labels}` map it forwards to the agent.
 */
import type { ClaudeQuestion } from "@/lib/askUserQuestion";

export type QuestionAnswers = Record<string, string | string[]>;

export interface QuestionDraft {
  /** Chosen option labels per question key; at most one for single-select. */
  selected: Record<string, string[]>;
  /** Whether the free-text ("Other") row is chosen. */
  customSelected: Record<string, boolean>;
  customText: Record<string, string>;
}

/** The answer-map key the server and agent expect: the question's id, else its text. */
export function questionKey(question: ClaudeQuestion): string {
  return question.id ? question.id : question.question;
}

/** Whether the question offers a free-text answer next to its options. */
export function allowsCustomAnswer(question: ClaudeQuestion): boolean {
  return question.textInput !== undefined || question.isOther !== false;
}

/** A fresh draft: single-select questions start on their first option, like the web form. */
export function initialDraft(questions: ClaudeQuestion[]): QuestionDraft {
  const draft: QuestionDraft = { selected: {}, customSelected: {}, customText: {} };
  for (const question of questions) {
    const key = questionKey(question);
    const first = question.options[0]?.label;
    draft.selected[key] = question.multiSelect || !first || question.textInput ? [] : [first];
    draft.customSelected[key] = question.textInput !== undefined;
    draft.customText[key] = question.textInput?.default ?? "";
  }
  return draft;
}

/** Pick an option: single-select replaces the choice (and leaves the custom row), multi-select toggles it. */
export function chooseOption(draft: QuestionDraft, question: ClaudeQuestion, label: string): void {
  const key = questionKey(question);
  if (!question.multiSelect) {
    draft.selected[key] = [label];
    draft.customSelected[key] = false;
    return;
  }
  const current = draft.selected[key] ?? [];
  draft.selected[key] = current.includes(label) ? current.filter((value) => value !== label) : [...current, label];
}

/** Choose (or, for multi-select, toggle) the free-text row. */
export function chooseCustom(draft: QuestionDraft, question: ClaudeQuestion, on: boolean): void {
  const key = questionKey(question);
  draft.customSelected[key] = on;
  if (on && !question.multiSelect) draft.selected[key] = [];
}

/** The question's answer, or `null` while it is unanswered. */
export function answerFor(question: ClaudeQuestion, draft: QuestionDraft): string | string[] | null {
  const key = questionKey(question);
  const selected = draft.selected[key] ?? [];
  const customOn = draft.customSelected[key] ?? false;
  const rawText = draft.customText[key] ?? "";
  const text = rawText.trim();
  if (question.multiSelect) {
    const all = customOn && text ? [...new Set([...selected, text])] : selected;
    return all.length > 0 ? all : null;
  }
  // A text-input question's exact text, even empty, is its answer.
  if (customOn) return question.textInput ? rawText : text || null;
  return selected[0] ?? null;
}

/** Every question's answer, or `null` while any is unanswered. */
export function collectAnswers(questions: ClaudeQuestion[], draft: QuestionDraft): QuestionAnswers | null {
  const answers: QuestionAnswers = {};
  for (const question of questions) {
    const answer = answerFor(question, draft);
    if (answer === null) return null;
    answers[questionKey(question)] = answer;
  }
  return answers;
}

/** One-line summary of an answer for the transcript and review step. */
export function formatAnswer(answer: string | string[] | null): string {
  if (answer === null) return "—";
  return Array.isArray(answer) ? answer.join(", ") : answer;
}
