/**
 * Notes as context: `[[wikilinks]]` in a message, the active note or a selection
 * are inlined into the message text so any agent sees them, whatever its tools.
 */

export interface ContextNote {
  /** Vault-relative path, e.g. `"Projects/Roadmap.md"`. */
  path: string;
  content: string;
}

/** Separates the user's text from attached notes in a composed message. */
export const CONTEXT_SEPARATOR = "\n\n---\nContext from my Obsidian vault:\n\n";

/** Split a composed message back into what the user typed and the attached context. */
export function splitContext(message: string): { text: string; context: string | null; notePaths: string[] } {
  const index = message.indexOf(CONTEXT_SEPARATOR);
  if (index < 0) return { text: message, context: null, notePaths: [] };
  const context = message.slice(index + CONTEXT_SEPARATOR.length);
  const notePaths = [...context.matchAll(/^Note: (.+)$/gm)].map((match) => match[1]!);
  return { text: message.slice(0, index), context, notePaths };
}

const WIKILINK = /\[\[([^\]|#^]+)(?:[#^][^\]|]*)?(?:\|[^\]]*)?\]\]/g;

/** Link targets mentioned as `[[target]]`, `[[target|alias]]` or `[[target#heading]]`, deduped in order. */
export function extractWikiLinks(text: string): string[] {
  const targets: string[] = [];
  for (const match of text.matchAll(WIKILINK)) {
    const target = match[1]!.trim();
    if (target && !targets.includes(target)) targets.push(target);
  }
  return targets;
}

/** Longest run of backticks in `text`, so a fence can be chosen that the content cannot close. */
function longestBacktickRun(text: string): number {
  let longest = 0;
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  return longest;
}

/**
 * Compose the outgoing message: the user's text followed by each note in a fenced
 * block headed by its path. Notes are truncated (with a marker) once `charLimit`
 * characters of note text have been used.
 */
export function composeMessageWithContext(userText: string, notes: ContextNote[], charLimit: number): string {
  if (notes.length === 0) return userText;
  let remaining = charLimit;
  const sections: string[] = [];
  for (const note of notes) {
    if (remaining <= 0) {
      sections.push(`(Omitted ${note.path}: context size limit reached.)`);
      continue;
    }
    const truncated = note.content.length > remaining;
    const body = truncated ? note.content.slice(0, remaining) : note.content;
    remaining -= body.length;
    const fence = "`".repeat(Math.max(3, longestBacktickRun(body) + 1));
    sections.push(
      `Note: ${note.path}\n${fence}markdown\n${body}${body.endsWith("\n") ? "" : "\n"}${fence}` +
        (truncated ? `\n(Truncated ${note.path} at ${body.length} of ${note.content.length} characters.)` : ""),
    );
  }
  return `${userText}${CONTEXT_SEPARATOR}${sections.join("\n\n")}`;
}
