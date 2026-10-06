import './styles.css';
import type { AgentEvent, WebviewToHost } from '../protocol';

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
const composer = mustGet<HTMLFormElement>('composer');
const input = mustGet<HTMLTextAreaElement>('input');
const sendButton = mustGet<HTMLButtonElement>('send');
const cancelButton = mustGet<HTMLButtonElement>('cancel');
const resetButton = mustGet<HTMLButtonElement>('reset');

/** Render-side view model only; the extension host owns the real transcript. */
let active: { requestId: string; body: HTMLElement; text: string } | undefined;
let requestCounter = 0;

function scrollToBottom(): void {
  log.scrollTop = log.scrollHeight;
}

function addMessage(role: 'user' | 'assistant' | 'error', text: string): HTMLElement {
  const wrap = document.createElement('article');
  wrap.className = `msg msg-${role}`;

  const label = document.createElement('div');
  label.className = 'msg-role';
  label.textContent = role === 'user' ? '你' : role === 'assistant' ? '助手' : '错误';

  const body = document.createElement('div');
  body.className = 'msg-body';
  body.textContent = text;

  wrap.append(label, body);
  log.append(wrap);
  scrollToBottom();
  return body;
}

function setBusy(busy: boolean): void {
  sendButton.disabled = busy;
  cancelButton.hidden = !busy;
  input.disabled = busy;
}

function send(): void {
  const prompt = input.value.trim();
  if (!prompt || active) {
    return;
  }

  addMessage('user', prompt);
  input.value = '';
  setBusy(true);

  const requestId = `r${++requestCounter}`;
  active = { requestId, body: addMessage('assistant', ''), text: '' };

  const message: WebviewToHost = { t: 'submit', requestId, prompt };
  vscode.postMessage(message);
}

function handle(event: AgentEvent): void {
  switch (event.t) {
    case 'start':
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
      // Progress is transient: show it in place of the body until real text lands.
      if (active.text.length === 0) {
        active.body.textContent = `_${event.message}_`;
      }
      break;
    }

    case 'toolStart': {
      if (active?.requestId === event.requestId) {
        active.body.textContent = `${active.text}\n[调用工具 ${event.name}…]`;
      }
      break;
    }

    case 'toolEnd':
      break;

    case 'error': {
      const body = addMessage('error', event.error.message);
      if (active?.requestId === event.requestId) {
        body.textContent = `${active.text}\n\n${event.error.message}`;
      }
      break;
    }

    case 'done':
      if (active?.requestId === event.requestId) {
        if (active.text.length === 0) {
          active.body.textContent = '(无输出)';
        } else {
          active.body.textContent = active.text;
        }
        active = undefined;
        setBusy(false);
        input.focus();
      }
      break;
  }
}

composer.addEventListener('submit', (e) => {
  e.preventDefault();
  send();
});

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
