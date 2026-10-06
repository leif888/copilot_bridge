import type { AgentErrorPayload } from '../protocol';

/** A tool call that is about to run. */
export interface ToolStartInfo {
  readonly callId: string;
  readonly name: string;
  /** One-line, human-facing description, e.g. `readFile src/core/agent.ts`. */
  readonly label: string;
}

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
  /** Report transient progress, e.g. "reading 3 files...". */
  progress(message: string): void;
  /** A tool call is about to run. */
  toolStart(info: ToolStartInfo): void;
  /**
   * A tool call finished. `summary` describes the result, e.g.
   * `lines 1-120 of 320`, or the failure reason when `ok` is false.
   */
  toolEnd(callId: string, ok: boolean, summary: string): void;
  /** The turn failed. Always terminal — `done` will not follow. */
  error(error: AgentErrorPayload): void;
  /** The turn completed successfully. */
  done(): void;
}
