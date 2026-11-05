import { SCENARIOS, TOOLS } from './state.mjs';
import { button } from './ui.mjs';
export const INSTALL_URLS = {
  codex: 'https://github.com/openai/codex',
  claude: 'https://code.claude.com/docs/en/overview',
  dsh: 'https://github.com/deepseek-ai/deepseek-harness',
};
export function presenter(state) {
  const pending = Object.entries(state.tools).filter(([, tool]) => tool.status === 'pending');
  const unknown = Object.entries(state.tools).filter(([, tool]) => tool.status === 'unknown');
  return `<aside class="dev-panel" aria-label="原型场景控制"><h2>原型场景</h2><p>仅改变演示条件，不读取本机工具、不调用 API。切换会新建演示记录，旧记录保留。</p><label class="dev-label" for="scenario">初始条件</label><select id="scenario">${Object.entries(
    SCENARIOS,
  )
    .map(([id, title]) => `<option value="${id}" ${id === state.fixture ? 'selected' : ''}>${title}</option>`)
    .join(
      '',
    )}</select><div class="button-row">${button('重新体验', 'newRun', 'secondary')}${button('隐藏面板 H', 'dev', 'text-button')}</div>${pending.map(([id]) => `<label class="dev-label">${TOOLS[id].label} 官方登录返回（模拟）</label><div class="button-row">${button('授权成功', `loginOk:${id}`, 'secondary')}${button('登录失败', `loginFail:${id}`, 'secondary')}${button('取消', `cancel:${id}`, 'text-button')}</div>`).join('')}${unknown.map(([id]) => `<div class="button-row">${button(`${TOOLS[id].label} 恢复可读`, `detectOk:${id}`, 'secondary')}</div>`).join('')}${state.accounts.some((a) => a.status === 'pending') ? `<label class="dev-label">新增账号授权结果（模拟）</label><div class="button-row">${button('新号登录成功', 'accountOk', 'secondary')}${button('新号登录失败', 'accountFail', 'secondary')}</div>` : ''}<label class="dev-label" for="pin-policy">待对齐：新安装默认固定</label><select id="pin-policy"><option value="original" ${state.pinPolicy === 'original' ? 'selected' : ''}>按原 issue：默认固定成员 / 账号</option><option value="workspace" ${state.pinPolicy === 'workspace' ? 'selected' : ''}>Workspace 对照：默认不固定</option></select><p>提示记录和固定列表独立。取消固定后不会自动补回。</p><div class="button-row">${button('切换成员固定', 'pin:members', 'text-button')}${button('切换账号固定', 'pin:accounts', 'text-button')}</div></aside>`;
}
export function overlay(storageError, modal) {
  if (storageError)
    return `<div class="modal-backdrop"><div class="modal" role="dialog" aria-modal="true"><h2>原型进度暂时无法读取</h2><p>没有把读取失败当成全新用户，也没有覆盖原记录。你可以刷新重试，或另开一份演示。</p>${button('另开演示', 'newRun', 'primary')}</div></div>`;
  if (!modal) return '';
  return `<div class="modal-backdrop"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><h2 id="modal-title">${modal.title}</h2>${modal.body}<div class="button-row">${modal.actions || ''}${button('返回', 'dismiss', 'secondary')}</div></div></div>`;
}
