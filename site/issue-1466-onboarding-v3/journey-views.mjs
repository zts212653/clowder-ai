import { CATS, canCreate, DEMO_PROMPT, selected, TOOLS } from './state.mjs';
import { avatar, button, catSprite, esc, icon, toolSummary } from './ui.mjs';

const progress = (step) =>
  `<div class="progress" aria-label="首次使用进度">${['认识伙伴', '确认你的伙伴', '开始交流'].map((label, i) => `<span class="${i === step ? 'current' : ''}"><i>${i < step ? icon('check', 12) : i + 1}</i>${label}</span>${i < 2 ? '<b></b>' : ''}`).join('')}</div>`;
export function welcome() {
  return `<section class="welcome"><div class="welcome-brand"><img src="assets/logo.png" alt=""/> Clowder AI</div><div class="welcome-inner"><p class="eyebrow">很高兴，终于见到你</p><h1>有个想法？<br>和伙伴一起把它做好。</h1><p class="intro">你说目标。它们分工、互相审阅，<br class="mobile-break">带着更好的结果回来。</p><div class="cat-stage">${Object.keys(
    CATS,
  )
    .map(
      (id, i) =>
        `<div class="cat-on-stage" style="--delay:${i * 0.4}s">${catSprite(id)}<span>${CATS[id].name}</span></div>`,
    )
    .join(
      '',
    )}</div><div class="welcome-action">${button(`认识一下 ${icon('arrow', 17)}`, 'start', 'primary big')}${button('我想直接配置工具', 'setup', 'text-button')}</div><p class="fine">一段简短的团队示范，不调用模型。</p></div><footer class="welcome-footer"><span>从一位伙伴开始，也很好。</span><span>你的工具 · 你的选择</span></footer></section>`;
}
const DEMO = [
  { title: '先说说你想做什么', caption: '一个目标，就可以成为协作的开始。' },
  { title: '一位伙伴先动手', caption: '写出初稿，再主动请同伴看看。' },
  { title: '另一种视角，发现一个问题', caption: '互相 @ 是为了把事情做好。' },
  { title: '同一个结果，变得更好了', caption: '建议被采用，修改直接出现在结果里。' },
  { title: '现在，轮到你的伙伴了', caption: '刚才是示范。接下来，我们连接你已经在用的工具。' },
];
const message = (cat, text, extra = '') =>
  `<article class="cat-message ${extra}">${avatar(cat)}<div><div class="message-author">${CATS[cat].name}<span>示范</span></div><div class="bubble">${text}</div></div></article>`;
export function demo(s) {
  const [writer, reviewer] = Object.keys(CATS).filter((id) => id !== s.narrator);
  const scene = DEMO[s.scene];
  return `<div class="demo-page ${s.paused ? 'is-paused' : ''}"><header class="chat-header"><div><span class="eyebrow">认识伙伴</span><h2>一次小小的协作</h2></div><span class="tag">脚本示范 · 不调用模型</span></header><div class="demo-content">${s.scene === 0 ? `<div class="demo-input-stage"><p class="fine">示范正在输入一个目标</p><div class="demo-composer"><span id="demo-typing">${esc(DEMO_PROMPT.slice(0, s.demoTyped || 0))}</span><i></i></div></div>` : `<div class="demo-goal"><span>你</span><p>${DEMO_PROMPT}</p></div>`}${s.scene >= 1 ? message(writer, `初稿：欢迎来到猫咖，这里支持 <span class="jargon">A2A 协作</span>。<br><span class="mention">@${CATS[reviewer].name}</span> 帮我看看，新朋友能看懂吗？`, s.scene === 1 && !s.paused ? 'entering' : '') : ''}${s.scene >= 2 ? message(reviewer, '“A2A 协作”是我们熟悉的术语，但新朋友未必明白。<br>直接告诉他：这里的伙伴会互相搭把手。', s.scene === 2 && !s.paused ? 'entering' : '') : ''}${s.scene >= 3 ? message(writer, '<span class="diff-label">采纳建议</span><br>欢迎来到猫咖，<del>这里支持 A2A 协作</del><br><mark>你说想做什么，几只猫会互相搭把手，一起把它做好。</mark>', s.scene === 3 && !s.paused ? 'entering' : '') : ''}${s.scene === 4 ? `<div class="narrator-note">${avatar(s.narrator)}<p><b>你说目标，我们自己分工。</b><br>需要你决定时，再带着结果回来。</p></div>` : ''}</div><div class="demo-dock"><div class="mini-cats">${Object.keys(
    CATS,
  )
    .map(
      (id) =>
        `<div class="mini-cat ${id === s.narrator ? 'narrator' : ''}">${catSprite(id, id === s.narrator && s.scene === 4 ? 'wave' : 'sit')}<small>${id === s.narrator ? '陪你认识团队' : CATS[id].name}</small></div>`,
    )
    .join(
      '',
    )}</div><div class="demo-caption"><strong>${scene.title}</strong><p>${scene.caption}</p></div><div class="demo-controls"><div class="dots">${DEMO.map((_, i) => `<i class="${i <= s.scene ? 'filled' : ''}"></i>`).join('')}</div>${button(icon('back', 17), 'prev', 'icon-button', 'aria-label="上一幕"')}${button(`${icon(s.paused ? 'play' : 'pause', 16)} ${s.paused ? '播放' : '暂停'}`, 'pause', 'secondary')}${s.scene === 4 ? button(s.members.length ? '回到我的对话' : `确认我的伙伴 ${icon('arrow', 16)}`, s.members.length ? 'chat' : 'setup', 'primary') : button('下一幕', 'next', 'secondary')}</div>${button(s.members.length ? '返回我的伙伴' : '跳过示范，直接配置', s.members.length ? 'chat' : 'setup', 'text-button subtle')}</div></div>`;
}
function toolState(tool) {
  return {
    ready: tool.auth === 'native-api' ? '已有工具配置' : '已读取登录配置',
    login: '需要登录',
    pending: '等待你完成登录',
    unknown: '暂时读不到状态',
    failed: '登录未完成',
    missing: '尚未安装',
  }[tool.status];
}
function recommendation(s, id) {
  const c = s.candidates[id],
    t = s.tools[c.tool],
    saved = s.members.some((m) => m.id === c.id);
  const isReady = t.status === 'ready';
  const action = isReady
    ? button('调整', `edit:${id}`, 'text-button')
    : t.status === 'missing'
      ? button('连接工具', `install:${c.tool}`, 'secondary')
      : t.status === 'unknown'
        ? button('查看并重新检测', `inspect:${c.tool}`, 'secondary')
        : button(
            t.status === 'pending' ? '继续登录' : t.status === 'failed' ? '重试登录' : '去登录',
            `login:${c.tool}`,
            'secondary',
          );
  return `<article class="partner-card ${c.selected ? 'chosen' : ''}" data-tool="${id}"><input type="checkbox" aria-label="选择 ${TOOLS[c.tool].label}" data-select="${id}" ${c.selected ? 'checked' : ''} ${(!isReady && !c.selected) || saved ? 'disabled' : ''} />${avatar(c.cat, true)}<div class="partner-copy"><h3>${esc(c.name)} ${c.cat === s.narrator ? '<span class="inline-note">刚才的解说伙伴</span>' : ''}</h3><p>${esc(c.role)}</p><div class="tool-line"><b>${TOOLS[c.tool].label}</b><span class="status ${isReady ? 'good' : 'attention'}">${saved ? '已加入' : toolState(t)}</span></div><div class="preference">${isReady ? `${c.model || c.effort ? `模型：${esc(c.model || '跟随工具')} · 思考强度：${esc(c.effort || '跟随工具')}` : '模型与思考强度跟随工具设置'}` : '完成后回到这里，选择和修改都会保留'}</div></div><div class="card-action">${action}</div></article>`;
}
export function setup(s) {
  const installed = Object.keys(TOOLS).filter((id) => s.tools[id].installed);
  const count = selected(s).length;
  return `<section class="page setup-page">${progress(1)}<div class="page-heading"><div><h1>${installed.length ? '这些伙伴，可以陪你开始' : '先连接一个你喜欢的工具'}</h1><p>${installed.length ? '选择要加入的伙伴。已有配置直接复用，其他设置以后再调。' : '装好并完成工具自己的配置，我们就从这里继续。'}</p></div>${button(`${icon('reset', 16)} 重新检测`, 'redetect', 'text-button')}</div><div class="quiet-note">${icon('people', 18)}<span>来自工具的安装与配置状态；实际调用会在第一次回复时验证。</span></div>${
    installed.length
      ? `<div class="partners">${installed.map((id) => recommendation(s, id)).join('')}</div>`
      : `<div class="empty-tools"><div class="empty-cat">${catSprite('maine')}</div><h2>一位伙伴，就能开始</h2><p>已经用过 Codex、Claude Code 或 DSH？<br>安装并配置其中一个即可，无需把密钥再填一遍。</p><div class="install-options">${Object.entries(
          TOOLS,
        )
          .map(([id, t]) => button(`${icon('plus', 16)} ${t.label}`, `install:${id}`, 'secondary'))
          .join(
            '',
          )}</div>${button('我已安装，重新检测', 'redetect', 'primary')}<p class="fine">安装引导是下一阶段；本原型可预览返回与重新检测的流程。</p></div>`
  }<details class="advanced"><summary>其他接入方式</summary><p>工具使用 API 密钥或自定义服务？已有配置仍会沿用。仅在缺少配置时添加账户。</p>${button('前往账户与登录', 'nav:accounts', 'text-button')}<p class="fine">自定义程序、ACP、语音和上下文策略在成员详情中管理，不必现在填写。</p></details>${s.error ? `<div role="alert" class="notice warning"><b>部分伙伴已经加入</b><p>${esc(s.error)}</p>${button(`先和已加入的 ${s.members.length} 位开始`, 'useCreated', 'text-button')}</div>` : ''}<div class="sticky-footer"><div><b>${count ? `已选择 ${count} 位伙伴` : '还没有选择伙伴'}</b><p>${count === 1 ? '先从你和它开始，之后可以邀请更多伙伴。' : count > 1 ? '一次确认，组成你的团队。' : '选择一个已配置好的工具即可继续。'}</p></div>${button(`${s.error ? '重试未完成项' : `确认并加入${count ? ` ${count} 位伙伴` : ''}`} ${icon('arrow', 16)}`, 'create', 'primary', canCreate(s) ? '' : 'disabled')}</div></section>`;
}
export function handoff(s) {
  const lead = s.members[0];
  return `<section class="handoff-page">${progress(2)}<div class="handoff-cats">${s.members.map((m) => `<div>${catSprite(m.cat, 'wave')}<b>${esc(m.name)}</b><span>${TOOLS[m.tool].label}</span></div>`).join('')}</div><p class="eyebrow">刚才是示范 · 现在是你选择的伙伴</p><h1>${s.members.length === 1 ? '先从你和它开始。' : '你的伙伴，都在这里了。'}</h1><p class="intro">${esc(lead.name)}会先陪你开始。<br>${s.members.length === 1 ? '另外两位留在示范里，以后随时可以邀请更多伙伴。' : '你可以 @ 任何一位，也可以让它们互相搭把手。'}</p><div class="handoff-summary">${avatar(lead.cat)}<span><b>${esc(lead.name)}</b><small>默认回复伙伴 · ${toolSummary(lead)}</small></span></div>${button(`开始对话 ${icon('arrow', 16)}`, 'chat', 'primary big')}<p class="fine">原型中的成员保存为演示数据。下一页可输入自己的话，回复为模拟。</p></section>`;
}
export function chat(s) {
  const lead = s.members[0];
  if (!lead) return setup(s);
  const tips = s.guide === 'unhandled';
  return `<section class="chat-page"><header class="chat-header"><div>${avatar(lead.cat)}<b>${esc(lead.name)}</b><span class="muted">${TOOLS[lead.tool].label}</span></div>${button(`${icon('people', 16)} 我的伙伴`, 'nav:members', 'text-button')}</header><div class="chat-body">${!s.messages.length ? `<div class="chat-empty">${catSprite(lead.cat)}<h1>从你的一个想法开始。</h1><p>可以先说说你想做什么，也可以随意聊聊。</p><div class="suggestions">${button('帮我梳理一个项目想法', 'suggest:project', 'suggestion')}${button(s.members.length > 1 ? '请两位伙伴一起审阅这段代码' : '帮我审阅一段代码', 'suggest:review', 'suggestion')}</div><small>点建议只填入输入框，你可以修改后再发送。</small></div>` : s.messages.map((m) => (m.from === 'user' ? `<div class="user-message">${esc(m.text)}</div>` : `<article class="cat-message">${avatar(lead.cat)}<div><div class="message-author">${esc(lead.name)}<span>模拟回复</span></div><div class="bubble pre-line">${esc(m.text)}</div></div></article>`)).join('')}${s.exchange === 'sent' ? `<div class="response-state">${avatar(lead.cat)}<span>消息已保留，正在等待回复…</span></div>` : s.exchange === 'failed' ? `<div class="notice warning" role="alert"><b>这次没有收到回复</b><p>你的消息和伙伴配置都在，可以重试。</p>${button('重试回复', 'reply', 'secondary')}</div>` : ''}</div><div class="chat-bottom">${tips ? `<div class="entry-tip"><span>${icon('help', 17)} 随时从设置调整伙伴或管理登录。</span>${button('看看入口', 'showGuide', 'text-button')}${button('先不看', 'skipGuide', 'text-button')}</div>` : ''}<form class="composer" id="composer"><textarea id="message" aria-label="输入消息" placeholder="输入消息…（@ 召唤伙伴）" rows="2">${esc(s.draft)}</textarea><div><span class="muted">${esc(lead.name)} · ${TOOLS[lead.tool].label}</span><button class="send" aria-label="发送消息" ${s.exchange === 'sent' ? 'disabled' : ''}>${icon('send', 19)}</button></div></form><p class="composer-note">交互原型：输入会保留在本浏览器，回复为模拟，不调用模型。</p></div>${button(avatar(lead.cat), 'concierge', 'catball', `aria-label="猫猫球：${esc(lead.name)}"`)}</section>`;
}
