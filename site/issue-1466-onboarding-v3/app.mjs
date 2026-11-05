import { chat, demo, handoff, setup, welcome } from './journey-views.mjs';
import { bindKeyboard } from './keyboard.mjs';
import { INSTALL_URLS, overlay, presenter } from './preview-controls.mjs';
import { accounts, editor, members } from './settings-views.mjs';
import { DEMO_PROMPT, initial, reduce, restore, TOOLS } from './state.mjs';
import { button, notify, shell } from './ui.mjs';

const root = document.getElementById('root');
const params = new URLSearchParams(location.search);
let run = params.get('run') || crypto.randomUUID();
let fixture = params.get('case') || 'one';
let state = initial(fixture);
let devOpen = false,
  section = 'runtime',
  adding = false,
  filter = 'all',
  query = '',
  modal = null;
let editorOriginal = state.editorBaseline || null,
  busy = false,
  timer = null,
  storageError = false;
let renderedPage = '';
const key = () => `clowder:onboarding-prototype:v3:${run}`;
try {
  const saved = localStorage.getItem(key());
  if (saved) {
    const parsed = restore(saved);
    if (parsed) {
      state = parsed;
      editorOriginal = state.editorBaseline || null;
    } else storageError = true;
  }
} catch {
  storageError = true;
}
function persist() {
  try {
    localStorage.setItem(key(), JSON.stringify(state));
  } catch {
    notify('本浏览器无法保存原型进度，请保持页面开启。');
  }
  const url = new URL(location.href);
  url.searchParams.set('run', run);
  url.searchParams.set('case', state.fixture);
  history.replaceState(null, '', url);
}
function dispatch(action, rerender = true) {
  state = reduce(state, action);
  persist();
  if (rerender) render();
}
function newRun(nextFixture = fixture) {
  clearTimeout(timer);
  busy = false;
  run = crypto.randomUUID();
  fixture = nextFixture;
  state = initial(fixture);
  storageError = false;
  modal = null;
  editorOriginal = null;
  adding = false;
  section = 'runtime';
  persist();
  render();
}
function render() {
  clearTimeout(timer);
  const page = `${state.view}:${state.stage}:${state.editorId}`;
  let body;
  if (state.view === 'accounts') body = accounts(state, filter, query, adding);
  else if (state.view === 'editor') body = editor(state, section);
  else if (state.view === 'members') body = members(state);
  else body = { welcome, demo, setup, handoff, chat }[state.stage](state);
  const top = `<div class="preview-top"><b>交互原型 · 模拟数据 <span class="preview-version">／ #1466 · 新版引导</span></b>${button('原型场景', 'dev', '', `aria-expanded="${devOpen}"`)}</div>`;
  root.innerHTML =
    top +
    (state.stage === 'welcome' && state.view === 'journey' ? body : shell(state, body)) +
    (devOpen ? presenter(state) : '') +
    overlay(storageError, modal);
  if (page !== renderedPage) {
    window.scrollTo(0, 0);
    renderedPage = page;
  }
  const demoContent = root.querySelector('.demo-content');
  if (demoContent) demoContent.scrollTop = demoContent.scrollHeight;
  if (busy) {
    root.querySelectorAll('[data-action="create"]').forEach((el) => {
      el.disabled = true;
      el.textContent = '正在保存伙伴…';
    });
  }
  if (state.stage === 'demo' && !state.paused && state.view === 'journey') scheduleDemo();
  if (state.stage === 'chat' && state.exchange === 'sent') timer = setTimeout(() => dispatch({ type: 'reply' }), 1500);
}
function scheduleDemo() {
  if (state.scene === 0 && (state.demoTyped || 0) < DEMO_PROMPT.length) {
    timer = setTimeout(() => {
      dispatch({ type: 'typeChar' }, false);
      const text = document.getElementById('demo-typing');
      if (text) text.textContent = DEMO_PROMPT.slice(0, state.demoTyped);
      scheduleDemo();
    }, 75);
  } else timer = setTimeout(() => dispatch({ type: 'tick' }), state.scene === 0 ? 900 : 5500);
}
function navigate(view) {
  if (view === 'accounts') state.accountReturn = state.view;
  dispatch({ type: 'navigate', view });
}
root.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]');
  if (!target || target.disabled) return;
  const [action, id] = target.dataset.action.split(':');
  switch (action) {
    case 'dev':
      devOpen = !devOpen;
      render();
      break;
    case 'newRun':
      newRun(state.fixture);
      break;
    case 'start':
    case 'pause':
    case 'setup':
    case 'chat':
    case 'useCreated':
      dispatch({ type: action });
      break;
    case 'prev':
    case 'next':
      dispatch({ type: 'scene', delta: action === 'next' ? 1 : -1 });
      break;
    case 'nav':
      navigate(id);
      break;
    case 'home':
      if (state.members.length) dispatch({ type: 'chat' });
      else dispatch({ type: 'setup' });
      break;
    case 'edit':
      editorOriginal = structuredClone(state.candidates[id]);
      section = 'runtime';
      dispatch({ type: 'openEditor', id });
      break;
    case 'closeEditor':
    case 'saveEditor':
      if (action === 'saveEditor' && !state.candidates[state.editorId].name.trim()) {
        notify('请给伙伴起一个名字。');
        break;
      }
      if (action === 'saveEditor')
        state.members = state.members.map((m) =>
          m.id === state.candidates[state.editorId].id ? { ...m, ...state.candidates[state.editorId] } : m,
        );
      dispatch({ type: 'closeEditor' });
      break;
    case 'discardEditor':
      if (editorOriginal) state.candidates[state.editorId] = editorOriginal;
      dispatch({ type: 'closeEditor' });
      break;
    case 'section':
      section = id;
      render();
      break;
    case 'login':
      dispatch({ type: 'login', id });
      devOpen = true;
      render();
      break;
    case 'loginOk':
    case 'loginFail':
      dispatch({ type: 'loginResult', id, status: action === 'loginOk' ? 'ready' : 'failed' });
      break;
    case 'cancel':
      dispatch({ type: 'cancelLogin', id });
      break;
    case 'detectOk':
      dispatch({ type: 'detected', id, status: 'ready' });
      break;
    case 'accountBack':
      navigate(state.accountReturn || (state.stage === 'setup' ? 'journey' : 'members'));
      break;
    case 'create': {
      if (busy) break;
      busy = true;
      render();
      const creatingRun = run;
      setTimeout(() => {
        if (creatingRun !== run) return;
        busy = false;
        dispatch({ type: 'create' });
      }, 650);
      break;
    }
    case 'reply':
      dispatch({ type: 'reply' });
      break;
    case 'suggest': {
      const text =
        id === 'project'
          ? '我想做一个帮助小团队整理任务的应用。请先问我三个关键问题，再帮我梳理第一版的范围。'
          : '请审阅下面这段代码，先指出风险，再给出修改建议。\n\nfunction getData(url) {\n  fetch(url).then(res => res.json()).then(console.log);\n}';
      dispatch({ type: 'draft', text });
      document.getElementById('message')?.focus();
      break;
    }
    case 'skipGuide':
      dispatch({ type: 'guide', status: 'skipped' });
      break;
    case 'showGuide':
      modal = {
        title: '以后，从这里找到伙伴',
        body: '<p><b>设置与管理 → 猫猫团队</b></p><p>成员与运行时：改名字、选择工具、调整模型。<br>账户与登录：管理已有登录，按需添加账号。</p><p class="fine">正式版使用 F155 在对应入口轻提示。这里是交接预演，不阻塞对话。</p>',
        actions: button('去成员与运行时', 'guideMembers', 'primary'),
      };
      dispatch({ type: 'guide', status: 'completed' });
      break;
    case 'guideMembers':
      modal = null;
      navigate('members');
      break;
    case 'pin':
      dispatch({ type: 'pin', id });
      break;
    case 'addAccountPanel':
      adding = true;
      render();
      break;
    case 'cancelAdd':
      adding = false;
      render();
      break;
    case 'accountOk':
    case 'accountFail':
      dispatch({ type: 'accountResult', status: action === 'accountOk' ? 'ready' : 'failed' });
      break;
    case 'retryAccount':
      dispatch({ type: 'retryAccount', id });
      devOpen = true;
      render();
      break;
    case 'filter':
      filter = id;
      render();
      break;
    case 'dismiss':
      modal = null;
      render();
      break;
    case 'install':
      modal = {
        title: `连接 ${TOOLS[id].label}`,
        body: `<p>从工具官方入口完成安装和配置，再回来重新检测。</p><a class="install-link" href="${INSTALL_URLS[id]}" target="_blank" rel="noopener">打开 ${TOOLS[id].label} 官方项目 ↗</a><p class="fine">此原型不会安装程序。以下按钮仅模拟安装后的外部状态，不代表真实可用性。</p>`,
        actions: button('模拟已安装并配置', `installed:${id}`, 'primary'),
      };
      render();
      break;
    case 'installed':
      modal = null;
      dispatch({ type: 'detected', id, status: 'ready' });
      break;
    case 'redetect':
      notify('模拟重新检测完成。未改变你的勾选、名字或模型偏好。');
      break;
    case 'inspect':
      devOpen = true;
      render();
      notify('当前没有可靠的认证证据。可模拟恢复可读后，再确认伙伴。');
      break;
    case 'addMember':
      dispatch({ type: 'setup' });
      break;
    case 'replay':
    case 'help':
      dispatch({ type: 'start' });
      state.view = 'journey';
      persist();
      render();
      break;
    case 'concierge':
      notify(`这是 ${state.members[0].name} 的前台入口预演，与默认回复伙伴为同一成员。`);
      break;
    default:
      break;
  }
});
root.addEventListener('change', (event) => {
  const el = event.target;
  if (el.id === 'scenario') {
    newRun(el.value);
    return;
  }
  if (el.id === 'pin-policy') {
    dispatch({ type: 'pinPolicy', policy: el.value });
    return;
  }
  if (el.dataset.select) {
    dispatch({ type: 'toggle', id: el.dataset.select });
    return;
  }
  if (['tool', 'model', 'effort', 'account', 'cat'].includes(el.id) && state.editorId) {
    if (el.id === 'tool') {
      dispatch({ type: 'selectTool', id: state.editorId, tool: el.value });
    } else dispatch({ type: 'edit', id: state.editorId, patch: { [el.id]: el.value } });
  }
});
root.addEventListener('input', (event) => {
  const el = event.target;
  if (el.id === 'message') dispatch({ type: 'draft', text: el.value }, false);
  if (['name', 'nickname', 'role'].includes(el.id) && state.editorId)
    dispatch({ type: 'edit', id: state.editorId, patch: { [el.id]: el.value } }, false);
  if (el.id === 'account-search') {
    query = el.value;
    const cursor = el.selectionStart;
    render();
    const search = document.getElementById('account-search');
    search.focus();
    search.setSelectionRange(cursor, cursor);
  }
});
root.addEventListener('submit', (event) => {
  event.preventDefault();
  if (event.target.id === 'composer') dispatch({ type: 'send' });
  if (event.target.id === 'new-account') {
    const name = document.getElementById('account-name').value.trim();
    if (!name) return;
    adding = false;
    devOpen = true;
    dispatch({ type: 'addAccount', name });
  }
});
bindKeyboard({
  getState: () => state,
  dispatch,
  togglePanel: () => {
    devOpen = !devOpen;
    render();
  },
  dismiss: () => {
    modal = null;
    devOpen = false;
    render();
  },
});
if (!storageError) persist();
render();
