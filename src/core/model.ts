import * as vscode from 'vscode';

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

/** Describe a model for diagnostics and logs. */
export function describeModel(model: vscode.LanguageModelChat): string {
  return `id=${model.id} vendor=${model.vendor} family=${model.family} version=${model.version} maxInputTokens=${model.maxInputTokens}`;
}

/** A serializable snapshot of a LanguageModelError, safe to log or post to a webview. */
export interface ModelFailure {
  code: string;
  message: string;
  cause?: string;
}

/**
 * Normalize any thrown value into a ModelFailure. `LanguageModelError.code` is the
 * error *name* (`NoPermissions` / `Blocked` / `NotFound` / `Unknown`), per vscode.d.ts.
 */
export function toModelFailure(err: unknown): ModelFailure {
  if (err instanceof vscode.LanguageModelError) {
    return {
      code: err.code,
      message: err.message,
      ...(err.cause ? { cause: String(err.cause) } : {}),
    };
  }
  if (err instanceof Error) {
    return { code: 'Unknown', message: err.message };
  }
  return { code: 'Unknown', message: String(err) };
}

/** User-facing guidance for a failed model call. */
export function explainFailure(failure: ModelFailure): string {
  switch (failure.code) {
    case 'NoPermissions':
      return '未获得使用 Copilot 模型的授权。请运行 "GitHub Copilot: Sign In" 后重试,或检查企业策略是否允许此模型。';
    case 'Blocked':
      return '请求被阻止 —— 通常是配额或速率限制。稍后重试,或检查 Copilot 订阅状态。';
    case 'NotFound':
      return '所选模型已不可用。可能需要重新选择模型。';
    default:
      return `模型调用失败:${failure.message}`;
  }
}
