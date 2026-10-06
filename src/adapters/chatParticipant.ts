import * as vscode from 'vscode';
import { runTurn } from '../core/agent';
import { resolveModel } from '../core/model';
import { NO_MODEL_MESSAGE, SYSTEM_PROMPT } from '../core/prompt';
import { Session } from '../core/session';
import type { AgentSink } from './sink';

export const PARTICIPANT_ID = 'copilotBridge.assistant';

/**
 * `ChatResponseStream.markdown()` appends a new markdown chunk per call.
 * Streaming raw token deltas would repeatedly hand VS Code malformed markdown
 * (an unterminated code fence renders mid-stream as garbage), so buffer and
 * flush only at a safe boundary: a newline, or once the buffer grows past
 * FLUSH_THRESHOLD characters.
 */
class MarkdownFlusher {
  private static readonly FLUSH_THRESHOLD = 240;
  private buffer = '';

  constructor(private readonly stream: vscode.ChatResponseStream) {}

  push(delta: string): void {
    this.buffer += delta;
    if (this.buffer.length >= MarkdownFlusher.FLUSH_THRESHOLD || this.buffer.includes('\n')) {
      this.flush();
    }
  }

  flush(): void {
    if (this.buffer.length > 0) {
      this.stream.markdown(this.buffer);
      this.buffer = '';
    }
  }
}

/**
 * Register the `@bridge` participant inside the existing Copilot Chat panel.
 *
 * The handler runs in response to a user message, which is what satisfies the
 * Language Model API rule that `sendRequest` is only called from a user action.
 */
export function registerChatParticipant(
  context: vscode.ExtensionContext,
  log: vscode.OutputChannel,
): vscode.ChatParticipant {
  // ChatRequest carries no conversation id, so we keep one rolling session and
  // treat "empty history" as the signal that the user started a new chat.
  //
  // Known limitation: two chat sessions open at once will share this transcript.
  let session = new Session(SYSTEM_PROMPT);

  const participant = vscode.chat.createChatParticipant(
    PARTICIPANT_ID,
    async (request, chatContext, stream, token) => {
      log.appendLine(`[chat] @bridge <- ${request.prompt.slice(0, 80)}`);

      if (chatContext.history.length === 0) {
        session = new Session(SYSTEM_PROMPT);
      }

      const model = await resolveModel();
      if (!model) {
        log.appendLine('[chat] no Copilot model available');
        stream.markdown(NO_MODEL_MESSAGE);
        return;
      }

      const flusher = new MarkdownFlusher(stream);
      const sink: AgentSink = {
        text: (delta) => flusher.push(delta),
        progress: (message) => stream.progress(message),
        toolStart: () => {
          /* wired up in M4 */
        },
        toolEnd: () => {
          /* wired up in M4 */
        },
        error: (err) => {
          log.appendLine(`[chat] model error ${err.code}: ${err.message}`);
          flusher.flush();
          stream.markdown(`\n\n**Error** (${err.code}): ${err.message}`);
        },
        done: () => flusher.flush(),
      };

      await runTurn({ model, session, prompt: request.prompt, sink, token });
    },
  );

  participant.iconPath = new vscode.ThemeIcon('comment-discussion');
  context.subscriptions.push(participant);
  return participant;
}
