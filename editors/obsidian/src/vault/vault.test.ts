import { describe, expect, it } from "vitest";
import { composeMessageWithContext, extractWikiLinks, splitContext } from "./context";
import { localHostIdForServer, pickHost, resolveWorkspacePath } from "./workspace";

describe("extractWikiLinks", () => {
  it("returns link targets without aliases, headings or duplicates", () => {
    expect(extractWikiLinks("See [[Roadmap]], [[Plans/Q3|Q3 plan]], [[Roadmap#Risks]] and [[^block]].")).toEqual([
      "Roadmap",
      "Plans/Q3",
    ]);
  });
});

describe("composeMessageWithContext", () => {
  it("returns the text unchanged without notes", () => {
    expect(composeMessageWithContext("hi", [], 100)).toBe("hi");
  });

  it("appends fenced notes and truncates past the limit", () => {
    const message = composeMessageWithContext(
      "Summarize",
      [
        { path: "A.md", content: "0123456789" },
        { path: "B.md", content: "abcdefghij" },
        { path: "C.md", content: "never" },
      ],
      15,
    );
    expect(message).toContain("Note: A.md\n```markdown\n0123456789\n```");
    expect(message).toContain("Note: B.md\n```markdown\nabcde\n```\n(Truncated B.md at 5 of 10 characters.)");
    expect(message).toContain("(Omitted C.md: context size limit reached.)");
  });

  it("uses a fence longer than any backtick run inside the note", () => {
    const message = composeMessageWithContext("x", [{ path: "Code.md", content: "````js\ncode\n````" }], 100);
    expect(message).toContain("`````markdown\n````js\ncode\n````\n`````");
  });
});

describe("resolveWorkspacePath", () => {
  it("maps settings to an absolute directory inside the vault", () => {
    expect(resolveWorkspacePath("/v", "vault", "")).toBe("/v");
    expect(resolveWorkspacePath("/v", "folder", "Agents/work")).toBe("/v/Agents/work");
    expect(resolveWorkspacePath("/v", "none", "")).toBeUndefined();
    expect(resolveWorkspacePath(null, "vault", "")).toBeUndefined();
    expect(() => resolveWorkspacePath("/v", "folder", "../outside")).toThrow("outside the vault");
  });
});

describe("localHostIdForServer", () => {
  it("finds the daemon record for the server URL", () => {
    const records = [
      "not json",
      JSON.stringify({ host_id: "other", server_url: "http://127.0.0.1:6767" }),
      JSON.stringify({ host_id: "mine", server_url: "https://ws/api/2.0/omnigent", target: "https://ws/api/2.0/omnigent" }),
    ];
    expect(localHostIdForServer(records, "https://ws/api/2.0/omnigent/")).toBe("mine");
    expect(localHostIdForServer(records, "https://elsewhere")).toBeNull();
  });
});

describe("pickHost", () => {
  const hosts = [
    { host_id: "laptop", name: "Laptop", status: "online" },
    { host_id: "desktop", name: "Desktop", status: "offline" },
    { host_id: "sandbox", status: "online", sandbox_provider: "modal" },
  ];

  it("prefers the configured host, then this machine, then the only online host", () => {
    expect(pickHost(hosts, "desktop", "laptop")?.host_id).toBe("desktop");
    expect(pickHost(hosts, "", "desktop")?.host_id).toBe("desktop");
    expect(pickHost(hosts, "", null)?.host_id).toBe("laptop");
    expect(pickHost(hosts, "sandbox", null)).toBeNull();
    expect(pickHost([...hosts, { host_id: "x", status: "online" }], "", null)).toBeNull();
  });
});

describe("splitContext", () => {
  it("recovers the typed text and note paths from a composed message", () => {
    const composed = composeMessageWithContext("Summarize", [{ path: "A.md", content: "a" }, { path: "B/C.md", content: "c" }], 100);
    expect(splitContext(composed)).toMatchObject({ text: "Summarize", notePaths: ["A.md", "B/C.md"] });
    expect(splitContext("plain")).toEqual({ text: "plain", context: null, notePaths: [] });
  });
});
