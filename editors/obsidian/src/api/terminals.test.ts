import { describe, expect, it } from "vitest";
import { directAttachUrl, pickTerminal, terminalLabel, terminalName } from "./terminals";

const shell = { id: "terminal_shell_main", name: "shell:main", metadata: { terminal_name: "shell", session_key: "main" } };
const tui = { id: "terminal_tui_main", name: "tui:main", metadata: { terminal_name: "tui", session_key: "main" } };

describe("terminals", () => {
  it("prefers the agent's own terminal UI", () => {
    expect(pickTerminal([shell, tui])).toBe(tui);
    expect(pickTerminal([shell])).toBe(shell);
    expect(pickTerminal([])).toBeNull();
  });

  it("names terminals from metadata, falling back to the resource name", () => {
    expect(terminalName(shell)).toBe("shell");
    expect(terminalName({ id: "terminal_x", name: "bash:work" })).toBe("bash");
    expect(terminalLabel(tui)).toBe("tui (main)");
  });

  it("uses only loopback direct-attach URLs, with the read-only flag", () => {
    const direct = "ws://127.0.0.1:4100/v1/sessions/s/resources/terminals/t/attach?token=abc";
    const withUrl = (url: unknown) => ({ ...tui, metadata: { ...tui.metadata, direct_attach_url: url } });
    expect(directAttachUrl(withUrl(direct), false)).toBe(direct);
    expect(directAttachUrl(withUrl(direct), true)).toBe(`${direct}&read_only=true`);
    expect(directAttachUrl(withUrl("wss://evil.example.com/attach"), false)).toBeUndefined();
    expect(directAttachUrl(tui, false)).toBeUndefined();
  });
});
