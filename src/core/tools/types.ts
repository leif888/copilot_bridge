import type * as vscode from 'vscode';

/** Everything a tool is allowed to know about the turn it runs in. */
export interface ToolContext {
  readonly token: vscode.CancellationToken;
}

/** What a tool hands back once it succeeds. */
export interface ToolResult {
  /** Result text, passed to the model verbatim. */
  readonly content: string;
  /** One-line, human-facing summary for the UI. */
  readonly summary: string;
}

/**
 * A tool implemented inside this extension.
 *
 * These are "private tools" in Language Model API terms: they are passed to
 * `sendRequest` through `options.tools` and invoked here directly, so they need
 * no `languageModelTools` contribution and no registry round-trip. That is only
 * appropriate for tools that need no confirmation — the write and terminal
 * tools in M6/M7 must go through `lm.registerTool` + `lm.invokeTool` so that
 * `prepareInvocation`'s confirmation UI applies.
 */
export interface LocalTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  /**
   * Best-effort one-line label for the UI, e.g. `readFile src/core/agent.ts`.
   * Must never throw: it runs before the input has been validated.
   */
  describe(input: unknown): string;
  /**
   * Run the tool. Throw {@link ToolError} for a problem the model should read
   * and correct; throw anything else only for a genuine bug.
   */
  run(input: unknown, context: ToolContext): Promise<ToolResult>;
}

/**
 * A tool failure that the model is expected to see and recover from — a missing
 * file, a bad argument, a path outside the workspace. These are handed back as
 * ordinary tool results rather than aborting the turn, because "the path was
 * wrong, try another" is a normal step in a tool-calling loop.
 */
export class ToolError extends Error {}
