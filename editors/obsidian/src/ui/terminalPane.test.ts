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
