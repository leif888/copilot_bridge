import type { AgentErrorPayload } from '../protocol';

/**
 * The single boundary between the agent core and whatever is rendering it.
 *
 * `core/agent.ts` only ever talks to a sink, which is what lets one agent
 * implementation serve both the Copilot Chat participant (mapped onto
 * `ChatResponseStream`) and the standalone webview panel (mapped onto
 * `postMessage`).
 */
export interface AgentSink {
  /** Append streamed assistant text. Deltas arrive in order. */
  text(delta: string): void;
  /** Report transient progress, e.g. "正在读取 3 个文件…". */
  progress(message: string): void;
  /** A tool call is about to run. */
  toolStart(callId: string, name: string, input: unknown): void;
  /** A tool call finished. */
  toolEnd(callId: string, ok: boolean): void;
  /** The turn failed. Always terminal — `done` will not follow. */
  error(error: AgentErrorPayload): void;
  /** The turn completed successfully. */
  done(): void;
}
