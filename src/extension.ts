import * as vscode from 'vscode';
import { registerChatParticipant } from './adapters/chatParticipant';
import { ChatWebviewProvider, VIEW_ID } from './adapters/webviewView';
import {
  describeModel,
  explainFailure,
  registerModelTracking,
  selectCopilotModels,
  toModelFailure,
} from './core/model';

const OUTPUT_CHANNEL_NAME = 'Copilot Bridge';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  context.subscriptions.push(output);
  output.appendLine(`[activate] Copilot Bridge on VS Code ${vscode.version}`);

  registerModelTracking(context);

  // Entry point 1: `@bridge` inside the existing Copilot Chat panel.
  registerChatParticipant(context);

  // Entry point 2: standalone sidebar panel.
  const provider = new ChatWebviewProvider(context);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(VIEW_ID, provider));

  context.subscriptions.push(
    vscode.commands.registerCommand('copilotBridge.open', async () => {
      await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    }),
    vscode.commands.registerCommand('copilotBridge.ping', () => runPing(context, output)),
  );
}

export function deactivate(): void {
  // All resources are held in context.subscriptions.
}

/**
 * Connectivity check. Kept from M1 — it is the fastest way to tell whether a
 * problem is "no Copilot model" versus "our code".
 *
 * `sendRequest` may only run in response to a user action, so this is wired to a
 * command rather than to activation.
 */
async function runPing(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
): Promise<void> {
  output.show(true);
  output.appendLine('');
  output.appendLine('[ping] ── connectivity check ──────────────────────────');

  const models = await selectCopilotModels();
  if (models.length === 0) {
    output.appendLine('[ping] ✗ selectChatModels({ vendor: "copilot" }) returned no models.');
    output.appendLine('[ping]   请确认:已登录 GitHub Copilot,且账号已分配 Copilot 席位。');
    void vscode.window.showErrorMessage(
      'Copilot Bridge: 未找到 Copilot 模型。请先登录 GitHub Copilot 并确认账号有席位。',
    );
    return;
  }

  output.appendLine(`[ping] ✓ found ${models.length} model(s):`);
  for (const model of models) {
    output.appendLine(`[ping]   - ${describeModel(model)}`);
  }

  const model = models[0];
  if (!model) {
    return;
  }

  const canSend = context.languageModelAccessInformation.canSendRequest(model);
  output.appendLine(`[ping] canSendRequest=${String(canSend)}`);

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Copilot Bridge: pinging model…' },
    async () => {
      try {
        const response = await model.sendRequest(
          [vscode.LanguageModelChatMessage.User('Reply with exactly one word: pong')],
          { justification: 'Copilot Bridge connectivity check' },
        );

        output.append('[ping] stream: ');
        let text = '';
        for await (const part of response.stream) {
          if (part instanceof vscode.LanguageModelTextPart) {
            text += part.value;
            output.append(part.value);
          } else if (part instanceof vscode.LanguageModelToolCallPart) {
            output.append(`<tool-call:${part.name}>`);
          }
        }
        output.appendLine('');
        output.appendLine(
          text.trim().length > 0
            ? '[ping] ✓ streaming OK.'
            : '[ping] ⚠ stream completed but produced no text.',
        );
      } catch (err) {
        const failure = toModelFailure(err);
        output.appendLine(`[ping] ✗ ${failure.code}: ${failure.message}`);
        if (failure.cause) {
          output.appendLine(`[ping]   cause: ${failure.cause}`);
        }
        void vscode.window.showErrorMessage(`Copilot Bridge: ${explainFailure(failure)}`);
      }
    },
  );
}
