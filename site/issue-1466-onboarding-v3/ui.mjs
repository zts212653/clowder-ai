import { CATS, TOOLS } from './state.mjs';

let toastTimer;
export function notify(text) {
  clearTimeout(toastTimer);
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.role = 'status';
  el.textContent = text;
  document.body.append(el);
  toastTimer = setTimeout(() => el.remove(), 4500);
}
export const esc = (text = '') =>
  String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const icon = (name, size = 20) => {
  const paths = {
    chat: '<path d="M5 4h14v12H9l-4 4z"/>',
    people: '<circle cx="9" cy="8" r="3"/><path d="M3 20v-3a6 6 0 0 1 12 0v3M17 4a3 3 0 0 1 0 6m1 4a5 5 0 0 1 3 5"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9m-5 5 3 3m0-6 3 3"/>',
    gear: '<circle cx="12" cy="12" r="4"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2"/>',
    arrow: '<path d="m5 12 14 0m-6-6 6 6-6 6"/>',
    back: '<path d="M19 12H5m6-6-6 6 6 6"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    pin: '<path d="m9 3 9 3-3 4v5l-4-1-4 7 1-9-4-2 5-2z"/>',
    play: '<path d="m8 5 11 7-11 7z"/>',
    pause: '<path d="M8 5v14M16 5v14"/>',
    reset: '<path d="M4 10a8 8 0 1 1 0 5M4 4v6h6"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9 9a3 3 0 0 1 6 0c0 2-3 2-3 5m0 2v1"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    send: '<path d="M12 20V4m-6 6 6-6 6 6"/>',
  };
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? paths.chat}</svg>`;
};
export const button = (label, action, cls = '', attrs = '') =>
  `<button type="button" class="${cls}" data-action="${action}" ${attrs}>${label}</button>`;
export function avatar(cat, large = false) {
  const m = CATS[cat];
  const scale = large ? 0.9 : 0.52;
  const size = large ? 56 : 34;
  return `<span class="avatar ${large ? 'large' : ''}" role="img" aria-label="${m.name}" style="--cat:${m.color};background-image:url(assets/cats/${cat}-sit-row.png);background-size:${192 * scale}px ${208 * scale}px;background-position:${size / 2 - m.head[0] * scale}px ${size / 2 - m.head[1] * scale}px"></span>`;
}
export const catSprite = (cat, pose = 'sit') =>
  `<span role="img" aria-label="${CATS[cat].name}" class="sprite ${pose}" style="--sprite:url(assets/cats/${cat}-${pose}-row.png)"></span>`;
export const field = (label, content) => `<label class="field"><span>${label}</span>${content}</label>`;
export const option = (value, label, chosen) =>
  `<option value="${esc(value)}" ${value === chosen ? 'selected' : ''}>${esc(label)}</option>`;
export function shell(s, content) {
  const settings = s.view !== 'journey' || s.stage === 'setup';
  const names = { members: '成员与运行时', accounts: '账户与登录', journey: '首次使用', editor: '成员与运行时' };
  const rail = `<nav class="rail" aria-label="主导航"><img class="logo" src="assets/logo.png" alt="Clowder AI" />${button(icon('chat'), 'home', 'icon-button', 'aria-label="我的 Café"')}${s.pins.map((id) => button(icon(id === 'members' ? 'people' : 'key'), `nav:${id}`, `icon-button ${s.view === id ? 'selected' : ''}`, `aria-label="${names[id]}"`)).join('')}<div class="spacer"></div>${button(icon('help'), 'help', 'icon-button', 'aria-label="重新查看引导"')}${button(icon('gear'), 'nav:members', 'icon-button', 'aria-label="设置与管理"')}</nav>`;
  const sidebar = settings
    ? `<aside class="sidebar settings-nav"><h2>设置与管理</h2><div class="nav-row active">${icon('people')} 猫猫团队</div><div class="nav-row muted">${icon('gear')} 系统</div><p class="sidebar-note">名字、工具与偏好，<br>随时可以回来调整。</p></aside>`
    : `<aside class="sidebar chat-nav"><h2>我的 Café</h2><div class="nav-row">${icon('plus')} 新对话</div><div class="sidebar-label">对话</div><div class="thread-active">${s.stage === 'demo' ? '一次小小的协作' : '和伙伴的第一次交流'}</div><div class="spacer"></div><div class="sidebar-note">Clowder AI<br>和你一起成长的 AI 团队</div></aside>`;
  const tabs = settings
    ? `<div class="tabs" role="navigation" aria-label="猫猫团队">${['members', 'accounts'].map((id) => button(names[id], `nav:${id}`, s.view === id || (s.view === 'editor' && id === 'members') ? 'tab active' : 'tab')).join('')}<span class="tab muted">能力画像来源</span><span class="tab muted">猫猫球</span></div>`
    : '';
  return `<div class="app-shell">${rail}${sidebar}<main class="main ${settings ? 'settings-main' : ''}">${tabs}${content}</main></div>`;
}
export const toolSummary = (member) => `${TOOLS[member.tool].label} · ${member.model || '跟随工具模型'}`;
