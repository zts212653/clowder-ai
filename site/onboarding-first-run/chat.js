/* Message rows and composer typing, shared by the scripted demo and the real first chat.
 * Structure mirrors packages/web/src/components/ChatMessage.tsx: avatar, name, bubble;
 * cats on the left, the user on the right. */
((root) => {
  const C = root.OnbClock;
  const Cats = root.OnbCats;

  const ICON = {
    chat: '<path d="M4 5h16v11H8l-4 4V5z"/>',
    planet: '<circle cx="12" cy="12" r="6"/><path d="M3 15c3 2 15-2 18-6"/>',
    memory:
      '<path d="M9 4a3 3 0 0 0-3 3v1a3 3 0 0 0 0 6v1a3 3 0 0 0 6 0V4H9zM15 4a3 3 0 0 1 3 3v1a3 3 0 0 1 0 6v1a3 3 0 0 1-6 0"/>',
    collective: '<circle cx="8" cy="9" r="3"/><circle cx="16" cy="9" r="3"/><circle cx="12" cy="16" r="3"/>',
    mission: '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4"/>',
    signal: '<path d="M5 21V4h11l-2 4 2 4H5"/>',
    members:
      '<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3 3-5 6-5s6 2 6 5"/><circle cx="17" cy="9" r="2.5"/><path d="M16 15c3 0 5 2 5 5"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3"/>',
    cat: '<path d="M5 20V9l3-5 2 4h4l2-4 3 5v11z"/><circle cx="9.5" cy="13" r=".8"/><circle cx="14.5" cy="13" r=".8"/>',
    palette: '<path d="M12 3a9 9 0 1 0 0 18c1 0 1.5-1 1-2s0-2 1.5-2H17a4 4 0 0 0 4-4c0-5-4-10-9-10z"/>',
    settings:
      '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/>',
    send: '<path d="M4 12l16-8-6 16-2-7z"/>',
  };
  const icon = (name) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;

  /** Append a message row. Cat avatars start hidden so a running cat can land in them. */
  function addMessage(list, { from, cat, label, pending = false }) {
    const row = document.createElement('div');
    const me = from === 'user';
    row.className = `msg${me ? ' me' : ''}`;
    if (!me) row.dataset.cat = cat;
    const avatar = document.createElement('div');
    avatar.className = `avatar${me ? ' me' : ''}${pending ? ' pending' : ''}`;
    if (me) avatar.textContent = 'ME';
    else Cats.paintAvatar(avatar, cat);
    const body = document.createElement('div');
    body.className = 'body';
    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = me ? '你' : label || Cats.META[cat].name;
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    body.append(who, bubble);
    if (me) row.append(body, avatar);
    else row.append(avatar, body);
    list.appendChild(row);
    requestAnimationFrame(() => row.classList.add('shown'));
    list.scrollTop = list.scrollHeight;
    return { row, avatar, bubble };
  }

  /** Stream text into an element a few characters at a time; html segments land whole. */
  async function stream(el, parts, run, cps = 28) {
    el.classList.add('caret');
    try {
      for (const part of parts) {
        if (part.html) {
          el.insertAdjacentHTML('beforeend', part.html);
          await C.wait(120, run);
          continue;
        }
        for (const ch of part) {
          el.append(ch);
          await C.wait(1000 / cps, run);
        }
      }
    } finally {
      el.classList.remove('caret');
    }
  }

  async function typeInto(textarea, text, run, cps = 16) {
    textarea.value = '';
    for (const ch of text) {
      textarea.value += ch;
      await C.wait(1000 / cps, run);
    }
  }

  root.OnbChat = { icon, addMessage, stream, typeInto };
})(window);
