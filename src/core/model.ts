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
      return '未获得使用 Copilot 模型的授权。请运行 "GitHub Copilot: Sign In" 后重试,或检查企业策略是否允许此模型。';
    case 'Blocked':
      return '请求被阻止 —— 通常是配额或速率限制。稍后重试,或检查 Copilot 订阅状态。';
    case 'NotFound':
      return '所选模型已不可用,可能需要重新选择模型。';
    case 'Cancelled':
      return '请求已取消。';
    default:
      return `模型调用失败:${failure.message}`;
  }
}
