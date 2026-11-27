/* 边界：一个含义一个组件、不为接口定制、不按位置推导样式 */
/* 状态与提示：状态、提示条、数量、徽标、进度、提示（toast）、撤销条、读取状态（骨架 / 出错 / 空）、提示轮换 */
'use strict';
/* 数量：唯一的画法（分段、分类、组头、工具入口、提示翻页里的“几个”）。弱色小字，不是要你看的计数徽标（那是 badge） */
function qty(n, warn) { return '<span class="c num' + (warn ? ' warn' : '') + '">' + h(n) + '</span>'; }
/* 状态：圆点 + 文字；地方不够时文字省略（全文由外层的提示给出） */
/* 严重度（tone）：组件库唯一的一套四档——info 提示 / ok 正常 / warn 留意 / danger 出错。所有带严重度的组件都只写 data-tone，颜色由 [data-tone] → --tone-c 给出；
   严重度不是“多显眼”（那是注意力层级，暂缓），也不是计数（计数徽标是中性的） */
const TONES = ['info', 'ok', 'warn', 'danger'];
function toneAttr(t) { return TONES.indexOf(t) >= 0 ? ' data-tone="' + t + '"' : ''; }
function status(kind, text, strong) { return '<span class="status"' + toneAttr(kind) + '>' + (strong ? '<b>' + h(strong) + '</b>' : '') + '<span class="status-t">' + h(text) + '</span></span>'; }   /* 放不下时省略（被截断的字悬停看全文：引擎的通用规则） */
const TONE_ICON = { info: 'info', ok: 'check', warn: 'alert', danger: 'alert' };
function notice(o) { return '<div class="notice"' + toneAttr(o.tone) + (o.note ? ' data-note="' + o.note + '"' : '') + '>' + icon(TONE_ICON[o.tone] || 'info', 18) + '<div class="grow">' + o.text + '</div>' + (o.action || '') + '</div>'; }
/* 一句提示（可带一个操作） */
/* 轻提示：唯一的画法。a 是一个或几个操作 { label, act, data（属性串或参数对象） }，操作是文字按钮 */
function toastHtml(t, a, o) { o = o || {}; const acts = [].concat(a || []).map(function (x) { return btn(x.label, { link: true, act: x.act, data: typeof x.data === 'string' ? x.data : argAttrs(x.data) }); }).join(''); return '<div class="toast' + (o.cls ? ' ' + o.cls : '') + '"' + toneAttr(o.tone) + (o.attrs || '') + ' role="status"><span>' + h(t) + '</span>' + acts + '</div>'; }
/* 色调点：标签颜色这类 */
function tintDot(n) { return lrDot('id', '', typeof n === 'string' && n.charAt(0) === '#' ? n : 'var(--tint-' + (+n || 1) + ')'); }   /* 色调点：主题色调槽位（1–6），或者取色器选的固定值（#hex） */
/* 徽标（组件库）：两种形态，由数据决定——有数就是计数胶囊（超过 99 写 99+），只有“有变化”没有数就是小圆点。
   计数（未读、待处理、@你）不是严重度：所有计数徽标同一个强调色胶囊（“等你来看”）；只有真正带严重度的指示才传 tone（warn / danger …），走同一套 data-tone */
function railActivity(value, corner = true) {
  if (value?.kind !== 'busy' && value?.kind !== 'unread') return null;
  const busy = value.kind === 'busy';
  return {
    label: value.label,
    html: '<span class="badge ' + (corner ? 'corner ' : 'trail ') + (busy ? 'rail-busy' : 'dot') + '" data-tone="' +
      (busy ? 'info' : 'danger') + '" data-rail-activity="' + value.kind + '" aria-hidden="true"></span>',
  };
}
function badge(n, o) {
  o = o || {};
  const a = toneAttr(o.tone) + (o.tip ? ' data-tip="' + h(o.tip) + '"' : '');
  const cn = o.corner ? ' corner' : '';   /* corner：贴宿主右上角（摆放是徽标自己的选项） */
  if (n === true && !o.at) return '<span class="badge dot' + cn + '"' + a + '></span>';
  if (!n) return '';
  return '<span class="badge count num' + cn + '"' + a + '>' + (o.at ? h(WHO_DATA.me().handle) + (n === true ? '' : ' ') : '') + (n === true ? '' : n > 99 ? '99+' : n) + '</span>';   /* at：有人提到你——同一个计数胶囊，前面写你的提及名（用户身份数据里的 mentionPatterns[0]，如 @lang），改了提及名这里跟着变 */
}
/* 撤销条：一句话 + 几个操作（acts: [{ label, act, data: {k: v} }]） */
function undoBar(text, acts) { return toastHtml(text, acts, { cls: 'raised', attrs: ' data-undo' }); }   /* 撤销条就是轻提示（带操作），抬高一档让开底部的轻提示 */
function progBar(pct, tone) { return '<span class="ws-prog' + (tone ? ' ' + tone : '') + '"><i style="--u-width:' + Math.max(0, Math.min(100, pct)) + '%" class="u-v-width"></i></span>'; }

/* 视图和块的读取状态（组件库，唯一一处）：加载中 = 骨架（可带一行淡字）；出错 = 一行危险色调的提示；
   数据过期 = 一行留意色调的提示（内容照常画在下面）；空 = 空状态。视图 / 块声明文字（loading / error / stale / empty）；
   只有声明了 retry 并且这个状态下有动作，才带一个重试（没有默认的原位重试） */
function viewState(kind, o) {
  o = o || {};
  const again = function (label) { return o.retry && o.retry.act ? btn(label, { sm: true, act: o.retry.act, data: o.retry.data || '' }) : ''; };
  if (kind === 'loading') return skel(o.count || 3, o.shape) + (o.text ? '<div class="vw-label below">' + h(o.text) + '</div>' : '');
  if (kind === 'error') return notice({ tone: 'danger', text: h(o.text || tc('frame.loadError')), action: again(tc('common.retry')) });
  if (kind === 'stale') return notice({ tone: 'warn', text: h(o.text || tc('frame.stale')), action: again(tc('frame.reload')) });
  return emptyState(o.text || tc('list.emptyState'));
}
/* 空状态（组件库统一的样子）：一句话 + 弱色补充 + 操作。e 可以是字符串，或 { text, sub, actions: [btn 参数…] } */
/* 空状态：唯一的画法。e 是文字，或 { text | html, sub, actions | acts（已渲染的操作）, help, icon（"选一项"的占位：大图标） }。侧栏里小一号是区域的 token（--empty-*），不是参数 */
function emptyState(e) {
  if (e == null) e = tc('list.emptyState');
  if (typeof e === 'string') e = { text: e };
  const acts = e.acts || (e.actions || []).map(function (a) { return btn(a.label, { sm: true, primary: !!a.primary, icon: a.icon, act: a.act, data: argAttrs(a.data) }); }).join('');
  return '<div class="empty' + (e.icon ? ' lead' : '') + '">' + (e.icon ? icon(e.icon, 28) : '') + '<span>' + (e.html != null ? e.html : h(e.text || '')) + (e.help || '') + '</span>' + (e.sub ? '<span class="faint">' + h(e.sub) + '</span>' : '') + (acts ? '<span class="ws-inline">' + acts + '</span>' : '') + '</div>';
}

/* 轮换（组件库的通用行为）：data-rot 的元素同一时刻只露一个子项，多于一个时按节拍轮换（每项 8 拍），悬停暂停。
   纯 CSS：显示哪一项是时间的函数（--rot-t 按 steps(n) 随动画走，子项在 --rot-t 等于自己的 --i 时露出），不存游标、不用计时器；
   诞生时和其它循环一样对齐到大拍（motion.js 的 animationstart）。rotHtml 给出容器和每项的序号 */
function rotHtml(tag, cls, items, attrs) {
  const n = items.length;
  return '<' + tag + ' class="' + cls + '"' + (n > 1 ? ' data-rot style="--n:' + n + '"' : '') + (attrs || '') + '>' + items.map(function (x, i) { return x.replace(/^<(\w+)/, '<$1 style="--i:' + i + '"'); }).join('') + '</' + tag + '>';
}
/* 展开区里的小标题和一行说明，也只有一种写法 */
/* 加载中：骨架行（列表、弹窗里的列表都用它） */
/* 骨架：唯一的画法。shape 'row'（默认，列表行）或 'card'（卡片网格：预览 + 两行字）；每一块是同一个骨架块、同一个背景档的节拍 */
function skelBar(k) { return '<div class="skel ' + k + '" aria-hidden="true"></div>'; }
function skel(n, shape) {
  const a = []; for (let i = 0; i < n; i++) a.push(shape === 'card' ? '<div class="cgrid-card">' + skelBar('prev') + '<div class="cgrid-meta">' + skelBar('line') + skelBar('line short') + '</div></div>' : skelBar('row'));
  return '<div class="' + (shape === 'card' ? 'cgrid' : 'group') + '" aria-busy="true">' + a.join('') + '</div>';
}
/* 数据读取中（组件库，唯一一处）：三点按共用节拍轮流起伏，表示正在读取数据（不是容器骨架） */
function loadingDots(label) { return '<span class="load-dots" role="status" aria-label="' + h(label || tc('common.loading')) + '"><i aria-hidden="true"></i><i aria-hidden="true"></i><i aria-hidden="true"></i></span>'; }
/* ───────── 目录登记：这个文件里的组件 ───────── */
Object.assign(LIB_CATALOG, {
  tooltip: { g: 'structure', inline: true, via: ['prop:tip', 'prop:help'], ex: function (s) { return btn(s.more, { act: 'noop', data: ' data-tip="' + h(s.sub) + '"' }) + helpTip(s.sub); } },
  toast: { g: 'alerts', inline: true, via: ['act:toast'], ex: function (s) { return toastHtml(s.toneText.ok, { label: tc('common.undo'), act: 'noop', data: '' }, { cls: 'cat-static' }); },
    tones: function (t, s) { return toastHtml(s.toneText[t], null, { cls: 'cat-static', tone: t }); } },
  badge: { g: 'alerts', inline: true, via: ['type:threads', 'shell'], ex: function () { return badge(8) + badge(true) + badge(3, { at: true }) + badge(2, { tone: 'warn' }); },
    tones: function (t) { return badge(3, { tone: t }) + badge(true, { tone: t }); },
    count: function () { return badge(4) + badge(120) + badge(true) + badge(2, { at: true }); } },
  loadingDots: { g: 'basics', inline: true, via: ['type:stream'], ex: function () { return loadingDots(); } }
});
