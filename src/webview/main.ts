import './styles.css';
import type { AgentEvent, RenderedMessage, WebviewToHost } from '../protocol';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscode = acquireVsCodeApi();

function mustGet<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`missing element #${id}`);
  }
  return el as T;
}

const log = mustGet<HTMLElement>('log');
const input = mustGet<HTMLTextAreaElement>('input');
const sendButton = mustGet<HTMLButtonElement>('send');
const cancelButton = mustGet<HTMLButtonElement>('cancel');
const resetButton = mustGet<HTMLButtonElement>('reset');
const statusEl = mustGet<HTMLElement>('status');

// Visible proof that this script executed. If the header does not show "ready",
// the bundle never ran and nothing else in this file can be trusted.
statusEl.textContent = 'ready';
statusEl.classList.add('ok');

interface ActiveTurn {
  readonly requestId: string;
  /** The assistant bubble. Tool lines are inserted *before* it. */
  readonly wrap: HTMLElement;
  readonly body: HTMLElement;
  text: string;
}

/** Render-side view model only; the extension host owns the real transcript. */
let active: ActiveTurn | undefined;
let requestCounter = 0;
/** Tool lines still running, so `toolEnd` can complete the right one. */
const toolLines = new Map<string, { element: HTMLElement; label: string }>();

const ROLE_LABEL: Record<RenderedMessage['role'], string> = {
  user: 'You',
  assistant: 'Assistant',
  tool: 'Tool',
  error: 'Error',
};

function scrollToBottom(): void {
  log.scrollTop = log.scrollHeight;
}

function buildMessage(role: RenderedMessage['role'], text: string): { wrap: HTMLElement; body: HTMLElement } {
  const wrap = document.createElement('article');

  if (role === 'tool') {
    wrap.className = 'tool';
    const mark = document.createElement('span');
    mark.className = 'tool-mark';
    const body = document.createElement('span');
    body.className = 'tool-text';
    body.textContent = text;
    wrap.append(mark, body);
    return { wrap, body };
  }

  wrap.className = `msg msg-${role}`;
  const label = document.createElement('div');
  label.className = 'msg-role';
  label.textContent = ROLE_LABEL[role];
  const body = document.createElement('div');
  body.className = 'msg-body';
  body.textContent = text;
  wrap.append(label, body);
  return { wrap, body };
}

/** Append at the end of the log, as a finished message. */
function appendMessage(role: RenderedMessage['role'], text: string): HTMLElement {
  const { wrap, body } = buildMessage(role, text);
  log.append(wrap);
  scrollToBottom();
  return body;
}

function setBusy(busy: boolean): void {
  sendButton.disabled = busy;
  cancelButton.hidden = !busy;
  input.disabled = busy;
}

/** End the current turn, whichever way it ended. Safe to call more than once. */
function finishTurn(): void {
  active = undefined;
  toolLines.clear();
  setBusy(false);
  input.focus();
}

function send(): void {
  const prompt = input.value.trim();
  if (!prompt || active) {
    return;
  }

  appendMessage('user', prompt);
  input.value = '';
  setBusy(true);

  const requestId = `r${++requestCounter}`;
  const { wrap, body } = buildMessage('assistant', '');
  log.append(wrap);
  scrollToBottom();
  active = { requestId, wrap, body, text: '' };

  const message: WebviewToHost = { t: 'submit', requestId, prompt };
  vscode.postMessage(message);
}

function handle(event: AgentEvent): void {
  switch (event.t) {
    case 'start':
      break;

    case 'restore':
      // The view was re-resolved (hidden then shown again). Rebuild from the
      // host's transcript rather than trusting the DOM, which was destroyed.
      log.replaceChildren();
      active = undefined;
      toolLines.clear();
      setBusy(false);
      for (const message of event.messages) {
        appendMessage(message.role, message.text);
      }
      break;

    case 'text': {
      if (active?.requestId !== event.requestId) {
        return;
      }
      active.text += event.delta;
      active.body.textContent = active.text;
      scrollToBottom();
      break;
    }

    case 'progress': {
      if (active?.requestId !== event.requestId) {
        return;
      }
      // Transient: replace the empty placeholder until real text arrives.
      if (active.text.length === 0) {
        active.body.textContent = event.message;
      }
      break;
    }

    case 'toolStart': {
      if (active?.requestId !== event.requestId) {
        return;
      }
      // Inserted before the assistant bubble so the turn reads in the order it
      // happened: tool work first, then the answer that the work produced.
      const { wrap } = buildMessage('tool', `${event.label} …`);
      wrap.classList.add('running');
      log.insertBefore(wrap, active.wrap);
      toolLines.set(event.callId, { element: wrap, label: event.label });
      scrollToBottom();
      break;
    }

    case 'toolEnd': {
      if (active?.requestId !== event.requestId) {
        return;
      }
      const line = toolLines.get(event.callId);
      if (!line) {
        return;
      }
      toolLines.delete(event.callId);
      line.element.classList.remove('running');
      line.element.classList.add(event.ok ? 'done' : 'failed');
      const text = line.element.querySelector('.tool-text');
      if (text) {
        text.textContent = `${line.label} · ${event.summary}`;
      }
      scrollToBottom();
      break;
    }

    case 'error': {
      if (active?.requestId === event.requestId) {
        active.body.textContent =
          active.text.length > 0 ? `${active.text}\n\n${event.error.message}` : event.error.message;
        active.body.closest('.msg')?.classList.add('msg-error');
      } else {
        appendMessage('error', event.error.message);
      }
      // Matches the AgentSink contract: `error` is terminal, `done` will not
      // follow. Reset the busy state here so the panel never gets stuck.
      finishTurn();
      break;
    }

    case 'done': {
      if (active?.requestId !== event.requestId) {
        return;
      }
      if (active.text.length > 0) {
        active.body.textContent = active.text;
      } else {
        // Nothing streamed and no error: say so rather than leaving a blank bubble.
        active.body.textContent = '(no output)';
      }
      finishTurn();
      break;
    }
  }
}

// Deliberately not a <form>: a form would natively submit (and reload the whole
// panel) if this script ever failed to run, destroying the conversation with no
// way to recover. A div plus explicit handlers cannot do that.
sendButton.addEventListener('click', () => send());

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

cancelButton.addEventListener('click', () => {
  if (active) {
    const message: WebviewToHost = { t: 'cancel', requestId: active.requestId };
    vscode.postMessage(message);
  }
});

resetButton.addEventListener('click', () => {
  log.replaceChildren();
  active = undefined;
  toolLines.clear();
  setBusy(false);
  const message: WebviewToHost = { t: 'reset' };
  vscode.postMessage(message);
  input.focus();
});

window.addEventListener('message', (e: MessageEvent<unknown>) => {
  handle(e.data as AgentEvent);
});

setBusy(false);
vscode.postMessage({ t: 'ready' } satisfies WebviewToHost);
