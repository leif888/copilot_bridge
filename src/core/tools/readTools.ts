import * as vscode from 'vscode';
import { resolveInsideWorkspace } from '../paths';
import {
  DEFAULT_EXCLUDE,
  MAX_SCAN_BYTES,
  decodeUtf8,
  displayPath,
  looksBinary,
  readTextFile,
  splitLines,
  stat,
} from './fs';
import {
  booleanOr,
  boundedInteger,
  optionalInteger,
  optionalString,
  requireString,
} from './input';
import { ToolError, type LocalTool, type ToolResult } from './types';

/** Lines returned when the model does not ask for a window. */
const DEFAULT_READ_LINES = 400;
/** Ceiling on one `readFile` call, so a windowed read cannot be used to fetch a whole file. */
const MAX_READ_LINES = 2000;
const MAX_DIR_ENTRIES = 500;
const MAX_FIND_FILES = 200;
const MAX_FIND_TEXT_RESULTS = 100;
/** Files `findText` will open before giving up. */
const MAX_SCAN_FILES = 1500;
/** Characters of a matched line echoed back — enough to judge relevance. */
const MAX_MATCH_LINE_CHARS = 200;

const readFileTool: LocalTool = {
  name: 'readFile',
  description:
    'Read a text file from the workspace. Lines are returned with their 1-based line numbers so you can cite them. For a long file, read a window with startLine/endLine rather than the whole thing.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Workspace-relative path, e.g. "src/core/agent.ts".',
      },
      startLine: {
        type: 'integer',
        description: 'First line to return, 1-based. Defaults to 1.',
      },
      endLine: {
        type: 'integer',
        description: 'Last line to return, 1-based and inclusive. Defaults to the end of the file.',
      },
    },
    required: ['path'],
    additionalProperties: false,
  },

  describe(input: unknown): string {
    const target = optionalString(input, 'path') ?? '(no path)';
    const start = optionalInteger(input, 'startLine');
    const end = optionalInteger(input, 'endLine');
    const window = start !== undefined || end !== undefined ? `:${start ?? 1}-${end ?? ''}` : '';
    return `readFile ${target}${window}`;
  },

  async run(input: unknown): Promise<ToolResult> {
    const requested = requireString(input, 'path');
    const uri = resolveInsideWorkspace(requested);
    const display = displayPath(uri);
    const lines = splitLines(await readTextFile(uri, display));
    const total = lines.length;

    if (total === 0) {
      return { content: `${display} is empty.`, summary: 'empty file' };
    }

    const start = optionalInteger(input, 'startLine') ?? 1;
    if (start < 1) {
      throw new ToolError(`"startLine" must be 1 or greater, got ${start}.`);
    }
    if (start > total) {
      throw new ToolError(`${display} has ${total} line(s); startLine ${start} is past the end.`);
    }

    const explicitEnd = optionalInteger(input, 'endLine');
    const requestedEnd = explicitEnd ?? total;
    if (requestedEnd < start) {
      throw new ToolError(`"endLine" (${requestedEnd}) must be greater than or equal to startLine (${start}).`);
    }
    const wantsWindow = explicitEnd !== undefined || optionalInteger(input, 'startLine') !== undefined;

    // An explicit window is allowed to be large; a whole-file read is trimmed
    // to a screenful so that one call cannot flood the context.
    const ceiling = wantsWindow ? MAX_READ_LINES : DEFAULT_READ_LINES;

    // Clamp to the file and to that ceiling, then tell the model when either
    // clamp bit — a silently short answer would read as a complete one.
    const end = Math.min(requestedEnd, total);
    const clipped = end > start + ceiling - 1;
    const last = clipped ? start + ceiling - 1 : end;

    const body: string[] = [`${display} (lines ${start}-${last} of ${total})`];
    for (let n = start; n <= last; n++) {
      body.push(`${n}\t${lines[n - 1] ?? ''}`);
    }
    if (clipped) {
      body.push(`[stopped at ${ceiling} lines; continue with startLine=${last + 1}]`);
    } else if (end < total) {
      body.push(`[${total - end} more line(s) below]`);
    }

    return { content: body.join('\n'), summary: `lines ${start}-${last} of ${total}` };
  },
};

const listDirectoryTool: LocalTool = {
  name: 'listDirectory',
  description:
    'List the entries of a directory in the workspace. Directories are marked with a trailing slash.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Workspace-relative directory. Defaults to the workspace root.',
      },
    },
    additionalProperties: false,
  },

  describe(input: unknown): string {
    return `listDirectory ${optionalString(input, 'path') ?? '.'}`;
  },

  async run(input: unknown): Promise<ToolResult> {
    const requested = optionalString(input, 'path');
    const uri = requested === undefined ? workspaceRoot() : resolveInsideWorkspace(requested);
    const display = requested === undefined ? '.' : displayPath(uri);

    const info = await stat(uri);
    if (!info) {
      throw new ToolError(`${display} does not exist.`);
    }
    if (!(info.type & vscode.FileType.Directory)) {
      throw new ToolError(`${display} is not a directory. Use readFile instead.`);
    }

    const entries = await vscode.workspace.fs.readDirectory(uri);
    if (entries.length === 0) {
      return { content: `${display} is empty.`, summary: 'empty directory' };
    }

    // Directories first, then alphabetical: the shape a human would print.
    entries.sort(([aName, aType], [bName, bType]) => {
      const aDir = (aType & vscode.FileType.Directory) !== 0;
      const bDir = (bType & vscode.FileType.Directory) !== 0;
      if (aDir !== bDir) {
        return aDir ? -1 : 1;
      }
      return aName.localeCompare(bName);
    });

    const shown = entries.slice(0, MAX_DIR_ENTRIES);
    const body = shown.map(([name, type]) =>
      (type & vscode.FileType.Directory) !== 0 ? `${name}/` : name,
    );
    if (entries.length > shown.length) {
      body.push(`[${entries.length - shown.length} more entries not shown]`);
    }

    return {
      content: `${display} (${entries.length} entries)\n${body.join('\n')}`,
      summary: `${entries.length} entries`,
    };
  },
};

const findFilesTool: LocalTool = {
  name: 'findFiles',
  description:
    'Find files in the workspace by glob pattern, e.g. "**/*.test.ts" or "src/**/agent.*". Returns workspace-relative paths.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Glob pattern matched against workspace-relative paths.',
      },
      maxResults: {
        type: 'integer',
        description: `Maximum paths to return. Defaults to ${MAX_FIND_FILES}, and may not exceed it.`,
      },
    },
    required: ['pattern'],
    additionalProperties: false,
  },

  describe(input: unknown): string {
    return `findFiles ${optionalString(input, 'pattern') ?? '(no pattern)'}`;
  },

  async run(input: unknown, context): Promise<ToolResult> {
    const pattern = requireString(input, 'pattern');
    const limit = boundedInteger(input, 'maxResults', 1, MAX_FIND_FILES, MAX_FIND_FILES);

    const found = await searchFiles(pattern, limit, context.token);
    if (found.length === 0) {
      return { content: `No files match "${pattern}".`, summary: 'no matches' };
    }

    const body = found.map(displayPath).sort((a, b) => a.localeCompare(b));
    if (found.length >= limit) {
      body.push(`[stopped at the ${limit} file limit; the pattern may match more]`);
    }
    return { content: body.join('\n'), summary: `${found.length} file(s)` };
  },
};

const findTextTool: LocalTool = {
  name: 'findText',
  description:
    'Search file contents in the workspace and return matching lines as path:line: text. Cheaper than reading whole files, so prefer it for locating code.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Text to search for.' },
      isRegex: {
        type: 'boolean',
        description: 'Treat query as a JavaScript regular expression. Defaults to false (literal text).',
      },
      caseSensitive: { type: 'boolean', description: 'Defaults to false.' },
      include: {
        type: 'string',
        description: 'Glob restricting which files are searched. Defaults to "**/*".',
      },
      maxResults: {
        type: 'integer',
        description: `Maximum matching lines to return. Defaults to ${MAX_FIND_TEXT_RESULTS}, and may not exceed it.`,
      },
    },
    required: ['query'],
    additionalProperties: false,
  },

  describe(input: unknown): string {
    return `findText "${optionalString(input, 'query') ?? ''}"`;
  },

  async run(input: unknown, context): Promise<ToolResult> {
    const query = requireString(input, 'query');
    if (query.length > 200) {
      throw new ToolError('"query" is longer than 200 characters; search for a shorter fragment.');
    }
    const isRegex = booleanOr(input, 'isRegex', false);
    const caseSensitive = booleanOr(input, 'caseSensitive', false);
    const include = optionalString(input, 'include') ?? '**/*';
    const limit = boundedInteger(input, 'maxResults', 1, MAX_FIND_TEXT_RESULTS, MAX_FIND_TEXT_RESULTS);

    const matcher = buildMatcher(query, isRegex, caseSensitive);
    const candidates = await searchFiles(include, MAX_SCAN_FILES, context.token);

    const matches: string[] = [];
    let scanned = 0;
    let skippedLarge = 0;
    let skippedBinary = 0;
    let stoppedEarly = false;

    for (const uri of candidates) {
      if (context.token.isCancellationRequested) {
        stoppedEarly = true;
        break;
      }
      if (matches.length >= limit) {
        stoppedEarly = true;
        break;
      }

      const relative = displayPath(uri);
      const info = await stat(uri);
      if (!info || !(info.type & vscode.FileType.File)) {
        continue;
      }
      if (info.size > MAX_SCAN_BYTES) {
        skippedLarge++;
        continue;
      }

      let bytes: Uint8Array;
      try {
        bytes = await vscode.workspace.fs.readFile(uri);
      } catch {
        continue; // vanished or unreadable between listing and reading
      }
      if (looksBinary(bytes)) {
        skippedBinary++;
        continue;
      }

      scanned++;
      const lines = splitLines(decodeUtf8(bytes));
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        if (matcher.test(line)) {
          matches.push(`${relative}:${i + 1}: ${line.trim().slice(0, MAX_MATCH_LINE_CHARS)}`);
          if (matches.length >= limit) {
            break;
          }
        }
      }
    }

    if (matches.length === 0) {
      const notes = [
        `No match for "${query}" in ${scanned} file(s) scanned.`,
        skippedLarge > 0 ? `${skippedLarge} file(s) skipped as too large.` : '',
        skippedBinary > 0 ? `${skippedBinary} file(s) skipped as binary.` : '',
      ].filter((line) => line.length > 0);
      return { content: notes.join('\n'), summary: 'no matches' };
    }

    const notes: string[] = [];
    if (stoppedEarly) {
      notes.push(`[stopped early: results are not exhaustive — narrow the query or the include glob]`);
    }
    if (candidates.length >= MAX_SCAN_FILES) {
      notes.push(`[only the first ${MAX_SCAN_FILES} candidate file(s) were considered]`);
    }

    return {
      content: [...matches, ...notes].join('\n'),
      summary: `${matches.length} match(es) in ${scanned} file(s)`,
    };
  },
};

export const READ_TOOLS: readonly LocalTool[] = [
  readFileTool,
  listDirectoryTool,
  findFilesTool,
  findTextTool,
];

function workspaceRoot(): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    throw new ToolError('No workspace folder is open, so there is nothing to read.');
  }
  return folder.uri;
}

/**
 * `workspace.findTextInFiles` was removed from the public API, so content
 * search is done here: list candidates by glob, then read and scan each one.
 * The caps keep a broad query from turning into a full-repository read.
 */
async function searchFiles(
  pattern: string,
  limit: number,
  token: vscode.CancellationToken,
): Promise<vscode.Uri[]> {
  try {
    return await vscode.workspace.findFiles(pattern, DEFAULT_EXCLUDE, limit, token);
  } catch (err) {
    throw new ToolError(`"${pattern}" is not a usable glob pattern: ${String(err)}`);
  }
}

function buildMatcher(query: string, isRegex: boolean, caseSensitive: boolean): RegExp {
  const source = isRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    return new RegExp(source, caseSensitive ? '' : 'i');
  } catch (err) {
    throw new ToolError(`"${query}" is not a valid regular expression: ${String(err)}`);
  }
}
