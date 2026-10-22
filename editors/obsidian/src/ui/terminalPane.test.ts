import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalPane } from "./terminalPane";

const copyText = vi.hoisted(() => vi.fn(async (_text: string) => {}));
vi.mock("@/lib/clipboard", () => ({ copyText: (text: string) => copyText(text) }));

function clipboardFrame(text: string): string {
  return JSON.stringify({ type: "clipboard-write", encoding: "base64", data: Buffer.from(text).toString("base64") });
}

function paneWithInputAt(lastInputAt: number): InstanceType<typeof TerminalPane> {
  const pane = Object.create(TerminalPane.prototype) as InstanceType<typeof TerminalPane>;
  (pane as unknown as { lastInputAt: number }).lastInputAt = lastInputAt;
  return pane;
}

describe("TerminalPane clipboard frames", () => {
  afterEach(() => {
    copyText.mockClear();
    vi.restoreAllMocks();
  });

  it("copies a tmux selection that follows local input", () => {
    vi.spyOn(performance, "now").mockReturnValue(10_000);
    paneWithInputAt(9_000).handleControlFrame(clipboardFrame("selected λ"));
    expect(copyText).toHaveBeenCalledWith("selected λ");
  });

  it("ignores selections without recent input and unknown frames", () => {
    vi.spyOn(performance, "now").mockReturnValue(60_000);
    paneWithInputAt(9_000).handleControlFrame(clipboardFrame("someone else's copy"));
    paneWithInputAt(59_000).handleControlFrame(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
    expect(copyText).not.toHaveBeenCalled();
  });
});

describe("TerminalPane keys", () => {
  function keyEvent(type: string, init: Partial<KeyboardEvent>): KeyboardEvent {
    return { type, key: "", shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, isComposing: false, keyCode: 0, preventDefault: vi.fn(), ...init } as unknown as KeyboardEvent;
  }

  it("sends Shift+Enter once as CSI-u and leaves plain Enter to xterm", () => {
    const pane = paneWithInputAt(0);
    const send = vi.fn();
    (pane as unknown as { socket: unknown }).socket = { readyState: 1, send };

    expect(pane.handleKey(keyEvent("keydown", { key: "Enter", shiftKey: true }))).toBe(false);
    expect(pane.handleKey(keyEvent("keyup", { key: "Enter", shiftKey: true }))).toBe(false);
    expect(pane.handleKey(keyEvent("keydown", { key: "Enter" }))).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0].toString()).toBe("\x1b[13;2u");
  });
});
