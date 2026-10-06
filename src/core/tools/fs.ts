import * as path from 'node:path';
import * as vscode from 'vscode';
import { ToolError } from './types';

export const MAX_READ_BYTES = 2 * 1024 * 1024;
export const MAX_SCAN_BYTES = 1024 * 1024;

/**
 * Directories `findFiles` and `findText` skip.
 *
 * `workspace.findFiles` honours `files.exclude` but explicitly *not*
 * `search.exclude`, so dependency and build trees have to be excluded by hand
 * or every search wades through `node_modules`.
 */
export const DEFAULT_EXCLUDE =
  '**/{node_modules,.git,.hg,.svn,dist,out,build,coverage,vendor,target,__pycache__,.venv,venv,.next,.nuxt,.cache,.idea,.vscode-test}/**';

/** Workspace-relative, forward-slashed path — the form used for citation. */
export function displayPath(uri: vscode.Uri): string {
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const relative = path.relative(folder.uri.fsPath, uri.fsPath);
    if (relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)) {
      return relative.split(path.sep).join('/');
    }
  }
  return uri.fsPath;
}

/** `stat` that reports "not there" as `undefined` instead of throwing. */
export async function stat(uri: vscode.Uri): Promise<vscode.FileStat | undefined> {
  try {
    return await vscode.workspace.fs.stat(uri);
  } catch {
    return undefined;
  }
}

/** Heuristic: a NUL byte near the start means this is not text. */
export function looksBinary(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 8000);
  for (let i = 0; i < limit; i++) {
    if (bytes[i] === 0) {
      return true;
    }
  }
  return false;
}

export function decodeUtf8(bytes: Uint8Array): string {
  const text = new TextDecoder('utf-8').decode(bytes);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Split on any line ending, dropping the phantom trailing line a final CRLF creates. */
export function splitLines(text: string): string[] {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

/** Read a workspace file as text, refusing directories, binaries and huge files. */
export async function readTextFile(uri: vscode.Uri, display: string): Promise<string> {
  const info = await stat(uri);
  if (!info) {
    throw new ToolError(`${display} does not exist or cannot be read.`);
  }
  if (info.type & vscode.FileType.Directory) {
    throw new ToolError(`${display} is a directory. Use listDirectory instead.`);
  }
  if (info.size > MAX_READ_BYTES) {
    throw new ToolError(
      `${display} is ${info.size} bytes, above the ${MAX_READ_BYTES} byte limit. Use findText to locate the part you need.`,
    );
  }
  const bytes = await vscode.workspace.fs.readFile(uri);
  if (looksBinary(bytes)) {
    throw new ToolError(`${display} looks like a binary file and cannot be read as text.`);
  }
  return decodeUtf8(bytes);
}
