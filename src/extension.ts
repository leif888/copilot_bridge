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
  const log = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  context.subscriptions.push(log);
  log.appendLine(`[activate] Copilot Bridge on VS Code ${vscode.version}`);

  registerModelTracking(context);

  // Entry point 1: standalone sidebar panel (M2).
  const provider = new ChatWebviewProvider(context, log);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(VIEW_ID, provider));

  // Entry point 2: `@bridge` inside the existing Copilot Chat panel (M3).
  // Registered defensively and *after* the panel: a problem with the chat API
  // must not take the panel down with it.
  try {
    registerChatParticipant(context, log);
  } catch (err) {
    log.appendLine(`[activate] chat participant registration failed: ${String(err)}`);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('copilotBridge.open', async () => {
      await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    }),
    vscode.commands.registerCommand('copilotBridge.ping', () => runPing(context, log)),
  );
}

export function deactivate(): void {
  // All resources are held in context.subscriptions.
}

/**
 * Connectivity check: the fastest way to tell whether a problem is
 * "no Copilot model" versus "our code".
 *
 * `sendRequest` may only run in response to a user action, so this is wired to a
 * command rather than to activation.
 */
async function runPing(
  context: vscode.ExtensionContext,
  log: vscode.OutputChannel,
): Promise<void> {
  log.show(true);
  log.appendLine('');
  log.appendLine('[ping] -- connectivity check --------------------------');

  const models = await selectCopilotModels();
  if (models.length === 0) {
    log.appendLine('[ping] FAIL: selectChatModels({ vendor: "copilot" }) returned no models.');
    log.appendLine('[ping]       Sign in to GitHub Copilot and confirm the account has a seat.');
    void vscode.window.showErrorMessage(
      'Copilot Bridge: no Copilot model found. Sign in to GitHub Copilot and confirm your account has a seat.',
    );
    return;
  }

  log.appendLine(`[ping] found ${models.length} model(s):`);
  for (const model of models) {
    log.appendLine(`[ping]   - ${describeModel(model)}`);
  }

  const model = models[0];
  if (!model) {
    return;
  }

  const canSend = context.languageModelAccessInformation.canSendRequest(model);
  log.appendLine(`[ping] canSendRequest=${String(canSend)}`);

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Copilot Bridge: pinging model...' },
    async () => {
      try {
        const response = await model.sendRequest(
          [vscode.LanguageModelChatMessage.User('Reply with exactly one word: pong')],
          { justification: 'Copilot Bridge connectivity check' },
        );

        log.append('[ping] stream: ');
        let text = '';
        for await (const part of response.stream) {
          if (part instanceof vscode.LanguageModelTextPart) {
            text += part.value;
            log.append(part.value);
          } else if (part instanceof vscode.LanguageModelToolCallPart) {
            log.append(`<tool-call:${part.name}>`);
          }
        }
        log.appendLine('');
        log.appendLine(
          text.trim().length > 0
            ? '[ping] OK: streaming works.'
            : '[ping] WARN: stream completed but produced no text.',
        );
      } catch (err) {
        const failure = toModelFailure(err);
        log.appendLine(`[ping] FAIL: ${failure.code}: ${failure.message}`);
        if (failure.cause) {
          log.appendLine(`[ping]       cause: ${failure.cause}`);
        }
        void vscode.window.showErrorMessage(`Copilot Bridge: ${explainFailure(failure)}`);
      }
    },
  );
}
