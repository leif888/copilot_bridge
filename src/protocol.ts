/**
 * Wire contract shared by the extension host and the webview bundle.
 *
 * This module must stay free of `vscode` imports — the webview bundle is built
 * for the browser and cannot resolve them. Everything here is plain,
 * structured-clone-safe data (no class instances, no functions).
 */

/** Mirrors `vscode.LanguageModelError.code`, plus a local `Cancelled`. */
export type AgentErrorCode =
  | 'NoPermissions'
  | 'Blocked'
  | 'NotFound'
  | 'Cancelled'
  | 'Unknown';

export interface AgentErrorPayload {
  readonly code: AgentErrorCode;
  readonly message: string;
}

/**
 * A finished message, as rendered in the panel.
 *
 * `tool` is a one-line record of a tool call. It is part of the transcript
 * rather than a transient decoration so that a re-resolved view replays the
 * work the assistant did, not just its prose.
 */
export interface RenderedMessage {
  readonly role: 'user' | 'assistant' | 'tool' | 'error';
  readonly text: string;
}

/** Extension host -> webview. */
export type AgentEvent =
  | { readonly t: 'start'; readonly requestId: string }
  | { readonly t: 'text'; readonly requestId: string; readonly delta: string }
  | { readonly t: 'progress'; readonly requestId: string; readonly message: string }
  | {
      readonly t: 'toolStart';
      readonly requestId: string;
      readonly callId: string;
      readonly label: string;
    }
  | {
      readonly t: 'toolEnd';
      readonly requestId: string;
      readonly callId: string;
      readonly ok: boolean;
      readonly summary: string;
    }
  | { readonly t: 'error'; readonly requestId: string; readonly error: AgentErrorPayload }
  | { readonly t: 'done'; readonly requestId: string }
  /**
   * Rebuild the panel from scratch. Sent on `ready`, which happens on first
   * render *and* every time VS Code re-resolves the view — sidebar views are
   * disposed whenever they are hidden, which would otherwise wipe the
   * conversation.
   */
  | { readonly t: 'restore'; readonly messages: readonly RenderedMessage[] };

/** Webview -> extension host. */
export type WebviewToHost =
  | { readonly t: 'ready' }
  | { readonly t: 'submit'; readonly requestId: string; readonly prompt: string }
  | { readonly t: 'cancel'; readonly requestId: string }
  | { readonly t: 'reset' };

/**
 * Runtime guard for messages crossing the webview boundary. `onDidReceiveMessage`
 * is typed `any`, so nothing else validates this shape for us.
 */
export function isWebviewToHost(value: unknown): value is WebviewToHost {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const t = (value as { t?: unknown }).t;
  return t === 'ready' || t === 'submit' || t === 'cancel' || t === 'reset';
}
