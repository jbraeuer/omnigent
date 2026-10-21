/** Server → client `clipboard-write` frames relayed from tmux copy mode. */

/** Largest tmux selection accepted for a browser clipboard write. */
export const TERMINAL_CLIPBOARD_MAX_BYTES = 1024 * 1024;
/** A tmux copy notification must closely follow input on this attachment. */
export const TERMINAL_CLIPBOARD_INPUT_WINDOW_MS = 5000;

const STRICT_BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Decode one bounded, canonical base64 terminal clipboard payload. */
export function decodeTerminalClipboardBase64(encoded: string): string | null {
  if (
    encoded.length === 0 ||
    encoded.length > Math.ceil(TERMINAL_CLIPBOARD_MAX_BYTES / 3) * 4 ||
    encoded.length % 4 !== 0 ||
    !STRICT_BASE64_RE.test(encoded)
  ) {
    return null;
  }
  let binary: string;
  try {
    binary = atob(encoded);
  } catch {
    return null;
  }
  if (binary.length === 0 || binary.length > TERMINAL_CLIPBOARD_MAX_BYTES) return null;
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Parse the strict server→browser clipboard control-message schema. */
export function parseTerminalClipboardMessage(message: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(message);
  } catch {
    return null;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    (value as { type?: unknown }).type !== "clipboard-write" ||
    (value as { encoding?: unknown }).encoding !== "base64" ||
    typeof (value as { data?: unknown }).data !== "string"
  ) {
    return null;
  }
  return decodeTerminalClipboardBase64((value as { data: string }).data);
}

/** Whether a clipboard event is attributable to recent input on this attach. */
export function hadRecentTerminalInput(lastInputAt: number, now: number): boolean {
  return (
    lastInputAt > 0 && now >= lastInputAt && now - lastInputAt <= TERMINAL_CLIPBOARD_INPUT_WINDOW_MS
  );
}
