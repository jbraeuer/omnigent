/** Terminal bytes for browser key events that xterm.js does not encode itself. */

/** Kitty Keyboard Protocol / CSI-u encoding for Shift+Enter. */
export const SHIFT_ENTER_CSI_U = "\x1b[13;2u";

/** Readline line-editing bytes for the macOS Cmd key mappings below. */
export const CMD_BACKSPACE_LINE_KILL = "\x15"; // Ctrl-U: kill to line start
export const CMD_LEFT_LINE_START = "\x01"; // Ctrl-A: cursor to line start
export const CMD_RIGHT_LINE_END = "\x05"; // Ctrl-E: cursor to line end

/**
 * Return the terminal bytes to send for a browser key event.
 *
 * Two key families need synthesized bytes because neither xterm.js nor the
 * browser produces them:
 *
 * - **Shift+Enter** — xterm does not emit Kitty Keyboard Protocol sequences
 *   for it, so the browser attach path synthesizes the CSI-u sequence,
 *   mirroring native terminals that support CSI-u while keeping plain Enter
 *   and modified Enter variants on xterm's default path.
 * - **macOS Cmd+Backspace / Cmd+Left / Cmd+Right** — the standard
 *   readline-style line shortcuts. The Option (Alt) equivalents work because
 *   xterm encodes Alt-modified keys as ESC-prefixed sequences that
 *   readline/zsh read as word operations; Cmd (metaKey) combos get no
 *   encoding at all — the browser eats them and nothing reaches the PTY.
 *   Each maps to the Ctrl control character a native terminal sends. Only
 *   bare Cmd combos are mapped: Cmd+C/V/K/R and friends keep their
 *   browser/xterm meaning (copy/paste/clear/reload).
 *
 * :param event: Browser keyboard event from xterm's custom key handler.
 * :returns: Bytes to send instead of xterm's default handling, or ``null``
 *     to let xterm handle the event normally.
 */
export function terminalKeyEventPayload(event: KeyboardEvent): string | null {
  // An in-flight IME composition owns the keyboard: xterm consults this
  // handler BEFORE its CompositionHelper, so claiming a key mid-conversion
  // would drop the composed text. Return null so xterm runs composition
  // handling (keyCode 229 is the legacy composition signal).
  if (event.isComposing || event.keyCode === 229) {
    return null;
  }
  if (
    event.key === "Enter" &&
    event.shiftKey &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey
  ) {
    return SHIFT_ENTER_CSI_U;
  }
  if (event.metaKey && !event.altKey && !event.ctrlKey && !event.shiftKey) {
    if (event.key === "Backspace") return CMD_BACKSPACE_LINE_KILL;
    if (event.key === "ArrowLeft") return CMD_LEFT_LINE_START;
    if (event.key === "ArrowRight") return CMD_RIGHT_LINE_END;
  }
  return null;
}
