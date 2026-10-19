import { describe, expect, it } from "vitest";
import { HostRouting, SLICE_KEY_HEADER, hostScopeForPath, isWrongReplicaBody } from "./routing";

describe("hostScopeForPath", () => {
  it.each([
    ["/v1/hosts/h%201/filesystem", { kind: "host", hostId: "h 1" }],
    ["/v1/sessions/conv_1/stream", { kind: "session", sessionId: "conv_1" }],
    ["/v1/sessions/conv_1/resources/terminals/t/attach", { kind: "session", sessionId: "conv_1" }],
    ["/v1/sessions/conv_1", { kind: "none" }],
    ["/v1/sessions/updates", { kind: "none" }],
    ["/v1/sessions", { kind: "none" }],
    ["/v1/projects", { kind: "none" }],
  ])("%s", (path, scope) => {
    expect(hostScopeForPath(path)).toEqual(scope);
  });
});

describe("isWrongReplicaBody", () => {
  it("recognizes only the structured 400", () => {
    expect(isWrongReplicaBody(400, '{"error":{"code":"wrong_replica"}}')).toBe(true);
    expect(isWrongReplicaBody(400, '{"error":{"code":"runner_unavailable"}}')).toBe(false);
    expect(isWrongReplicaBody(503, '{"error":{"code":"wrong_replica"}}')).toBe(false);
    expect(isWrongReplicaBody(400, "not json")).toBe(false);
  });
});

describe("HostRouting", () => {
  it("keys by host until the host is proven keyless, and never when disabled", () => {
    const routing = new HostRouting(true);
    routing.learn("conv_1", "h1");
    const scope = { kind: "session", sessionId: "conv_1" } as const;
    expect(routing.headersFor(routing.hostFor(scope))).toEqual({ [SLICE_KEY_HEADER]: "h1" });
    routing.markKeyless("h1");
    expect(routing.headersFor("h1")).toEqual({});
    routing.clearKeyless("h1");
    expect(routing.headersFor("h1")).toEqual({ [SLICE_KEY_HEADER]: "h1" });
    expect(new HostRouting(false).headersFor("h1")).toEqual({});
    routing.learn("conv_2", undefined);
    expect(routing.knows("conv_2")).toBe(false);
  });
});
