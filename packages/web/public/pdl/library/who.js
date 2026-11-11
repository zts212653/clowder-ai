/* 边界：一个含义一个组件、不为接口定制、不按位置推导样式 */
/* 身份：成员、用户、插件、系统都是同一个 from 结构 { kind, id }。
   对话消息、引用、队列、正在执行、工作台列表……所有位置都用这一份渲染；
   不同组件只是选不同的形态，决定显示到哪一级：
     dot     只有颜色（悬停看全名）
     avatar  头像（悬停看全名）
     chip    头像，悬停展开成 头像 + 名字
     name    名字（成员色）
     title   名字 + 句柄（列表行标题用）
     line    头像 + 名字 + 句柄
     text    纯文字（提示、通知里用） */
'use strict';
/* 身份的数据经引擎的 WHO_DATA 读（应用登记：成员、你、插件的身份贡献、连接器、执行状态、回调授权健康） */

/* from 和共用的 MessageFrom 一致：
     { kind: 'user', userId } · { kind: 'agent', catId } · { kind: 'external', connectorId, sender?: { id, name? }, address? }
     { kind: 'plugin', instanceId } · { kind: 'system', service }
   from 里没有名字、图标、颜色。显示身份按 resolveMessageSender 的顺序解析：消息的 source（label / icon / themeColor / sender）
   → 身份登记（插件清单里的 identity 贡献、连接器定义：displayName / icon / color）→ 默认值。
   兼容：成员 id 字符串、'me'、'system'；{ kind: 'member', id } / { kind: 'plugin', id } / { kind: 'system', id, name }。 */
function fromOf(x) {
  if (!x) return { kind: 'system', service: 'system' };
  if (typeof x === 'string') return x === 'user' || x === 'me' ? { kind: 'user', userId: 'me' } : x === 'system' ? { kind: 'system', service: 'system' } : senderDef(x) && !WHO_DATA.members().some(function (m) { return m.id === x; }) ? { kind: 'plugin', instanceId: x } : { kind: 'agent', catId: x };
  if (x.kind === 'agent' || x.kind === 'member') return { kind: 'agent', catId: x.catId || x.id, name: x.name };
  if (x.kind === 'user') return { kind: 'user', userId: x.userId || 'me' };
  if (x.kind === 'plugin') return { kind: 'plugin', instanceId: senderAlias(x.instanceId || x.id) || x.instanceId || x.id, name: x.name, icon: x.icon };   /* icon：这个实例自己的头像（插件的称呼里换过的），优先于插件包的图标 */
  if (x.kind === 'external') return x;
  if (x.kind === 'system') return { kind: 'system', service: x.service || x.id || 'system', name: x.name };
  if (x.id == null && x.name != null) return { kind: 'draft', name: x.name, tint: x.tint, color: x.color, fixedColor: x.fixedColor, avatarPath: x.avatarPath };   /* 还不是成员的身份（新建成员的表单、所有者）：名字 + 代表色，不按 id 去查 */
  return { kind: 'agent', catId: x.id, name: x.name };   /* 传进来的是成员对象 */
}
/* 旧数据里的插件 id → 身份登记里的 id：身份贡献自己声明 aliases（本地真实对话：{ kind: 'plugin', id: 'github' } 是 GitHub 的 PR 等待通知，GitHub 插件的 github-wait 身份声明了它） */
function senderAlias(id) { const EXT = WHO_DATA.plugins(); for (const k in EXT) { const hit = (EXT[k].identities || []).find(function (d) { return (d.aliases || []).indexOf(id) >= 0; }); if (hit) return hit.id; } return null; }
/* 身份登记：插件清单的 identity 贡献 { type: 'identity', id, displayName, icon?, color? }，连接器定义 { id, displayName, icon, themeColor } */
function senderDef(id) {
  if (!id) return null;
  /* 图标写的是包内的名字（插件清单贡献的图标登记成 plugin:<包>/<名字>），找不到就当内置图标名 */
  const EXT = WHO_DATA.plugins(), ic = function (k, n) { return n && ICONS['plugin:' + k + '/' + n] ? 'plugin:' + k + '/' + n : n; };
  for (const k in EXT) { const hit = (EXT[k].identities || []).find(function (d) { return d.id === id; }); if (hit) return Object.assign({ plugin: k }, hit, { icon: ic(k, hit.icon) }); }
  const k = EXT[id] ? id : Object.keys(EXT).find(function (x) { return EXT[x].instanceId === id; });   /* 插件实例 id（收件人、收据、回复）也认 */
  return k ? { id: id, plugin: k, displayName: EXT[k].name, icon: ic(k, EXT[k].icon), color: EXT[k].themeColor } : null;
}
/* 声明了颜色的身份：只取色相（数据），明度 / 彩度跟当前主题的成员色走——CSS 相对颜色直接算，主题变了自动跟着变，不在渲染时读样式 */
function senderHue(hex) { return Math.round(hexOk(hex).H); }
/* 你的消息气泡：色相和彩度来自你的代表色，明度和每种外观下的彩度比例由主题定（--bg-bubble、--bubble-cmul）；没有代表色就是主题的气泡色 */
function whoMeBubble() { const c = WHO_DATA.me().color, o = c && c.primary ? hexOk(c.primary) : null; return o ? ';--me-h:' + Math.round(o.H) + ';--me-c:' + o.C.toFixed(3) : ''; }
/* 原始身份色对应主题声明的参考色档；精确匹配优先，其余按色相距离，等距保持声明顺序。 */
function whoTint(color) {
  const palette = PDL_WHO.member.palette, p = color && color.primary ? color.primary.toLowerCase() : '', k = palette.indexOf(p);
  if (k >= 0) return k + 1;
  if (!p) return 0;
  const hue = function (hex) { const n = parseInt(hex.slice(1), 16), r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn || 1; return ((mx === r ? (g - b) / d : mx === g ? 2 + (b - r) / d : 4 + (r - g) / d) * 60 + 360) % 360; };
  const hh = hue(p); let best = 0, bd = 999;
  palette.forEach(function (x, i) { const dd = Math.min(Math.abs(hue(x) - hh), 360 - Math.abs(hue(x) - hh)); if (dd < bd) { bd = dd; best = i; } });
  return best + 1;
}
/* 后端身份色与手选的固定 hex 是两份数据；固定色覆盖文字，底色仍使用身份的主题档。 */
function whoColors(m) {
  const step = m.color && typeof m.color === 'object' ? whoTint(m.color) : m.tint || 0, fixed = m.fixedColor || (typeof m.color === 'string' ? m.color : '');
  return { step: step, fixed: fixed, color: fixed || (step ? 'var(--name-' + step + ')' : null), bg: 'var(--tint-' + (step || 1) + ')' };
}
/* 解析成显示需要的一份信息；颜色只取 token。source 是消息上的来源（可选）。side：只有你是 right，其余没写就是 left（消息模板的左右只从这里推出） */
function whoInfo(x, source) {
  const f = fromOf(x); source = source || {};
  if (f.kind === 'draft') { const nm = String(f.name || '?'), c = whoColors(f); return { kind: 'member', id: '', name: nm, handle: '', glyph: h(nm.slice(0, 1)), img: f.avatarPath ? ioFile(f.avatarPath) : null, step: c.step, color: c.color, bg: c.fixed || c.bg, ink: 'var(--fg-strong)', shape: 'round' }; }
  if (f.kind === 'agent') { const m = WHO_DATA.member(f.catId, f.name), c = whoColors(m);   /* 成员的结构化信息由应用给（查不到时应用自己按名字整理），这里只画 */ return { kind: 'member', id: m.id, name: m.name, handle: m.handle, glyph: h(m.name.slice(0, 1)), img: ioFile(m.avatarPath), step: c.step, color: c.color, bg: c.bg, ink: 'var(--fg-strong)', shape: 'round', act: 'open', data: ' data-page="member" data-p="' + h(m.id) + '"', verb: tc('who.viewMember') }; }
  if (f.kind === 'user') { const ME = WHO_DATA.me(); return { kind: 'user', side: 'right', id: 'me', name: ME.name, handle: ME.handle, glyph: h(ME.name.slice(0, 1).toUpperCase()), color: ME.color && ME.color.primary ? 'oklch(from var(--name-1) l c ' + senderHue(ME.color.primary) + ')' : 'var(--fg-strong)', bg: 'var(--bg-selected)', ink: 'var(--fg-strong)', shape: 'round' }; }
  /* 外部的人（不是宿主内置连接器来的）：和成员同一个外壳——圆形首字头像 + 自己的名字，不带来源名和种类 */
  if (f.kind === 'external' && !WHO_DATA.builtinConnector(f.connectorId) && f.sender) { const nm = f.sender.name || f.sender.id; return { kind: 'external', id: f.connectorId + ':' + f.sender.id, name: nm, handle: '', glyph: h(nm.slice(0, 1)), color: null, bg: 'var(--bg-raised)', ink: 'var(--fg-strong)', shape: 'round' }; }
  const id = f.kind === 'plugin' ? f.instanceId : f.kind === 'external' ? f.connectorId : f.service;
  const def = f.kind === 'system' ? null : senderDef(source.connector || id);
  const srcName = source.label || (def && def.displayName) || f.name || id || '';
  const base = srcName || (f.kind === 'plugin' ? tc('who.plugin') : f.kind === 'system' ? f.service : tc('who.unknown'));
  const actor = source.sender && source.sender.name || f.sender && f.sender.name || '';
  const col = source.themeColor || def && def.color, hue = col ? senderHue(col) : null, nm = hue != null ? 'oklch(from var(--name-1) l c ' + hue + ')' : null;
  const ic = [source.icon, f.icon, def && def.icon].find(function (n) { return n && (glyphSrc(n) || ICONS[n]); }) || (f.kind === 'system' ? 'system' : 'robot'), img = glyphSrc(ic);
  return { kind: f.kind === 'external' ? 'external' : f.kind, id: id, name: actor ? base + ' · ' + actor : base, handle: '',   /* 不加“插件 / 系统”这类种类标签：只有成员有句柄 */
    glyph: icon(img ? (f.kind === 'system' ? 'system' : 'robot') : ic, 13), img: img,   /* 包图片沿用同一个头像铺满口；图标仍用原来的尺寸。 */
    color: nm, bg: 'var(--bg-raised)', ink: nm || 'var(--fg-strong)', shape: 'square',   /* 形状只看是不是人（成员、你）：其余来源一律方形，不枚举种类 */
    act: def && def.plugin ? 'open' : '', data: def && def.plugin ? ' data-page="extItem" data-p="' + def.plugin + '"' : '' };
}
/* 悬停打开的声明只在 PDL_WHO 声明的放置处生效（place：调用方说这是哪个放置，比如消息的作者行 author）；别处的头像 / 名字没有悬停卡 */
function whoHover(w, place) { const d = PDL_WHO[w.kind]; return d && d.hover && place && d.at === place ? ' data-hover="' + d.hover + '"' + argAttrs(d.hoverArgs) + ' data-who="' + h(w.id) + '"' : ''; }
function whoTip(w) { return w.name + (w.handle ? ' ' + w.handle : ''); }
/* 头像：一个组件，只有尺寸不同——o.size 是档位 xs（和所在那行文字一样高，约 1.25em）| s | m | l | xl；成员数据有头像图（avatarPath）就画图，没有就是首字；
   执行中（外圈扩散，和全局节拍同相位）/ 卡住（静止警示圈）由 whoLive(成员 id) 决定，不接受调用方传入；o.click 为真时点头像去看这个成员/插件；o.tip 覆盖悬停文字；o.place 放置处（悬停卡只在 PDL_WHO 声明的放置处，见 whoHover） */
/* 档位：xs | s | m（默认）| l | xl；line / sm / lg …映射到档位 */
const AV_STEP = { line: 'xs', sm: 's', md: 'm', base: 'm', lg: 'xl' };
/* 成员头像总带 data-live（谁）/ data-turn（哪一回合）/ data-status（现在的状态，空 = 不在执行）：回合时钟跨过安静门槛时只改这几个属性（cafe.js liveSync），不整页重画 */
/* 圈的状态表里的节拍档（颜色和幅度在 CSS 的同一张表里）：卡住和出错用 alert（1 拍，快），其余 ambient */
function whoAva(x, o) {
  o = o || {};
  const step = AV_STEP[o.size] || o.size || 'm';
  const w = whoInfo(x, o.source), tip = o.tip || whoTip(w), fixed = o.live !== undefined, live = w.kind !== 'member' ? '' : fixed ? o.live || '' : WHO_DATA.live ? WHO_DATA.live(w.id, o.turn) : '',   /* live：调用的数据已经给出这个头像代表的那件事的执行状态（投递头像），组件只按它画，不再自己读 */   /* 执行状态只有一个来源：成员这一回合的状态（whoLive 给出 CatStatusType），调用方不能按位置传；所有位置的这只猫一起变 */
    cls = 'avatar av-' + step + (live ? ' run' : ''),
    attrs = ' data-kind="' + w.kind + '" data-shape="' + w.shape + '"' + (w.kind === 'member' ? (fixed ? '' : ' data-live="' + h(w.id) + '"' + (o.turn != null ? ' data-turn="' + h(o.turn) + '"' : '')) + ' data-status="' + live + '"' : '') + (w.img ? ' data-img' : '') + whoHover(w, o.place), bg = '--av-bg:' + w.bg + ';--av-ink:' + w.ink + ';--c:' + (w.color || 'initial') + (w.img ? ';--av-img:url(&quot;' + h(w.img) + '&quot;)' : '');   /* 形状、底色、字色、头像图都来自 whoInfo 推出的属性；样式只认 data-shape / data-img（图盖在首字上，读不到图时首字露出来） */
  const face = w.img ? '' : w.glyph;   /* 有图就只画图，首字和图二选一 */
  const hd = whoHealth(w, o), wrap = function (a) { return hd ? '<span class="av-wrap">' + a + hd + '</span>' : a; };
  if (o.click && w.act) return wrap('<button type="button" class="' + cls + '"' + attrs + ' style="' + bg + '" data-act="' + w.act + '"' + (w.data || ' data-id="' + w.id + '"') + ' data-tip="' + h((w.verb || tc('who.view')) + tip) + '" aria-label="' + h(tip) + '">' + face + '</button>');
  return wrap('<span class="' + cls + '"' + attrs + ' style="' + bg + '"' + (o.tip !== false ? ' data-tip="' + h(tip) + '"' : '') + ' aria-hidden="' + (o.tip === false) + '"' + (o.tip !== false ? ' role="img" aria-label="' + h(tip) + '"' : '') + '>' + face + '</span>');
}
/* 回调授权健康点（头像的能力，o.health 开）：只用在 运维 › 可观测 › 回调鉴权 的“受影响的猫”里（对话侧每只猫挂点的做法被否了，见 hub-icons.tsx）——近 24 小时有失败就挂一个点，
   悬停看原因 × 次数、常用工具；点它去设置 › 运维看详情（区域模型自动给“返回”）。数据只读 CB_AUTH（/api/callback-auth/snapshot） */
function whoHealth(w, o) {
  const CB_AUTH = WHO_DATA.health(); if (!o.health || w.kind !== 'member' || !CB_AUTH) return '';
  const c = CB_AUTH.byCat[w.id]; if (!c || c.status === 'healthy') return '';
  const tip = tc('cbauth.healthTip', c.failures24h) + ' · ' + CB_AUTH.topReasons.map(function (r) { return r.name + ' ×' + r.count; }).join('、') + ' · ' + tc('cbauth.topTools') + ' ' + CB_AUTH.topTools.slice(0, 3).map(function (r) { return r.name; }).join('、');
  return '<span class="av-health" role="button" tabindex="0" data-health="' + c.status + '" data-act="cbAuthOpen" data-tip="' + h(tip) + '" aria-label="' + h(tip) + '"></span>';   /* 不能是 button：头像常在可点的行里（按钮里不能套按钮） */
}
function who(x, form, o) {
  o = o || {};
  const w = whoInfo(x);
  if (form === 'text') return w.name + (o.handle && w.handle ? ' ' + w.handle : '');
  if (form === 'dot') return lrDot('id', whoTip(w), w.color || 'initial');
  if (form === 'avatar') return whoAva(x, o);
  if (form === 'name') return '<span class="who-name" style="--c:' + (w.color || 'initial') + '">' + h(w.name) + '</span>';
  if (form === 'title') return h(w.name) + (w.handle ? ' <span class="plain">' + h(w.handle) + '</span>' : '');
  if (form === 'chip') return capsule({ lead: whoAva(x, { size: 'sm', tip: false }), body: '<span class="who-name" style="--c:' + (w.color || 'initial') + '">' + h(w.name) + '</span>' + (o.body || ''), tip: whoTip(w), cls: 'cap-who', style: whoVar(x) });
  return '<span class="who-line">' + whoAva(x, { size: o.size || 'sm', tip: false, click: o.click }) + '<span class="who-name" style="--c:' + (w.color || 'initial') + '">' + h(w.name) + '</span>' + (w.handle ? '<span class="plain">' + h(w.handle) + '</span>' : '') + '</span>';
}
/* 颜色：身份自带的颜色是数据（和名字一样随身份来）。支持颜色的组件在自己的根元素上写一个 --c（没有颜色就写 initial，不继承外层），
   默认值在组件自己的样式里声明：var(--c, var(--identity-fallback))——所有组件的默认都是同一个主题 token（中性色；主色只留给操作和链接） */
function whoVar(x, source) { return '--c:' + (whoInfo(x, source).color || 'initial'); }



/* ───────── 目录登记：身份 ───────── */
Object.assign(LIB_CATALOG, {
  avatarSteps: { g: 'identity', inline: true, via: ['prop:who', 'type:avatar'], ex: function () { return ['xs', 's', 'm', 'l', 'xl'].map(function (z) { return '<span class="cat-st">' + whoAva('sol', { size: z, tip: false }) + '<span class="mono faint">' + z + '</span></span>'; }).join(''); } },
  avatarShapes: { g: 'identity', inline: true, via: ['prop:who'], ex: function (s) { return ['sol', 'me', 'system', s.packageIdentity].map(function (x) { return whoAva(x, { size: 'l' }); }).join('') + who('opus', 'line') + who('sol', 'chip'); } },
  /* 执行光圈：状态 = 颜色 + 节奏；出问题时借用严重度的 warn / danger（通道唯一的有意重叠）。info / ok 不是光圈的状态：执行中用成员色，完成后光圈消失 */
  ring: { g: 'identity', inline: true, via: ['type:capsules', 'prop:who'], ex: function (s) { return s.executions.map(function (e) { return '<span class="cat-st">' + whoAva(e.id, { size: 'l', tip: false }) + '<span class="mono faint">' + e.status + '</span></span>'; }).join(''); },
    tones: function (t, s) { const st = { warn: 'suspected_stall', danger: 'error' }[t]; if (!st) return null; const e = s.executions.find(function (x) { return x.status === st; }); return e ? whoAva(e.id, { size: 'l', tip: false }) : null; } }
});
/* 身份的显示文字交给引擎（ENGINE_PARTS.whoText，应用经 whoText 取） */
ENGINE_PARTS.whoText = function (x, o) { return who(x, 'text', o); };

/* 身份组件只更新自己的状态属性；业务状态由 WHO_DATA 给出。 */
ENGINE_PARTS.whoSync = function () {
  document.querySelectorAll('[data-live]').forEach(function (el) {
    const row = el.closest('[data-tid]'), st = row ? WHO_DATA.threadLive(row.dataset.tid, el.dataset.live) : WHO_DATA.live(el.dataset.live, el.hasAttribute('data-turn') ? el.dataset.turn : null);
    if ((el.dataset.status || '') === st) return;
    el.setAttribute('data-status', st); if (el.classList.contains('avatar')) el.classList.toggle('run', !!st);
    localSync(el);
  });
};
