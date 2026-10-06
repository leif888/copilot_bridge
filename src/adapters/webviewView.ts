import * as vscode from 'vscode';
import { runTurn } from '../core/agent';
import { resolveModel } from '../core/model';
import { NO_MODEL_MESSAGE, SYSTEM_PROMPT } from '../core/prompt';
import { Session } from '../core/session';
import {
  isWebviewToHost,
  type AgentEvent,
  type RenderedMessage,
  type WebviewToHost,
} from '../protocol';
import type { AgentSink } from './sink';

export const VIEW_ID = 'copilotBridge.panel';

/**
 * Standalone assistant panel.
 *
 * Two VS Code behaviours shape this class:
 *
 * 1. A sidebar webview view is **disposed every time it is hidden**. So the
 *    render transcript is kept here and replayed on `ready`, otherwise the
 *    conversation would vanish whenever the user glances at another view.
 * 2. Disposal must **not** cancel the in-flight turn, for the same reason.
 */
export class ChatWebviewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private readonly session = new Session(SYSTEM_PROMPT);
  private inflight: vscode.CancellationTokenSource | undefined;
  /** Render-side transcript, replayed whenever the view is re-resolved. */
  private rendered: RenderedMessage[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: vscode.OutputChannel,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.log.appendLine('[panel] view resolved');
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')],
    };
    view.webview.html = this.renderHtml(view.webview);

    // If the webview bundle is missing from disk the panel silently degrades to
    // static HTML, which looks like "nothing works". Check and say so.
    void this.checkAssets();

    view.webview.onDidReceiveMessage((raw: unknown) => {
      if (!isWebviewToHost(raw)) {
        this.log.appendLine(`[panel] ignored unrecognized message: ${JSON.stringify(raw)}`);
        return;
      }
      this.log.appendLine(`[panel] <- ${raw.t}`);
      void this.handle(raw);
    });

    view.onDidDispose(() => {
      this.log.appendLine('[panel] view disposed (hidden or closed) — turn keeps running');
      this.view = undefined;
    });
  }

  private async checkAssets(): Promise<void> {
    for (const name of ['webview.js', 'webview.css']) {
      const uri = vscode.Uri.joinPath(this.context.extensionUri, 'dist', name);
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        this.log.appendLine(`[panel] asset ${name} present (${stat.size} bytes)`);
      } catch {
        this.log.appendLine(`[panel] ASSET MISSING: ${uri.fsPath} — the build did not run`);
      }
    }
  }

  private post(event: AgentEvent): void {
    if (!this.view) {
      // The view is hidden; `rendered` still holds the transcript for replay.
      return;
    }
    void this.view.webview.postMessage(event);
  }

  private async handle(msg: WebviewToHost): Promise<void> {
    switch (msg.t) {
      case 'ready':
        this.post({ t: 'restore', messages: this.rendered });
        break;
      case 'reset':
        this.session.reset();
        this.rendered = [];
        break;
      case 'cancel':
        this.inflight?.cancel();
        break;
      case 'submit':
        await this.run(msg.requestId, msg.prompt);
        break;
    }
  }

  private async run(requestId: string, prompt: string): Promise<void> {
    if (this.inflight) {
      this.post({
        t: 'error',
        requestId,
        error: { code: 'Unknown', message: 'A request is already in flight. Cancel it first.' },
      });
      this.post({ t: 'done', requestId });
      return;
    }

    this.post({ t: 'start', requestId });
    this.rendered.push({ role: 'user', text: prompt });

    const model = await resolveModel();
    if (!model) {
      this.log.appendLine('[panel] no Copilot model available');
      this.post({ t: 'error', requestId, error: { code: 'NotFound', message: NO_MODEL_MESSAGE } });
      this.rendered.push({ role: 'error', text: NO_MODEL_MESSAGE });
      this.post({ t: 'done', requestId });
      return;
    }

    const cts = new vscode.CancellationTokenSource();
    this.inflight = cts;

    let accumulated = '';
    let failureMessage: string | undefined;

    const sink: AgentSink = {
      text: (delta) => {
        accumulated += delta;
        this.post({ t: 'text', requestId, delta });
      },
      progress: (message) => this.post({ t: 'progress', requestId, message }),
      toolStart: (callId, name, input) =>
        this.post({ t: 'toolStart', requestId, callId, name, input }),
      toolEnd: (callId, ok) => this.post({ t: 'toolEnd', requestId, callId, ok }),
      error: (error) => {
        failureMessage = error.message;
        this.log.appendLine(`[panel] model error ${error.code}: ${error.message}`);
        this.post({ t: 'error', requestId, error });
      },
      done: () => this.post({ t: 'done', requestId }),
    };

    try {
      await runTurn({ model, session: this.session, prompt, sink, token: cts.token });
    } catch (err) {
      // runTurn handles model failures itself; reaching here means a bug in our code.
      this.log.appendLine(`[panel] unexpected failure: ${String(err)}`);
      this.post({ t: 'error', requestId, error: { code: 'Unknown', message: String(err) } });
      this.post({ t: 'done', requestId });
    } finally {
      if (failureMessage !== undefined) {
        this.rendered.push({ role: 'error', text: failureMessage });
      } else if (accumulated.length > 0) {
        this.rendered.push({ role: 'assistant', text: accumulated });
      }
      cts.dispose();
      if (this.inflight === cts) {
        this.inflight = undefined;
      }
    }
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = createNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js'),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.css'),
    );

    // `default-src 'none'` plus an explicit allowlist: the panel renders model
    // output, which is untrusted text and must never reach a remote origin.
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}' ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>Copilot Bridge</title>
</head>
<body>
  <header class="bar">
    <span class="title">Copilot Bridge</span>
    <span id="status" class="status"></span>
    <button id="reset" class="ghost" type="button" title="Clear conversation">Clear</button>
  </header>

  <main id="log" class="log" aria-live="polite"></main>

  <div class="composer">
    <textarea id="input" rows="3" placeholder="Ask something...  (Enter to send, Shift+Enter for a new line)"></textarea>
    <div class="actions">
      <button id="cancel" class="ghost" type="button" hidden>Stop</button>
      <button id="send" type="button">Send</button>
    </div>
  </div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function createNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}
