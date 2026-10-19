/**
 * Setup for integration tests against a real Omnigent stack started with
 * `python -m dev.repro_env --output <dir> serve` (server + runner + mock LLM).
 * Point `OMNIGENT_REPRO_ENV` at that output directory.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { agentBundle } from "./bundle.mjs";

export interface ReproEnvironment {
  serverUrl: string;
  mockUrl: string;
  runnerId: string;
}

export function reproEnvironment(): ReproEnvironment | null {
  const dir = process.env.OMNIGENT_REPRO_ENV;
  if (!dir) return null;
  const state = JSON.parse(readFileSync(join(dir, "environment.json"), "utf8")) as {
    status: string;
    base_url: string;
    mock_url: string;
    runner_id: string;
  };
  if (state.status !== "ready") throw new Error(`Repro environment in ${dir} is ${state.status}`);
  return { serverUrl: state.base_url, mockUrl: state.mock_url, runnerId: state.runner_id };
}

/** Create a session from an inline agent YAML and bind it to the stack's runner. */
export async function createBundledSession(
  env: ReproEnvironment,
  agentName: string,
  yaml: string,
  title: string,
): Promise<string> {
  const form = new FormData();
  form.set("metadata", JSON.stringify({ title }));
  form.set("bundle", new Blob([agentBundle(`${agentName}.yaml`, yaml)], { type: "application/gzip" }), "agent.tar.gz");
  const created = await fetch(`${env.serverUrl}/v1/sessions`, { method: "POST", body: form });
  if (!created.ok) throw new Error(`create session: ${created.status} ${await created.text()}`);
  const { session_id: sessionId } = (await created.json()) as { session_id: string };
  const bound = await fetch(`${env.serverUrl}/v1/sessions/${sessionId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ runner_id: env.runnerId }),
  });
  if (!bound.ok) throw new Error(`bind runner: ${bound.status} ${await bound.text()}`);
  return sessionId;
}

/** Queue scripted mock-LLM responses for requests whose user text contains `match`. */
export async function scriptMockLlm(env: ReproEnvironment, match: string, responses: unknown[]): Promise<void> {
  const response = await fetch(`${env.mockUrl}/mock/configure`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: `obsidian-${match}`, match, responses }),
  });
  if (!response.ok) throw new Error(`mock configure: ${response.status} ${await response.text()}`);
}

/** Request bodies the mock LLM received, serialized for substring checks. */
export async function mockLlmRequests(env: ReproEnvironment): Promise<string> {
  const response = await fetch(`${env.mockUrl}/mock/requests`);
  return JSON.stringify(await response.json());
}

export async function waitFor<T>(
  probe: () => T | undefined | null | false | Promise<T | undefined | null | false>,
  description: string,
  timeoutMs = 45_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

export const HELLO_AGENT_YAML = `name: obsidian_hello
prompt: You are a friendly assistant.

executor:
  model: gpt-4o-mini
  harness: openai-agents
`;

export const TERMINAL_AGENT_YAML = `name: obsidian_terminal
prompt: |
  When asked to open a shell, call sys_terminal_launch with terminal="shell" and session="main",
  then reply with one short sentence.

executor:
  model: gpt-4o-mini
  harness: openai-agents

os_env:
  type: caller_process
  cwd: .
  sandbox:
    type: none

terminals:
  shell:
    command: bash
    args: ["--noprofile", "--norc"]
    os_env:
      type: caller_process
      cwd: .
      sandbox:
        type: none
`;
