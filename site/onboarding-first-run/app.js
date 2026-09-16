/* Wiring: state, persistence, scene flow, presenter controls.
 *
 * State lives in OnbCore and is saved after every action, so closing and reopening the page
 * resumes at the unfinished step (Core.resume decides where). The presenter bar only
 * simulates what a static page cannot observe — which clients are installed, whether an
 * external login finished — and never bypasses a gate the user would face. */
(() => {
  const Core = window.OnbCore;
  const C = window.OnbClock;
  const Cats = window.OnbCats;
  const Chat = window.OnbChat;
  const Demo = window.OnbDemo;
  const Setup = window.OnbSetup;
  const First = window.OnbFirstChat;
  const $ = (id) => document.getElementById(id);

  const KEY = 'clowder-onboarding-prototype:v1';
  const params = new URLSearchParams(location.search);
  if (params.has('fresh')) localStorage.removeItem(KEY);
  let state = Core.resume(localStorage.getItem(KEY));
  if (params.get('variant')) state = Core.reduce(state, { type: 'variant', value: params.get('variant') });
  let run = C.newRun();
  let devFixture = params.get('fixture') || state.fixture || 'one-ready';
  // ?fresh=1 starts a brand-new journey, so the fixture in the URL is the detection result too.
  if (params.has('fresh')) state = Core.reduce(Core.initial(devFixture), { type: 'variant', value: state.variant });

  const SCENES = [
    ['intro', '1 开场'],
    ['demo', '2–4 示范'],
    ['narrate', '5 解说'],
    ['setup', '6 召集团队'],
    ['handoff', '7 交接'],
    ['chat', '8 第一次交流'],
  ];

  const getState = () => state;
  function persist() {
    localStorage.setItem(KEY, Core.serialize(state));
    window.__onb = state;
    renderLedger();
  }
  function dispatch(action) {
    const prev = state;
    state = Core.reduce(state, action);
    if (state === prev) return;
    persist();
    if (state.stage === 'setup') Setup.renderSetup(state, dispatch, redetect);
    if (prev.stage === 'setup' && state.stage === 'handoff') goHandoff(false);
  }

  function freshRun() {
    run.cancelled = true;
    run = C.newRun();
    C.setPlaying(true);
    Demo.hideCaption();
    Setup.hideSetup();
    for (const id of ['handoff', 'spot', 'spotTip', 'hint']) $(id).classList.add('hidden');
    return run;
  }

  function showShell(mode) {
    const real = mode === 'real' && state.members.length;
    const top = [
      ['chat', '对话', true],
      ['planet', '猫猫星球'],
      ['memory', '记忆'],
      ['collective', 'Collective'],
      ['mission', 'Mission Hub'],
      ['signal', '信号'],
    ];
    const btn = (icon, label, extra = '') =>
      `<button class="rail-btn ${extra}" type="button" title="${label}" aria-label="${label}">${Chat.icon(icon)}</button>`;
    let html = top.map(([i, l, active]) => btn(i, l, active ? 'active' : '')).join('');
    if (real)
      html += `<div class="rail-sep"></div>${btn('members', '成员', 'pin').replace('<button', '<button id="pinMembers"')}${btn('key', '密钥', 'pin').replace('<button', '<button id="pinKeys"')}`;
    html += `<div class="rail-bottom">${btn('cat', '前台猫')}${btn('palette', '主题')}${btn('settings', '设置')}</div>`;
    $('rail').innerHTML = html;
    $('send').innerHTML = Chat.icon('send');
    $('threadTitle').textContent = real ? `和${Cats.META[state.members[0].cat].name}的第一次对话` : '示范对话';
    $('ctx').textContent = real ? Setup.memberLabel(state.members[0]) : '示范 · 不是真实对话';
    $('app').classList.remove('hidden');
    $('stage').classList.add('gone');
  }

  // ---- scene flow ----
  function playIntro() {
    const r = freshRun();
    Demo.intro(r).catch(ignoreCancel);
  }

  async function playDemo({ instantDemo = false } = {}) {
    const r = freshRun();
    try {
      r.instant = instantDemo;
      await Demo.demo(r, showShell);
      r.instant = false;
      await Demo.narrate(r, () => {
        Demo.hideCaption();
        dispatch({ type: 'toSetup' });
      });
      dispatch({ type: 'demoDone' });
    } catch (e) {
      ignoreCancel(e);
    }
  }

  function redetect() {
    dispatch({ type: 'redetect', fixture: devFixture });
    if (state.stage === 'setup') Setup.renderSetup(state, dispatch, redetect);
  }

  async function showSetup() {
    const r = freshRun();
    r.instant = true;
    await Demo.demo(r, showShell).catch(ignoreCancel);
    Setup.renderSetup(state, dispatch, redetect);
  }

  async function goHandoff(instant) {
    const r = freshRun();
    r.instant = instant;
    showShell('real');
    $('messages').innerHTML = '';
    try {
      await Setup.handoff(state, r, Demo.ensureCats());
      dispatch({ type: 'toChat' });
      await First.render(state, r, Demo.cats, { arriving: true, dispatch, getState });
    } catch (e) {
      ignoreCancel(e);
    }
  }

  function showChat() {
    const r = freshRun();
    r.instant = true;
    Demo.ensureCats();
    showShell('real');
    First.render(state, r, Demo.cats, { dispatch, getState }).catch(ignoreCancel);
  }

  function ignoreCancel(e) {
    if (!C.isCancel(e)) console.error(e);
  }

  // ---- jumping between scenes (presenter) ----
  function stateFor(scene) {
    let s = Core.reduce(Core.initial(devFixture), { type: 'variant', value: state.variant });
    if (scene === 'intro') return s;
    s = Core.reduce(s, { type: 'start' });
    if (scene === 'demo' || scene === 'narrate') return s;
    s = Core.reduce(Core.reduce(s, { type: 'demoDone' }), { type: 'toSetup' });
    if (scene === 'setup') return s;
    if (!Core.canConfirm(s))
      s = Core.reduce(Core.reduce(Core.initial('one-ready'), { type: 'variant', value: state.variant }), {
        type: 'start',
      });
    if (s.stage !== 'setup') s = Core.reduce(Core.reduce(s, { type: 'demoDone' }), { type: 'toSetup' });
    s = Core.reduce(s, { type: 'confirm' });
    return scene === 'handoff' ? s : Core.reduce(s, { type: 'toChat' });
  }

  function jump(scene) {
    state = stateFor(scene);
    persist();
    if (scene === 'intro') playIntro();
    else if (scene === 'demo') playDemo();
    else if (scene === 'narrate') playDemo({ instantDemo: true });
    else if (scene === 'setup') showSetup();
    else if (scene === 'handoff') goHandoff(false);
    else showChat();
  }

  function currentScene() {
    if (state.stage === 'demo') return state.demo === 'done' ? 'narrate' : 'demo';
    return state.stage;
  }

  // ---- presenter bar ----
  function renderDev() {
    const opt = (list, cur) =>
      list.map(([v, l]) => `<option value="${v}"${v === cur ? ' selected' : ''}>${l}</option>`).join('');
    $('dev').innerHTML = `
      <button type="button" id="devPrev" title="上一幕 ←">◀</button>
      <select id="devScene" aria-label="跳到场景">${opt(SCENES, currentScene())}</select>
      <button type="button" id="devNext" title="下一幕 →">▶</button>
      <button type="button" id="devPlay" title="播放/暂停 空格">暂停</button>
      <label>探测结果 <select id="devFixture">${opt(
        [
          ['none', '没有客户端'],
          ['one-ready', '1 个已登录'],
          ['one-login', '1 个未登录'],
          ['many', '多个'],
        ],
        devFixture,
      )}</select></label>
      <label>入口提醒 <select id="devVariant">${opt(
        [
          ['after', '进主界面后提醒（已采纳）'],
          ['before', '开口前必看（已否决，留作对照）'],
        ],
        state.variant,
      )}</select></label>
      <span id="devLogin"></span>
      <button type="button" id="devReset">清空进度</button>
      <span class="ledger" id="ledger"></span>
      <span style="opacity:.6">H 隐藏</span>`;
    $('devScene').addEventListener('change', (e) => jump(e.target.value));
    $('devPrev').addEventListener('click', () => step(-1));
    $('devNext').addEventListener('click', () => step(1));
    $('devPlay').addEventListener('click', togglePlay);
    $('devFixture').addEventListener('change', (e) => {
      devFixture = e.target.value;
    });
    $('devVariant').addEventListener('change', (e) => {
      dispatch({ type: 'variant', value: e.target.value });
      if (state.stage === 'chat') jump('chat');
    });
    $('devReset').addEventListener('click', () => {
      localStorage.removeItem(KEY);
      location.search = '';
    });
    renderLedger();
  }

  function renderLedger() {
    const ledger = $('ledger');
    if (!ledger) return;
    const logins = state.order.map((id) => `${id}:${state.clients[id].login}`).join(' ');
    ledger.textContent = `stage=${state.stage} demo=${state.demo} ${logins || 'clients:none'} members=${state.members.length} firstExchange=${state.firstExchange}`;
    const scene = $('devScene');
    if (scene) scene.value = currentScene();
    const pending = state.order.filter((id) => state.clients[id].login === 'pending');
    $('devLogin').innerHTML = pending.length
      ? `外部登录结果：<button type="button" id="devLoginOk">成功</button> <button type="button" id="devLoginFail">失败</button>`
      : '';
    if (pending.length) {
      $('devLoginOk').onclick = () => dispatch({ type: 'loginDone', id: pending[0] });
      $('devLoginFail').onclick = () => dispatch({ type: 'loginFailed', id: pending[0] });
    }
  }

  function step(delta) {
    const i = SCENES.findIndex(([id]) => id === currentScene());
    const next = SCENES[Math.min(SCENES.length - 1, Math.max(0, i + delta))][0];
    jump(next);
  }

  function togglePlay() {
    C.setPlaying(!C.isPlaying());
    $('devPlay').textContent = C.isPlaying() ? '暂停' : '播放';
  }

  document.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
    if (e.key === ' ') {
      e.preventDefault();
      togglePlay();
    } else if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'ArrowRight') step(1);
    else if (e.key === 'h' || e.key === 'H') {
      // Only the presenter bar hides; the prototype label is the honesty marker and stays.
      $('dev').classList.toggle('hidden');
      document.body.classList.toggle('bare');
    }
  });

  // ---- user actions ----
  $('startBtn').addEventListener('click', () => {
    dispatch({ type: 'start' });
    playDemo();
  });
  $('composer').addEventListener('submit', (e) => {
    e.preventDefault();
    First.send(getState, dispatch, run);
  });
  $('input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      First.send(getState, dispatch, run);
    }
  });
  $('hintGo').addEventListener('click', () => {
    $('hint').classList.add('hidden');
    First.tour(run, () => dispatch({ type: 'tourDone' }));
  });

  // ---- boot: resume where the user left off ----
  renderDev();
  persist();
  if (state.stage === 'setup') showSetup();
  else if (state.stage === 'chat') showChat();
  else playIntro();
})();
