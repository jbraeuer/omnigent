// End-to-end check of the plugin inside the real Obsidian desktop app.
//
// Launches the installed Obsidian with a throwaway profile and vault (your own
// vaults and running instance are untouched), loads the built plugin pointed at
// a `dev.repro_env` stack, then drives the UI over the Chrome DevTools Protocol
// and saves screenshots.
//
//   node scripts/e2e-obsidian.mjs --env /tmp/omni-repro --out /tmp/omni-obsidian-e2e
//
// Requires a built plugin (`pnpm build`) and macOS (`/Applications/Obsidian.app`).
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import WebSocket from "ws";

const { values: args } = parseArgs({
  options: {
    env: { type: "string" },
    out: { type: "string", default: "/tmp/omni-obsidian-e2e" },
    app: { type: "string", default: "/Applications/Obsidian.app/Contents/MacOS/Obsidian" },
    port: { type: "string", default: "9333" },
    keep: { type: "boolean", default: false },
  },
});
if (!args.env) throw new Error("--env <dev.repro_env output dir> is required");
const environment = JSON.parse(readFileSync(join(args.env, "environment.json"), "utf8"));
if (environment.status !== "ready") throw new Error(`repro environment is ${environment.status}`);
const serverUrl = environment.base_url;
const mockUrl = environment.mock_url;
const pluginDir = resolve(import.meta.dirname, "..");
const out = resolve(args.out);
const vault = join(out, "vault");
const profile = join(out, "profile");

// ── Fixture vault + profile ────────────────────────────────────────────────
rmSync(out, { recursive: true, force: true });
const installed = join(vault, ".obsidian", "plugins", "omnigent");
mkdirSync(installed, { recursive: true });
for (const file of ["main.js", "manifest.json", "styles.css"]) copyFileSync(join(pluginDir, file), join(installed, file));
writeFileSync(join(vault, ".obsidian", "community-plugins.json"), JSON.stringify(["omnigent"]));
// DOM menus instead of macOS native ones, so menus are inspectable and visible in screenshots.
writeFileSync(join(vault, ".obsidian", "app.json"), JSON.stringify({ nativeMenus: false }));
writeFileSync(
  join(installed, "data.json"),
  JSON.stringify({ serverUrl, authMode: "none", workspaceMode: "none", canvasFolder: "Omnigent" }),
);
mkdirSync(join(vault, "Projects"), { recursive: true });
writeFileSync(join(vault, "Projects", "Roadmap.md"), "# Roadmap\n\n- Milestone e2e-alpha: ship the Obsidian plugin\n");
mkdirSync(profile, { recursive: true });
writeFileSync(
  join(profile, "obsidian.json"),
  JSON.stringify({ vaults: { e2evault0000000a: { path: vault, ts: Date.now(), open: true } } }),
);

// ── Server-side fixtures: a runner-bound session and scripted replies ───────
const nonce = Math.random().toString(36).slice(2, 8);
async function post(url, body, method = "POST") {
  const response = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${method} ${url}: ${response.status} ${await response.text()}`);
  return response.json();
}
const { agentBundle } = await import(join(pluginDir, "test/integration/bundle.mjs"));
async function bundledSession(title, yaml) {
  const form = new FormData();
  form.set("metadata", JSON.stringify({ title }));
  form.set("bundle", new Blob([agentBundle("obsidian_e2e.yaml", yaml)]), "agent.tar.gz");
  const created = await fetch(`${serverUrl}/v1/sessions`, { method: "POST", body: form });
  if (!created.ok) throw new Error(`create session: ${created.status} ${await created.text()}`);
  const { session_id: id } = await created.json();
  await post(`${serverUrl}/v1/sessions/${id}`, { runner_id: environment.runner_id }, "PATCH");
  return id;
}
const agentYaml = `name: obsidian_e2e
prompt: You are a friendly assistant.
executor:
  model: gpt-4o-mini
  harness: openai-agents
os_env:
  type: caller_process
  cwd: .
  sandbox:
    type: none
`;
const project = await post(`${serverUrl}/v1/projects`, { name: `Obsidian e2e ${nonce}` });
const sessionId = await bundledSession(`Plan the Obsidian plugin ${nonce}`, agentYaml);
await post(`${serverUrl}/v1/sessions/${sessionId}`, { project_id: project.id }, "PATCH");
await bundledSession(`Unfiled research ${nonce}`, agentYaml);
await post(`${mockUrl}/mock/configure`, {
  key: `obsidian-e2e-${nonce}`,
  match: `e2e-${nonce}`,
  responses: [
    {
      text:
        `## Roadmap summary\n\nThe note lists **one milestone**:\n\n- e2e-alpha — ship the Obsidian plugin\n\n` +
        "```ts\nconst ok = true;\n```",
    },
  ],
});

// ── Launch Obsidian and attach over CDP ────────────────────────────────────
const portInUse = await fetch(`http://127.0.0.1:${args.port}/json`).then(
  () => true,
  () => false,
);
if (portInUse) throw new Error(`Port ${args.port} is already in use (a previous run left Obsidian open?)`);
const obsidian = spawn(args.app, [`--user-data-dir=${profile}`, `--remote-debugging-port=${args.port}`], {
  stdio: ["ignore", "pipe", "pipe"],
});
obsidian.stderr.on("data", () => {});
obsidian.stdout.on("data", () => {});
let socket;
try {
  let target;
  for (let attempt = 0; attempt < 60 && !target; attempt++) {
    await sleep(500);
    try {
      const targets = await (await fetch(`http://127.0.0.1:${args.port}/json`)).json();
      target = targets.find((candidate) => candidate.type === "page" && candidate.url.startsWith("app://"));
    } catch {
      // Not listening yet.
    }
  }
  if (!target) throw new Error("Obsidian did not expose a debuggable window");
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((done, fail) => (socket.once("open", done), socket.once("error", fail)));
  let nextId = 0;
  const pending = new Map();
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.method === "Runtime.exceptionThrown") {
      console.log(`[renderer exception] ${message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text}`);
    } else if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
      console.log(`[renderer console.error] ${message.params.args.map((arg) => arg.value ?? arg.description).join(" ")}`);
    }
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });
  const cdp = (method, params = {}) =>
    new Promise((done) => {
      const id = ++nextId;
      pending.set(id, done);
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const { result } = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result?.exceptionDetails) throw new Error(`${expression}\n${JSON.stringify(result.exceptionDetails)}`);
    return result?.result?.value;
  };
  const waitUntil = async (expression, description, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await evaluate(expression).catch(() => undefined);
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`Timed out: ${description}`);
      await sleep(250);
    }
  };
  const screenshot = async (name) => {
    await sleep(400);
    const { result } = await cdp("Page.captureScreenshot", { format: "png" });
    const path = join(out, `${name}.png`);
    writeFileSync(path, Buffer.from(result.data, "base64"));
    console.log(`screenshot ${path}`);
  };
  const steps = [];
  const check = (name, ok) => {
    steps.push({ name, ok: Boolean(ok) });
    console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  };

  await cdp("Runtime.enable");
  // The test window runs in the background; menus close in an unfocused window.
  await cdp("Emulation.setFocusEmulationEnabled", { enabled: true });
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 0, mobile: false });
  await waitUntil("window.app?.workspace?.layoutReady", "workspace ready", 60_000);
  // A fresh vault starts in restricted mode; trust it for this throwaway profile.
  await evaluate(`(async () => {
    if (!app.plugins.isEnabled()) await app.plugins.setEnable(true);
    if (!app.plugins.enabledPlugins.has("omnigent")) await app.plugins.enablePluginAndSave("omnigent");
    document.querySelectorAll(".modal-close-button").forEach((button) => button.click());
    return true;
  })()`);
  await waitUntil(`!!app.plugins.plugins.omnigent`, "plugin loaded");
  await evaluate(`app.plugins.plugins.omnigent.activateNavigator()`);
  await waitUntil(
    `document.querySelector('.omnigent-navigator')?.textContent.includes(${JSON.stringify(`Plan the Obsidian plugin ${nonce}`)})`,
    "navigator lists the session",
  );
  check("navigator shows projects and sessions", await evaluate(
    `(() => { const t = document.querySelector('.omnigent-navigator').textContent;
      return t.includes(${JSON.stringify(`Obsidian e2e ${nonce}`)}) && t.includes(${JSON.stringify(`Unfiled research ${nonce}`)}); })()`,
  ));
  await screenshot("01-navigator");

  // Hover a project row: "New session in project" and "⋯" appear, like the desktop sidebar.
  const projectRow = `[...document.querySelectorAll('.omnigent-project-row')].find((row) => row.textContent.includes(${JSON.stringify(`Obsidian e2e ${nonce}`)}))`;
  // Synthetic hover is unreliable in a background window; a focused row reveals the same actions.
  await evaluate(`${projectRow}.focus()`);
  check("project row shows its action buttons", await evaluate(
    `(() => { const buttons = [...${projectRow}.querySelectorAll('.omnigent-row-actions button')];
      return getComputedStyle(${projectRow}.querySelector('.omnigent-row-actions')).display === 'flex' &&
        buttons.map((b) => b.getAttribute('aria-label')).join('|') === 'New session in project|Project actions'; })()`,
  ));
  await evaluate(`${projectRow}.querySelector('[aria-label="Project actions"]').click()`);
  await waitUntil(`document.querySelector('.menu')?.textContent.includes('Project settings')`, "project menu");
  check("project menu lists rename, settings and delete", await evaluate(
    `(() => { const t = document.querySelector('.menu').textContent;
      return ['New session', 'Rename project', 'Project settings', 'Delete project'].every((label) => t.includes(label)); })()`,
  ));
  await screenshot("01b-project-menu");
  await evaluate(`[...document.querySelectorAll('.menu .menu-item')].find((i) => i.textContent.includes('Project settings')).click()`);
  await waitUntil(`document.querySelector('.modal')?.textContent.includes('Defaults for new sessions')`, "project settings dialog");
  await screenshot("01c-project-settings");
  await evaluate(`document.querySelector('.modal .modal-close-button').click()`);

  await evaluate(`app.plugins.plugins.omnigent.openSession(${JSON.stringify(sessionId)})`);
  await waitUntil(`document.querySelector('.omnigent-session-view textarea')`, "session view open");
  await evaluate(`(() => {
    document.querySelector('.omnigent-session-view textarea').value = ${JSON.stringify(`Summarize [[Roadmap]] e2e-${nonce}`)};
    [...document.querySelectorAll('.omnigent-session-view button')].find((b) => b.textContent === 'Send').click();
    return true;
  })()`);
  await waitUntil(
    `document.querySelector('.omnigent-transcript')?.querySelector('h2')?.textContent.includes('Roadmap summary')`,
    "rendered markdown reply",
  );
  check("attached note collapses into a context disclosure", await evaluate(
    `document.querySelector('.omnigent-transcript .omnigent-context summary')?.textContent === 'Context: Projects/Roadmap.md'`,
  ));
  check("reply rendered as markdown (heading, list, code block)", await evaluate(
    `(() => { const t = document.querySelector('.omnigent-transcript');
      return !!t.querySelector('h2') && !!t.querySelector('li') && !!t.querySelector('pre code'); })()`,
  ));
  check("view header shows the session title", await evaluate(
    `document.querySelector('.workspace-leaf.mod-active .view-header-title')?.textContent.includes(${JSON.stringify(`Plan the Obsidian plugin ${nonce}`)})`,
  ));
  const requests = JSON.stringify(await (await fetch(`${mockUrl}/mock/requests`)).json());
  check("[[Roadmap]] note content reached the model", requests.includes("Milestone e2e-alpha"));
  await screenshot("02-session-rendered");

  await evaluate(`[...document.querySelectorAll('.omnigent-mode-toggle button')].find((b) => b.textContent === 'Console').click()`);
  // The WebGL renderer paints to a canvas, so read the terminal's own buffer.
  const terminalText = `(() => { const buffer = app.workspace.getLeavesOfType('omnigent-session')[0]?.view.terminal?.terminal?.buffer.active;
    if (!buffer) return '';
    let text = '';
    for (let row = 0; row < buffer.length; row++) text += buffer.getLine(row)?.translateToString(true) ?? '';
    return text.trim(); })()`;
  await waitUntil(`${terminalText}.length > 0`, "terminal output", 30_000);
  check("console mode shows the live terminal", true);
  check("console attaches directly to this machine's runner", await evaluate(
    `[...document.querySelectorAll('.workspace-leaf.mod-active *')].some((el) => el.children.length === 0 && /^Attached to .*, direct$/.test(el.textContent))`,
  ));
  // Let the terminal repaint at its fitted size before the screenshot.
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  await screenshot("03-session-console");

  await evaluate(`app.plugins.plugins.omnigent.openInbox()`);
  await waitUntil(`document.querySelector('.omnigent-inbox-list')`, "inbox open");
  check("inbox view opens", true);
  await screenshot("04-inbox");

  await evaluate(`app.plugins.plugins.omnigent.generateCanvases(true)`);
  await waitUntil(`!!(app.vault.getFileByPath('Omnigent/Main.canvas') && app.vault.getFileByPath(${JSON.stringify(`Omnigent/Obsidian e2e ${nonce}.canvas`)}))`, "canvas files");
  const canvas = await evaluate(
    `app.vault.read(app.vault.getFileByPath(${JSON.stringify(`Omnigent/Obsidian e2e ${nonce}.canvas`)}))`,
  );
  check("project canvas links to the session", canvas.includes(`obsidian://omnigent?session=${sessionId}`));
  await evaluate(`app.workspace.getLeaf('tab').openFile(app.vault.getFileByPath(${JSON.stringify(`Omnigent/Obsidian e2e ${nonce}.canvas`)}))`);
  await screenshot("05-canvas");

  const failed = steps.filter((step) => !step.ok);
  writeFileSync(join(out, "result.json"), JSON.stringify({ steps, sessionId }, null, 2));
  console.log(failed.length ? `${failed.length} check(s) failed` : `All ${steps.length} checks passed`);
  process.exitCode = failed.length ? 1 : 0;
} finally {
  socket?.close();
  if (!args.keep) {
    // Obsidian can linger after SIGTERM; make sure the test instance is gone.
    const exited = new Promise((done) => obsidian.once("exit", done));
    obsidian.kill("SIGTERM");
    const timer = setTimeout(() => obsidian.kill("SIGKILL"), 5_000);
    await exited;
    clearTimeout(timer);
  } else {
    console.log(`Obsidian left running (pid ${obsidian.pid}); vault at ${vault}`);
  }
}
