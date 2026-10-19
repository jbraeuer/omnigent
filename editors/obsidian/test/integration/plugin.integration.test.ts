/**
 * The plugin's client, stores and terminal transport against a real server,
 * runner and mock LLM. Skipped unless `OMNIGENT_REPRO_ENV` names a ready
 * `dev.repro_env` output directory (see the plugin README).
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { NoAuth } from "../../src/auth/auth";
import { OmnigentClient } from "../../src/api/client";
import { SessionController } from "../../src/state/sessionController";
import { SessionsStore, closeQuietly } from "../../src/state/sessionsStore";
import { pickTerminal, terminalName } from "../../src/api/terminals";
import { composeMessageWithContext } from "../../src/vault/context";
import {
  HELLO_AGENT_YAML,
  TERMINAL_AGENT_YAML,
  createBundledSession,
  mockLlmRequests,
  reproEnvironment,
  scriptMockLlm,
  waitFor,
} from "./harness";

const env = reproEnvironment();
const cleanup: Array<() => void | Promise<unknown>> = [];

afterAll(async () => {
  for (const step of cleanup.reverse()) await step();
});

describe.skipIf(!env)("plugin against a live Omnigent server", () => {
  const client = new OmnigentClient(env?.serverUrl ?? "http://unused", new NoAuth());

  it("streams a chat turn whose message carries vault note context", async () => {
    const nonce = randomUUID().slice(0, 8);
    await scriptMockLlm(env!, nonce, [{ text: `**Mock reply** ${nonce}: the roadmap has three milestones.` }]);
    const sessionId = await createBundledSession(env!, "obsidian_hello", HELLO_AGENT_YAML, `Chat ${nonce}`);
    const controller = new SessionController(client, sessionId);
    cleanup.push(() => controller.stop());
    controller.start();
    await waitFor(() => controller.snapshot, "initial snapshot");

    const message = composeMessageWithContext(
      `Summarize [[Roadmap]] ${nonce}`,
      [{ path: "Projects/Roadmap.md", content: `# Roadmap\n- Milestone ${nonce}-alpha` }],
      10_000,
    );
    await controller.send(message);

    const reply = await waitFor(
      () =>
        controller.blocks.find(
          (block) => block.type === "text_done" && block.fullText.includes(`Mock reply** ${nonce}`),
        ),
      "assistant reply in the transcript",
    );
    expect(reply).toBeTruthy();
    await waitFor(() => controller.status === "idle" && controller.pendingMessages.length === 0, "idle session");
    expect(controller.liveText).toBe("");
    // The note body reached the model, not just the transcript.
    expect(await mockLlmRequests(env!)).toContain(`Milestone ${nonce}-alpha`);
  });

  it("keeps the session list live and files sessions into projects", async () => {
    const store = new SessionsStore();
    cleanup.push(() => store.disconnect());
    await store.connect(client);
    expect(store.state.kind).toBe("connected");

    const nonce = randomUUID().slice(0, 8);
    const sessionId = await createBundledSession(env!, "obsidian_hello", HELLO_AGENT_YAML, `List ${nonce}`);
    // Discovery is pushed over the updates socket, without a list refresh.
    await waitFor(() => store.sessions.get(sessionId), "new session pushed to the store");

    await client.updateSession(sessionId, { title: `Renamed ${nonce}` });
    await waitFor(() => store.sessions.get(sessionId)?.title === `Renamed ${nonce}`, "rename delta");

    const project = await client.createProject(`Obsidian ${nonce}`);
    await client.updateSession(sessionId, { project_id: project.id });
    await store.refresh();
    expect(store.projects.map((candidate) => candidate.id)).toContain(project.id);
    expect(store.sessions.get(sessionId)?.project_id).toBe(project.id);

    await client.updateSession(sessionId, { project_id: "" });
    await client.updateSession(sessionId, { archived: true });
    await store.refresh();
    expect(store.sessions.has(sessionId)).toBe(false);
  });

  it("attaches to the session terminal and round-trips keystrokes", async () => {
    const nonce = randomUUID().slice(0, 8);
    await scriptMockLlm(env!, `open a shell ${nonce}`, [
      {
        tool_calls: [
          {
            call_id: `call_${nonce}`,
            name: "sys_terminal_launch",
            arguments: JSON.stringify({ terminal: "shell", session: "main" }),
          },
        ],
      },
      { text: "The shell is running." },
    ]);
    const sessionId = await createBundledSession(env!, "obsidian_terminal", TERMINAL_AGENT_YAML, `Terminal ${nonce}`);
    await client.sendMessage(sessionId, [{ type: "input_text", text: `open a shell ${nonce}` }]);
    const terminal = await waitFor(
      async () => (await client.listTerminals(sessionId)).find((candidate) => terminalName(candidate) === "shell"),
      "the agent-launched shell terminal",
    );
    // Without an explicit choice the console shows the agent's own terminal UI.
    expect(terminalName(pickTerminal(await client.listTerminals(sessionId))!)).toBe("tui");

    const socket = await client.openTerminal(sessionId, terminal.id, false);
    cleanup.push(() => closeQuietly(socket));
    let output = "";
    socket.on("message", (data, isBinary) => {
      if (isBinary) output += (data as Buffer).toString("utf8");
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    socket.send(JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
    // Keystrokes sent before tmux attaches are dropped; type once the screen has painted.
    await waitFor(() => output.length > 0, "initial terminal output");
    socket.send(Buffer.from(`echo obsidian-$((6*7))-${nonce}\r`), { binary: true });
    await waitFor(() => output.includes(`obsidian-42-${nonce}`), "command output from the terminal");
  });
});
