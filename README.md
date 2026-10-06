# Copilot Bridge

A personal AI assistant for VS Code, backed by GitHub Copilot through the
`vscode.lm` Language Model API.

All model access goes through VS Code with `vendor: 'copilot'`. This extension
never calls Copilot endpoints directly, so authentication, enterprise policy,
content exclusion, and usage attribution stay owned by VS Code.

## Requirements

- VS Code 1.133.0 or newer
- A GitHub Copilot seat, signed in

## Setup

```bash
npm install
npm run build
```

Then press **F5** to launch an Extension Development Host.

`dist/` is a build artifact and is **not committed**. Every machine needs its
own `npm install` + build.

## Entry points

- **Panel**: the Copilot Bridge icon in the activity bar.
- **Chat participant**: `@bridge` inside the Copilot Chat panel.

Both share one agent core; only the rendering adapter differs.

## Tools

The assistant answers from the workspace, not from memory. It has four
**read-only** tools and calls them on its own:

| Tool | Purpose |
| --- | --- |
| `readFile` | Read a file, with line numbers. `startLine`/`endLine` window a long file. |
| `listDirectory` | List a directory's entries. |
| `findFiles` | Find files by glob, e.g. `**/*.test.ts`. |
| `findText` | Search file contents, returned as `path:line: text`. |

There are no write or terminal tools yet — the model is told to say so rather
than pretend. Those arrive in M6/M7, where they must go through
`lm.registerTool` so that VS Code's own confirmation UI covers both entry
points.

Every path is resolved against the workspace and anything outside it is
refused. That check is the whole security model for this milestone: tool
results go straight into the model context, so without it a prompt injected
from a file in the workspace could talk the model into reading `~/.ssh/id_rsa`
into the transcript.

The loop is bounded on five independent axes — 12 iterations, 40 tool calls,
3 repeated identical calls, a 5 minute budget, and a size cap per tool result —
because a model can run away without ever tripping any single one of them.

## Commands

| Command | Purpose |
| --- | --- |
| `Copilot Bridge: Open assistant panel` | Focus the sidebar panel |
| `Copilot Bridge: Ping model` | Verify model access end to end |

## Troubleshooting

Start with the **Output panel → "Copilot Bridge"** channel. It logs activation,
panel messages, model resolution, and model errors.

**The panel shows "Build output missing".**
`dist/webview.js` is not on disk. Run `npm run build`, then
`Developer: Reload Window`.

**The panel is inert and the header shows no `● ready`.**
The webview script did not execute. Check the log for missing assets, then open
`Developer: Open Webview Developer Tools` and read the Console.

**A change to `esbuild.mjs` does not take effect.**
VS Code keeps background tasks alive across launches, so an `npm: watch` task
started before the change keeps running with the old configuration — it will
rebuild `extension.js` but never produce new outputs. Restart it via
`Tasks: Restart Running Task`, or terminate the task and press F5 again.

**"No Copilot model is available".**
Run `Copilot Bridge: Ping model` to see how many models were found. Zero means
you are not signed in, have no seat, or enterprise policy is blocking it.

**The assistant answers without touching any file.**
Not every model drives tools well. The panel shows a line per tool call as it
happens, so an answer with no tool lines means the model chose not to look —
ask it to check the file explicitly.

**"Stopped after 12 tool rounds" or similar.**
A guard rail fired. The answer is incomplete on purpose: the alternative is a
loop that burns your quota. Narrow the question and retry.

## Project layout

```
src/
  protocol.ts          wire contract shared by both bundles (no vscode imports)
  extension.ts         activation, commands
  core/                extension-host only; may import vscode
    agent.ts           the turn runner: tool-calling loop and its guard rails
    session.ts         model history
    model.ts           model selection, error mapping
    prompt.ts          system prompt
    paths.ts           workspace containment for every model-supplied path
    tools/             the tool catalogue
      types.ts         LocalTool contract
      input.ts         defensive argument reading
      fs.ts            file-system helpers and shared limits
      readTools.ts     readFile, listDirectory, findFiles, findText
  adapters/
    sink.ts            AgentSink: the single core <-> UI boundary
    chatParticipant.ts AgentSink -> ChatResponseStream
    webviewView.ts     AgentSink -> postMessage; owns the view provider
  webview/             browser bundle; must never import vscode
```

## Milestones

M1 connectivity, M2 panel, M3 chat participant, M4 agent loop and read tools —
done.
M5 reuse built-in tools, M6 writes with confirmation and diffs, M7 terminal
execution, M8 hardening.

## Deviating from the original plan

Two things changed once the actual API was checked:

- **`workspace.findTextInFiles` no longer exists.** Content search is done by
  listing candidates with `findFiles`, then reading and scanning them, with caps
  on candidate count, file size and results. M5 should revisit whether the
  built-in `copilot_findTextInFiles` is faster and safe to delegate to.
- **Read tools are private, not registered.** Tools that need no confirmation
  can be passed straight to `sendRequest` and invoked in-process, which skips a
  registry round-trip. Only tools that must confirm — the M6/M7 writes and
  terminal — need `lm.registerTool`.
