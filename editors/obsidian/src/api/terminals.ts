import { parseDirectAttachUrl, withAttachParams } from "@/lib/terminals";
import type { TerminalResource } from "./types";

/** Declared terminal name, e.g. `"tui"` for `tui:main`. */
export function terminalName(terminal: TerminalResource): string {
  const declared = terminal.metadata?.terminal_name;
  if (typeof declared === "string" && declared) return declared;
  return (terminal.name ?? terminal.id).split(":")[0]!;
}

/** Label for a terminal picker, e.g. `"tui (main)"`. */
export function terminalLabel(terminal: TerminalResource): string {
  const sessionKey = terminal.metadata?.session_key;
  const name = terminalName(terminal);
  return typeof sessionKey === "string" && sessionKey ? `${name} (${sessionKey})` : name;
}

/** The agent's own terminal UI (`tui`) when present, else the first terminal. */
export function pickTerminal(terminals: TerminalResource[]): TerminalResource | null {
  return terminals.find((terminal) => terminalName(terminal) === "tui") ?? terminals[0] ?? null;
}

/**
 * The runner's loopback attach URL, disclosed to session owners when the
 * runner advertises one. Only reachable when the runner is on this machine.
 */
export function directAttachUrl(terminal: TerminalResource, readOnly: boolean): string | undefined {
  const url = parseDirectAttachUrl(terminal.metadata?.direct_attach_url);
  return url && withAttachParams(url, readOnly);
}
