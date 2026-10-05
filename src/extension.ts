import * as vscode from 'vscode';
import {
  describeModel,
  explainFailure,
  selectCopilotModels,
  toModelFailure,
} from './core/model';

const OUTPUT_CHANNEL_NAME = 'Copilot Bridge';

/**
 * M1: prove that `vscode.lm` can reach a Copilot-backed model end-to-end.
 *
 * This milestone intentionally has no UI and no tools. It verifies the three
 * preconditions everything else depends on:
 *   1. `selectChatModels({ vendor: 'copilot' })` returns a model
 *   2. the user consent dialog can be satisfied
 *   3. streaming responses work
 *
 * `sendRequest` may only run in response to a user action, so this is wired to a
 * command rather than to activation.
 */
export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  context.subscriptions.push(output);

  output.appendLine(`[activate] Copilot Bridge on VS Code ${vscode.version}`);

  context.subscriptions.push(
    vscode.commands.registerCommand('copilotBridge.ping', () => runPing(context, output)),
  );
}

export function deactivate(): void {
  // All resources are held in context.subscriptions.
}

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

  // Precheck consent without triggering the dialog (undefined == not yet asked).
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
            ? '[ping] ✓ streaming OK — M1 verified, Copilot model access works.'
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
