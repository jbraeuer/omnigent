import { describe, expect, it, vi } from "vitest";
import {
  DATABRICKS_ORG_ID_HEADER,
  DatabricksCliAuth,
  NoAuth,
  StaticTokenAuth,
  findCliTokenRecord,
  parseDatabricksTokenOutput,
  resolveAuth,
  type AuthDeps,
  type AuthSettings,
  type DatabricksCliAuthOptions,
  type RunCommand,
} from "./auth";

const WORKSPACE = "https://dbc-123.cloud.databricks.com";
const SERVER = `${WORKSPACE}/api/2.0/omnigent`;
const AUTO: AuthSettings = { mode: "auto", token: "", databricksCliPath: "" };

function tokenJson(token: string, expiry: string): string {
  return JSON.stringify({ access_token: token, token_type: "Bearer", expiry });
}

function deps(files: Record<string, string>, runCommand: AuthDeps["runCommand"] = vi.fn()): AuthDeps {
  return {
    runCommand,
    cliTokenFilePath: "/home/.omnigent/auth_tokens.json",
    databricksConfigPath: "/home/.databrickscfg",
    readFile: async (path) => {
      if (!(path in files)) throw new Error("ENOENT");
      return files[path]!;
    },
  };
}

describe("parseDatabricksTokenOutput", () => {
  it("reads the token and expiry", () => {
    expect(parseDatabricksTokenOutput(tokenJson("abc", "2026-10-16T10:00:00Z"))).toEqual({
      token: "abc",
      expiresAtMs: Date.parse("2026-10-16T10:00:00Z"),
    });
  });

  it.each(["not json", "{}", '{"access_token":""}'])("rejects %s", (output) => {
    expect(() => parseDatabricksTokenOutput(output)).toThrow();
  });
});

function cliAuth(run: RunCommand, overrides: Partial<DatabricksCliAuthOptions> = {}): DatabricksCliAuth {
  return new DatabricksCliAuth({
    workspaceHost: WORKSPACE,
    cliCandidates: ["databricks"],
    runCommand: run,
    readConfig: async () => null,
    ...overrides,
  });
}

// Three profiles share the host, as `databricks auth login --host` and `omnigent login` leave behind.
const SHARED_HOST_CFG = `
[DEFAULT]
host = https://adb-1.azuredatabricks.net

[ug-oauth-dbc-123]
host = ${WORKSPACE}/
auth_type = databricks-cli

[sp]
host = ${WORKSPACE}
client_id = abc
client_secret = shh

[omnigent-dbc-123]
host = dbc-123.cloud.databricks.com
auth_type = databricks-cli
`;

describe("DatabricksCliAuth", () => {
  it("caches until shortly before expiry, then re-mints", async () => {
    let now = Date.parse("2026-10-16T09:00:00Z");
    const run = vi
      .fn()
      .mockResolvedValueOnce(tokenJson("first", "2026-10-16T10:00:00Z"))
      .mockResolvedValueOnce(tokenJson("second", "2026-10-16T11:00:00Z"));
    const auth = cliAuth(run, { now: () => now });

    expect(await auth.headers()).toEqual({ Authorization: "Bearer first" });
    now = Date.parse("2026-10-16T09:50:00Z");
    expect(await auth.headers()).toEqual({ Authorization: "Bearer first" });
    now = Date.parse("2026-10-16T09:56:00Z");
    expect(await auth.headers()).toEqual({ Authorization: "Bearer second" });
    // No ~/.databrickscfg profile for the host: fall back to the host lookup.
    expect(run).toHaveBeenCalledWith("databricks", ["auth", "token", "--host", WORKSPACE]);
  });

  it("names a profile when several share the host, skipping ones that fail", async () => {
    const run = vi.fn(async (_cli: string, args: string[]) => {
      if (args.includes("ug-oauth-dbc-123")) throw new Error("refresh token is invalid");
      return tokenJson("from-omnigent-profile", "2099-01-01T00:00:00Z");
    });
    const auth = cliAuth(run, { readConfig: async () => SHARED_HOST_CFG });
    expect(await auth.headers()).toEqual({ Authorization: "Bearer from-omnigent-profile" });
    // User profiles in file order before the service principal.
    expect(run.mock.calls.map(([, args]) => args.at(-1))).toEqual(["ug-oauth-dbc-123", "omnigent-dbc-123"]);
  });

  it("prefers DATABRICKS_CONFIG_PROFILE, then an explicit setting overrides matching", async () => {
    const run = vi.fn(async () => tokenJson("t", "2099-01-01T00:00:00Z"));
    await cliAuth(run, { readConfig: async () => SHARED_HOST_CFG, envProfile: "sp" }).headers();
    expect(run).toHaveBeenLastCalledWith("databricks", ["auth", "token", "--profile", "sp"]);
    await cliAuth(run, { readConfig: async () => SHARED_HOST_CFG, profile: "mine" }).headers();
    expect(run).toHaveBeenLastCalledWith("databricks", ["auth", "token", "--profile", "mine"]);
  });

  it("uses a profile's stored personal access token without the CLI", async () => {
    const run = vi.fn();
    const auth = cliAuth(run, { readConfig: async () => `[pat]\nhost = ${WORKSPACE}\ntoken = dapi123\n` });
    expect(await auth.headers()).toEqual({ Authorization: "Bearer dapi123" });
    expect(run).not.toHaveBeenCalled();
  });

  it("tries other CLI locations only when the binary is missing", async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("spawn /opt/homebrew/bin/databricks ENOENT"))
      .mockResolvedValueOnce(tokenJson("t", "2099-01-01T00:00:00Z"));
    const auth = cliAuth(run, { cliCandidates: ["/opt/homebrew/bin/databricks", "/usr/local/bin/databricks"] });
    expect(await auth.headers()).toEqual({ Authorization: "Bearer t" });

    const missing = cliAuth(vi.fn().mockRejectedValue(new Error("spawn databricks ENOENT")));
    await expect(missing.headers()).rejects.toThrow("Databricks CLI not found");
  });

  it("explains how to log in when every profile fails", async () => {
    const run = vi.fn().mockRejectedValue(new Error("refresh token is invalid"));
    const auth = cliAuth(run);
    await expect(auth.headers()).rejects.toThrow(`databricks auth login --host ${WORKSPACE}`);
  });

  it("shares one mint between concurrent callers and re-mints after invalidate", async () => {
    const run = vi.fn().mockResolvedValue(tokenJson("t", "2099-01-01T00:00:00Z"));
    const auth = cliAuth(run, { extraHeaders: { [DATABRICKS_ORG_ID_HEADER]: "42" } });
    const [a, b] = await Promise.all([auth.headers(), auth.headers()]);
    expect(a).toEqual({ [DATABRICKS_ORG_ID_HEADER]: "42", Authorization: "Bearer t" });
    expect(b).toEqual(a);
    expect(run).toHaveBeenCalledTimes(1);
    auth.invalidate();
    await auth.headers();
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe("findCliTokenRecord", () => {
  it("matches the CLI's slash-stripped keys", () => {
    const file = JSON.stringify({ "http://localhost:6767": { token: "jwt" } });
    expect(findCliTokenRecord(file, "http://localhost:6767/")).toEqual({ token: "jwt" });
    expect(findCliTokenRecord("[]", "http://localhost:6767")).toBeNull();
    expect(findCliTokenRecord("garbage", "http://localhost:6767")).toBeNull();
  });
});

describe("resolveAuth", () => {
  const tokenFile = "/home/.omnigent/auth_tokens.json";

  it("uses no credentials for loopback servers in auto mode", async () => {
    expect(await resolveAuth("http://127.0.0.1:6767", AUTO, deps({}))).toBeInstanceOf(NoAuth);
  });

  it("prefers a live `omnigent login` session token", async () => {
    const files = { [tokenFile]: JSON.stringify({ "https://omni.example.com": { token: "jwt", expires_at: 4e9 } }) };
    const auth = await resolveAuth("https://omni.example.com", AUTO, deps(files));
    expect(await auth.headers()).toEqual({ Authorization: "Bearer jwt" });
  });

  it("ignores an expired session token", async () => {
    const files = { [tokenFile]: JSON.stringify({ "https://omni.example.com": { token: "jwt", expires_at: 1 } }) };
    expect(await resolveAuth("https://omni.example.com", AUTO, deps(files))).toBeInstanceOf(NoAuth);
  });

  it("follows a Databricks pointer record to its workspace, with org routing", async () => {
    const files = {
      [tokenFile]: JSON.stringify({
        "https://app.databricksapps.com": { auth_type: "databricks", workspace_host: WORKSPACE, org_id: "7" },
      }),
    };
    const run = vi.fn().mockResolvedValue(tokenJson("dbx", "2099-01-01T00:00:00Z"));
    const auth = await resolveAuth("https://app.databricksapps.com", AUTO, deps(files, run));
    expect(await auth.headers()).toEqual({ [DATABRICKS_ORG_ID_HEADER]: "7", Authorization: "Bearer dbx" });
    expect(run).toHaveBeenCalledWith("/opt/homebrew/bin/databricks", ["auth", "token", "--host", WORKSPACE]);
  });

  it("mints for workspace-hosted URLs without any stored record", async () => {
    const run = vi.fn().mockResolvedValue(tokenJson("dbx", "2099-01-01T00:00:00Z"));
    const auth = await resolveAuth(SERVER, { ...AUTO, databricksCliPath: "/custom/databricks" }, deps({}, run));
    expect(await auth.headers()).toEqual({ Authorization: "Bearer dbx" });
    expect(run).toHaveBeenCalledWith("/custom/databricks", ["auth", "token", "--host", WORKSPACE]);
  });

  it("honors explicit modes", async () => {
    expect(await resolveAuth(SERVER, { ...AUTO, mode: "none" }, deps({}))).toBeInstanceOf(NoAuth);
    const token = await resolveAuth(SERVER, { ...AUTO, mode: "token", token: " pasted " }, deps({}));
    expect(token).toBeInstanceOf(StaticTokenAuth);
    expect(await token.headers()).toEqual({ Authorization: "Bearer pasted" });
  });
});
