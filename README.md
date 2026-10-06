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

## Project layout

```
src/
  protocol.ts          wire contract shared by both bundles (no vscode imports)
  extension.ts         activation, commands
  core/                extension-host only; may import vscode
    agent.ts           the turn runner; the tool-calling loop lands here in M4
    session.ts         model history
    model.ts           model selection, error mapping
    prompt.ts          system prompt
  adapters/
    sink.ts            AgentSink: the single core <-> UI boundary
    chatParticipant.ts AgentSink -> ChatResponseStream
    webviewView.ts     AgentSink -> postMessage; owns the view provider
  webview/             browser bundle; must never import vscode
```

## Milestones

M1 connectivity, M2 panel, M3 chat participant — done.
M4 agent loop and read tools, M5 reuse built-in tools, M6 writes with
confirmation and diffs, M7 terminal execution, M8 hardening.
