/* Scene 8: the user's own first conversation, and the entrance tour in two placements.
 *
 * The composer is a real textarea and sending really changes state; only the cat's reply
 * is a placeholder, labelled as such. Variant "before" walks through the pinned Members and
 * Keys entries before the user may type; variant "after" lets the user speak first and only
 * offers the tour as a light hint once the cat has answered. */
((root) => {
  const Core = root.OnbCore;
  const C = root.OnbClock;
  const Cats = root.OnbCats;
  const Chat = root.OnbChat;
  const Setup = root.OnbSetup;
  const $ = (id) => document.getElementById(id);

  const SUGGESTION = '帮我看看这个项目的 README，告诉我可以从哪里开始';
  // Two steps only, and only as a reminder. Implementation should drive these from the
  // existing scene guidance engine (F155 guides/flows) instead of a second tour system.
  const TOUR = [
    { target: 'pinMembers', text: '这里是「成员」。之后想邀请更多伙伴，从这里进。' },
    { target: 'pinKeys', text: '这里是「密钥」。换账号、加 API Key 都在这里。' },
  ];

  const lead = (s) => s.members[0];
  const greetingText = (s) =>
    `我是${Cats.META[lead(s).cat].name}，接在 ${Core.CLIENTS[lead(s).client].label} 上。\n想做点什么，直接跟我说。`;

  function renderMessage(list, s, m) {
    if (m.from === 'user') {
      const row = Chat.addMessage(list, { from: 'user' });
      row.bubble.textContent = m.text;
      row.row.dataset.role = 'user-message';
      return row;
    }
    const row = Chat.addMessage(list, { from: 'cat', cat: m.cat, label: Setup.memberLabel(lead(s)) });
    if (m.kind === 'greeting') row.bubble.textContent = greetingText(s);
    else fillReply(row.bubble, s);
    return row;
  }

  function fillReply(bubble, s) {
    bubble.textContent = `收到。这里会是 ${Core.CLIENTS[lead(s).client].label} 上的真实回复。`;
    const note = document.createElement('span');
    note.className = 'proto-note';
    note.textContent = '原型：此处接真实模型';
    bubble.appendChild(note);
  }

  function syncComposer(s) {
    const input = $('input');
    const locked = Core.composerLocked(s);
    input.disabled = locked;
    $('send').disabled = locked;
    $('hint').classList.toggle('hidden', !Core.offerTour(s));
  }

  /** Render scene 8 from state. `arriving` animates the lead cat into its first bubble. */
  async function render(s, run, catsById, { arriving = false, dispatch, getState }) {
    const list = $('messages');
    list.innerHTML = '';
    const input = $('input');
    for (const m of s.messages) {
      const isNewGreeting = arriving && m.kind === 'greeting';
      if (!isNewGreeting) {
        renderMessage(list, s, m);
        continue;
      }
      const row = Chat.addMessage(list, { from: 'cat', cat: m.cat, label: Setup.memberLabel(lead(s)), pending: true });
      const cat = catsById[m.cat];
      if (!run.instant) {
        const r = row.avatar.getBoundingClientRect();
        await Cats.runTo(cat, r.left + 70, r.top + 70, run, 700);
        await Cats.shrinkInto(cat, row.avatar, run);
        await Chat.stream(row.bubble, [greetingText(s)], run);
      } else {
        row.avatar.classList.remove('pending');
        row.bubble.textContent = greetingText(s);
      }
    }
    for (const cat of Object.values(catsById)) cat.el.style.visibility = 'hidden';
    const spoke = s.messages.some((m) => m.from === 'user');
    input.disabled = false;
    if (!spoke && !input.value) input.value = SUGGESTION;
    syncComposer(s);
    if (Core.composerLocked(s)) await tour(run, () => dispatch({ type: 'tourDone' }));
    syncComposer(getState());
    if (!input.disabled) input.focus();
  }

  async function send(getState, dispatch, run) {
    const input = $('input');
    const before = getState();
    dispatch({ type: 'send', text: input.value });
    const s = getState();
    if (s === before) return;
    const list = $('messages');
    renderMessage(list, s, s.messages.at(-1));
    input.value = '';
    const pending = Chat.addMessage(list, { from: 'cat', cat: lead(s).cat, label: Setup.memberLabel(lead(s)) });
    pending.bubble.textContent = 'Thinking...';
    pending.bubble.classList.add('caret');
    await C.wait(900, run).catch(() => {});
    pending.bubble.classList.remove('caret');
    dispatch({ type: 'replied' });
    fillReply(pending.bubble, getState());
    syncComposer(getState());
  }

  /** Spotlight each pinned rail entry in turn. Resolves when the user has seen all of them. */
  async function tour(run, onDone) {
    const spot = $('spot');
    const tip = $('spotTip');
    for (const [i, step] of TOUR.entries()) {
      const r = $(step.target).getBoundingClientRect();
      Object.assign(spot.style, {
        left: `${r.left - 4}px`,
        top: `${r.top - 4}px`,
        width: `${r.width + 8}px`,
        height: `${r.height + 8}px`,
      });
      tip.style.left = `${r.right + 14}px`;
      tip.style.top = `${r.top - 6}px`;
      const last = i === TOUR.length - 1;
      tip.innerHTML = `${step.text}<div class="row"><button class="btn-primary" id="tourNext">${last ? '知道了' : '下一个'}</button></div>`;
      spot.classList.remove('hidden');
      tip.classList.remove('hidden');
      await new Promise((resolve) => $('tourNext').addEventListener('click', resolve, { once: true }));
      if (run.cancelled) break;
    }
    spot.classList.add('hidden');
    tip.classList.add('hidden');
    if (!run.cancelled) onDone();
  }

  root.OnbFirstChat = { render, send, tour, syncComposer, SUGGESTION };
})(window);
