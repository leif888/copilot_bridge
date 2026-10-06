import type * as vscode from 'vscode';
import { READ_TOOLS } from './readTools';
import type { LocalTool } from './types';

export { ToolError } from './types';
export type { LocalTool, ToolContext, ToolResult } from './types';

/**
 * Every tool this extension offers the model.
 *
 * M4 is read-only by design: these four tools cannot change a single byte, so
 * they need no confirmation and can be invoked directly. The write and terminal
 * tools arrive in M6/M7 and must be registered through `lm.registerTool` so
 * that VS Code's own confirmation UI covers both entry points.
 */
export const ALL_TOOLS: readonly LocalTool[] = [...READ_TOOLS];

/** The schemas handed to `sendRequest`. */
export function toolDefinitions(): vscode.LanguageModelChatTool[] {
  return ALL_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

export function findTool(name: string): LocalTool | undefined {
  return ALL_TOOLS.find((tool) => tool.name === name);
}

export function toolNames(): string {
  return ALL_TOOLS.map((tool) => tool.name).join(', ');
}
