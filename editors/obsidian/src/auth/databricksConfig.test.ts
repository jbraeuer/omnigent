import { describe, expect, it } from "vitest";
import { isServicePrincipal, parseDatabricksConfig, profilesForHost } from "./databricksConfig";

describe("parseDatabricksConfig", () => {
  it("reads sections, keys and skips comments", () => {
    const sections = parseDatabricksConfig("; note\n[a]\nhost = https://x\n# c\nAuth_Type= pat\n");
    expect(sections.get("a")).toEqual({ host: "https://x", auth_type: "pat" });
  });
});

describe("profilesForHost", () => {
  it("matches scheme- and slash-insensitively, with [DEFAULT] host inheritance last", () => {
    const cfg = "[DEFAULT]\nhost = https://ws.example.com\n[inherits]\ntoken = dapi\n[other]\nhost = https://else\n";
    expect(profilesForHost(cfg, "ws.example.com/")).toEqual([{ name: "inherits", token: "dapi" }, { name: "DEFAULT" }]);
  });

  it("classifies service principals by auth type or client credentials", () => {
    expect(isServicePrincipal({ auth_type: "oauth-m2m" })).toBe(true);
    expect(isServicePrincipal({ client_id: "a", client_secret: "b" })).toBe(true);
    expect(isServicePrincipal({ client_id: "a", client_secret: "b", auth_type: "databricks-cli" })).toBe(false);
    expect(isServicePrincipal({ auth_type: "databricks-cli" })).toBe(false);
  });
});
