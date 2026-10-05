import { initialState, reduce, restore } from './state.mjs';

const key = 'f317-design-fixture-v1';
const $ = (id) => document.getElementById(id);
let state = initialState();
try {
  const saved = localStorage.getItem(key);
  if (saved) state = restore(JSON.parse(saved));
} catch {
  /* A corrupt design fixture starts visibly unconfigured. */
}
let compact = Boolean(window.companionDesign);
let narrow = false;
let pointTimer;

function dispatch(action) {
  state = reduce(state, action);
  try {
    localStorage.setItem(key, JSON.stringify(state));
  } catch {
    state.notice = '本机存储不可用，这次变化还没有保存。';
  }
  render();
}

function item(text, speaker, target) {
  const li = document.createElement('li');
  if (speaker) {
    const label = document.createElement('strong');
    label.textContent = speaker;
    li.append(label);
  }
  const content = document.createElement('span');
  content.textContent = text;
  li.append(content);
  if (target) {
    const small = document.createElement('small');
    small.textContent = target;
    li.append(small);
  }
  return li;
}

function renderSetup() {
  $('setup').hidden = state.view !== 'setup';
  $('companion').hidden = state.view !== 'companion';
  $('moments-view').hidden = state.view !== 'moments';
  $('artifact-state').textContent = state.installed ? '已安装（演示）' : '尚未安装';
  $('intent-state').textContent = state.enabled ? '已开启（演示）' : '关闭';
  $('install').hidden = state.installed;
  $('enable').hidden = !state.installed || state.enabled;
  $('back').hidden = !state.enabled;
  $('disable').hidden = !state.enabled;
}

function render() {
  renderSetup();
  $('target').value = state.target;
  $('follow').checked = state.follow;
  $('compact-state').textContent = state.sharing
    ? `陪你看 · ${state.target}`
    : state.enabled
      ? '已暂停 · 未共享'
      : '尚未共享';
  $('live-state').textContent = state.sharing ? '共同在场' : state.connected ? '连接可用 · 已暂停' : '尚未连接';
  $('live-dot').classList.toggle('live', state.sharing);
  $('sharing').textContent = state.sharing ? '暂停共享' : state.connected ? '恢复共享' : '开始陪伴';
  $('sharing').classList.toggle('primary', !state.sharing);
  $('scope').textContent = state.sharing
    ? state.target === '只聊一会儿'
      ? '只听你说 · 不看屏幕（模拟）'
      : `${state.target} + 窗口声音 + 你的声音（模拟）`
    : '屏幕与声音都已关闭。继续聊的背景还在。';
  $('point').disabled = !state.sharing || state.target === '只聊一会儿';
  $('pet-hint').textContent = state.sharing ? `共享中（演示）· ${state.target}` : '体验稿 · 未共享';
  $('expand').classList.toggle('sharing', state.sharing);
  $('empty').hidden = state.messages.length > 0;
  appendMessages();
  $('thought').hidden = !state.thinking;
  $('point-row').hidden = !state.point;
  $('point-label').textContent = state.point ? `此处 · ${state.point.x}, ${state.point.y}（临时）` : '';
  $('moment-count').textContent = state.moments.length;
  $('moment-list').replaceChildren(...state.moments.map((moment) => item(moment.text, null, moment.target)));
  $('notice').hidden = !state.notice;
  $('notice').textContent = state.notice;
}

function appendMessages() {
  const list = $('messages');
  const followsTail = list.scrollHeight - list.scrollTop - list.clientHeight < 32;
  for (const message of state.messages.slice(list.childElementCount)) {
    const li = item(message.text, message.speaker);
    if (message.speaker === '你') li.classList.add('user');
    list.append(li);
  }
  if (followsTail) list.scrollTop = list.scrollHeight;
}

function setCompact(value) {
  compact = value;
  document.body.classList.toggle('compact', compact);
  $('collapse').hidden = compact;
  $('expand').hidden = !compact;
  window.companionDesign?.resize(compact ? 'compact' : narrow ? 'narrow' : 'normal');
}

for (const action of ['install', 'enable', 'disable', 'end']) $(action).onclick = () => dispatch({ type: action });
$('settings').onclick = () => {
  setCompact(false);
  dispatch({ type: 'view', view: 'setup' });
};
for (const id of ['back', 'return']) $(id).onclick = () => dispatch({ type: 'view', view: 'companion' });
$('moments').onclick = () => dispatch({ type: 'view', view: 'moments' });
$('sharing').onclick = () => dispatch({ type: state.sharing ? 'pause' : 'start' });
$('target').onchange = (event) => dispatch({ type: 'target', target: event.target.value });
$('follow').onchange = (event) => dispatch({ type: 'follow', value: event.target.checked });
$('collapse').onclick = () => setCompact(true);
$('expand').onclick = () => setCompact(false);
$('narrow').onclick = () => {
  narrow = !narrow;
  document.body.style.maxWidth = narrow ? '320px' : '';
  window.companionDesign?.resize(narrow ? 'narrow' : 'normal');
};
$('composer').onsubmit = (event) => {
  event.preventDefault();
  dispatch({ type: 'say', text: $('input').value });
  $('input').value = '';
};
$('remember').onclick = () => {
  dispatch({ type: 'remember', text: $('input').value });
};
$('clear-point').onclick = () => {
  clearTimeout(pointTimer);
  dispatch({ type: 'clear-point' });
  window.companionDesign?.clearPoint();
};
$('point').onclick = () => {
  if (window.companionDesign) window.companionDesign.point();
  else {
    state.notice = '屏幕指点在桌面浮窗中体验；网页预览不读取外部应用。';
    render();
  }
};
window.companionDesign?.onPoint((point) => {
  dispatch({ type: 'point', ...point });
  clearTimeout(pointTimer);
  pointTimer = setTimeout(() => dispatch({ type: 'clear-point' }), 10000);
});
document.querySelectorAll('[data-action]').forEach((button) => {
  button.onclick = () => {
    const type = button.dataset.action;
    if (type === 'question')
      dispatch({
        type: 'answer',
        generation: state.generation,
        question: true,
        text: '你指的是内侧接缝，还是外面的投影？',
      });
    else if (type === 'answer')
      dispatch({
        type: 'answer',
        generation: state.generation,
        text: '我们先固定光源，再比较倒角前后这条阴影。你刚补充的位置我一起考虑了。',
      });
    else if (type === 'stale')
      dispatch({ type: 'answer', generation: state.generation - 1, text: '这条依据旧画面的答案不应进入交流。' });
    else dispatch({ type });
  };
});
render();
setCompact(compact);
