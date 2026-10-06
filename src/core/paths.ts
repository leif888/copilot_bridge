import * as path from 'node:path';
import * as vscode from 'vscode';
import { ToolError } from './tools/types';

/**
 * Resolve a model-supplied path and refuse anything outside the workspace.
 *
 * This matters more than it looks. Tool results are fed straight into the model
 * context, so without a containment check a prompt injected from a file in the
 * workspace could talk the model into reading `~/.ssh/id_rsa` or
 * `~/.aws/credentials` and printing it into the transcript. The workspace
 * boundary is the whole security model here.
 *
 * Known gap: symbolic links are not resolved, so a link inside the workspace
 * that points outside it still passes. Reads only, for now; M6 revisits this
 * before any tool gains the ability to write.
 */
export function resolveInsideWorkspace(input: string): vscode.Uri {
  const primary = vscode.workspace.workspaceFolders?.[0];
  if (!primary) {
    throw new ToolError('No workspace folder is open, so there is nothing to read.');
  }
  const folders = vscode.workspace.workspaceFolders ?? [];

  // The model may hand back either the workspace-relative path it was given or
  // the absolute path it saw in an earlier tool result; both must land on the
  // same file.
  const target = path.isAbsolute(input)
    ? path.resolve(input)
    : path.resolve(primary.uri.fsPath, input);

  for (const folder of folders) {
    if (isInside(folder.uri.fsPath, target)) {
      return vscode.Uri.file(target);
    }
  }

  throw new ToolError(
    `"${input}" is outside the workspace, which this tool is not allowed to read.`,
  );
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), target);
  if (relative === '') {
    return true;
  }
  if (path.isAbsolute(relative)) {
    return false; // different drive or UNC share
  }
  // `path.relative` is case-insensitive on Windows, which is what we want here.
  return relative !== '..' && !relative.startsWith(`..${path.sep}`);
}
