import * as vscode from 'vscode';
import type { AgentErrorCode } from '../protocol';

/**
 * Every model request in this extension must go through the `copilot` vendor so
 * that VS Code — not this extension — owns authentication, enterprise policy,
 * content exclusion and usage attribution. Never call Copilot endpoints directly.
 */
export const COPILOT_VENDOR = 'copilot';

/** Select the Copilot-backed chat models currently available to this window. */
export async function selectCopilotModels(): Promise<vscode.LanguageModelChat[]> {
  return vscode.lm.selectChatModels({ vendor: COPILOT_VENDOR });
}

/**
 * Cached first available model. The set of models changes over time (sign-in,
 * seat changes, policy), so this is invalidated via `onDidChangeChatModels`.
 */
let cachedModel: vscode.LanguageModelChat | undefined;

/** Resolve a usable model, or `undefined` when none is available. */
export async function resolveModel(): Promise<vscode.LanguageModelChat | undefined> {
  if (cachedModel) {
    return cachedModel;
  }
  const models = await selectCopilotModels();
  cachedModel = models[0];
  return cachedModel;
}

/** Drop the cached model and re-query on the next turn. */
export function invalidateModelCache(): void {
  cachedModel = undefined;
}

/** Wire model-cache invalidation into the extension lifecycle. */
export function registerModelTracking(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.lm.onDidChangeChatModels(() => invalidateModelCache()));
}

/** Describe a model for diagnostics and logs. */
export function describeModel(model: vscode.LanguageModelChat): string {
  return `id=${model.id} vendor=${model.vendor} family=${model.family} version=${model.version} maxInputTokens=${model.maxInputTokens}`;
}

/** A serializable snapshot of a LanguageModelError, safe to log or post to a webview. */
export interface ModelFailure {
  readonly code: AgentErrorCode;
  readonly message: string;
  readonly cause?: string;
}

/**
 * Normalize any thrown value into a ModelFailure. `LanguageModelError.code` is
 * the error *name* (`NoPermissions` / `Blocked` / `NotFound` / `Unknown`).
 */
export function toModelFailure(err: unknown): ModelFailure {
  if (err instanceof vscode.LanguageModelError) {
    return {
      code: asAgentErrorCode(err.code),
      message: err.message,
      ...(err.cause ? { cause: String(err.cause) } : {}),
    };
  }
  if (err instanceof Error) {
    return { code: 'Unknown', message: err.message };
  }
  return { code: 'Unknown', message: String(err) };
}

function asAgentErrorCode(code: string): AgentErrorCode {
  switch (code) {
    case 'NoPermissions':
    case 'Blocked':
    case 'NotFound':
      return code;
    default:
      return 'Unknown';
  }
}

/** User-facing guidance for a failed model call. */
export function explainFailure(failure: ModelFailure): string {
  switch (failure.code) {
    case 'NoPermissions':
      return 'Not authorized to use the Copilot model. Run "GitHub Copilot: Sign In" and retry, or check whether enterprise policy permits this model.';
    case 'Blocked':
      return 'The request was blocked — usually a quota or rate limit. Retry later, or check your Copilot subscription.';
    case 'NotFound':
      return 'The selected model is no longer available. Reselect a model and retry.';
    case 'Cancelled':
      return 'Request cancelled.';
    default:
      return `Model call failed: ${failure.message}`;
  }
}
