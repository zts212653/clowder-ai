import { CATS, TOOLS } from './state.mjs';
import { avatar, button, esc, field, icon, option, toolSummary } from './ui.mjs';

export function editor(s, section = 'runtime') {
  const c = s.candidates[s.editorId];
  if (!c) return members(s);
  const t = TOOLS[c.tool];
  const runtime = `<h2>模型与工具</h2>${field(
    '使用工具',
    `<select id="tool">${Object.entries(TOOLS)
      .map(([id, tool]) => option(id, tool.label, c.tool))
      .join('')}</select>`,
  )}<div class="inline-info">已读取的工具配置会继续沿用。</div><div class="two-fields">${field('模型', `<select id="model">${option('', '跟随工具设置', c.model)}${t.models.map((m) => option(m, m, c.model)).join('')}</select>`)}${field('思考强度', `<select id="effort">${option('', '跟随工具设置', c.effort)}${t.efforts.map((e) => option(e, { low: '低', medium: '中', high: '高', xhigh: '更高', off: '关闭' }[e], c.effort)).join('')}</select>`)}</div><p class="fine">原型使用样例目录。正式界面读取所选工具和模型的能力。</p><details class="advanced"><summary>使用的账户</summary>${field(
    '账户',
    `<select id="account">${option('native', `${t.label} 登录（本机默认）`, c.account)}${s.accounts
      .filter((a) => c.tool === 'codex' && a.status === 'ready')
      .map((a) => option(a.id, a.name, c.account))
      .join('')}</select>`,
  )}${button('添加或登录账号', 'nav:accounts', 'text-button')}<p class="fine">恢复模型或强度跟随，不会更换账户。</p></details>`;
  const identity = `<h2>身份与职责</h2>${field('名字', `<input id="name" value="${esc(c.name)}" maxlength="60" />`)}${field('昵称', `<input id="nickname" value="${esc(c.nickname)}" maxlength="60" />`)}<p class="inline-info">名字显示在成员列表与对话里，昵称单独显示。</p>${field('职责', `<textarea id="role" rows="3">${esc(c.role)}</textarea>`)}<details class="advanced"><summary>角色模板</summary>${field(
    '模板',
    `<select id="cat">${Object.entries(CATS)
      .map(([id, cat]) => option(id, cat.name, c.cat))
      .join('')}</select>`,
  )}<p class="fine">更换形象不自动改写你填好的名字与工具。</p></details>`;
  const advanced = `<h2>按需调整，随时可回来</h2><p class="body-copy">语音、上下文与会话策略、启动程序和接入参数沿用新版成员设置。本次首启原型只演示常用配置与返回流程。</p><div class="notice">这些设置不作为首启必填项；正式接入复用已有编辑器，不另存一套。</div>`;
  return `<section class="page editor-page">${button(`${icon('back', 16)} ${s.stage === 'setup' ? '推荐伙伴' : '成员与运行时'}`, 'closeEditor', 'text-button back-link')}<header class="page-heading"><div><h1>${esc(c.name)}</h1><p>${t.label} · ${esc(c.role)}</p></div>${avatar(c.cat, true)}</header><div class="editor-layout"><nav aria-label="成员配置目录">${[
    ['runtime', '模型与工具'],
    ['identity', '身份与职责'],
    ['advanced', '更多设置'],
  ]
    .map(([id, title]) => button(title, `section:${id}`, `section-link ${id === section ? 'active' : ''}`))
    .join(
      '',
    )}</nav><div class="field-panel">${section === 'runtime' ? runtime : section === 'identity' ? identity : advanced}</div></div><div class="sticky-footer"><div><b>调整仅用于这位伙伴</b><p>返回清单前可以确认，账号页往返也会保留草稿。</p></div><div class="button-row">${button('放弃本次调整', 'discardEditor', 'text-button')}${button('确认调整', 'saveEditor', 'primary')}</div></div></section>`;
}
function nativeAccount(s, id) {
  const tool = s.tools[id];
  const used = s.members.filter((m) => m.tool === id && m.account === 'native');
  const status = {
    ready: '已读取配置',
    pending: '等待授权完成',
    failed: '登录未完成',
    login: '需要登录',
    unknown: '读不到',
    missing: '尚未安装',
  }[tool.status];
  const actions =
    tool.status === 'pending'
      ? button('取消登录', `cancel:${id}`, 'text-button')
      : tool.status === 'ready'
        ? '<span class="muted">随工具管理</span>'
        : button(tool.status === 'failed' ? '重新登录' : '去登录', `login:${id}`, 'secondary');
  return `<article class="account-row"><b>${TOOLS[id].label}</b><div><strong>${TOOLS[id].label} ${tool.auth === 'native-api' ? '已有 API 配置' : '登录（本机默认）'}</strong><small>${tool.auth === 'native-api' ? '沿用工具配置，不重复输入密钥' : '由工具保管登录信息'}</small></div><span class="status ${tool.status === 'ready' ? 'good' : 'attention'}">${status}</span><div>${used.length ? used.map((m) => `<span class="chip">${esc(m.name)}</span>`).join('') : '<span class="muted">尚未关联成员</span>'}</div><div>${actions}</div></article>`;
}
export function accounts(s, filter = 'all', query = '', adding = false) {
  const installed = Object.keys(TOOLS).filter((id) => s.tools[id].installed);
  const matches = (text) => text.toLowerCase().includes(query.toLowerCase());
  const rows = installed.filter(
    (id) =>
      (filter === 'all' || (filter === 'api') === (s.tools[id].auth === 'native-api')) &&
      matches(
        `${TOOLS[id].label} ${s.members
          .filter((m) => m.tool === id)
          .map((m) => m.name)
          .join(' ')}`,
      ),
  );
  const extra = s.accounts.filter((a) => filter !== 'api' && matches(`Codex ${a.name}`));
  const oauthCount = installed.filter((id) => s.tools[id].auth !== 'native-api').length + s.accounts.length;
  const apiCount = installed.filter((id) => s.tools[id].auth === 'native-api').length;
  return `<section class="page accounts-page">${button(`${icon('back', 16)} 返回${s.accountReturn === 'editor' ? '伙伴调整' : s.stage === 'setup' ? '推荐伙伴' : '对话'}`, 'accountBack', 'text-button back-link')}<header class="page-heading"><div><h1>账户与登录</h1><p>沿用工具已有的配置。需要另一个账号时，再添加。</p></div>${button(`${icon('plus', 16)} 添加账号`, 'addAccountPanel', 'primary')}</header><div class="account-toolbar"><input id="account-search" type="search" aria-label="搜索账户" placeholder="搜索工具、账号或猫的名字" value="${esc(query)}" /><div class="segments">${[
    ['all', '全部', oauthCount + apiCount],
    ['oauth', 'OAuth', oauthCount],
    ['api', 'API', apiCount],
  ]
    .map(([id, name, count]) =>
      button(`${name} <small>${count}</small>`, `filter:${id}`, filter === id ? 'active' : ''),
    )
    .join(
      '',
    )}</div></div>${s.loginId && s.tools[s.loginId]?.status === 'pending' ? `<div class="login-notice"><div class="pending-symbol"></div><div><h3>请在 ${TOOLS[s.loginId].label} 中完成登录</h3><p>完成后会回到这里。现在可以暂时离开，原来的选择还在。</p><p class="fine">交互原型：没有打开真实授权。下方“原型场景”可模拟外部成功、失败或取消。</p></div></div>` : ''}${adding ? `<form id="new-account" class="add-account"><h2>添加 Codex 账号</h2><p>给新账号一个方便辨认的备注。</p>${field('账号备注', '<input id="account-name" placeholder="例如：公司号" maxlength="50" required />')}<div class="notice">F320 对接预演：正式版仅展示后端支持的工具，调用该工具的官方登录。这里不接收密钥。</div><div class="button-row">${button('取消', 'cancelAdd', 'secondary')}<button class="primary">开始官方登录（模拟）</button></div></form>` : ''}<div class="accounts-table"><div class="account-row table-head"><span>工具</span><span>账号</span><span>状态</span><span>谁在用</span><span>动作</span></div>${rows.map((id) => nativeAccount(s, id)).join('')}${extra
    .map(
      (a) =>
        `<article class="account-row"><b>Codex</b><div><strong>${esc(a.name)}</strong><small>独立登录 · 不改变本机默认</small></div><span class="status ${a.status === 'ready' ? 'good' : 'attention'}">${a.status === 'ready' ? '已登录' : a.status === 'pending' ? '等待授权' : '登录未完成'}</span><span class="muted">${
          s.members.some((m) => m.account === a.id)
            ? `正在用：${s.members
                .filter((m) => m.account === a.id)
                .map((m) => esc(m.name))
                .join('、')}`
            : '尚未使用'
        }</span>${a.status === 'failed' ? button('重试', `retryAccount:${a.id}`, 'secondary') : '<span class="muted">在成员详情选择</span>'}</article>`,
    )
    .join(
      '',
    )}${!rows.length && !extra.length ? '<div class="table-empty">没有符合条件的账号</div>' : ''}</div><p class="fine">新增登录不会自动切换成员账号。“本机默认登录”和猫正在使用的账号是两件事。</p></section>`;
}
export function members(s) {
  return `<section class="page"><header class="page-heading"><div><h1>成员与运行时</h1><p>选择猫猫伙伴，设置使用的工具、模型和职责。</p></div>${button(`${icon('plus', 16)} 添加成员`, 'addMember', 'primary')}</header>${s.members.length ? `<div class="default-member"><div><b>默认回复伙伴</b><p>新对话未指定伙伴时，由这位伙伴回复</p></div><span>${avatar(s.members[0].cat)} ${esc(s.members[0].name)}</span></div><div class="member-list">${s.members.map((m) => `<button class="member-row" data-action="edit:${m.key || m.tool}">${avatar(m.cat, true)}<div><h3>${esc(m.name)}</h3>${m.nickname ? `<p>昵称：${esc(m.nickname)}</p>` : ''}<p>${toolSummary(m)}</p><span class="mention">@${esc(m.name)}</span></div><span class="member-enabled">已启用 <i></i></span></button>`).join('')}</div>` : `<div class="notice"><h2>还没有加入伙伴</h2><p>确认推荐清单后，你选择的伙伴会出现在这里。</p>${button('继续配置伙伴', 'setup', 'primary')}</div>`}<div class="settings-footnote">${button(`${icon('chat', 16)} 回到对话`, 'home', 'text-button')}${button('重看团队示范', 'replay', 'text-button')}</div></section>`;
}
