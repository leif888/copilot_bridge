import * as vscode from 'vscode';
import type { AgentSink } from '../adapters/sink';
import { explainFailure, toModelFailure } from './model';
import type { Session } from './session';

export interface TurnRequest {
  readonly model: vscode.LanguageModelChat;
  readonly session: Session;
  readonly prompt: string;
  readonly sink: AgentSink;
  readonly token: vscode.CancellationToken;
}

/**
 * Run one assistant turn.
 *
 * Milestone state: text-only. The tool-calling loop (collect
 * `LanguageModelToolCallPart`s, invoke, feed back an Assistant message carrying
 * the call followed by a User message carrying the result) lands in M4 — this
 * function is the seam it grows from, which is why the request/commit split
 * already lives in `Session` rather than here.
 */
export async function runTurn(req: TurnRequest): Promise<void> {
  const { model, session, prompt, sink, token } = req;

  const messages = session.beginTurn(prompt);

  let text = '';
  try {
    const response = await model.sendRequest(
      messages,
      { justification: 'Copilot Bridge — 结合当前工作区回答用户问题。' },
      token,
    );

    for await (const part of response.stream) {
      if (token.isCancellationRequested) {
        break;
      }
      if (part instanceof vscode.LanguageModelTextPart) {
        text += part.value;
        sink.text(part.value);
      }
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

  // Partial output from a cancelled turn is still useful context for the next
  // one, so commit whatever arrived rather than discarding it.
  if (text.length > 0) {
    session.endTurn(text);
  } else {
    session.abortTurn();
  }
  sink.done();
}
