import * as vscode from 'vscode';
import type { AgentSink } from '../adapters/sink';
import { explainFailure, toModelFailure } from './model';
import type { Session } from './session';
import { findTool, toolDefinitions, toolNames } from './tools';
import { ToolError } from './tools/types';

export interface TurnRequest {
  readonly model: vscode.LanguageModelChat;
  readonly session: Session;
  readonly prompt: string;
  readonly sink: AgentSink;
  readonly token: vscode.CancellationToken;
}

/**
 * Runaway protection. One ceiling is not enough — a model can loop without ever
 * hitting any single one of these, so they overlap deliberately.
 */
const MAX_ITERATIONS = 12;
const MAX_TOOL_CALLS = 40;
const MAX_DUPLICATE_CALLS = 3;
const MAX_TURN_MS = 5 * 60_000;
/** Backstop on what one tool may hand back to the model, over each tool's own limits. */
const MAX_RESULT_CHARS = 24_000;

/** Why the loop stopped. Anything other than `reply`/`cancelled` is a ceiling. */
type StopReason =
  | 'reply'
  | 'cancelled'
  | 'iteration-limit'
  | 'call-limit'
  | 'duplicate-limit'
  | 'timeout';

/**
 * Run one assistant turn, including the tool-calling loop.
 *
 * The Language Model API is manual about tool calls: the caller executes the
 * tools itself. The wire protocol is rigid — the call parts must be echoed back
 * verbatim on an **Assistant** message, and only then may the results follow on
 * a **User** message. Reordering, merging or swapping those sides breaks the
 * request, so the two pushes below are kept adjacent and separate on purpose.
 *
 * Milestone state: read-only tools. Writes and terminal execution arrive in
 * M6/M7, where they must be mediated by `lm.invokeTool` so confirmation applies.
 */
export async function runTurn(req: TurnRequest): Promise<void> {
  const { model, session, prompt, sink, token } = req;

  const messages = session.beginTurn(prompt);
  const definitions = toolDefinitions();
  const deadline = Date.now() + MAX_TURN_MS;

  /** Keys of every call made this turn, for duplicate detection. */
  const seen = new Set<string>();
  /** Everything streamed this turn, committed to the session once at the end. */
  let transcript = '';
  let usedCalls = 0;
  let duplicateCalls = 0;
  let reason: StopReason = 'iteration-limit';

  try {
    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      if (token.isCancellationRequested) {
        reason = 'cancelled';
        break;
      }
      if (Date.now() > deadline) {
        reason = 'timeout';
        break;
      }

      const response = await model.sendRequest(
        messages,
        {
          justification: 'Copilot Bridge — answer the user using the current workspace.',
          tools: definitions,
          toolMode: vscode.LanguageModelChatToolMode.Auto,
        },
        token,
      );

      let reply = '';
      const calls: vscode.LanguageModelToolCallPart[] = [];
      for await (const part of response.stream) {
        if (token.isCancellationRequested) {
          break;
        }
        if (part instanceof vscode.LanguageModelTextPart) {
          reply += part.value;
          transcript += part.value;
          sink.text(part.value);
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
          calls.push(part);
        }
      }
      if (token.isCancellationRequested) {
        reason = 'cancelled';
        break;
      }

      // Echo the assistant turn back, calls included, before any result goes out.
      // The text part is omitted when empty rather than sent as a blank part.
      messages.push(
        vscode.LanguageModelChatMessage.Assistant([
          ...(reply.length > 0 ? [new vscode.LanguageModelTextPart(reply)] : []),
          ...calls,
        ]),
      );

      if (calls.length === 0) {
        reason = 'reply';
        break;
      }

      const results: vscode.LanguageModelToolResultPart[] = [];
      let halt: StopReason | undefined;

      for (const call of calls) {
        if (token.isCancellationRequested) {
          reason = 'cancelled';
          break;
        }
        if (++usedCalls > MAX_TOOL_CALLS) {
          halt = 'call-limit';
          break;
        }

        const tool = findTool(call.name);
        sink.toolStart({
          callId: call.callId,
          name: call.name,
          label: `${tool?.describe(call.input) ?? call.name}`,
        });

        const key = callKey(call);
        if (seen.has(key)) {
          duplicateCalls++;
          sink.toolEnd(call.callId, false, 'repeated call skipped');
          if (duplicateCalls >= MAX_DUPLICATE_CALLS) {
            halt = 'duplicate-limit';
            break;
          }
          // A model that repeats itself usually keeps repeating itself. One
          // nudge is worth trying; a pattern is not, hence the ceiling.
          results.push(
            toolResult(
              call.callId,
              'You already called this tool with these exact arguments earlier in this turn. Its result is above — use it, or change the arguments.',
            ),
          );
          continue;
        }
        seen.add(key);

        if (!tool) {
          sink.toolEnd(call.callId, false, 'unknown tool');
          results.push(
            toolResult(
              call.callId,
              `No tool named "${call.name}". Available tools: ${toolNames()}.`,
            ),
          );
          continue;
        }

        try {
          const outcome = await tool.run(call.input, { token });
          sink.toolEnd(call.callId, true, outcome.summary);
          results.push(toolResult(call.callId, clamp(outcome.content)));
        } catch (err) {
          // A tool failure is information for the model, not a dead turn: a
          // wrong path is a normal step in the loop.
          const message =
            err instanceof ToolError ? err.message : `Tool crashed: ${String(err)}`;
          sink.toolEnd(call.callId, false, 'failed');
          results.push(toolResult(call.callId, `Error: ${message}`));
        }
      }

      if (halt) {
        reason = halt;
        break;
      }
      if (reason === 'cancelled' || results.length === 0) {
        break;
      }

      messages.push(vscode.LanguageModelChatMessage.User(results));
    }
  } catch (err) {
    session.abortTurn();
    if (token.isCancellationRequested) {
      sink.done();
      return;
    }
    const failure = toModelFailure(err);
    sink.error({ code: failure.code, message: explainFailure(failure) });
    return;
  }

  // Partial output from a cancelled or cut-short turn is still useful context
  // for the next one, so commit whatever arrived rather than discarding it.
  if (transcript.length > 0) {
    session.endTurn(transcript);
  } else {
    session.abortTurn();
  }

  if (reason === 'reply' || reason === 'cancelled') {
    sink.done();
    return;
  }
  sink.error({ code: 'Unknown', message: stopMessage(reason) });
}

/** Turn-local key: same tool + same arguments means the same answer. */
function callKey(call: vscode.LanguageModelToolCallPart): string {
  return `${call.name}:${stableStringify(call.input)}`;
}

/** JSON with sorted keys, so two structurally equal inputs always key the same. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

function toolResult(callId: string, content: string): vscode.LanguageModelToolResultPart {
  return new vscode.LanguageModelToolResultPart(callId, [new vscode.LanguageModelTextPart(content)]);
}

function clamp(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_RESULT_CHARS)}\n\n[truncated: ${text.length - MAX_RESULT_CHARS} more characters]`;
}

function stopMessage(reason: StopReason): string {
  switch (reason) {
    case 'iteration-limit':
      return `Stopped after ${MAX_ITERATIONS} tool rounds without reaching an answer. Try asking something narrower.`;
    case 'call-limit':
      return `Stopped: this turn exceeded ${MAX_TOOL_CALLS} tool calls.`;
    case 'duplicate-limit':
      return `Stopped: the model repeated the same tool call with identical arguments ${MAX_DUPLICATE_CALLS} times.`;
    case 'timeout':
      return `Stopped: the turn exceeded its ${MAX_TURN_MS / 60_000} minute budget.`;
    default:
      return 'Stopped.';
  }
}
