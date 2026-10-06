import * as vscode from 'vscode';

/** Committed user+assistant pairs to retain before trimming the oldest. */
const MAX_TURNS = 30;

/**
 * Model-side conversation history.
 *
 * `ChatRequest` (participant path) exposes no conversation identifier, so the
 * participant adapter keeps one rolling Session and resets it when the chat UI
 * reports empty history. The webview path owns its Session directly.
 *
 * Note on the system prompt: the Language Model API has no System role
 * (`LanguageModelChatMessageRole` is only `User | Assistant`), so standing
 * instructions are folded into the *first* user turn of the conversation rather
 * than sent as a dedicated message.
 */
export class Session {
  private turns: vscode.LanguageModelChatMessage[] = [];
  private hasInstructions = false;
  private pending: { text: string; attached: boolean } | undefined;

  constructor(private readonly systemPrompt: string) {}

  /** Committed user+assistant turns. */
  get turnCount(): number {
    return this.turns.length;
  }

  /**
   * Build the message array for a new user prompt.
   *
   * The turn is not committed until `endTurn` is called, so a failed request
   * never leaves a dangling user turn in the transcript.
   */
  beginTurn(prompt: string): vscode.LanguageModelChatMessage[] {
    const attached = !this.hasInstructions;
    const text = attached ? `${this.systemPrompt}\n\n---\n\n${prompt}` : prompt;
    this.pending = { text, attached };
    return [...this.turns, vscode.LanguageModelChatMessage.User(text)];
  }

  /** Commit the turn after a successful request. */
  endTurn(reply: string): void {
    const turn = this.pending;
    if (!turn) {
      return;
    }
    this.pending = undefined;
    this.turns.push(vscode.LanguageModelChatMessage.User(turn.text));
    this.turns.push(vscode.LanguageModelChatMessage.Assistant(reply));
    if (turn.attached) {
      this.hasInstructions = true;
    }
    this.trim();
  }

  /** Discard the in-flight turn (request failed, produced nothing, or was cancelled). */
  abortTurn(): void {
    this.pending = undefined;
  }

  reset(): void {
    this.turns = [];
    this.hasInstructions = false;
    this.pending = undefined;
  }

  private trim(): void {
    let dropped = false;
    while (this.turns.length > MAX_TURNS * 2) {
      this.turns.shift();
      dropped = true;
    }
    // Instructions only ever live in the very first turn, so any drop loses them.
    // Assume they are gone and let the next turn re-attach them.
    if (dropped) {
      this.hasInstructions = false;
    }
  }
}
