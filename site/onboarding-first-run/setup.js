/* Scenes 6–7: gather your team, then hand the demo team over to the user's own members.
 *
 * The client list comes from a fixture chosen in the presenter bar, because a static page
 * cannot look at the user's computer. What is real is the gate: "log in" only starts a
 * pending state, and the next step stays disabled until a login actually completes. */
((root) => {
  const Core = root.OnbCore;
  const C = root.OnbClock;
  const Cats = root.OnbCats;
  const $ = (id) => document.getElementById(id);

  const INSTALL = ['Claude Code', 'Codex', 'Kimi Code', 'OpenCode'];

  function clientRow(s, id, dispatch) {
    const c = s.clients[id];
    const meta = Core.CLIENTS[id];
    const row = document.createElement('label');
    row.className = 'client';
    row.dataset.client = id;
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'check';
    box.checked = c.login === 'done' && c.selected;
    box.disabled = c.login !== 'done';
    box.setAttribute('aria-label', `选择 ${meta.label}`);
    box.addEventListener('change', () => dispatch({ type: 'toggle', id }));
    const name = document.createElement('span');
    name.innerHTML = `<span class="name">${meta.label}</span><span class="ver">${meta.version}</span>`;
    const state = document.createElement('span');
    state.className = 'state';
    if (c.login === 'done') {
      state.classList.add('ok');
      state.textContent = '已登录';
    } else if (c.login === 'pending') {
      state.classList.add('pending');
      state.textContent = '等待登录完成…';
      state.title = '请在弹出的终端里完成登录';
    } else {
      const go = document.createElement('button');
      go.type = 'button';
      go.className = 'btn-secondary';
      go.dataset.login = id;
      go.textContent = '去登录';
      go.addEventListener('click', (e) => {
        e.preventDefault();
        dispatch({ type: 'loginStart', id });
      });
      state.appendChild(go);
    }
    row.append(box, name, state);
    return row;
  }

  function why(s) {
    const visible = Core.visibleClients(s);
    if (!visible.length) return '';
    if (visible.some((id) => s.clients[id].login === 'pending')) return '登录完成后，这位伙伴就能选了';
    if (!visible.some((id) => s.clients[id].login === 'done')) return '先登录至少一个客户端';
    if (!Core.canConfirm(s)) return '至少选一位伙伴';
    return `将配置 ${Core.selectedReady(s).length} 位伙伴`;
  }

  /** Render the dialog from state. Called after every dispatch while on setup. */
  function renderSetup(s, dispatch, onRedetect) {
    const dlg = $('setupDialog');
    const visible = Core.visibleClients(s);
    const missing = s.order.filter((id) => !s.clients[id].installed).map((id) => Core.CLIENTS[id].label);
    dlg.innerHTML = `
      <header>
        <h3 id="setupTitle">召集你的团队</h3>
        <p class="sub">我们在你的电脑上找到了这些客户端。每选一个，就配一位伙伴。</p>
        <span class="proto-note">原型：此处接真实探测（#1463），当前为演示数据</span>
      </header>`;
    if (visible.length) {
      const list = document.createElement('div');
      list.className = 'list';
      for (const id of visible) list.appendChild(clientRow(s, id, dispatch));
      dlg.appendChild(list);
    } else {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.id = 'setupEmpty';
      empty.innerHTML = `还没找到可用的客户端。<br>先装一个（比如 ${INSTALL.join('、')}），装好后点「重新检测」，我们就从这里继续，不用重看示范。`;
      dlg.appendChild(empty);
    }
    if (missing.length) {
      const chips = document.createElement('div');
      chips.className = 'chips';
      chips.innerHTML = `未安装：${missing.map((m) => `<span class="chip">${m}</span>`).join('')}`;
      dlg.appendChild(chips);
    }
    const foot = document.createElement('footer');
    foot.innerHTML = `<span class="why" id="setupWhy">${why(s)}</span>`;
    if (!visible.length) {
      const re = document.createElement('button');
      re.type = 'button';
      re.className = 'btn-secondary';
      re.id = 'redetect';
      re.textContent = '重新检测';
      re.addEventListener('click', onRedetect);
      foot.appendChild(re);
    }
    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'btn-primary';
    next.id = 'setupNext';
    next.textContent = '下一步';
    next.disabled = !Core.canConfirm(s);
    next.addEventListener('click', () => dispatch({ type: 'confirm' }));
    foot.appendChild(next);
    dlg.appendChild(foot);
    $('setup').classList.remove('hidden');
  }

  function hideSetup() {
    $('setup').classList.add('hidden');
  }

  const memberLabel = (m) => `${Cats.META[m.cat].name}（${Core.CLIENTS[m.client].label}）`;

  const takePlace = (cat, x, y, run) => (run.instant ? Cats.place(cat, x, y) : Cats.runTo(cat, x, y, run));

  /** Demo partners that were not configured wave and leave; they are not members. */
  function stepBack(cat, y, run) {
    if (run.instant) {
      cat.el.style.visibility = 'hidden';
      return Promise.resolve();
    }
    return Cats.changePose(cat, 'wave', run)
      .then(() => C.wait(700, run))
      .then(() => Cats.runTo(cat, innerWidth + 160, y, run))
      .then(() => {
        cat.el.style.visibility = 'hidden';
      });
  }

  /** Scene 7. The demo team steps back; the user's own members step forward. */
  async function handoff(s, run, catsById) {
    const card = $('handoffCard');
    const [lead, ...rest] = s.members;
    const extra = rest.length ? `${rest.map(memberLabel).join('、')} 也加入了你的团队。` : '之后随时可以邀请更多伙伴。';
    card.innerHTML = `刚才是示范。<br><b>从这里开始，是你自己的伙伴了。</b><small>先从你和${memberLabel(lead)}开始。${extra}</small>`;
    $('handoff').classList.remove('hidden');
    requestAnimationFrame(() => card.classList.add('shown'));
    const ws = document.querySelector('.workspace').getBoundingClientRect();
    const cx = ws.left + ws.width / 2;
    const y = ws.top + ws.height * 0.62;
    const memberCats = new Set(s.members.map((m) => m.cat));
    const moves = Object.entries(catsById).map(([id, cat]) => {
      if (cat.el.style.visibility === 'hidden') Cats.place(cat, ws.right - 80, y);
      return memberCats.has(id)
        ? takePlace(cat, cx + s.members.findIndex((m) => m.cat === id) * 130, y, run)
        : stepBack(cat, y, run);
    });
    await Promise.all(moves);
    if (!run.instant) await C.wait(2200, run);
    card.classList.remove('shown');
    $('handoff').classList.add('hidden');
  }

  root.OnbSetup = { renderSetup, hideSetup, handoff, memberLabel };
})(window);
