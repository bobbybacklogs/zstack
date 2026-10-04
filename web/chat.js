/**
 * The chat pages: the conversation list and one conversation.
 *
 * A chat lives on the server now, so this module holds no state: it renders
 * what the server returns and reports clicks back to the router, which owns
 * every request. That split is what lets a conversation survive a reload and be
 * opened from anywhere, and it keeps the one source of truth on the server.
 *
 * Nothing from a model is parsed as HTML. The renderer sets `textContent`, and
 * so does this module, because model output is untrusted and this process can
 * start commands.
 */

import { el, clear, relativeTime, renderIcon } from './render.js';

/** Free models are marked in the picker; the name is the only signal there is. */
export function modelLabel(id) {
  return /free/i.test(id) ? `${id} · free` : id;
}

function messageCountLabel(count) {
  return `${count} message${count === 1 ? '' : 's'}`;
}

/**
 * One message block.
 *
 * Exported because the router patches a single message in place while it
 * streams: re-rendering the whole page on every token would rebuild the
 * transcript and reset scroll, which is exactly what a streaming cursor is
 * meant to avoid.
 */
export function renderChatMessage(message, options = {}) {
  const { onContinue, onSelect, selected } = options;
  const role = message.role === 'user' ? 'user' : 'assistant';
  const meta = [];
  if (role === 'assistant') {
    if (message.model) meta.push(message.model);
    if (Number.isFinite(message.tokens) && message.tokens > 0) {
      meta.push(`${message.tokens.toLocaleString('en-US')} tok`);
    }
    if (Number.isFinite(message.durationMs) && message.durationMs > 0) {
      meta.push(`${(message.durationMs / 1000).toFixed(1)}s`);
    }
  }
  if (message.at) meta.push(relativeTime(message.at));

  const body = message.content && message.content !== ''
    ? message.content
    : (message.streaming ? 'Thinking…' : '(empty reply)');

  const headChildren = [
    el('span', { class: 'chat__msg-role', text: role === 'user' ? 'You' : 'Model' }),
    meta.length > 0 ? el('span', { class: 'chat__msg-meta', text: meta.join(' · ') }) : null
  ];
  if (role === 'user' && onContinue) {
    headChildren.push(
      el('button', {
        class: 'btn btn--xs chat__msg-action',
        type: 'button',
        text: 'Continue as run',
        title: 'Open run composer pre-filled with this message',
        onClick: (e) => {
          e.stopPropagation();
          onContinue(message);
        }
      })
    );
  }

  return el('div', {
    class: `chat__msg chat__msg--${role}${selected ? ' chat__msg--selected' : ''}`,
    dataset: { id: message.id },
    onClick: role === 'user' && onSelect ? () => onSelect(message.id) : null
  }, [
    el('div', { class: 'chat__msg-head' }, headChildren),
    el('div', {
      class: `chat__msg-body${message.streaming ? ' streaming' : ''}`,
      text: body
    }),
    message.error ? el('div', { class: 'chat__msg-error', text: message.error }) : null
  ]);
}

/** The conversation list. */
export function renderChatList({ chats, onOpen, onNew }) {
  const wrap = el('div', { class: 'page page--wide' }, [
    el('header', { class: 'page__header' }, [
      el('div', { class: 'page__icon-box' }, [renderIcon('chat', 'page__header-icon')]),
      el('div', { class: 'page__badge' }, [el('span', { class: 'chip chip--neutral', text: 'chats' })]),
      el('h1', { class: 'page__title', text: 'Chats' }),
      el('div', { class: 'page__meta', text: 'Conversations with a pinned model. Kept on this machine, not in run history.' })
    ]),
    el('div', { style: 'margin:18px 0' }, [
      el('button', { class: 'btn btn--primary', type: 'button', text: 'New chat', onClick: onNew })
    ])
  ]);

  const list = (chats || []).slice().sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  if (list.length === 0) {
    wrap.append(el('div', { class: 'empty' }, [
      el('h2', { text: 'No chats yet' }),
      el('p', { text: 'Start one, pin a model, and talk. Free models work.' })
    ]));
    return wrap;
  }

  wrap.append(el('div', { class: 'list' }, list.map((chat) =>
    el('button', {
      class: 'card',
      type: 'button',
      dataset: { id: chat.id },
      onClick: () => onOpen(chat.id)
    }, [
      el('div', { class: 'card__title', text: chat.title || 'New chat' }),
      el('div', { class: 'card__side' }, [
        el('span', { text: relativeTime(chat.updatedAt) })
      ]),
      el('div', { class: 'card__sub' }, [
        chat.model ? el('span', { class: 'mono', text: chat.model }) : el('span', { text: 'no model pinned' }),
        el('span', { text: messageCountLabel(chat.messageCount || 0) })
      ])
    ])
  )));
  return wrap;
}

/**
 * One conversation: header, the transcript, and the composer.
 *
 * The composer stays enabled only while a model is pinned and no turn is in
 * flight. A streaming reply is a real message in `chat.messages` with
 * `streaming: true`, so the transcript has one shape whether the answer is
 * arriving or finished.
 */
export function renderChatPage(chat, listing = {}, handlers = {}) {
  const { onSend, onStop, onPin, onRename, onDelete, onContinueAsRun } = handlers;
  const models = Array.isArray(listing.models) ? listing.models : [];
  const pending = chat.pending === true;
  const messages = Array.isArray(chat.messages) ? chat.messages : [];
  let selectedMessageId = null;

  const select = el('select', { class: 'chat__pin', name: 'model', disabled: pending }, [
    el('option', { value: '', text: models.length === 0 ? 'No models available' : 'Pin a model…' })
  ]);
  for (const id of models) {
    select.append(el('option', { value: id, text: modelLabel(id), selected: id === chat.model }));
  }
  if (chat.model && !models.includes(chat.model)) {
    select.append(el('option', {
      value: chat.model,
      text: `${chat.model} (not in the current catalogue)`,
      selected: true
    }));
  }
  select.addEventListener('change', () => onPin?.(select.value));

  const userMessages = messages.filter((m) => m.role === 'user');

  const metaParts = [chat.model ? `Pinned to ${chat.model}` : 'No model pinned yet.'];
  if (chat.projectId) metaParts.push(`Project: ${chat.projectId}`);

  const header = el('header', { class: 'page__header' }, [
    el('div', { class: 'page__icon-box' }, [renderIcon('chat', 'page__header-icon')]),
    el('div', { class: 'page__badge' }, [
      el('span', { class: 'chip chip--neutral', text: 'chat' }),
      el('span', { class: 'chip', text: messageCountLabel(messages.length) })
    ]),
    el('h1', { class: 'page__title', text: chat.title || 'New chat' }),
    el('div', {
      class: 'page__meta',
      text: metaParts.join(' · ')
    })
  ]);

  const continueRunBtn = onContinueAsRun
    ? el('button', {
      class: 'btn',
      type: 'button',
      text: 'Continue as run',
      disabled: pending || userMessages.length === 0,
      title: userMessages.length === 0
        ? 'No user messages to continue from'
        : 'Open run composer pre-filled with this conversation',
      onClick: () => {
        if (userMessages.length === 0) return;
        const target = selectedMessageId
          ? userMessages.find((m) => m.id === selectedMessageId) || userMessages[userMessages.length - 1]
          : userMessages[userMessages.length - 1];
        onContinueAsRun(target, chat);
      }
    })
    : null;

  const controls = el('div', { class: 'chat__controls' }, [
    el('div', { class: 'field' }, [
      el('label', { text: 'Pinned model' }),
      select,
      el('div', {
        class: 'field__hint',
        text: listing.connected === false
          ? `The bridge is unreachable, so the catalogue is empty. ${listing.error || ''}`.trim()
          : 'One model for the whole conversation. Free models are marked.'
      })
    ]),
    el('div', { class: 'chat__controls-actions' }, [
      continueRunBtn,
      onRename
        ? el('button', { class: 'btn', type: 'button', text: 'Rename', disabled: pending, onClick: () => onRename() })
        : null,
      onDelete
        ? el('button', { class: 'btn btn--danger', type: 'button', text: 'Delete', disabled: pending, onClick: () => onDelete() })
        : null
    ])
  ]);

  const log = el('div', { class: 'chat__log' });

  function renderMessages() {
    clear(log);
    if (messages.length === 0) {
      log.append(el('div', { class: 'empty', style: 'margin:0' }, [
        el('h2', { text: 'Nothing said yet' }),
        el('p', {
          text: chat.model
            ? 'Ask anything. This is a plain conversation: no tools, no workspace, nothing written to run history.'
            : 'Pin a model above, then ask anything.'
        })
      ]));
    } else {
      for (const message of messages) {
        log.append(renderChatMessage(message, {
          selected: message.id === selectedMessageId,
          onContinue: onContinueAsRun ? (msg) => onContinueAsRun(msg, chat) : null,
          onSelect: message.role === 'user' ? (msgId) => {
            selectedMessageId = selectedMessageId === msgId ? null : msgId;
            renderMessages();
          } : null
        }));
      }
    }
  }

  renderMessages();

  const textarea = el('textarea', {
    class: 'chat__input',
    rows: 3,
    placeholder: chat.model ? `Message ${chat.model}` : 'Pin a model first',
    disabled: pending || !chat.model
  });
  const sendButton = el('button', {
    class: `btn ${pending ? 'btn--danger' : 'btn--primary'}`,
    type: 'button',
    text: pending ? 'Stop' : 'Send'
  });

  const submit = () => {
    if (pending) return;
    const text = textarea.value.trim();
    if (text === '') {
      textarea.focus();
      return;
    }
    onSend?.(text);
  };
  sendButton.addEventListener('click', () => (pending ? onStop?.() : submit()));
  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  });

  const composer = el('div', { class: 'chat__composer' }, [
    textarea,
    el('div', { class: 'chat__composer-foot' }, [
      sendButton,
      el('span', { class: 'hint' }, [
        el('span', { class: 'kbd', text: 'Enter' }),
        ' to send, ',
        el('span', { class: 'kbd', text: 'Shift' }),
        '+',
        el('span', { class: 'kbd', text: 'Enter' }),
        ' for a new line'
      ])
    ])
  ]);

  if (!pending && chat.model) setTimeout(() => textarea.focus(), 0);

  return el('div', { class: 'page page--chat' }, [header, controls, log, composer]);
}

/** Start a conversation: pick the model it will be pinned to. */
export function renderNewChatDialog({ models = [], projects = [], listing = {}, onClose, onSubmit }) {
  const select = el('select', { name: 'model' }, models.map((id, index) =>
    el('option', { value: id, text: modelLabel(id), selected: index === 0 })
  ));
  if (models.length === 0) {
    select.append(el('option', { value: '', text: 'No models available' }));
  }
  const projectSelect = el('select', { name: 'project' }, [
    el('option', { value: '', text: 'No project' }),
    ...(projects || []).map((p) => el('option', { value: p.id, text: `${p.name} — ${p.dir}` }))
  ]);
  const problem = el('div', { class: 'composer__warning' });
  const submit = el('button', { class: 'btn btn--primary', type: 'button', text: 'Start chat' });

  const save = async () => {
    if (!select.value) {
      problem.textContent = listing.connected === false
        ? `The bridge is unreachable, so no model can be pinned. ${listing.error || ''}`.trim()
        : 'Pick a model to pin.';
      return;
    }
    submit.disabled = true;
    problem.textContent = '';
    try {
      await onSubmit({ model: select.value, projectId: projectSelect.value || undefined });
    } catch (err) {
      submit.disabled = false;
      problem.textContent = err.problems ? err.problems.join(' ') : err.message;
    }
  };
  submit.addEventListener('click', save);

  const box = el('div', { class: 'composer', onClick: (e) => e.stopPropagation() }, [
    el('div', { class: 'composer__head', text: 'New chat' }),
    el('div', { class: 'composer__controls' }, [
      el('div', { class: 'field' }, [
        el('label', { text: 'Pinned model' }),
        select,
        el('div', { class: 'field__hint' }, 'One model for the whole conversation. You can change it later.')
      ]),
      el('div', { class: 'field' }, [
        el('label', { text: 'Project' }),
        projectSelect,
        el('div', { class: 'field__hint' }, 'Optional workspace project for this chat.')
      ]),
      problem
    ]),
    el('div', { class: 'composer__foot' }, [
      submit,
      el('span', { class: 'hint' }, [
        el('span', { class: 'kbd', text: 'Esc' }),
        ' to close'
      ]),
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn', type: 'button', text: 'Cancel', onClick: onClose })
    ])
  ]);

  const overlay = el('div', { class: 'overlay', onClick: onClose }, [box]);
  overlay.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') onClose();
  });
  setTimeout(() => select.focus(), 0);
  return overlay;
}

/** Rename a chat. An empty title restores the derived one. */
export function renderRenameChatDialog({ chat, onClose, onSubmit }) {
  const input = el('input', { type: 'text', name: 'title', placeholder: chat.title || 'A name for this chat' });
  const problem = el('div', { class: 'composer__warning' });
  const submit = el('button', { class: 'btn btn--primary', type: 'button', text: 'Rename chat' });

  const save = async () => {
    submit.disabled = true;
    problem.textContent = '';
    try {
      await onSubmit({ title: input.value.trim() });
    } catch (err) {
      submit.disabled = false;
      problem.textContent = err.problems ? err.problems.join(' ') : err.message;
    }
  };
  submit.addEventListener('click', save);

  const box = el('div', { class: 'composer', onClick: (e) => e.stopPropagation() }, [
    el('div', { class: 'composer__head', text: 'Rename chat' }),
    el('div', { class: 'composer__controls' }, [
      el('div', { class: 'field' }, [
        el('label', { text: 'Title' }),
        input,
        el('div', { class: 'field__hint' }, 'Leave empty to name it after the first message again.')
      ]),
      problem
    ]),
    el('div', { class: 'composer__foot' }, [
      submit,
      el('span', { class: 'hint' }, [el('span', { class: 'kbd', text: 'Esc' }), ' to close']),
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn', type: 'button', text: 'Cancel', onClick: onClose })
    ])
  ]);

  const overlay = el('div', { class: 'overlay', onClick: onClose }, [box]);
  overlay.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') onClose();
  });
  setTimeout(() => {
    input.focus();
    input.select();
  }, 0);
  return overlay;
}
