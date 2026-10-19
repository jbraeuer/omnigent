/**
 * Resolve which server to talk to and with which credentials.
 *
 * An empty server URL means the local server: discovered with the VS Code
 * extension's pidfile + health logic (shared code), probing through Node so the
 * renderer's CORS rules don't apply.
 */
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  defaultDiscoveryIO,
  discoverLocalServer,
  probeHealth,
  type DiscoveryIO,
} from "../../vscode/src/discovery";
import { resolveAuth, type AuthSettings, type RunCommand } from "./auth/auth";
import { OmnigentClient } from "./api/client";
import { joinUrl, requestRaw } from "./transport/http";
import { localHostIdForServer } from "./vault/workspace";

export const OMNIGENT_HOME = join(homedir(), ".omnigent");

/** `fetch` stand-in over Node http, enough for the shared health probe. */
async function nodeFetch(input: string | URL, init?: { signal?: AbortSignal | null }): Promise<Response> {
  const response = await requestRaw(new URL(String(input)), { signal: init?.signal ?? undefined, timeoutMs: 5_000 });
  const chunks: Buffer[] = [];
  for await (const chunk of response) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return {
    status: response.statusCode ?? 0,
    ok: (response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300,
    json: async () => JSON.parse(text) as unknown,
    text: async () => text,
  } as Response;
}

const discoveryIO: DiscoveryIO = {
  ...defaultDiscoveryIO,
  probeHealth: (base, timeoutMs) => probeHealth(base, timeoutMs, nodeFetch as typeof fetch),
};

/** Base URL of the running local server, or a helpful error. */
export async function discoverLocalServerUrl(): Promise<string> {
  const discovery = await discoverLocalServer(discoveryIO);
  if (!discovery.found) {
    throw new Error(
      discovery.reason === "no-pidfile"
        ? "No local Omnigent server found. Start one with `omnigent server`, or set a server URL in the plugin settings."
        : "The local Omnigent server is not running. Start it with `omnigent server`.",
    );
  }
  if (discovery.health !== "ok") {
    throw new Error(`The local Omnigent server at ${discovery.baseUrl} is not healthy (${discovery.health}).`);
  }
  return discovery.baseUrl;
}

export const runCommand: RunCommand = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 30_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve(stdout);
    });
  });

export async function createClient(serverUrl: string, authSettings: AuthSettings): Promise<OmnigentClient> {
  const baseUrl = serverUrl ? serverUrl.replace(/\/+$/, "") : await discoverLocalServerUrl();
  // Validate early so a typo shows up as a clear settings error.
  joinUrl(baseUrl, "/v1");
  const auth = await resolveAuth(baseUrl, authSettings, {
    runCommand,
    readFile: (path) => readFile(path, "utf8"),
    cliTokenFilePath: join(OMNIGENT_HOME, "auth_tokens.json"),
    databricksConfigPath: process.env.DATABRICKS_CONFIG_FILE || join(homedir(), ".databrickscfg"),
    envProfile: process.env.DATABRICKS_CONFIG_PROFILE,
  });
  return new OmnigentClient(baseUrl, auth);
}

/** This machine's host id for `serverUrl`, from `omnigent host` daemon records. */
export async function readLocalHostId(serverUrl: string): Promise<string | null> {
  const dir = join(OMNIGENT_HOME, "daemons");
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith(".json"));
  } catch {
    return null;
  }
  const contents = await Promise.all(names.map((name) => readFile(join(dir, name), "utf8").catch(() => "")));
  return localHostIdForServer(contents, serverUrl);
}
