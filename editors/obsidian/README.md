# Omnigent for Obsidian

Use Omnigent from inside Obsidian: browse projects and sessions, chat with
agents, watch an agent's live terminal, answer approvals, and bring your notes
along as context or as the agent's working directory.

Desktop only (macOS, Windows, Linux). The plugin talks to the server through
Node, which mobile Obsidian does not provide.

## Features

| Omnigent desktop | In Obsidian |
|---|---|
| Sidebar: New session, Inbox, Canvas, Projects, Sessions with filter | **Omnigent** sidebar view (ribbon icon or *Omnigent: Open sessions sidebar*). Right-click a session to rename, move to a project, archive, or open its console. Live updates over the server's updates socket. |
| Chat with the agent | Session tab with **Rendered** mode: Obsidian-rendered markdown, collapsible tool calls and reasoning, inline approvals, Stop button. |
| Terminal / native harness TUI | **Console** mode: the session's terminal in xterm.js with GPU rendering (the agent's own `tui` by default, other terminals via the picker). When the agent runs on this computer, the console connects straight to the local runner, as the desktop app does, so keystrokes skip the server round trip; the status line then ends in *direct*. |
| Inbox | **Omnigent inbox** tab: approvals across sessions and unread sessions, grouped by recency. |
| Canvas | *Omnigent: Update session canvases* writes one Obsidian `.canvas` per project (plus `Main`) into the `Omnigent/` folder. Cards link back to the session; positions you move are kept on update. |
| Everything else (settings, files, PRs, forms) | *Open in Omnigent*: embedded web UI for local servers, the browser for hosted ones. |

Vault integration:

- **Notes as context**: `[[Note]]` links in a message, *Add note*, *Add current
  note*, the file menu's *Ask Omnigent about this note*, and the editor
  commands *Ask about current note in a new session* / *Send selection to the
  open session*. Note text is appended to the message (capped by the context
  size setting) and shown as a collapsed *Context* row in the transcript.
- **Vault as workspace**: new sessions run on this computer's host with the
  vault (or a folder in it) as working directory, so agent edits appear in the
  vault immediately.

## Install (from this checkout)

```bash
pnpm install --filter omnigent-obsidian
cd editors/obsidian
pnpm build                      # writes main.js and styles.css
VAULT=~/path/to/your/vault
mkdir -p "$VAULT/.obsidian/plugins/omnigent"
ln -sf "$PWD/main.js" "$PWD/manifest.json" "$PWD/styles.css" "$VAULT/.obsidian/plugins/omnigent/"
```

Then in Obsidian: *Settings → Community plugins → Turn on community plugins*,
enable **Omnigent**, and open its settings.

## Connect to a server

- **Local server**: leave *Server URL* empty. The plugin finds the server
  started by `omnigent server` through `~/.omnigent/local_server.pid`.
- **Hosted server**: set *Server URL* to the API URL, e.g.
  `https://<workspace>.cloud.databricks.com/api/2.0/omnigent`. With
  *Authentication: Automatic* the plugin uses, in order: your `omnigent login`
  session (`~/.omnigent/auth_tokens.json`), then the Databricks CLI
  (`databricks auth token --host <workspace>`) for workspace-hosted servers.
  When several `~/.databrickscfg` profiles point at the workspace, the plugin
  tries them by name (`DATABRICKS_CONFIG_PROFILE` first, then user logins,
  then service principals) and uses the first that yields a token; pin one
  with *Databricks profile*. Run `databricks auth login --host <workspace>`
  once if none works.
  Obsidian started from the Dock does not inherit your shell `PATH`; set
  *Databricks CLI path* if the CLI is not in `/opt/homebrew/bin` or
  `/usr/local/bin`.
- *Access token* mode stores a pasted bearer in the vault's plugin data
  (unencrypted).

For *Vault as workspace* on a hosted server, run `omnigent host` on this
computer. The plugin picks this computer's host from `~/.omnigent/daemons/`;
override it with *Default host ID*.

## Development

```bash
cd editors/obsidian
pnpm dev          # rebuilds main.js / styles.css on change
pnpm type-check
pnpm test         # unit tests (no Obsidian, no server)
```

[pjeby/hot-reload](https://github.com/pjeby/hot-reload) reloads the plugin in a
dev vault whenever `main.js` changes.

### Architecture

```
src/transport   Node http/https + SSE + ws (no CORS, no Origin header)
src/auth        none | omnigent login token | Databricks CLI | pasted token
src/api         typed /v1 client
src/state       SessionsStore (projects, sessions, inbox count; updates socket)
                SessionController (one session: items + snapshot + live stream)
src/ui          Obsidian views: navigator, session, inbox, embedded web UI
src/vault       notes as context, vault as workspace
src/canvas      JSON Canvas generation
```

The plugin bundles the web client's React-free stream and transcript modules
(`web/src/lib/sse.ts`, `itemsToBlocks.ts`, `inbox.ts`, …) so event parsing and
transcript shaping match the web UI exactly, and reuses the VS Code
extension's local-server discovery (`editors/vscode/src/discovery`).

Obsidian's `fetch` is blocked by CORS (the server sends no CORS headers) and
`requestUrl` cannot stream, so all traffic goes through Node. Node sends no
`Origin` header, which the server's local-mode origin check accepts.

## Testing

### Automated tests

| Suite | Needs | Command (in `editors/obsidian`) |
|---|---|---|
| Type check | nothing | `pnpm type-check` |
| Unit | nothing (Obsidian is mocked) | `pnpm test` |
| Integration | a repro env (server, runner, mock LLM) | `OMNIGENT_REPRO_ENV=/tmp/omni-repro pnpm test:integration` |
| End-to-end in Obsidian (macOS) | a repro env, Obsidian in `/Applications` | `pnpm build && node scripts/e2e-obsidian.mjs --env /tmp/omni-repro --out /tmp/omni-obsidian-e2e` |
| Repo lint | `pre-commit` | `pre-commit run --all-files` (repo root) |

Start the repro env from the repo root in a separate terminal and leave it
running while the integration and end-to-end suites run:

```bash
uv run python -m dev.repro_env --output /tmp/omni-repro serve
```

Integration tests cover a chat turn carrying note context (checked at the mock
model), live list updates, project filing and archive, and terminal attach with
a keystroke round-trip.

The end-to-end script starts the installed Obsidian with a throwaway profile
and vault (your own vaults and running Obsidian are untouched), drives the
sidebar, project actions, a chat turn, console mode, the inbox and canvas
generation over the DevTools protocol, and saves screenshots to the output
directory. Add `--keep` to leave the window open.

### Manual test checklist

The automated suites use a mock model and a local server. Check these by hand
against a real server, ideally with the Omnigent desktop app open side by side.
After each `pnpm build`, reload the plugin (*Settings → Community plugins*,
toggle **Omnigent** off and on).

1. **Connect.** Set *Server URL* (or leave it empty for a local server) and
   run *Omnigent: Reconnect to server*. The sidebar lists the same projects
   and sessions as the desktop app. For a hosted server with several
   `~/.databrickscfg` profiles, a wrong *Databricks profile* shows an error
   naming the `databricks auth login` command to run.
2. **Live updates.** Create or rename a session in the desktop app; it
   appears or updates in the sidebar within a few seconds. Type in the filter
   box; the list narrows.
3. **Project actions.** Hover a project row: *New session in project* and
   **⋯** appear. In **⋯**, try *Rename project*, *Move up/down* (the order
   also changes in the desktop app) and *Project settings*: pick an agent,
   this computer as host, *Use this vault*, then *Save*. *New session in
   project* now opens prefilled with those values.
4. **Session actions.** Hover a session row and use **⋯** (or right-click):
   rename, move to a project, archive.
5. **Chat (Rendered).** Open a session, send a message, and watch the reply
   stream in as markdown with collapsible tool calls. *Stop* interrupts a
   running turn.
6. **Notes as context.** Send `Summarize [[Some note]]`, or use *Add note* /
   *Add current note*. The message shows a collapsed *Context* row, and the
   reply refers to the note's content. Also try the file menu's *Ask Omnigent
   about this note* and *Omnigent: Send selection to the open session*.
7. **Console.** Switch the session to **Console**. A Claude Code or Codex
   session shows its live TUI; typing reaches the agent and resizing the pane
   reflows it. For a session whose host is offline, the console shows a hint
   instead of an error.
8. **Vault as workspace.** On a hosted server, run `omnigent host` on this
   computer first. Start a new session with this vault as working directory
   and ask the agent to create `Agent test.md`; the note appears in the vault.
9. **Approvals and inbox.** Trigger a tool approval. It appears inline in the
   session and in *Omnigent: Open inbox* (with a badge on the sidebar);
   approving it in Obsidian clears it in the desktop app too.
10. **Canvas.** Run *Omnigent: Update session canvases*. The `Omnigent/`
    folder gets one `.canvas` per project; clicking a card opens its session.
    Move a card, run the command again, and the card stays where you put it.
11. **Full UI.** *Omnigent: Open full Omnigent* opens the web UI in a tab
    (local server) or in the browser (hosted server).

## Limitations

- Approval prompts that need a form or a URL open the session in the full
  Omnigent UI.
- The rendered transcript shows the newest 200 items; older history is in the
  full Omnigent view.
- File uploads, model/effort selection, and forks are only in the full UI.
- Hosted servers open the full UI in the browser instead of an embedded tab.
