import { describe, expect, it } from "vitest";
import type { Project } from "../api/types";
import { mergeProjectConfig } from "./projectConfig";
import { moveId, orderProjects } from "./sessionsStore";

const project = (id: string, name: string): Project => ({ id, name });
const projects = [project("b", "Beta"), project("a", "Alpha"), project("c", "Gamma")];

describe("orderProjects", () => {
  it("sorts by name unless a manual order is set, appending unranked projects by name", () => {
    expect(orderProjects(projects, null).map((p) => p.id)).toEqual(["a", "b", "c"]);
    expect(orderProjects(projects, { sort_mode: "alphabetical", ordered_project_ids: ["c"] }).map((p) => p.id)).toEqual(["a", "b", "c"]);
    expect(orderProjects(projects, { sort_mode: "manual", ordered_project_ids: ["c", "gone"] }).map((p) => p.id)).toEqual(["c", "a", "b"]);
  });
});

describe("moveId", () => {
  it("moves the last item up or to the top, and is a no-op past the end", () => {
    expect(moveId(["a", "b", "c"], "c", "up")).toEqual(["a", "c", "b"]);
    expect(moveId(["a", "b", "c"], "c", "top")).toEqual(["c", "a", "b"]);
    expect(moveId(["a", "b", "c"], "c", "down")).toEqual(["a", "b", "c"]);
    expect(moveId(["a", "b", "c"], "c", "bottom")).toEqual(["a", "b", "c"]);
  });

  it("moves a middle item each way", () => {
    expect(moveId(["a", "b", "c"], "b", "up")).toEqual(["b", "a", "c"]);
    expect(moveId(["a", "b", "c"], "b", "down")).toEqual(["a", "c", "b"]);
    expect(moveId(["a", "b", "c"], "b", "top")).toEqual(["b", "a", "c"]);
    expect(moveId(["a", "b", "c"], "b", "bottom")).toEqual(["a", "c", "b"]);
    expect(moveId(["a"], "missing", "up")).toEqual(["a"]);
  });
});

describe("mergeProjectConfig", () => {
  it("keeps unrelated keys, drops cleared ones, and a workspace without host", () => {
    const stored = { agent_id: "old", workspace: "/v", host_id: "h", use_worktree: true };
    expect(mergeProjectConfig(stored, { agent_id: "", host_id: "h2", workspace: " /vault " })).toEqual({
      host_id: "h2",
      workspace: "/vault",
      use_worktree: true,
    });
    expect(mergeProjectConfig(stored, { agent_id: "ag", host_id: "", workspace: "/v" })).toEqual({
      agent_id: "ag",
      use_worktree: true,
    });
  });
});
