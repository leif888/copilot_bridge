import * as vscode from 'vscode';
import { runTurn } from '../core/agent';
import { resolveModel } from '../core/model';
import { NO_MODEL_MESSAGE, SYSTEM_PROMPT } from '../core/prompt';
import { Session } from '../core/session';
import { isWebviewToHost, type AgentEvent, type WebviewToHost } from '../protocol';
import type { AgentSink } from './sink';

export const VIEW_ID = 'copilotBridge.panel';

/**
 * Standalone assistant panel.
 *
 * The webview holds only a render-side view model; the authoritative transcript
 * lives here in `Session`. The webview never sends history back — it sends a
 * prompt and a request id — which keeps the two sides from drifting apart.
 */
export class ChatWebviewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private readonly session = new Session(SYSTEM_PROMPT);
  private inflight: vscode.CancellationTokenSource | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')],
    };
    view.webview.html = this.renderHtml(view.webview);

    view.webview.onDidReceiveMessage((raw: unknown) => {
      if (isWebviewToHost(raw)) {
        void this.handle(raw);
      }
    });

    view.onDidDispose(() => {
      this.inflight?.cancel();
      this.inflight?.dispose();
      this.inflight = undefined;
      this.view = undefined;
    });
  }

  private post(event: AgentEvent): void {
    void this.view?.webview.postMessage(event);
  }

  private async handle(msg: WebviewToHost): Promise<void> {
    switch (msg.t) {
      case 'ready':
        break;
      case 'reset':
        this.session.reset();
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
        error: { code: 'Unknown', message: '上一个请求仍在进行中,请先取消。' },
      });
      this.post({ t: 'done', requestId });
      return;
    }

    this.post({ t: 'start', requestId });

    const model = await resolveModel();
    if (!model) {
      this.post({ t: 'error', requestId, error: { code: 'NotFound', message: NO_MODEL_MESSAGE } });
      this.post({ t: 'done', requestId });
      return;
    }

    const cts = new vscode.CancellationTokenSource();
    this.inflight = cts;

    // The webview has no chat conversation, so the tool invocation token is
    // meaningless here; built-in tools invoked later will run without an inline
    // chip but still work and still confirm.
    const sink: AgentSink = {
      text: (delta) => this.post({ t: 'text', requestId, delta }),
      progress: (message) => this.post({ t: 'progress', requestId, message }),
      toolStart: (callId, name, input) => this.post({ t: 'toolStart', requestId, callId, name, input }),
      toolEnd: (callId, ok) => this.post({ t: 'toolEnd', requestId, callId, ok }),
      error: (error) => this.post({ t: 'error', requestId, error }),
      done: () => this.post({ t: 'done', requestId }),
    };

    try {
      await runTurn({ model, session: this.session, prompt, sink, token: cts.token });
    } finally {
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

    // No remote origins: the panel renders model output, which is untrusted text.
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="zh-CN">
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
    <button id="reset" class="ghost" type="button" title="清空会话">清空</button>
  </header>

  <main id="log" class="log" aria-live="polite"></main>

  <form id="composer" class="composer">
    <textarea id="input" rows="3" placeholder="问点什么…(Enter 发送,Shift+Enter 换行)"></textarea>
    <div class="actions">
      <button id="cancel" class="ghost" type="button" hidden>停止</button>
      <button id="send" type="submit">发送</button>
    </div>
  </form>

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
