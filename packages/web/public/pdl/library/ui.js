/* 边界：一个含义一个组件、不为接口定制、不按位置推导样式 */
/* 组件库：小组件（按钮、分段、选择、输入、状态、页头、小节、设置行、字段、提示、选项、搜索、插件框、返回）。
   它们是组件库的一部分，页面和视图模型只调用、不拼 HTML。 */
'use strict';
/* 时间和大小的写法（PDL 的 { of, fmt }）：接口给时间戳 / 字节数，这里按“你”的时区写成字。ago 侧栏的相对时间 · day 今天 / N月N日 · at 今天 hh:mm / 昨天 hh:mm / N 天前 / N月N日 hh:mm · hm 时:分 · stamp MM/DD hh:mm（对话和消息的时间，不分今天） · bytes GB / MB / KB（一位小数） */
function fmtParts(ts) { const tz = WHO_DATA.me().timeZone, o = {}; new Intl.DateTimeFormat('en-US', { timeZone: tz || undefined, year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(ts).forEach(function (p) { o[p.type] = p.value; }); return o; }
function fmtDayNo(o) { return Date.UTC(+o.year, +o.month - 1, +o.day) / 864e5; }
const FORMATS = {
  ago: function (ts) { if (typeof ts === 'string') ts = /^\d+$/.test(ts) ? Number(ts) : Date.parse(ts); if (!isFinite(ts)) return ''; const s = Math.max(0, (ioNow() - ts) / 1000);   /* 时间可能是毫秒数、数字串或 ISO 串；读不出来就不写 */ return s < 60 ? tc('common.justNow') : s < 3600 ? tc('format.minutes', Math.round(s / 60)) : s < 86400 ? tc('format.hours', Math.round(s / 3600)) : tc('format.days', Math.round(s / 86400)); },
  hm: function (ts) { const o = fmtParts(ts); return o.hour + ':' + o.minute; },
  stamp: function (ts) { const o = fmtParts(ts); return ('0' + o.month).slice(-2) + '/' + ('0' + o.day).slice(-2) + ' ' + o.hour + ':' + o.minute; },
  day: function (ts) { const o = fmtParts(ts); return fmtDayNo(o) === fmtDayNo(fmtParts(ioNow())) ? tc('format.today') : tc('format.date', +o.month, +o.day); },
  at: function (ts) { const o = fmtParts(ts), d = fmtDayNo(fmtParts(ioNow())) - fmtDayNo(o), hm = o.hour + ':' + o.minute; return d <= 0 ? tc('format.todayAt', hm) : d === 1 ? tc('format.yesterdayAt', hm) : d < 7 ? tc('format.daysAgo', Math.round((ioNow() - ts) / 864e5)) : tc('format.date', +o.month, +o.day) + ' ' + hm; },
  floorMinutes: function (seconds) { return Math.floor(seconds / 60); },
  num: function (n) { return Number(n).toLocaleString(); },
  datetime: function (ts) { return new Date(ts).toLocaleString(undefined, { timeZone: WHO_DATA.me().timeZone || undefined }); },
  date: function (ts) { return new Date(ts).toLocaleDateString(undefined, { timeZone: WHO_DATA.me().timeZone || undefined }); },
  duration: function (sec) { return ENGINE_PARTS.duration(sec); },
  clock: function (sec) { return clockText(sec); },
  clockH: function (sec) { return clockText(sec, true); },
  latency: function (ms) { return ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms'; },
  compact: function (n) { return n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n); },
  dec2: function (n) { return Number(n).toFixed(2); },
  basename: function (path) { return String(path).replace(/:\d+(-\d+)?$/, '').split('/').filter(Boolean).pop(); },
  localized: function (value) { if (typeof value === 'string') return value; const lang = S.lang || 'zh', t = value.translations || {}; return t[lang] || (lang === 'zh' ? t['zh-CN'] : '') || value.default; },
  jsonValue: function (value) { return typeof value === 'string' ? value : JSON.stringify(value); },
  json: function (value) { return JSON.stringify(value); },
  jsonLines: function (entries) { return entries.map(function (entry) { return JSON.stringify(entry); }).join('\n'); },
  noFinalPeriod: function (text) { return String(text).replace(/。$/, ''); },
  stem: function (name) { return String(name).replace(/\.[^.]+$/, ''); },
  markdown: function (text) { return mdLite(text); },
  escaped: function (text) { return h(text); },
  urlLabel: function (url) { return String(url).replace('https://', ''); },
  dirname: function (path) { return String(path).split('/').slice(0, -1).join('/'); },
  console: function (args) { return Array.isArray(args) ? args.map(function (v) { return typeof v === 'string' ? v : JSON.stringify(v); }).join(' ') : args; },
  server: function (target) { return target.host + ':' + target.port; },
  endpoint: function (target) { return FORMATS.server(target) + target.path; },
  withoutMention: function (value) { return value.text.replace(new RegExp('^' + value.handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*'), ''); },
  toolCall: function (value) { const name = value.call ? value.call.toolName || value.call.label.replace(/^.*? → /, '') : value.label; return name + (value.input ? ' ' + value.input : ''); },
  firstLine: function (text) { return String(text).split('\n').find(function (line) { return line.trim(); }); },
  /* Markdown 的第一行当一行字（去掉标记）和其余部分：一段说明收起时只露第一行，展开时接着画后面的，不把第一行再画一遍 */
  plainLine: function (text) { return htmlText(mdLite(FORMATS.firstLine(text) || '')); },
  markdownRest: function (text) { const lines = String(text).split('\n'), i = lines.findIndex(function (line) { return line.trim(); }); const rest = lines.slice(i + 1).join('\n'); return rest.trim() ? mdLite(rest) : ''; },
  identity: function (identity) { return whoText(identity); },
  identityHandle: function (identity) { return whoText(identity, { handle: true }); },
  color: function (value) { const c = whoColors('primary' in value ? { color: value } : value); return c.fixed || getComputedStyle(document.documentElement).getPropertyValue('--name-' + (c.step || 1)).trim().toLowerCase(); },
  bytes: function (n) { const r = function (d) { return Math.round(n / d * 10) / 10; }; return n >= 1073741824 ? tc('format.gb', r(1073741824)) : n >= 1048576 ? tc('format.mb', r(1048576)) : tc('format.kb', r(1024)); }
};
ENGINE_PARTS.format = function (kind, v) { return FORMATS[kind](v); };
ENGINE_PARTS.duration = function (sec) { sec = Math.round(sec); return sec >= 60 ? tc('format.duration.minutesSeconds', Math.floor(sec / 60), sec % 60) : tc('format.duration.seconds', sec); };
/* 导航行：唯一的画法（侧栏导航、页面目录）。o = { label, icon, attrs（data-act 等属性串）, current, trail（已渲染的尾部）, cls } */
function navRow(o) { return '<button type="button" class="nav-item' + (o.cls ? ' ' + o.cls : '') + '"' + (o.attrs || '') + (o.current ? ' aria-current="' + (o.current === true ? 'page' : o.current) + '"' : '') + '>' + (o.icon ? icon(o.icon) : '') + '<span>' + h(o.label) + '</span>' + (o.trail || '') + '</button>'; }   /* 名字一行，放不下省略，悬停看全文；从不在词中间折行 */
/* 数量：唯一的画法（分段、分类、组头、工具入口、提示翻页里的“几个”）。弱色小字，不是要你看的计数徽标（那是 badge） */
function qty(n, warn) { return '<span class="c num' + (warn ? ' warn' : '') + '">' + h(n) + '</span>'; }
/* 勾选标记（方框 + 勾）：唯一的画法。勾选控件（cafe-check）、目标勾选、只读清单都用它；on 也可以由外层的 aria-checked / 原生 :checked 给 */
function checkInd(on) { return '<span class="box' + (on ? ' on' : '') + '" aria-hidden="true">' + icon('check', 12) + '</span>'; }
/* 组件库原件的目录登记：每个原件在自己的定义旁边登记 { g 组, ex(样例数据) → 示例, via 哪些 PDL 用到它（用来数“当前主题使用 N 处”）,
   tones(档, 样例) → 这一档的示例或 null（不支持这一档）, count(样例) → 计数形态, inline 示例是并排的小件 }。组件目录（catalog.js）只枚举，不另写清单 */
const LIB_CATALOG = {};
function cellsHtml(o) {
  const r = cellsResolve(o.items, o.saved), gap = function (n) { return n > 0 ? '<span class="cell-gap" style="--u-n:' + n + '"></span>' : ''; };
  const one = function (it) { return '<span class="citem" data-ckey="' + h(it.key) + '" data-anchor="' + it.anchor + '" data-cell="' + it.cell + '" style="--u-span:' + it.span + '"' + (it.locked ? ' data-locked="1"' : o.edit ? ' data-edit="cell"' : '') + '>' + it.html + '</span>'; };
  let cur = 0, head = '';
  r.start.forEach(function (it) { head += gap(it.cell - cur) + one(it); cur = it.cell + it.span; });
  let tail = '';
  r.end.forEach(function (it, i) { const nx = r.end[i + 1]; tail += one(it) + gap(nx ? it.cell - (nx.cell + nx.span) : it.cell); });
  return '<div class="cells cells-' + (o.axis || 'row') + (o.cls ? ' ' + o.cls : '') + '" data-cells="' + h(o.key) + '"' + (o.attrs || '') + '>' + head + '<span class="cells-flex"></span>' + tail + '</div>';
}
/* 区域边界的调宽把手（组件库里只有这一个）：一种颜色、一套悬停 / 拖动中的状态、同样的宽度和命中区。
   which 说它调的是谁（nav 侧栏 / panel 工作台），side 说它贴在区域的哪条边（end 右边 / start 左边）。编辑布局时隐藏（那时区域的边用来移动区域） */
function resizeHandle(o) { return '<div class="resize-handle" data-resize="' + o.which + '" data-side="' + o.side + '" role="separator" aria-orientation="vertical" aria-label="' + h(o.label) + '" tabindex="0" data-tip="' + h(o.tip) + '"' + (o.now != null ? ' aria-valuenow="' + o.now + '" aria-valuemin="' + o.min + '" aria-valuemax="' + o.max + '"' : '') + '></div>'; }
/* ───────────── Small components ───────────── */
/* 按钮（组件库）：四种样式（solid / soft / danger solid / danger soft）在 core.css 里声明；默认 soft，调用方只说这一个按钮是什么：o.primary 一组里的主操作（solid）；o.danger 危险（danger soft，和 primary 一起 = 最后一步的破坏性确认，danger solid）；
   o.link 文中的链接（强调色字）；o.iconOnly 只有图标（墨色，悬停强调色）；o.pressed 开关（开关规则）。尺寸三档：m（默认）/ s（sm）/ xs（行内的小图标按钮：提示胶囊、标签页上的固定和关闭） */
function btn(label, o) {
  o = o || {};
  if (o.busy) o = Object.assign({}, o, { icon: o.icon || 'refresh', data: (o.data || '') + ' aria-busy="true"' });   /* 进行中：按钮自己的图标转起来（没有图标的用刷新图标），不能再点（core.css） */
  const cls = 'btn' + (o.link ? ' btn-text' : '') + (o.size === 'xs' ? ' btn-xs' : o.sm ? ' btn-sm' : '') + (o.iconOnly ? ' btn-icon' : '') + (o.danger ? ' danger' : '') + (o.cls ? ' ' + o.cls : ''), pri = o.primary ? ' data-primary' : '';
  const body = o.html != null ? o.html : o.iconOnly ? '' : o.link && !o.why ? btnLinkText(label, o) : h(label);
  /* 停用而且说了原因（why）：不用原生 disabled（原生停用的按钮不发悬停事件，提示出不来），而是 aria-disabled + 原因在悬停提示里（不弹提示条） */
  if (o.why) return '<button type="button" class="' + cls + '"' + pri + ' aria-disabled="true" data-tip="' + h(o.why) + '"' + (o.iconOnly ? ' aria-label="' + h(o.aria || label) + '"' : '') + (o.icon ? libActAttr(o.act, o.data, o.icon) : '') + '>' + (o.icon ? icon(libActIcon(o.act, o.data, o.icon)) : '') + body + '</button>';
  return '<button type="' + (o.submit ? 'submit' : 'button') + '" class="' + cls + '"' + pri + (o.act ? ' data-act="' + o.act + '"' : '') + (o.data || '') + (o.disabled ? ' disabled' : '') + (o.pressed != null ? ' aria-pressed="' + o.pressed + '"' : '') + (o.iconOnly ? ' aria-label="' + h(o.aria || label) + '" data-tip="' + h(o.tip || label) + '"' : '') + (o.note ? ' data-note="' + o.note + '"' : '') + (o.icon ? libActAttr(o.act, o.data, o.icon) : '') + '>' + (o.icon ? icon(libActIcon(o.act, o.data, o.icon)) : '') + body + '</button>';
}
/* 文字链接按钮的字：放不下时省略（被截断的字悬停看全文是引擎的通用规则） */
function btnLinkText(label, o) { return '<span class="cafe-ellip">' + h(label) + '</span>'; }
/* 可复制的值（组件库，唯一的一个）：值 + 末尾的复制图标（只有图标）。图标的提示说复制的是什么（label，比如“复制路径”）；值自己的提示可以说别的（tip，比如只读的规则）。
   点图标复制 v（默认就是显示的值）。所有“一个值 + 复制”的地方都用它，复制在哪都长一个样 */
function copyValue(o) {
  return '<span class="copyv"' + (o.tail ? ' data-tail' : '') + '><span class="copyv-v' + (o.mono ? ' mono' : '') + '"' + (o.tip ? ' data-tip="' + h(o.tip) + '"' : '') + '>' + (o.tail ? '<bdi dir="ltr">' + h(o.value) + '</bdi>' : h(o.value)) + '</span>' +
    btn(o.label, { iconOnly: true, icon: 'copy', sm: true, act: 'copy', data: argAttrs({ v: o.v != null && o.v !== '' ? o.v : o.value, msg: tc('control.copied', o.v != null && o.v !== '' ? o.v : o.value) }) }) + '</span>';
}
/* 标签自带的移除按钮（标签这个组件的一部分）：从选择里拿掉用 close（×）；真正删除数据用 delete（垃圾桶） */
function chipX(act, data, label, glyph) { return '<button type="button" class="chip-x" data-act="' + act + '"' + (data || '') + libActAttr(act, data, glyph || 'close') + ' aria-label="' + h(label || tc('common.remove')) + '" data-tip="' + h(label || tc('common.remove')) + '">' + icon(libActIcon(act, data, glyph || 'close'), 12) + '</button>'; }
/* 标签（组件库唯一的画法）：PDL 的 chip 控件、消息上的标签、标签编辑器、只读的一列值、阶段进度、流程节点、筛选标签、认领行都画它，不各写一份。
   文字类参数（label / kind / faint / tip / lead / tail）是已转义的 HTML；thumb 是图片地址，优先于 icon 字形；tint 是色调槽位或 #hex（有才画色点）；
   act + data：整个标签可点（button，pressed 写 aria-pressed，check 时选中多一个勾）；disabled：停用的原因（button + aria-disabled，同按钮的停用规则）；
   x：标签自带的移除按钮（chipX 画好的）——能点又能移除时点名字打开、× 移除；cls / attrs：钩子类名和额外属性（行为用，不挑样子） */
function chipHtml(o) {
  const x = o.x || '', more = (o.tip ? ' data-tip="' + o.tip + '"' : '') + (o.tone ? ' data-tone="' + h(o.tone) + '"' : '') + (o.attrs || ''), cls = 'chip' + (o.cls ? ' ' + o.cls : '');
  const body = (o.tint !== undefined ? tintDot(o.tint) : '') + (o.check && o.pressed ? icon('check', 12) : '') + (o.lead || '') + (o.thumb ? '<img class="chip-thumb" src="' + h(o.thumb) + '" alt="" draggable="false">' : o.icon ? icon(o.icon, 13) : '') + (o.kind ? '<b class="mono vw-11">' + o.kind + '</b>' : '') + (o.ellip ? '<span class="cafe-ellip vw-w220">' + o.label + '</span>' : (o.label || '')) + (o.faint ? '<span class="faint">' + o.faint + '</span>' : '') + (o.tail || '');
  const pr = o.pressed != null ? ' aria-pressed="' + !!o.pressed + '"' : '';
  if (o.act && x) return '<span class="' + cls + '"' + more + '><button type="button" class="chip-main" data-act="' + o.act + '"' + (o.data || '') + '>' + body + '</button>' + x + '</span>';   /* 能点开又能移除：点名字打开，× 移除 */
  if (o.disabled) return '<button type="button" class="' + cls + '" aria-disabled="true" data-tip="' + h(o.disabled) + '"' + (o.tone ? ' data-tone="' + h(o.tone) + '"' : '') + (o.attrs || '') + pr + '>' + body + '</button>';
  return o.act ? '<button type="button" class="' + cls + '" data-act="' + o.act + '"' + (o.data || '') + more + pr + '>' + body + x + '</button>' : '<span class="' + cls + '"' + more + '>' + body + x + '</span>';
}
/* PDL 里声明了 ⋯ 菜单的节点（type: more / prop: menu / 行的 ⋯）画出来的元素都带这个标记：右键找菜单主人只认它（见下面的 contextmenu） */
const MENU_DECL = ' data-menu-decl';
/* ⋯ 的档位（PDL size）：s 和行里的小按钮一样高（默认），m 和同一行的普通按钮一样高；高度是按钮的控件高度 token */
function moreBtn(key, data, label, size) { return btn(label || tc('common.moreActions'), { iconOnly: true, icon: 'more', act: 'menu', data: ' data-menu="' + key + '"' + (data || '') + MENU_DECL, sm: size !== 'm' }); }
/* 开关：label 是它的名字——只给读屏，开关旁边不写字（开关本身就表达了开 / 关，不写「启用」「已启用」）；要说明的写 tip（提示） */
function sw(on, act, data, label, disabled) { return swBtn(on, act, data, label, disabled); }
function swBtn(on, act, data, label, disabled) { return '<button' + (disabled ? ' disabled' : '') + ' type="button" class="switch" role="switch" aria-checked="' + (on ? 'true' : 'false') + '" aria-label="' + h(label || tc('control.enable')) + '" data-act="' + act + '"' + (data || '') + '><span></span></button>'; }
/* 开关的开 / 关过渡（组件库，所有开关共用一处）：点下去先在原节点上翻 aria-checked，过渡就在这个节点上开始；
   紧跟着的整页重画由引擎的节点复用留住这个节点（reuseHold），不换成一个已经在终态的新节点 */
document.addEventListener('click', function (e) {
  const el = e.target.closest && e.target.closest('.switch'); if (!el || el.disabled || el.closest('.layer-covered, .edit-layout')) return;
  el.setAttribute('aria-checked', String(el.getAttribute('aria-checked') !== 'true')); getComputedStyle(el.firstElementChild || el).transform;   /* 原地翻过来，过渡从这一帧开始 */
  reuseHold(el);
}, true);
/* 分段控件；kind = 'ctabs' 时是一排可点的标签（筛选， 的 chip：选中 = aria-pressed，有异常的那一类带 warn 色调） */
function seg(items, act, kind, label, data) {
  return '<div class="' + (kind || 'seg') + '" role="group"' + (label ? ' aria-label="' + h(label) + '"' : '') + '>' + items.map(function (it) {
    /* why：这一档现在不能选（停用，悬停看原因），和按钮的停用同一条规则 */
    const g = it.g != null && it.g !== '' ? ' data-g="' + it.g + '"' : '';
    if (kind === 'ctabs') return chipHtml({ label: h(it.label), tail: it.count != null ? qty(it.count, false) : '', tone: it.warn ? 'warn' : '', pressed: !!it.active, disabled: it.why, act: act, data: (data || '') + g + ' data-v="' + it.v + '"', attrs: it.why ? g + ' data-v="' + it.v + '"' : '' });   /* 一排筛选标签：每一项就是标签组件 */
    return '<button type="button"' + ' aria-pressed="' + (it.active ? 'true' : 'false') + '"' + (it.why ? ' aria-disabled="true" data-tip="' + h(it.why) + '"' : ' data-act="' + act + '"' + (data || '')) + g + ' data-v="' + it.v + '">' + h(it.label) + (it.count != null ? qty(it.count, it.warn) : '') + '</button>';
  }).join('') + '</div>';
}
/* 设置行里的选择（Keeper 式：当前值 + 上下箭头）。change 交给 CHANGES 里的键；data 是附加属性（比如 ' data-k="font"'）。
   选项可以是 [值, 文字] 或直接是文字。 */
function pick(id, opts, val, label, change, data) { return sel(id, opts, val, { label: label, change: change, data: data }); }   /* 设置行里的值：就是下拉本身（下拉只有一个样子） */
/* 下拉：选项可以是字符串（值 = 显示文字），也可以是 { v, label }——值是模型里的枚举，文字来自文案；功能代码只比较枚举 */
/* 下拉（组件库唯一一个，只有一个样子：宽度是最宽的那个选项，不按所在的表单 / 筛选 / 设置行换样子）。
   选项可以是字符串、[值, 文字] 或 { v, label }——值是模型里的枚举，文字来自文案；功能代码只比较枚举 */
/* 重画后弹窗里的值会被恢复到隐藏的 select 上：让看得见的按钮文字跟上 */
function selSync() { document.querySelectorAll('.select-wrap > select.sr').forEach(function (s) { const b = s.nextElementSibling, o = s.options[s.selectedIndex], v0 = b && b.querySelector('.select-v'), v = v0 && (v0.querySelector('.select-t') || v0); if (v && o && v.textContent !== o.textContent) v.textContent = o.textContent; }); }
const SEL = {};   /* 下拉 id → { lead: 前导函数（菜单项和按钮画同一个前导）, multi: 多选的选项和值 }；每次画 sel 时更新 */
/* o.multi（多选：成员多选也是它）：值是一组；按钮上是选中项的前导叠在一起 + 名字（选项的 short，没有就用 label）；点开同一种菜单，每项是一个就地的开关（stay），
   点了执行声明的 act（参数 args，再加 key（缺省 v）= 这一项的值）——多选的值不在原生 select 上，由动作改数据，重画时打勾跟着变 */
function sel(id, opts, val, o) {
  o = o || {};
  const ov = function (x) { return Array.isArray(x) ? x : x && typeof x === 'object' ? [x.v, x.label, x.why, x.remove, x.short, x.sub] : [x, x]; };   /* 选项可以声明 remove { act, args, label }：菜单里这一项末尾有删除；sub：菜单里这一项的第二行说明 */
  if (o.multi) return selMulti(id, opts.map(ov), val, o);
  const ps = opts.map(ov);
  const cur = ps.find(function (p) { return p[0] === val; }) || ps[0] || ['', ''];
  /* 选项的前导（o.lead(值) → 一段前导内容：头像、图标……，没有就是空）：按钮上的当前值、量宽用的每个选项、点开的菜单项都画同一个前导。
     选项的通用排法只有一条（core.css .select-v / .select-sz）：前导 + 文字一行、垂直居中、省略只在文字上——不按前导是什么换样子 */
  const lead = function (v) { return o.lead ? o.lead(v) || '' : ''; };
  SEL[id] = { lead: o.lead || null, span: o.span };
  /* 值的载体是一个隐藏的原生 select（表单读值、change 事件、未保存检测都照旧）；看得见的是组件库自己的按钮，点开是组件库的菜单（不用系统的下拉） */
  return '<div class="select-wrap' + (o.cls ? ' ' + o.cls : '') + '"' + (o.span ? ' data-span="' + o.span + '" style="--u-span:var(--span-' + o.span + ')"' : '') + '>' +
    '<select class="sr" tabindex="-1" aria-hidden="true" id="' + h(id) + '"' + (o.change ? ' data-change="' + o.change + '"' : '') + (o.data || '') + '>' +
    ps.map(function (p) { const why = typeof p[2] === 'string' ? p[2] : ''; return '<option value="' + h(p[0]) + '"' + (p[0] === val ? ' selected' : '') + (why ? ' disabled data-tip="' + h(why) + '"' : '') + (p[3] ? ' data-rm="' + h(JSON.stringify(p[3])) + '"' : '') + (p[5] ? ' data-sub="' + h(p[5]) + '"' : '') + '>' + h(p[1]) + '</option>'; }).join('') + '</select>' +   /* 第三项是“为什么现在不能选”：选项停用，悬停看原因 */
    '<button type="button" class="select' + (o.mono ? ' mono' : '') + '" data-act="selOpen" data-for="' + h(id) + '" aria-haspopup="menu"' + (o.invalid ? ' aria-invalid="true"' : '') + (o.label ? ' aria-label="' + h(o.label) + '"' : '') + (o.disabled ? ' disabled' : '') + (o.tip ? ' data-tip="' + h(o.tip) + '"' : '') + '>' +   /* 整个改不了（disabled）：停用，悬停看原因（tip） */
    (o.prefix ? '<span class="select-p">' + h(o.prefix) + '</span>' : '') + '<span class="select-vs"><span class="select-v">' + lead(cur[0]) + '<span class="select-t">' + h(cur[1]) + '</span></span>' + ps.map(function (p) { return '<span class="select-sz" aria-hidden="true">' + lead(p[0]) + '<span class="select-t">' + h(p[1]) + '</span></span>'; }).join('') + '</span>' + icon('updown', 13) + '</button></div>';   /* 宽度 = 最宽的选项（和原生下拉一样）：换一个值，同一行后面的东西不挪 */
}
/* 下拉（sel）点开：组件库的菜单，选项来自隐藏的原生 select（文字、停用原因、末尾的删除），每项带和按钮上一样的前导；选中后改它的值并发出 change，原来的处理照旧 */
function selMulti(id, ps, val, o) {
  const on = [].concat(val || []).filter(function (v) { return ps.some(function (p) { return p[0] === v; }); }), lead = function (v) { return o.lead ? o.lead(v) || '' : ''; };
  SEL[id] = { lead: o.lead || null, multi: { ps: ps, on: on, act: o.act, args: o.args || {}, key: o.key || 'v' } };
  const txt = on.map(function (v) { const p = ps.find(function (x) { return x[0] === v; }); return p[4] || p[1]; }).join('、') || o.none || '';
  return '<div class="select-wrap' + (o.cls ? ' ' + o.cls : '') + '"><button type="button" class="select" id="' + h(id) + '" data-act="selOpen" data-for="' + h(id) + '" aria-haspopup="menu"' + (o.label ? ' aria-label="' + h(o.label) + '"' : '') + '>' +
    (o.lead ? '<span class="stack">' + on.map(lead).join('') + '</span>' : '') + '<span class="select-v"><span class="select-t">' + h(txt) + '</span></span>' + icon('updown', 13) + '</button></div>';
}
A.selOpen = function (d, el) {
  const m = SEL[d.for] && SEL[d.for].multi;
  if (m) {   /* 多选：每次画菜单都按当前的值（就地开关后打勾跟着变） */
    S.menu = { sel: d.for, get items() { const x = (SEL[d.for] && SEL[d.for].multi) || m, lead = SEL[d.for] && SEL[d.for].lead; return x.ps.map(function (p) { return { lead: lead ? lead(p[0]) || '' : '', label: p[1], act: 'selToggle', data: { for: d.for, v: p[0] }, cur: x.on.indexOf(p[0]) >= 0, stay: true }; }); } }; menuAnchor(el);
    render(true); return;
  }
  const s = document.getElementById(d.for); if (!s) return;
  const lead = SEL[d.for] && SEL[d.for].lead;
  S.menu = { span: SEL[d.for] && SEL[d.for].span, items: Array.prototype.map.call(s.options, function (o) { return { label: o.textContent, sub: o.dataset.sub || '', lead: lead ? lead(o.value) || '' : '', act: 'selPick', data: { for: d.for, v: o.value }, cur: o.selected, why: o.disabled ? o.dataset.tip || ' ' : '', x: o.dataset.rm ? JSON.parse(o.dataset.rm) : null }; }), sel: d.for, q: '' }; menuAnchor(el);
  render(true);
};
/* 多选的一项：先在组件自己记着的值上翻过来（菜单这一次重画就打上勾，不等视图模型下一轮），再执行声明的动作（参数 args + key = 这一项的值） */
A.selToggle = function (d, el) {
  const x = SEL[d.for] && SEL[d.for].multi; if (!x) return;
  const v = String(d.v), i = x.on.map(String).indexOf(v), a = Object.assign({}, x.args); a[x.key] = d.v;
  if (i >= 0) x.on.splice(i, 1); else x.on.push(d.v);
  return actFn(x.act)(a, el);
};
/* 带候选的输入框（PDL input 的 listFrom）：框尾的按钮点开组件库的菜单，候选可以带第二行说明；选中的值写回输入框，和手动输入一样发出 input + change */
const COMBO = {};
A.comboOpen = function (d, el) {
  const input = document.getElementById(d.for); if (!input) return;
  S.menu = { sel: d.for, q: '', items: (COMBO[d.for] || []).map(function (c) { return { label: c.label, sub: c.sub || '', act: 'comboPick', data: { for: d.for, v: c.v }, cur: c.v === input.value }; }) }; menuAnchor(el);
  render(true);
};
A.comboPick = function (d) {
  const input = document.getElementById(d.for); S.menu = null; if (!input) { render(true); return; }
  input.value = d.v; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
  render(true);
};
INPUTS.menuQ = function (e) { if (S.menu) { S.menu.q = e.target.value; render(true); } };
A.selPick = function (d) {
  const s = document.getElementById(d.for);
  if (!s) { render(true); return; }
  if (s.value !== d.v) { s.value = d.v; s.dispatchEvent(new Event('change', { bubbles: true })); }
  render(true);
};
/* 选成员（组件库唯一一个成员选择器）：单选就是下拉 sel()，前导是成员的头像（值是成员 id）；
   多选是同一个按钮（选中的头像叠在一起），点开同一种菜单，每项是一个就地的开关（stay），动作由声明给，参数里带成员 id。
   o = { id, pool: [id], value: id | [id], none（不选时那一项的文字）, multi, act, args（参数属性串）, change, data, label } */
function memberLead(id) { return id ? whoAva(id, { size: 's', tip: false }) : ''; }   /* 空值是“不选”那一项：没有前导 */
function memberLabel(id) { const m = WHO_DATA.member(id); return m.name + ' ' + m.handle; }
function memberPick(o) {
  const ps = (o.none != null && !o.multi ? [['', o.none]] : []).concat(o.pool.map(function (id) { return { v: id, label: memberLabel(id), short: WHO_DATA.member(id).name }; }));
  return sel(o.id, ps, o.multi ? o.value || [] : o.value || '', { lead: memberLead, change: o.change, data: o.data, label: o.label, multi: !!o.multi, act: o.act, args: o.args, key: 'id', none: o.none });   /* 单选、多选都是下拉本身（multi 模式），前导是头像 */
}
/* 取色（组件库唯一一个，不用系统取色器）：值的载体是隐藏的原生颜色输入（input 事件、未保存检测照旧）；看得见的是一个色块按钮，
   点开组件库的浮层：色轮（一圈是色相，圆心到边是饱和度）+ 明度滑块 + 预览 + 主题里已有的颜色 + 十六进制输入。和下拉 sel() 同一个模式。
   选中的颜色存成固定值（十六进制），原样画出来，不按浅色 / 深色推导别的值 */
/* o.input：值变了交给哪个输入处理；o.slots = 'name'：主题的成员色槽位排在前面；o.preview：旁边一段文字用这个颜色（名字的预览），浮层里也用它预览；
   o.kind = 'slot'：只在主题的成员色槽位里单选（见下面 colorSlots）——取色只有这一个组件，槽位单选是它的变体 */
function colorCtl(o) {
  if (o.kind === 'slot') return colorSlots(o);
  if (o.value && typeof o.value === 'object') o = Object.assign({}, o, { value: FORMATS.color(o.value) });
  if (!o.value && o.default) o = Object.assign({}, o, { value: getComputedStyle(document.documentElement).getPropertyValue(o.default).trim().toLowerCase() });
  return '<span class="color-wrap"><input type="color" class="sr tok-color" tabindex="-1" aria-hidden="true" id="' + h(o.id) + '" value="' + h(o.value) + '"' + (o.tok ? ' data-tok="' + h(o.tok) + '"' : '') + (o.input ? ' data-input="' + h(o.input) + '"' : '') + (o.slots ? ' data-slots="' + h(o.slots) + '"' : '') + (o.preview ? ' data-preview="' + h(o.preview) + '"' : '') + '>' +
    '<button type="button" class="color-sw" data-act="colorOpen" data-for="' + h(o.id) + '" aria-haspopup="dialog" aria-label="' + h(o.label || tc('control.color')) + '" style="--sw:' + h(o.value) + '"></button>' +
    (o.preview ? '<span class="color-name" style="--sw:' + h(o.value) + '">' + h(o.preview) + '</span>' : '') + '</span>';
}
/* 取色的 slot 变体：只在主题的 6 个成员色槽位里单选一个（值是槽位号，不是固定值）——主人的两种颜色、目录里的 tints 控件。
   o = { value: 槽位号, act, label, name（放在对话框字段里时的字段 id：点了改字段的数据）, data } */
function colorSlots(o) {
  return '<span class="cafe-tints" role="radiogroup" aria-label="' + h(o.label || tc('control.color')) + '"' + (o.name ? ' data-swatch="' + h(o.name) + '"' : '') + '>' + [1, 2, 3, 4, 5, 6].map(function (n) { return '<button type="button" role="radio" aria-checked="' + (o.value === n) + '" aria-label="' + h(tc('control.colorN', n)) + '" data-act="' + o.act + '"' + (o.data || '') + ' data-v="' + n + '" data-n="' + n + '" style="--u-background:var(--tint-' + n + ')" class="u-v-background"></button>'; }).join('') + '</span>';
}
/* 槽位单选点了一项：在对话框字段里就改字段的数据（重画）；不在字段里就只是就地改选中（单选的行为属于这个组件） */
A.swatch = function (d, el) {
  const f = dlgFieldById(el.parentNode.dataset.swatch); if (f) { dlgSync(); f.swatch.cur = +d.n; render(true); return; }
  el.parentNode.querySelectorAll('[role="radio"]').forEach(function (b) { b.setAttribute('aria-checked', b === el ? 'true' : 'false'); });
};
/* 色轮的颜色模型是 HSL：色相 h（度，0 在正上方、顺时针）、饱和度 s 和明度 l（0–1）。浮层上只写这三个变量，色轮、圆点、滑块、预览的颜色都由 CSS 推出 */
function hexHsl(hex) {
  const c = [1, 3, 5].map(function (i) { return (parseInt(String(hex).slice(i, i + 2), 16) || 0) / 255; }), mx = Math.max.apply(null, c), mn = Math.min.apply(null, c), l = (mx + mn) / 2, d = mx - mn;
  if (!d) return { h: 0, s: 0, l: l };
  const s = d / (1 - Math.abs(2 * l - 1)), hh = mx === c[0] ? ((c[1] - c[2]) / d + 6) % 6 : mx === c[1] ? (c[2] - c[0]) / d + 2 : (c[0] - c[1]) / d + 4;
  return { h: hh * 60, s: Math.min(1, s), l: l };
}
function hslHex(o) {
  const a = o.s * Math.min(o.l, 1 - o.l), f = function (n) { const k = (n + o.h / 30) % 12; return o.l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return '#' + [0, 8, 4].map(function (n) { return ('0' + Math.round(Math.max(0, Math.min(1, f(n))) * 255).toString(16)).slice(-2); }).join('');
}
/* 取色的三个动作（组件库的原件，登记进动作表）：打开浮层、选定一个颜色、输入十六进制 */
Object.assign(A, {
  /* 取色：组件库的浮层（色轮 + 明度 + 预览 + 主题已有颜色 + 十六进制）。浮层每次画都按隐藏输入现在的值（选了之后浮层留着，接着调）；
     色轮的 HSL 记在菜单上，十六进制往返不丢色相（灰色时色相照旧） */
  colorOpen: function (d, el) {
    const s = document.getElementById(d.for); if (!s) return;
    const cs = getComputedStyle(document.documentElement), seen = {};
    const names = ['--name-1', '--name-2', '--name-3', '--name-4', '--name-5', '--name-6'], base = ['--accent', '--ok', '--warn', '--danger', '--info'];
    const val = function (l) { return l.map(function (t) { return cs.getPropertyValue(t).trim().toLowerCase(); }).filter(function (v) { if (!/^#[0-9a-f]{6}$/.test(v) || seen[v]) return false; seen[v] = 1; return true; }); };
    const theme = (s.dataset.slots === 'name' ? [names, base] : [base, names]).map(val);   /* 主题已有的颜色按组各一行（成员色槽位 / 强调和状态色），点了就是那个固定值 */
    const preview = s.dataset.preview || '';
    S.menu = { sel: d.for, label: el.getAttribute('aria-label'), hsl: hexHsl(s.value.toLowerCase()),
      get html() { const x = document.getElementById(d.for), hex = x ? x.value.toLowerCase() : hslHex(this.hsl); if (hslHex(this.hsl) !== hex) this.hsl = hexHsl(hex); return colorPopHtml({ for: d.for, hex: hex, hsl: this.hsl, theme: theme, preview: preview }); } };
    menuAnchor(el);
    render(true);
  },
  /* 选定一个颜色（固定值）：改隐藏输入的值并发出 input，原来的处理照旧；浮层留着（keep：色轮已经记下了 HSL） */
  colorSet: function (d) {
    const s = document.getElementById(d.for), v = String(d.v || '').toLowerCase();
    if (!/^#[0-9a-f]{6}$/.test(v)) return;
    if (S.menu && S.menu.hsl && !d.keep) S.menu.hsl = hexHsl(v);
    if (s && s.value.toLowerCase() !== v) { s.value = v; s.dispatchEvent(new Event('input', { bubbles: true })); }
    render(true);
  },
  colorHex: function (d, el) { const v = (el.value || '').trim(); A.colorSet({ for: d.for, v: v.charAt(0) === '#' ? v : '#' + v }); }
});
function colorVars(o) { return '--h:' + o.h.toFixed(1) + ';--s:' + o.s.toFixed(3) + ';--l:' + o.l.toFixed(3); }
/* 取色浮层的内容（组件库）：色轮 · 明度 · 预览（名字或色块）+ 十六进制 · 主题已有的颜色（每组一行，点了就是这个固定值） */
function colorPopHtml(o) {
  const sw = function (v) { return '<button type="button" class="color-sw" data-act="colorSet" data-stay data-for="' + h(o.for) + '" data-v="' + v + '" style="--sw:' + v + '"' + (v === o.hex ? ' aria-current="true"' : '') + ' aria-label="' + v + '"></button>'; };
  return '<div class="color-pop" data-for="' + h(o.for) + '" style="' + colorVars(o.hsl) + '">' +
    '<div class="color-wheel" id="color-wheel" role="slider" tabindex="0" aria-label="' + h(tc('control.colorWheel')) + '" aria-valuetext="' + o.hex + '"><span class="color-dot"></span></div>' +
    '<input type="range" class="color-l" id="color-l" min="0" max="100" step="1" value="' + Math.round(o.hsl.l * 100) + '" aria-label="' + h(tc('control.colorLight')) + '">' +
    '<div class="color-out">' + (o.preview ? '<span class="color-name">' + h(o.preview) + '</span>' : '<span class="color-now"></span>') +
    '<input class="input mono" id="color-hex" value="' + h(o.hex) + '" maxlength="7" aria-label="HEX" data-for="' + h(o.for) + '" data-on-enter="colorHex"></div>' +
    o.theme.filter(function (g) { return g.length; }).map(function (g) { return '<div class="color-row">' + g.map(sw).join('') + '</div>'; }).join('') + '</div>';
}
/* 色轮的拖动和按键（组件库，唯一一处）：按下 / 拖动只改浮层上的变量（边拖边预览），松手才写进隐藏输入（发出 input）；
   方向键：左右转色相、上下改饱和度，每按一下就写进去；明度滑块边拖边预览，松手写进去 */
function colorLive(p, o) {
  if (S.menu) S.menu.hsl = o;
  p.style.cssText = colorVars(o); const hex = hslHex(o), x = p.querySelector('#color-hex'), w = p.querySelector('.color-wheel');
  if (x) x.value = hex; if (w) w.setAttribute('aria-valuetext', hex);
}
function colorCommit(p) { if (S.menu && S.menu.hsl) A.colorSet({ for: p.dataset.for, v: hslHex(S.menu.hsl), keep: true }); }
(function () {
  let drag = null;
  const at = function (w, e) {
    const r = w.getBoundingClientRect(), dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
    let hh = Math.atan2(dx, -dy) * 180 / Math.PI; if (hh < 0) hh += 360;
    return { h: hh, s: Math.min(1, Math.hypot(dx, dy) / (r.width / 2)), l: S.menu && S.menu.hsl ? S.menu.hsl.l : 0.5 };
  };
  document.addEventListener('pointerdown', function (e) {
    const w = e.target.closest && e.target.closest('.color-wheel'); if (!w || e.button) return;
    drag = { w: w, p: w.closest('.color-pop') }; try { w.setPointerCapture(e.pointerId); } catch (err) { /* 有的浏览器不支持 */ }
    w.focus({ preventScroll: true, focusVisible: false });   /* 方向键接着调；指针按下不画焦点环 */ colorLive(drag.p, at(w, e)); e.preventDefault();
  });
  document.addEventListener('pointermove', function (e) { if (drag) colorLive(drag.p, at(drag.w, e)); });
  document.addEventListener('pointerup', function () { if (!drag) return; const d = drag; drag = null; colorCommit(d.p); });
  document.addEventListener('input', function (e) { const t = e.target; if (!t.classList || !t.classList.contains('color-l') || !S.menu || !S.menu.hsl) return; colorLive(t.closest('.color-pop'), Object.assign({}, S.menu.hsl, { l: t.value / 100 })); });
  document.addEventListener('change', function (e) { const t = e.target; if (t.classList && t.classList.contains('color-l')) colorCommit(t.closest('.color-pop')); });
  KEY_FNS.push(function (e) {
    const p = e.target.closest && e.target.closest('.color-pop'); if (!p || !/^Arrow/.test(e.key)) return false;
    if (!e.target.classList.contains('color-wheel') || !S.menu || !S.menu.hsl) return true;   /* 滑块和输入框自己处理方向键（不让菜单的上下键抢走） */
    const o = Object.assign({}, S.menu.hsl), big = e.shiftKey ? 3 : 1;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') o.h = (o.h + (e.key === 'ArrowRight' ? 5 : -5) * big + 360) % 360;
    else o.s = Math.max(0, Math.min(1, o.s + (e.key === 'ArrowUp' ? 0.05 : -0.05) * big));
    e.preventDefault(); colorLive(p, o); colorCommit(p); return true;
  });
})();
function inp(id, val, ph, o) { o = o || {}; return '<input class="input' + (o.mono ? ' mono' : '') + '" id="' + id + '" value="' + h(val) + '" placeholder="' + h(ph || '') + '"' + (o.readonly ? ' readonly' : '') + (o.dirty === false ? '' : ' data-input="dirty"') + (o.style ? ' style="' + o.style + '"' : '') + '>'; }
function avatar(m, size) { return whoAva(m, { size: size }); }   /* 身份统一走 who.js */
/* 可上传的头像（组件库唯一一个）：点头像本身就是上传，悬停出现上传提示；成员表单和对话框的头像字段都用它 */
function avatarUp(lead, size, up, data) {
  return '<label class="ava-up" data-tip="' + h(up.label) + '">' + avatar(lead, size) + '<span class="ava-up-ic" aria-hidden="true">' + icon('upload', 16) + '</span><input type="file" accept="' + h(up.accept || '') + '" class="sr" aria-label="' + h(up.label) + '" data-filemsg="' + h(up.msg || '') + '"' + (data || '') + '></label>';
}
/* 状态：圆点 + 文字；地方不够时文字省略（全文由外层的提示给出） */
/* 严重度（tone）：组件库唯一的一套四档——info 提示 / ok 正常 / warn 留意 / danger 出错。所有带严重度的组件都只写 data-tone，颜色由 [data-tone] → --tone-c 给出；
   严重度不是“多显眼”（那是注意力层级，暂缓），也不是计数（计数徽标是中性的） */
const TONES = ['info', 'ok', 'warn', 'danger'];
function toneAttr(t) { return TONES.indexOf(t) >= 0 ? ' data-tone="' + t + '"' : ''; }
function status(kind, text, strong) { return '<span class="status"' + toneAttr(kind) + '>' + (strong ? '<b>' + h(strong) + '</b>' : '') + '<span class="status-t">' + h(text) + '</span></span>'; }   /* 放不下时省略（被截断的字悬停看全文：引擎的通用规则） */
/* 页头：返回、（可选）前导头像、标题 + 标注 + ?、下方一行数据（sub）；右边操作。标题带 data-title：组件声明的标题位（返回的提示取它的字，引擎只认这个标记） */
function pageHead(o) {
  const h1 = '<h1 class="page-title" data-title' + (o.titleNote ? ' data-note="' + o.titleNote + '"' : '') + '>' + o.title + annotLabel(o.label, 'after') + helpTip(o.help || o.desc) + '</h1>';
  const id = (o.status ? '<div class="head-line">' + h1 + o.status + '</div>' : h1) + annotLabel(o.label, 'below') + (o.sub ? '<div class="vw-label below">' + o.sub + '</div>' : '');   /* 行内状态紧跟标题（头的统一排法） */
  return '<header class="page-head">' + (o.back || '') + '<div class="grow">' +
    (o.lead ? '<div class="page-id">' + o.lead + '<div class="grow">' + id + '</div></div>' : id) + '</div>' +
    (o.actions ? '<div class="page-actions"' + (o.actNote ? ' data-note="' + o.actNote + '"' : '') + '>' + o.actions + '</div>' : '') + '</header>';
}
function section(o) {
  /* 小节头（统一排法）：标题 → 行内状态 → 空白 → 操作控件在最后 */
  const h2 = '<h2 class="section-title">' + h(o.title) + annotLabel(o.label, 'after') + helpTip(o.help || o.desc) + '</h2>';
  return '<section class="section"' + (o.note ? ' data-note="' + o.note + '"' : '') + (o.id ? ' id="' + o.id + '"' : '') + '>' + (o.title ? '<div class="section-head"><div class="grow">' + (o.status ? '<div class="head-line">' + h2 + o.status + '</div>' : h2) + annotLabel(o.label, 'below') + '</div>' + (o.actions || '') + '</div>' : '') + o.body + '</section>';
}
/* ───────── 注释：help（解释，渲染成 ?，悬停约 0.5 秒后显示，离开立刻消失——原生提示）/ label（直接显示的短文字，位置 after / corner / below） ─────────
   说明性文字只能来自这两个字段（lint：ui-note）。 */
function helpPlain(t) { return String(t == null ? '' : t).replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim(); }
function helpTip(t) { const x = helpPlain(t); return x ? ' <span class="help-q" tabindex="0" role="img" data-tip="' + h(x) + '" aria-label="' + h(tc('control.helpLabel', x)) + '">?</span>' : ''; }
function annotLabel(l, pos) {
  if (!l) return '';
  if (Array.isArray(l)) return l.map(function (x) { return annotLabel(x, pos); }).join('');
  const o = typeof l === 'string' ? { text: l, pos: 'after' } : l;
  if ((o.pos || 'after') !== pos || !o.text) return '';
  return pos === 'below' ? '<div class="vw-label below' + (o.tone ? ' vw-t-' + o.tone : '') + '">' + h(o.text) + '</div>' : ' <span class="vw-label ' + pos + (o.tone ? ' vw-t-' + o.tone : '') + '">' + h(o.text) + '</span>';
}
function group(rows, cls) { return '<div class="group' + (cls ? ' ' + cls : '') + '">' + rows.join('') + '</div>'; }
/* 说明（help）一律收成标题后的 ?；状态、校验错误、跟着字段的操作放在字段下面一行（foot），不写成说明段 */
function srow(label, trail, o) {
  o = o || {};
  return '<div class="row setting"' + (o.note ? ' data-note="' + o.note + '"' : '') + '><div class="row-main"><div class="row-title' + (o.mono ? ' mono' : '') + '">' + h(label) + helpTip(o.help) + '</div></div>' + (trail ? '<div class="row-trail">' + trail + '</div>' : '') + '</div>';
}
function field(o) { return '<div class="field"' + (o.note ? ' data-note="' + o.note + '"' : '') + '>' + (o.id ? '<label for="' + o.id + '">' : '<div class="label">') + h(o.label) + (o.req ? '<span class="req" aria-label="' + h(tc('common.required')) + '">*</span>' : '') + helpTip(o.help) + (o.id ? '</label>' : '</div>') + '<div>' + o.control + (o.foot ? '<div class="field-foot">' + o.foot + '</div>' : '') + '</div></div>'; }
const TONE_ICON = { info: 'info', ok: 'check', warn: 'alert', danger: 'alert' };
function notice(o) { return '<div class="notice"' + toneAttr(o.tone) + (o.note ? ' data-note="' + o.note + '"' : '') + '>' + icon(TONE_ICON[o.tone] || 'info', 18) + '<div class="grow">' + o.text + '</div>' + (o.action || '') + '</div>'; }
/* 单选项：o.act 换成自己的动作（默认 radio），o.plain 标题不加粗 */
function opt(g, v, cur, title, sub, o) { o = o || {}; return '<div class="opt" role="radio" tabindex="0" aria-checked="' + (v === cur ? 'true' : 'false') + '" data-act="' + (o.act || 'radio') + '" data-g="' + g + '" data-v="' + h(v) + '"' + (o.data || '') + '><span class="radio"></span><div class="row-main"><div class="' + (o.plain ? 'u-w-normal ' : '') + 'row-title">' + h(title) + '</div>' + (sub ? '<div class="row-sub">' + h(sub) + '</div>' : '') + '</div></div>'; }
/* 勾选框按钮：[框] 标签（标签是已经转义好的片段） */
function checkBox(on, label, act, data, disabled) { return '<button type="button" class="cafe-check" role="checkbox" aria-checked="' + (on === 'mixed' ? 'mixed' : !!on) + '" data-act="' + act + '"' + (data || '') + (disabled ? ' disabled' : '') + '>' + checkInd() + label + '</button>'; }
/* 单行输入框：o.mono 等宽、o.max 最长、o.disabled、o.input 输入时的处理（默认 cafeField） */
function textInput(id, val, ph, o) { o = o || {}; return '<input class="input' + (o.mono ? ' mono' : '') + '" id="' + id + '" value="' + h(val == null ? '' : val) + '" placeholder="' + h(ph || '') + '" data-input="' + (o.input || 'cafeField') + '"' + (o.max ? ' maxlength="' + o.max + '"' : '') + (o.disabled ? ' disabled' : '') + (o.type ? ' type="' + o.type + '"' : '') + (o.k != null ? ' data-k="' + h(o.k) + '"' : '') + '>'; }
function glyphSrc(n) { return n && typeof n === 'object' ? n.src : /^(https?:|data:|blob:|\/|\.{1,2}\/)/.test(n) ? n : ''; }
function glyph(n, cls) { const src = glyphSrc(n); return '<span class="glyph' + (cls ? ' ' + cls : '') + '">' + (src ? '<img src="' + h(src) + '" alt="">' : icon(n, 18)) + '</span>'; }
function muted(t) { return '<span class="t-m muted">' + t + '</span>'; }
/* 一个输入框（组件库，表单输入的唯一规则）：回车提交，Esc 取消（声明了 cancel 时失焦也取消；没声明时 Esc 清空）；
   提交只有框里最后一个图标，框外不放“添加 / 保存 / 创建 / 取消”这类文字按钮。一个框里可以有几个输入（“听成 → 应为”），中间一个箭头；
   提交前可以放一个框里的小件（选颜色）。提交的动作拿到 { 框上的参数…, v: 第一个输入的值, vals: 每个输入的值 }。
   o = { id, value, placeholder, label, mono, list, listFrom, input, go, data（参数属性串）, icon, goLabel, cancel, more: [{ id, value, placeholder, label, mono }], extra } */
function goField(o) {
  if (o.add) {
    const open = !!S.folds['field:' + o.id], data = ' data-field="' + h(o.id) + '"';
    return '<span class="field-add" data-add-field="' + h(o.id) + '" data-open="' + open + '">' +
      btn(o.label || tc('common.add'), { iconOnly: true, icon: 'plus', act: 'fieldAddToggle', data: data + ' aria-expanded="' + open + '"' }) +
      goField(Object.assign({}, o, { add: false, go: 'fieldAddCommit', cancel: 'fieldAddCancel', data: (o.data || '') + data + ' data-commit="' + h(o.go) + '"' })) + '</span>';
  }
  const one = function (x) { return '<input class="input' + (x.mono ? ' mono' : '') + '" id="' + h(x.id) + '" value="' + h(x.value == null ? '' : x.value) + '" placeholder="' + h(x.placeholder || '') + '" aria-label="' + h(x.label || x.placeholder || '') + '"' + (x.list ? ' list="' + h(x.list) + '"' : '') + (x.input ? ' data-input="' + x.input + '"' : '') + ' data-on-enter="fieldGo" data-on-esc="fieldEsc"' + (o.cancel ? ' data-on-blur="fieldBlur"' : '') + ' autocomplete="off" spellcheck="false">'; };
  return '<span class="ifield" data-go="' + h(o.go) + '"' + (o.cancel ? ' data-cancel="' + h(o.cancel) + '"' : '') + (o.data || '') + '>' + [o].concat(o.more || []).map(one).join('<span class="ifield-sep" aria-hidden="true">' + icon('right', 12) + '</span>') + (o.extra || '') +
    btn(o.goLabel || tc('common.add'), { iconOnly: true, sm: true, icon: o.icon || 'check', act: 'fieldGo', cls: 'ifield-go' }) + '</span>' +
    (o.list ? '<datalist id="' + h(o.list) + '">' + (o.listFrom || []).map(function (x) { return '<option value="' + h(x) + '">'; }).join('') + '</datalist>' : '');
}
/* 添加与编辑共用同一个输入框；加号只负责本地展开，不重画外层容器。 */
function fieldAddSet(id, open) {
  S.folds['field:' + id] = open;
  const input = document.getElementById(id), host = input && input.closest('.field-add');
  if (!host) return;
  localOpen(host, open, host.querySelector('[data-act="fieldAddToggle"]'));
  if (open) input.focus(); else input.value = '';
}
A.fieldAddToggle = function (d) { fieldAddSet(d.field, !S.folds['field:' + d.field]); };
A.fieldAddCancel = function (d) { fieldAddSet(d.field, false); };
A.fieldAddCommit = function (d, el) { const out = actFn(d.commit)(d, el); Promise.resolve(out).then(function (ok) { if (ok !== false) fieldAddSet(d.field, false); }); return out; };   /* 提交（同步或异步）成功后才收起并清空；后端拒绝时草稿留着 */
function fieldError(p) { return '<div class="field-err" data-for="' + h(p.id) + '" role="alert">' + status('danger', p.text) + '</div>'; }
PDL_COMPONENTS.fieldError = function (p, sc, root) { return fieldError({ id: pv(p.id, sc, root), text: pv(p.text, sc, root) }); };
PDL_COMPONENTS.fieldError.catalog = { g: 'basics', props: { id: 'catalog-field', text: '$.sub' } };
function fieldErrSync() {
  Object.keys(FIELD_ERR).forEach(function (id) {
    const el = document.getElementById(id); if (!el) { delete FIELD_ERR[id]; return; }
    el.setAttribute('aria-invalid', 'true');
    const host = el.closest('.ifield, .input-lead, .select-wrap') || el, nx = host.nextElementSibling;
    if (nx && nx.classList.contains('field-err') && nx.dataset.for === id) return;
    host.insertAdjacentHTML('afterend', fieldError({ id: id, text: FIELD_ERR[id] }));
  });
}
ENGINE_PARTS.fieldErr = fieldErrSync;
onRender(fieldErrSync);
document.addEventListener('input', function (e) {
  const id = e.target && e.target.id; if (!id || !FIELD_ERR[id]) return;
  delete FIELD_ERR[id]; e.target.removeAttribute('aria-invalid');
  const m = document.querySelector('.field-err[data-for="' + CSS.escape(id) + '"]'); if (m) m.remove();
});
/* 搜索框的放大镜就是“搜”：纯图标按钮（墨色，悬停变强调色）。在表单里就提交表单（回车也提交），不在表单里就把焦点放进框里；不另放“搜索”文字按钮 */
function searchGo() { return '<button type="button" class="search-go" data-act="searchGo" aria-label="' + h(tc('common.search')) + '" data-tip="' + h(tc('common.search')) + '">' + icon('search', 14) + '</button>'; }
A.searchGo = function (d, el) { const f = el.closest('form'), i = el.parentElement.querySelector('input'); if (f) f.requestSubmit(); else if (i) i.focus(); };
function search(id, ph, val, inputKey, cls) { return '<div class="search' + (cls ? ' ' + cls : '') + '">' + searchGo() + '<input class="input" id="' + id + '" placeholder="' + h(ph) + '" aria-label="' + h(ph) + '" value="' + h(val || '') + '"' + (inputKey ? ' data-input="' + inputKey + '"' : '') + '></div>'; }
/* 插件框：谁提供的在框的提示里，不写成框里的一句话 */
function frame(plugin, what, tall) { const d = WHO_DATA.plugins()[plugin]; return '<div class="frame' + (tall ? ' tall' : '') + '" data-tip="' + h(tc('frame.embeddedBy', d.name)) + '">' + icon(d.icon, 28) + '<b>' + h(what) + ('</b><span class="mono faint">plugin://') + plugin + '/' + (tall ? 'app' : 'settings') + '</span></div>'; }

/* 返回：通用组件。工作台的“‹ 来源”、区域被占用时的“‹ 返回”都用它 */
/* 展开指示（组件库，唯一一个）：分组、树、手风琴、工作台折叠段、过程记录的“展开”都用它——向右的箭头，展开时转 90°（由所在按钮的 aria-expanded 或 data-open 决定，开关只改属性）。
   内容折叠（消息中间 / 底部折叠、排队“还有 N 条”）是另一个角色，用 foldTg */
function twisty(open) { return '<span class="tw" data-open="' + !!open + '" aria-hidden="true">' + icon('right', 14) + '</span>'; }   /* 展开指示只有一个尺寸 */
/* 返回：唯一的画法（back 含义的图标 + 去处的名字）；没有名字时只有图标，名字进 aria-label */
/* 缩略图单选的一项（组件库）：一个小窗口（窄栏、侧栏、页面、一张卡片、强调色的一笔），颜色是数据（这套主题在某个外观下的几个值），写成 --u-* 交给样式。
   thumb 给一份就是一个窗口；给两份就左右各半（自动 = 左浅右深）。下面是名字；当前项用标准的选中样式 */
function modeThumb(x, act, args) {
  const win = function (c) { const v = Object.assign({}, snapTokens(c.palette, c.mode), (themeVals(c.palette) || {})[c.mode] || {}); return '<span class="thumb-win" style="--u-rail:' + h(v['bg-rail']) + ';--u-nav:' + h(v['bg-nav']) + ';--u-page:' + h(v['bg-page']) + ';--u-group:' + h(v['bg-group']) + ';--u-fg:' + h(v['fg-muted']) + ';--u-accent:' + h(v.accent) + '"><i class="tw-rail"></i><i class="tw-nav"></i><i class="tw-page"><b class="tw-card"></b><b class="tw-dot"></b></i></span>'; };
  return '<button type="button" class="thumb-opt" role="radio" aria-checked="' + !!x.active + '"' + actAttrs(act, Object.assign({}, args, { v: x.v })) + '><span class="thumb' + (x.thumb.length > 1 ? ' split' : '') + '">' + x.thumb.map(win).join('') + '</span><span class="thumb-l">' + h(tc('modeThumb.label', x.v)) + '</span></button>';
}
/* 返回：唯一的画法（back 含义的图标；主题声明了 showLabel 时后面跟着去处的名字）。去处的名字一直在悬停提示和读屏标签里 */
function backLink(o) { return btn(o.label || o.tip, { sm: true, iconOnly: true, cls: 'back', icon: 'back', act: o.act, data: o.data, tip: o.tip, html: o.label ? '<span class="back-l">' + h(o.label) + '</span>' : '' }); }
/* 引擎的返回（唯一一个）：打开的内容盖住了触发它的地方时出现，回到来源；d.label 是来源自己的标题，d.showLabel 是主题的声明（只画图标还是图标 + 名字）。
   区域标签、主区、被占用的区域、视图下钻（含弹出层的子页）、表单自己的取消都走这里，页面不写自己从哪来；放在哪由引擎的返回槽决定（frame.js 的 BACK） */
function engineBack(d) { return backLink({ act: d.act, data: d.data || '', label: d.showLabel ? d.label : '', tip: tc('frame.backTo', d.label || '') }); }

/* ───────── 浮层（组件库）：菜单、确认框、浮动小窗、提示 ───────── */
/* 浮层的壳（组件库唯一的一个）：面（阴影、圆角）→ 可选的头（.float-head：标题 / 搜索 + 头上的操作 + ×）→ 里层滚动（.scroll.float-body）→ 可选的尾。
   菜单、弹出层、启动面板、全部标签、待办、插件小窗都是它，不各写一份头和身。
   o = { cls：面的角色变体（menu / pop / ws-pop / inbox / plugin-float …，登记在 LIB_PARTS.surface），role（缺省 dialog），label，attrs，
         head（头里的内容）, body, foot, scroll（里层滚动的额外属性，比如限行数）, bare（内容自己就是一块、不套滚动层：取色） } */
function floatHtml(o) {
  return '<div class="' + o.cls + '" role="' + (o.role || 'dialog') + '"' + (o.label != null ? ' aria-label="' + h(o.label) + '"' : '') + (o.attrs || '') + '>' + (o.head ? '<div class="float-head">' + o.head + '</div>' : '') +
    (o.bare ? o.body : '<div class="scroll float-body"' + (o.scroll || '') + '>' + o.body + '</div>') + (o.foot ? '<div class="float-foot">' + o.foot + '</div>' : '') + '</div>';
}
/* 既有浮层的 PDL 绑定：壳的角色和内容由声明给出，仍使用同一 floatHtml。 */
PDL_COMPONENTS.floatHtml = function (o, sc, root) { return floatHtml({ cls: pv(o.className, sc, root), label: pv(o.label, sc, root), body: pvBlocks(o.blocks, sc, root) }); };
PDL_COMPONENTS.floatHtml.catalog = { g: 'popups', props: { className: 'pop', label: '$.title', blocks: [{ type: 'text', text: '$.sub' }] } };
/* 菜单（⋯ 打开的那种）：m = { k, items: [{ label, lead（前导内容：头像、图标，可选）, act, data, danger, cur } | { hr } | { group }] }；位置由锚定决定（触发元素是 --menu，见上面的锚定） */
function menuHtml(m) {
  if (m.html) return floatHtml({ cls: 'menu', attrs: ' id="menu"', label: m.label || '', body: m.html, bare: true });   /* 菜单浮层里放一块组件库内容（取色） */
  /* 分组：菜单项都作用在同一个对象上时不画分组名和分隔线；只有作用对象（范围）不同的项混在一起时，范围变化处画分隔线 + 范围名。
     数据里用 { scope: 名字 } 标出后面的项属于哪个范围；危险项只靠危险色，不单独隔开 */
  let cur = '';
  const rows = [];
  /* 下拉的选项多（超过一屏）或能填自定义值时，菜单顶上有一个筛选框：只筛已有的选项（文字、说明、值） */
  const q = (m.q || '').trim().toLowerCase(), filter = m.sel && m.items.length > MENU_ROWS;
  m.items.forEach(function (it) { if (it.scope != null && it.label == null) cur = it.scope; else if (!q || (it.label + ' ' + (it.sub || '') + ' ' + (it.data && it.data.v || '')).toLowerCase().indexOf(q) >= 0) rows.push({ it: it, scope: cur }); });
  const many = rows.some(function (r) { return r.scope !== rows[0].scope; });
  return floatHtml({ cls: 'menu', role: 'menu', attrs: ' id="menu"' + (m.span ? ' data-span="' + m.span + '" style="--u-span:var(--span-' + m.span + ')"' : ''),
    head: filter ? search('menu-q', tc('selectMenu.search'), m.q, 'menuQ') : '', scroll: scrollRows(MENU_ROWS, '--ctl-m'), body: rows.map(function (r, i) {
    const it = r.it, d = Object.assign({}, m.k != null ? { k: m.k } : {}, it.data || {});
    const head = many && (i === 0 || r.scope !== rows[i - 1].scope) ? (i ? '<div class="divider" role="separator"></div>' : '') + (r.scope ? lrSection(r.scope, '', { v: 'float' }) : '') : '';
    const b = '<button type="button" role="menuitem" class="' + (it.danger ? 'danger' : '') + '"' + (it.cur ? ' aria-current="true"' : '') + (it.stay ? ' data-stay' : '') + (it.why ? ' aria-disabled="true" data-tip="' + h(it.why) + '"' : actAttrs(it.act, d)) + '>' + (it.lead ? it.lead + ' ' : '') + (it.sub ? '<span class="menu-t">' + h(it.label) + '<span class="menu-sub">' + h(it.sub) + '</span></span>' : h(it.label)) + '</button>';
    /* 项末尾的删除（it.x = { act, args, label }，下拉的选项声明的 remove）：和项并排的图标按钮，悬停变危险色 */
    /* 项末尾的说明（it.help）：同一种行，尾巴是问号提示 */
    return head + (it.x || it.help ? '<div class="menu-row">' + b + (it.x ? btn(it.x.label || tc('common.delete'), { iconOnly: true, sm: true, danger: true, icon: 'delete', act: it.x.act, data: argAttrs(it.x.args) }) : helpTip(it.help)) + '</div>' : b);   /* 停用的项：没有动作，悬停说原因 */
  }).join('') });
}
/* 确认框：d = { title, help, text, body, ok, danger, focus: 'cancel' | 'confirm' }。没有 ok 的是即时生效的窗口（里面的开关改了就算数）：没有底部按钮，关闭只走 × / Esc / 点外面。遮罩、层级、拖动、Esc / × / 取消、默认焦点由弹窗框架给（PDL_POPUPS.dialog）；
   默认焦点在“取消”（安全的那个），声明 focus: 'confirm' 时在确认按钮上，回车就按它 */
/* 一排按钮的声明（对话框 / 模态的底部、文档上的操作）：数组的每一项是 [文字, btn 的选项]，或 ['cancel', 弹窗名]（取消，走弹窗的离开检查）、
   ['done', 弹窗名]（完成 = 关掉这个弹窗）；字符串原样用（已经画好的）。应用只给声明，不调用组件 */
function btnsHtml(x) {
  if (!Array.isArray(x)) return x || '';
  return x.map(function (b) { return b[0] === 'cancel' ? popCancel(b[1]) : b[0] === 'done' ? btn(tc('common.done'), { primary: true, act: 'close', data: ' data-popup="' + b[1] + '"' }) : btn(b[0], b[1]); }).join('');
}
/* 对话框里正在填的值读回字段（引擎在重画前、输入时调用 dlgSync → 这里）：每种字段的读法属于对话框组件——
   环境变量表展开时逐行读键和值；选项只读“自定义”那一格；标签、色板、头像、键值、文件自己管状态（通用动作直接改字段），不从页面读；其余按输入框 / 勾选框读 */
function dialogSync(d) {
  if (d.doc && d.doc.edit) { const t = document.getElementById(d.doc.id); if (t) d.doc.text = t.value; }   /* 可改的正文（文档对话框） */
  (d.fields || []).forEach(function (f) {
    if (!f.id) return;
    if (f.env) { if (f.env.open) f.env.rows = f.env.rows.map(function (r, i) { const k = document.getElementById(f.id + '-k' + i), v = document.getElementById(f.id + '-v' + i); return [k ? k.value : r[0], v ? v.value : r[1]]; }); return; }
    if (f.opts) { if (f.opts.custom) { const c = document.getElementById(f.opts.custom.id); if (c) f.opts.custom.value = c.value; } return; }
    if (f.radios) { const r = document.querySelector('input[name="' + f.id + '"]:checked'); if (r) f.value = r.value; return; }   /* 单选：重画（校验失败、提交中）后留在选中的那一项 */
    if (f.chips || f.swatch || f.avatar || f.kv || f.file) return;
    const el = document.getElementById(f.id); if (!el) return;
    if (el.type === 'checkbox') f.checked = el.checked; else f.value = el.value;
  });
}
function dialogHtml(d) {
  /* noFieldFocus：正文里有自己的一套输入（比如“挂载规则”底部的添加框），刚打开时不要把焦点丢进去、把正文滚到底 */
  /* key：画在哪个弹窗里（缺省是通用对话框 dialog；未保存确认 confirm、对话区的模态窗、主题计算器也是这个组件）；alert：要你先回答才能继续（alertdialog）；acts：底部按钮的声明（btnsHtml），代替 ok / 取消；
     actions：标题行里 × 前面的操作（头：标题 · 空白 · 操作 · ×）；modal: false 不是模态（没有遮罩的工具窗）；form：表单名（通用对话框有 ok 提交时默认为 dialog）；工具内容只用同一外壳，不隐式成为表单 */
  const k = d.key || 'dialog', tid = 'dlg-t' + (d.key ? '-' + String(d.key).replace(/\W/g, '-') : ''), form = d.form || (!d.key && d.ok ? 'dialog' : ''), tag = form ? 'form' : 'section';
  const body = typeof d.body === 'object' ? pvBlocks([d.body], d, d) : d.body;
  const text = d.text && typeof d.text === 'object' ? pvParts(d.text.parts, d.text.data, d.text.data) : d.text;   /* 写成片段的正文先画出来：画出来是空的就和没有正文一样 */   /* 声明的 PDL 正文每次按当前 VM 画，不在打开弹窗时存成一份旧 HTML。 */
  return '<' + tag + ' class="dialog' + (d.wide ? ' dialog-wide' : '') + (d.layout === 'viewport' ? ' dialog-viewport' : d.layout === 'fill' ? ' dialog-fill' : '') + (d.span === 'full' ? ' dialog-full' : '') + '"' + (d.noFieldFocus ? ' data-no-field-focus' : '') + toneAttr(d.tone || (d.danger ? 'danger' : '')) + ' role="' + (d.alert ? 'alertdialog' : 'dialog') + '"' + (d.modal === false ? '' : ' aria-modal="true"') + ' aria-labelledby="' + tid + '"' + (form ? ' data-form="' + form + '"' : '') + '><div class="dlg-head"><h3 id="' + tid + '">' + h(d.title) + helpTip(d.help) + '</h3>' + (d.actions || '') + popX(k) + '</div>' +
    (text || body || d.fields || d.doc || d.error ? '<div class="dialog-body scroll">' + (d.error ? '<p class="ws-danger">' + h(d.error) + '</p>' : '') + (text ? '<p>' + text + '</p>' : '') + (d.panes ? dlgPanes(d.panes) : '') + (d.fields ? d.fields.filter(function (f) { return !f.pane || !d.panes || f.pane === d.panes.cur; }).map(dlgField).join('') : '') + (d.foot ? dlgFoot(d.foot) : '') + (d.doc ? docBody(d.doc) : '') + (body || '') + '</div>' : '') + (d.acts ? '<div class="acts">' + btnsHtml(d.acts) + '</div>' : d.ok ? '<div class="acts">' + (d.ack ? '' : popCancel(k, d.focus)) + btn(d.ok, { primary: true, danger: !!d.danger, submit: true, data: d.focus === 'confirm' || d.ack ? ' data-autofocus="1"' : '' }) + '</div>' : '') + '</' + tag + '>';
}
/* 对话框里的字段：数据描述 { id, label, value, placeholder, mono, max, req, area: true（多行）, rows, options: [...]（下拉）, check: '文字'（勾选） } */
function dlgField(f) {
  if (f.kv) return kvGrid(f.kv.map(function (p) { return [p[0], h(p[1])]; }));   /* 只读的几行键值 */
  if (f.chips || f.swatch || f.color || f.avatar || f.opts || f.env) return field({ label: f.label, control: dlgSpecial(f), req: f.req, help: f.help, foot: dlgFootHtml(f) });
  if (f.check) return '<label class="cafe-check"><input type="checkbox" class="sr" id="' + f.id + '">' + checkInd() + h(f.check) + '</label>';   /* 表单里的勾选：同一个勾选组件的样子，原生输入只负责表单的值 */
  if (f.radios) return '<div class="opts" role="radiogroup">' + f.radios.map(function (r, i) { return '<label class="opt"><input type="radio" class="sr" name="' + f.id + '" value="' + h(r.v) + '"' + ((f.value != null ? f.value === r.v : i === 0) ? ' checked' : '') + '><span class="radio"></span><div class="row-main"><div class="row-title">' + h(r.title) + '</div>' + (r.sub ? '<div class="row-sub">' + h(r.sub) + '</div>' : '') + '</div></label>'; }).join('') + '</div>';   /* 几个带说明的单选（第一个默认选中） */
  if (f.pre) return '<pre class="' + (f.mono ? 'mono ' : '') + (f.cls === 'json' ? 'pdl-json scroll' : 'pre') + '">' + h(f.pre) + '</pre>';   /* 一段只读原文 */
  const attrs = ' id="' + f.id + '"' + (f.placeholder ? ' placeholder="' + h(f.placeholder) + '"' : '') + (f.max ? ' maxlength="' + f.max + '"' : '') + (f.label ? '' : ' aria-label="' + h(f.aria || f.placeholder || '') + '"');
  const attrs2 = attrs + (f.disabled ? ' disabled' : '') + (f.type ? ' type="' + f.type + '"' : '') + (f.min != null ? ' min="' + f.min + '"' : '') + (f.maxv != null ? ' max="' + f.maxv + '"' : '');
  const ctl = f.file ? '<input class="input" id="' + f.id + '" type="file"' + (f.file.accept ? ' accept="' + h(f.file.accept) + '"' : '') + (f.file.change ? ' data-change="' + f.file.change + '"' : '') + '>' : f.options ? sel(f.id, f.options, f.value, { change: f.change }) : f.area ? '<textarea class="input' + (f.mono ? ' mono' : '') + '"' + attrs2 + (f.rows ? ' rows="' + f.rows + '"' : '') + '>' + h(f.value || '') + '</textarea>' : '<input class="input' + (f.mono ? ' mono' : '') + '"' + attrs2 + (f.value != null ? ' value="' + h(f.value) + '"' : '') + '>';
  return f.label ? field({ label: f.label, id: f.id, control: ctl, req: f.req, help: f.help, foot: dlgFootHtml(f) }) : ctl;
}
/* 对话框里的一份文档：说明行（可带等宽路径）、几组切换、原文（可编辑的多行框或只读原文）、下面一行操作
   { meta, path, metaId, num, segs: [{ label, items, act }], text, id, edit, readonly, rows, json, acts: [{ label, act, args, sm }] } */
function docBody(d) {
  const acts = (d.acts || []).map(function (a) { return btn(a.label, Object.assign({}, a, { data: argAttrs(a.args) })); }).join('');
  return '<div class="dlg-body wide">' + (d.meta != null ? '<div class="lr-section-label' + (d.num ? ' num' : '') + '"' + (d.metaId ? ' id="' + d.metaId + '"' : '') + '>' + (d.path ? '<span class="mono">' + h(d.path) + '</span> · ' : '') + h(d.meta) + '</div>' : '') +
    (d.segs ? '<div class="sw-line">' + d.segs.map(function (g) { return seg(g.items, g.act, 'seg', g.label, argAttrs(g.args)); }).join('') + '</div>' : '') +
    (d.edit ? '<textarea class="input mono seg-text" id="' + d.id + '" rows="' + (d.rows || 16) + '"' + (d.readonly ? ' readonly' : '') + ' aria-label="' + h(d.label || '') + '">' + h(d.text) + '</textarea>' : '<pre class="' + (d.json ? 'pdl-json scroll mono' : 'mono pre') + '"' + (d.id ? ' id="' + d.id + '"' : '') + '>' + h(d.text) + '</pre>') +
    (acts ? '<div class="sw-line">' + acts + '</div>' : '') + '</div>';
}
/* 浮动小窗：标题 + ×（弹窗框架的 popX，o.pop = 弹窗名）+ 内容（伴随对话这类） */
function floatPanel(o) { return floatHtml({ cls: o.cls, label: o.title, head: '<span class="u-strong grow">' + h(o.title) + '</span>' + popX(o.pop), body: '<div class="u-p-foot">' + o.body + '</div>', bare: true }); }   /* 小窗的内容（插件界面框）自己滚动 */
/* 一句提示（可带一个操作） */
/* 轻提示：唯一的画法。a 是一个或几个操作 { label, act, data（属性串或参数对象） }，操作是文字按钮 */
function toastHtml(t, a, o) { o = o || {}; const acts = [].concat(a || []).map(function (x) { return btn(x.label, { link: true, act: x.act, data: typeof x.data === 'string' ? x.data : argAttrs(x.data) }); }).join(''); return '<div class="toast' + (o.cls ? ' ' + o.cls : '') + '"' + toneAttr(o.tone) + (o.attrs || '') + ' role="status"><span>' + h(t) + '</span>' + acts + '</div>'; }

/* 模态窗（对话区的“整理、导入、开局……”）：标题（说明进 ?）+ 关闭、可滚动的内容、底部按钮；整窗是一个表单，可拖动 */
function modalHtml(o) {
  return dialogHtml({ key: o.key || 'chat.modal', form: o.form, title: o.title, help: o.help, wide: o.wide, error: o.error, body: o.body, acts: btnsHtml(o.foot) ? o.foot : null });   /* 同一个对话框组件，不另画一份头 */
}
/* 色调点：标签颜色这类 */
function tintDot(n) { return lrDot('id', '', typeof n === 'string' && n.charAt(0) === '#' ? n : 'var(--tint-' + (+n || 1) + ')'); }   /* 色调点：主题色调槽位（1–6），或者取色器选的固定值（#hex） */
function mdUnesc(x) { return String(x).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&'); }
function mdRef(ref) { const u = mdUnesc(ref), r = MD_REF.resolve ? MD_REF.resolve(u, mdLinkTarget(u)) : null; return r ? refChip(r) : ''; }   /* 链接的种类由 Markdown 组件认（mdLinkTarget），解析钩子只拿结果 */
function refChip(r) {
  const t = PDL_FRAGS.refChip, act = pv(t.act, r, r);
  return '<button type="button" class="ref-chip"' + toneAttr(pv(t.tone, r, r)) + (act ? ' data-act="' + act + '"' + argAttrs(pvDeep(t.args, r, r)) : ' disabled') + ' data-tip="' + pvText(t.tip, r, r) + '">' + icon(pv(t.icon, r, r), 13) + '<span class="ref-n">' + pvParts(t.name, r, r) + '</span></button>';
}
function mdInline(t) {
  const keep = [], ph = function (x) { keep.push(x); return '\u0000' + (keep.length - 1) + '\u0000'; };
  let s = h(t).replace(/`([^`]+)`/g, function (m, c) { return ph(mdRef(c) || '<code>' + c + '</code>'); });
  s = s.replace(/(^|[^\w$])\$([^\s$](?:[^$]*?[^\s$])?)\$(?![\w$])/g, function (m, p, c) { return p + ph(mdRich('math', mdUnesc(c), true)); });   /* 行内公式 $…$（不跨行；$5 这类价格不是公式：结尾不能紧跟空格或字母） */
  s = mdLinks(s, ph);
  s = s.replace(/\*\*([^*]+?)\*\*/g, '<b>$1</b>').replace(/(^|[^\w])__([^_]+?)__(?!\w)/g, '$1<b>$2</b>')
    .replace(/(^|[^\w*])\*(?![\s*])([^*]+?)\*(?![\w*])/g, '$1<i>$2</i>').replace(/(^|[^\w])_(?![\s_])([^_]+?)_(?!\w)/g, '$1<i>$2</i>');
  s = s.replace(/(^|[^\w@])(@[\w\u4e00-\u9fff-]+)/g, function (m, p, hd) { return WHO_DATA.handleId(hd) ? p + '<span class="mention">' + hd + '</span>' : m; });
  return s.replace(/\u0000(\d+)\u0000/g, function (m, i) { return keep[+i]; });
}
/* 链接 [文字](地址)：地址按括号配对扫描（路径里可以有括号，可以带 :行号）。
   http(s) 在外部打开；thread:id 跳到对话；file:路径、绝对 / 相对路径（/ ./ ../ ~/ 或带扩展名）打开文件预览；其它保持原文 */
function mdLinkTarget(u) {
  const m = /^(file|thread):(.+)$/.exec(u);
  if (m) return { k: m[1], v: m[2] };
  if (/^https?:\/\//.test(u)) return { k: 'url', v: u };
  if (/^(\/|\.{1,2}\/|~\/)/.test(u) || /^[\w.@-]+(\/[\w.@()-]+)*\.\w+(:\d+(-\d+)?)?$/.test(u)) return { k: 'file', v: u };
  return null;
}

function mdLinks(s, ph) {
  let out = '', i = 0;
  while (i < s.length) {
    const a = s.indexOf('[', i); if (a < 0) break;
    const b = s.indexOf('](', a); if (b < 0) break;
    const tx = s.slice(a + 1, b);
    if (tx.indexOf('[') >= 0 || tx.indexOf('\n') >= 0 || !tx) { out += s.slice(i, a + 1); i = a + 1; continue; }
    let d = 1, j = b + 2;
    for (; j < s.length && d; j++) { const c = s[j]; if (c === '(') d++; else if (c === ')') d--; else if (c === ' ' || c === '\n') break; }
    const url = d ? null : s.slice(b + 2, j - 1), t = url && mdLinkTarget(url.replace(/&amp;/g, '&'));
    if (!t) { out += s.slice(i, a + 1); i = a + 1; continue; }
    out += s.slice(i, a);
    const chip = mdRef(url); if (chip) { out += ph(chip); i = j; continue; }
    out += t.k === 'url' ? ph('<a class="md-ext" href="' + url + '" target="_blank" rel="noopener noreferrer">') + tx + ph('</a>')
      : ph(t.k === 'file' ? '<button type="button" class="cafe-link" data-act="fileOpen" data-v="' + t.v + '" data-tip="' + t.v + '">' : '<button type="button" class="cafe-link mono" data-act="thread" data-id="' + t.v + '">') + tx + ph('</button>');
    i = j;
  }
  return out + s.slice(i);
}
/* 块级：front matter、标题、段落、列表（有序 / 无序，行内格式照常）、``` 代码块、表格、引用、分隔线 */
/* 正文里的批注：文字范围和气泡共用一份声明，不改变原来的段落结构。 */
function annotationHtml(html, annotations, markdown) {
  if (!annotations.length) return html;
  const root = document.createElement('div'); root.innerHTML = html;
  annotations.forEach(function (a) {
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: function (n) { return n.parentElement.closest('button') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; } }), nodes = [];
    let n, text = '';
    while ((n = walk.nextNode())) { nodes.push({ node: n, from: text.length, to: text.length + n.length }); text += n.data; }
    const positions = []; let compact = '';
    for (let i = 0; i < text.length; i++) if (!/\s/.test(text[i])) { positions.push(i); compact += text[i]; }
    const quote = document.createElement('div'); quote.innerHTML = markdown ? mdLite(a.quote) : h(a.quote);
    const needle = quote.textContent.replace(/\s/g, ''), at = compact.indexOf(needle);
    if (at < 0) return;
    const from = positions[at], to = positions[at + needle.length - 1] + 1; let last;
    nodes.forEach(function (s) {
      if (s.to <= from || s.from >= to) return;
      const r = document.createRange(), mark = document.createElement('mark'); mark.className = 'annotation-quote';
      r.setStart(s.node, Math.max(0, from - s.from)); r.setEnd(s.node, Math.min(s.node.length, to - s.from)); r.surroundContents(mark); last = mark;
    });
    last.insertAdjacentHTML('afterend', btn(a.speaking ? tc('frame.speak') : a.label, { iconOnly: true, icon: 'chat', sm: true, cls: 'annotation-mark', data: a.open ? actAttrs(a.open.act, a.open.args) : '' }));
  });
  return root.innerHTML;
}
function mdLite(src) {
  let fm = '', body = String(src == null ? '' : src);
  if (!body.trim()) return '';   /* 没有正文就什么都不画（调用方据此不画空的正文块） */
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(body);
  if (m) { fm = '<pre class="cap-fm mono">' + h(m[1]) + '</pre>'; body = body.slice(m[0].length); }
  const out = []; let list = null, ord = false, code = null, table = null, math = null;
  const flush = function () {
    if (list) { out.push((ord ? '<ol>' : '<ul>') + list.join('') + (ord ? '</ol>' : '</ul>')); list = null; }
    if (table) { const cells = function (r) { return r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(function (c) { return c.trim(); }); }, rows = table.filter(function (r) { return !/^\s*\|?\s*:?-{2,}/.test(r); });
      out.push('<table><thead><tr>' + cells(rows[0]).map(function (c) { return '<th>' + mdInline(c) + '</th>'; }).join('') + '</tr></thead><tbody>' + rows.slice(1).map(function (r) { return '<tr>' + cells(r).map(function (c) { return '<td>' + mdInline(c) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table>'); table = null; }
  };
  body.split('\n').forEach(function (line) {
    if (math) { if (/^\s*\$\$\s*$/.test(line)) { out.push(mdRich('math', math.join('\n'))); math = null; } else math.push(line); return; }
    if (/^\s*\$\$\s*$/.test(line)) { flush(); math = []; return; }   /* 块公式：$$ 单独成行开始、结束 */
    if (code) { if (/^\s*```/.test(line)) { out.push(code.lang === 'mermaid' ? mdRich('mermaid', code.join('\n')) : '<pre><code>' + mdCode(code.join('\n'), code.lang) + '</code></pre>'); code = null; } else code.push(line); return; }
    if (/^\s*```/.test(line)) { flush(); code = []; code.lang = line.replace(/^\s*```/, '').trim(); return; }
    if (/^\s*\|.*\|\s*$/.test(line)) { if (list) { const t = table; table = null; flush(); table = t; } table = table || []; table.push(line); return; }
    const li = /^\s*(-|\*|\d+\.) (.*)$/.exec(line);
    if (li) { if (table) flush(); const o = /\d/.test(li[1]); if (list && o !== ord) flush(); ord = o; list = list || []; list.push('<li>' + mdInline(li[2]) + '</li>'); return; }
    flush();
    if (/^#{1,6} /.test(line)) out.push('<h4>' + mdInline(line.replace(/^#+ /, '')) + '</h4>');
    else if (/^\s*> ?/.test(line)) out.push('<blockquote>' + mdInline(line.replace(/^\s*> ?/, '')) + '</blockquote>');
    else if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) out.push('<div class="divider" role="separator"></div>');
    else if (line.trim()) out.push('<p>' + mdInline(line) + '</p>');
  });
  if (code) out.push('<pre><code>' + h(code.join('\n')) + '</code></pre>');
  if (math) out.push(mdRich('math', math.join('\n')));
  flush();
  return fm + '<div class="md">' + out.join('') + '</div>';
}

/* 正文里的公式和 Mermaid 图（同一个正文组件）：组件只认语法；真正的绘制交给平台层 PLATFORM.richRender(kind, src, inline) → Promise<html>
   （网页版按需加载渲染库）。画好的结果按源文本缓存：重画时直接放进去，不闪；还没画好或画不了时显示源文本 */
const MD_RICH = {};
function mdRich(kind, src, inline) {
  const k = kind + (inline ? ':i:' : ':b:') + src, done = MD_RICH[k], tag = inline ? 'span' : 'div';
  return '<' + tag + ' class="md-rich" data-rich="' + kind + '"' + (inline ? ' data-inline' : '') + ' data-src="' + h(src) + '"' + (done ? ' data-done' : '') + '>' + (done || (inline ? '<code>' + h(src) + '</code>' : '<pre><code>' + h(src) + '</code></pre>')) + '</' + tag + '>';
}
treeIn(function (ns) {   /* 进树就画（整页重画、只重画一条消息、弹窗局部更新都一样） */
  ns.forEach(function (n) { (n.matches('.md-rich') ? [n] : Array.prototype.slice.call(n.querySelectorAll('.md-rich'))).filter(function (el) { return !el.hasAttribute('data-done') && !el.hasAttribute('data-busy'); }).forEach(function (el) {
    const kind = el.dataset.rich, src = el.dataset.src, inline = el.hasAttribute('data-inline'), k = kind + (inline ? ':i:' : ':b:') + src;
    el.setAttribute('data-busy', '');
    settleHold(PLATFORM.richRender(kind, src, inline)).then(function (html) { MD_RICH[k] = html; document.querySelectorAll('.md-rich[data-busy]').forEach(function (x) { if (x.dataset.src === src && x.dataset.rich === kind) { x.innerHTML = html; x.removeAttribute('data-busy'); x.setAttribute('data-done', ''); } }); },
      function () { el.removeAttribute('data-busy'); el.setAttribute('data-done', ''); });   /* 画不了：留源文本 */
  }); });
});
/* 代码块的轻量高亮（只认注释、字符串、关键字；CSS 认属性名），只在写了语言的代码块里用 */
const MD_KW = /\b(export|function|const|let|var|return|import|from|if|else|for|while|class|new|async|await|type|interface)\b/g;
function mdCode(src, lang) {
  if (!lang) return h(src);
  const keep = [], ph = function (cls, x) { keep.push('<span class="' + cls + '">' + x + '</span>'); return '\u0000' + (keep.length - 1) + '\u0000'; };
  let s = h(src).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, function (m) { return ph('c', m); }).replace(/&#39;[^\n]*?&#39;|&quot;[^\n]*?&quot;|'[^'\n]*'/g, function (m) { return ph('s', m); });
  s = lang === 'css' ? s.replace(/(^|\n)(\s+)([\w-]+)(?=:)/g, function (m, a, b, c) { return a + b + ph('k', c); }) : s.replace(MD_KW, function (m) { return ph('k', m); });
  return s.replace(/\u0000(\d+)\u0000/g, function (m, i) { return keep[+i]; });
}
/* 限行数的列表（组件库）：最多露 k 整行，再加 1 整行渐隐到透明（和折叠同一条规则：k 个完整单位 + 1 个整单位渐隐），一眼看得出还有更多。
   step 是这个列表行高的 token；列表放得下就不滚、不渐隐。 */
const MENU_ROWS = 10;
/* 徽标（组件库）：两种形态，由数据决定——有数就是计数胶囊（超过 99 写 99+），只有“有变化”没有数就是小圆点。
   计数（未读、待处理、@你）不是严重度：所有计数徽标同一个强调色胶囊（“等你来看”）；只有真正带严重度的指示才传 tone（warn / danger …），走同一套 data-tone */
function badge(n, o) {
  o = o || {};
  const a = toneAttr(o.tone) + (o.tip ? ' data-tip="' + h(o.tip) + '"' : '');
  const cn = o.corner ? ' corner' : '';   /* corner：贴宿主右上角（摆放是徽标自己的选项） */
  if (n === true && !o.at) return '<span class="badge dot' + cn + '"' + a + '></span>';
  if (!n) return '';
  return '<span class="badge count num' + cn + '"' + a + '>' + (o.at ? h(WHO_DATA.me().handle) + (n === true ? '' : ' ') : '') + (n === true ? '' : n > 99 ? '99+' : n) + '</span>';   /* at：有人提到你——同一个计数胶囊，前面写你的提及名（用户身份数据里的 mentionPatterns[0]，如 @lang），改了提及名这里跟着变 */
}
function scrollRows(k, step, more) { const v = ['--rows:' + k, '--row-step:var(' + step + ')'].concat(more ? [more] : []); return ' data-rows style="' + v.join(';') + '"'; }

/* ───────── 小件（组件库） ───────── */
/* 路径 + “在访达中显示”；只读的设置值 */
function plain(v) { return '<span class="sys-v">' + h(v) + '</span>'; }
/* 下拉按钮：文字 + ▾，点开菜单 menu（pressed 表示筛选生效中） */
function dropBtn(label, menu, o) { o = o || {}; return '<button type="button" class="cafe-drop" data-act="' + (o.act || 'menu') + '" data-menu="' + menu + '"' + (o.pressed ? ' aria-pressed="true"' : '') + (o.tip ? ' data-tip="' + h(o.tip) + '"' : '') + '><span class="cafe-ellip">' + h(label) + '</span>' + icon('down', 12) + '</button>'; }
/* 列表上方的一行工具：左边若干、右边若干（中间撑开） */
/* 列表上方的工具条：一个操作组（格子），编辑布局时组内的操作可以换位置；items = [{ key, html, span, anchor: start | end }] */
function listBar(o) { return '<div class="cafe-navbar"' + (o.note ? ' data-note="' + o.note + '"' : '') + '>' + cellsHtml({ key: o.key, axis: 'row', items: o.items, saved: pdlCells(o.key), edit: S.editLayout }) + '</div>'; }
/* 可滚动列表的容器（二级栏里的对话列表） */
/* 现有筛选下拉按钮的 PDL 入口；菜单和文案声明在主题里。 */
PDL_COMPONENTS.dropBtn = function (p, sc, root) { return dropBtn(pv(p.label, sc, root), menuLive(pvMenu(p.items, sc, root)), { tip: pv(p.tip, sc, root), pressed: pv(p.pressed, sc, root) }); };
PDL_COMPONENTS.dropBtn.catalog = { g: 'basics', view: 'nav.cafe.shell', get props() { return pdlLoc(PDL_VIEWS['nav.cafe.shell'].blocks[0].props.bar.items.find(function (x) { return x.key === 'group'; }).control.props); } };
function listWrap(html) { return '<div class="cafe-list-wrap">' + html + '</div>'; }
/* 撤销条：一句话 + 几个操作（acts: [{ label, act, data: {k: v} }]） */
function undoBar(text, acts) { return toastHtml(text, acts, { cls: 'raised', attrs: ' data-undo' }); }   /* 撤销条就是轻提示（带操作），抬高一档让开底部的轻提示 */
/* 浮层宿主：对话区的模态窗、图片查看、撤销条挂在这里 */
function layerHost(html) { return '<div id="cafe-layer">' + html + '</div>'; }
/* 一段等宽原样输出（工具结果） */
function monoBlock(t) { return '<div class="mono vw-12">' + h(t) + '</div>'; }

/* 工作台详情的通用零件：详情头、顶栏、可折叠分节、键值表、统计行、进度条、勾选框、原文块、chip 行；列表行（交给 lrow） */
function detailHead(o) {
  const h2 = o.title ? '<h2 class="ws-h"' + (o.note ? ' data-note="' + o.note + '"' : '') + '>' + o.title + '</h2>' : '';   /* 没有标题的子层头（面板顶上一行数据 + 操作）：只有数据行 */
  return '<div class="ws-dhead"' + (o.note && !o.title ? ' data-note="' + o.note + '"' : '') + '>' + (o.back || '') + '<div class="grow">' +
    (o.eyebrow ? '<div class="ws-eyebrow">' + o.eyebrow + '</div>' : '') + (o.status ? '<div class="head-line">' + h2 + o.status + '</div>' : h2) + (o.sub ? '<div class="vw-label below">' + o.sub + '</div>' : '') + '</div>' +
    (o.actions ? '<div class="ws-acts">' + o.actions + '</div>' : '') + '</div>';
}
function topBar(desc, actions, note, back) {
  return '<div class="ws-dhead">' + (back || '') + '<div class="grow">' + (desc ? '<div class="vw-label below"' + (note ? ' data-note="' + note + '"' : '') + '>' + desc + '</div>' : '') + '</div>' + (actions ? '<div class="ws-acts">' + actions + '</div>' : '') + '</div>';
}
/* 展开 / 收起一块（disclosure，组件库唯一的一个）：标题行（展开指示 · 标题 · 补充 · 数量 · 行尾）+ 展开时的内容。
   开合默认记在开合状态里（S.folds[key]，通用动作 toggle）；o.state + o.act：开合由视图模型管。
   v：角色变体——缺省 = 页面 / 面板里的一块（内容和标题之间留一档间距）；list = 列表里的一段（浮层列表的「最近关闭」：内容就是接着的几行，行距跟着所在列表） */
function foldSection(key, title, body, o) {
  o = o || {};
  const open = o.state != null ? !!o.state : S.folds[key] != null ? S.folds[key] : !!o.open;   /* o.state：调用方自己管开合（比如弹窗内容）；o.act 换成它的动作 */
  return '<div class="ws-fold"' + (o.v ? ' data-v="' + o.v + '"' : '') + (o.note ? ' data-note="' + o.note + '"' : '') + '><button type="button" class="ws-fold-h" data-act="' + (o.act || 'toggle') + '"' + (o.act ? '' : ' data-path="folds.' + h(key) + '" data-values="' + (o.open ? 'false|true' : 'true|false') + '" data-cast="bool"') + (o.data || '') + ' data-k="' + h(key) + '" data-d="' + (o.open ? 1 : 0) + '" aria-expanded="' + open + '">' + twisty(open) + '<span>' + title + '</span>' + (o.sub ? '<span class="faint ws-fold-s">' + o.sub + '</span>' : '') + (o.count != null ? '<span class="faint num">' + o.count + '</span>' : '') + (o.trail ? '<span class="grow"></span>' + o.trail : '') + '</button>' + (open ? '<div class="ws-fold-b">' + body + '</div>' : '') + '</div>';
}
/* 键值（组件库，唯一的一个）：一列标签 + 一列值。一个块里的所有行共用一列标签：宽度按这块里最宽的标签取档（s / m / l，token --kv-k-*），
   超过最宽一档的标签省略（悬停看全文）；值从标签列右边开始左对齐，可以换行。surface: 'group' 时自带分组底（工作台里的一块）。
   pairs：[[标签, 值的 HTML]] */
function kvGrid(pairs, o) {
  o = o || {};
  return '<dl class="kvg' + (o.surface ? ' kvg-' + o.surface : '') + '">' + pairs.map(function (p) { return '<dt data-tip="' + h(p[0]) + '">' + h(p[0]) + '</dt><dd>' + p[1] + '</dd>'; }).join('') + '</dl>';
}
function statRow(items) { return '<div class="kv">' + items.map(function (x) { return '<div' + (x[2] ? ' data-tip="' + h(x[2]) + '"' : '') + '><b' + (x[3] ? ' class="ws-' + x[3] + '"' : '') + '>' + x[0] + '</b><span>' + h(x[1]) + '</span></div>'; }).join('') + '</div>'; }
function progBar(pct, tone) { return '<span class="ws-prog' + (tone ? ' ' + tone : '') + '"><i style="--u-width:' + Math.max(0, Math.min(100, pct)) + '%" class="u-v-width"></i></span>'; }
function checkMark(on, act, data, label) { return '<button type="button" class="cafe-check" role="checkbox" aria-checked="' + !!on + '" aria-label="' + h(label || tc('common.select')) + '" data-act="' + act + '"' + (data || '') + '>' + checkInd() + '</button>'; }   /* 只有方框的勾选：同一个勾选组件（cafe-check），不另画一种 */
function preBlock(t) { return '<pre class="ws-pre">' + h(t) + '</pre>'; }
function chipList(list) { return '<div class="chips">' + list.join('') + '</div>'; }
function chipItem(t, act, data) { return chipHtml({ label: t, act: act, data: data }); }

/* 视图和块的读取状态（组件库，唯一一处）：加载中 = 骨架（可带一行淡字）；出错 = 一行危险色调的提示 + 重试；
   数据过期 = 一行留意色调的提示 + 重新读取（内容照常画在下面）；空 = 空状态。视图 / 块只声明文字（loading / error / stale / empty），重试是什么由引擎给 */
function viewState(kind, o) {
  o = o || {};
  const again = function (label) { return o.retry ? btn(label, { sm: true, act: o.retry.act, data: o.retry.data || '' }) : ''; };
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
/* 一段等宽文字（路径、id） */
function monoText(t) { return '<span class="mono">' + h(t) + '</span>'; }
/* 列表上方的小标签（说明进 ?） */
function listLabel(t, help) { return lrSection(t, '', { help: help }); }
/* 一行操作，后面可带一句弱色状态 */
function actionLine(acts, note) { return '<div class="u-mt-s sw-line">' + acts + (note ? muted(h(note)) : '') + '</div>'; }
/* 宽一点的弹窗内容（同步结果、异常列表这类表格感的内容） */
function wideBody(html) { return '<div class="dlg-wide">' + html + '</div>'; }
/* 长说明：只露一行，悬停给全文（内容是已经转义好的片段） */
function longText(t) { return '<span data-tip="' + h(String(t).replace(/<[^>]+>/g, '')) + '">' + t + '</span>'; }

/* 带小标题的要点列表（条目是已经转义好的片段）；没有条目时不画 */
function bulletList(title, items) { return items && items.length ? '<div class="cap-dlg-h">' + h(title) + '</div><ul class="rules">' + items.map(function (x) { return '<li>' + x + '</li>'; }).join('') + '</ul>' : ''; }
/* 现有正文原件的 PDL 入口：只解析声明，仍由同一个原件画。 */
PDL_COMPONENTS.wideBody = function (p, sc, root) { return wideBody(pvBlocks(p.blocks, sc, root)); };
PDL_COMPONENTS.longText = function (p, sc, root) { return longText(pvParts(p.parts, sc, root)); };
PDL_COMPONENTS.bulletList = function (p, sc, root) { return bulletList(pv(p.title, sc, root), pvList(p.from, sc, root).map(function (x) { return pvPart(p.item, x, root); })); };
PDL_COMPONENTS.wideBody.catalog = { g: 'structure', props: { blocks: [{ type: 'text', variant: 'para', text: '$.sub' }] } };
PDL_COMPONENTS.longText.catalog = { g: 'basics', props: { parts: [{ text: '$.sub' }] } };
PDL_COMPONENTS.bulletList.catalog = { g: 'structure', props: { title: '$.label', from: '$.chips', item: { text: '@' } } };

/* ───────── 表单弹窗（组件库）：字段全是数据，开合 / 切换 / 增删都改数据再重画；输入随时写回字段，重画不丢 ─────────
   字段：chips { vals, kind, ph, label, empty }、swatch { cur }、avatar { text, tint }、opts { items: [{ v, title, sub }], cur, custom: { id, placeholder } }、
         env { open, rows: [[k, v]], toggle: '高级配置（可选）' }、kv（只读键值）、type / min / maxv（数字框）、foot / footTone / links（字段下的一行） */
function dlgFootHtml(f) {
  const t = f.foot ? (f.footTone ? '<span class="' + f.footTone + '-t">' + h(f.foot) + '</span>' : h(f.foot)) : '';
  return t + (f.links || []).map(dlgLink).join('');
}
function dlgLink(l) { return l.href ? '<a class="btn btn-text" href="' + h(l.href) + '" target="_blank" rel="noopener">' + h(l.label) + ' ↗</a>' : btn(l.label, { link: true, act: l.act, data: l.msg ? ' data-msg="' + h(l.msg) + '"' : '' }); }
function dlgFoot(o) { return '<div class="field-foot">' + h(o.text || '') + (o.links || []).map(dlgLink).join('') + '</div>'; }
function dlgPanes(p) { return '<div class="seg' + (p.locked ? ' u-disabled' : '') + '" role="group"' + (p.locked ? ' aria-disabled="true"' : '') + '>' + p.items.map(function (x) { return '<button type="button"' + (p.locked ? '' : ' data-act="set" data-path="s.dialog.panes.cur"') + ' data-v="' + h(x.v) + '" aria-pressed="' + (x.v === p.cur) + '">' + h(x.label) + '</button>'; }).join('') + '</div>'; }
function dlgSpecial(f) {
  if (f.chips) return chipBox(f.id, f.chips.vals, { kind: f.chips.kind, ph: f.chips.ph, label: f.chips.label, empty: f.chips.empty, lock: f.chips.lock });
  if (f.swatch) return colorCtl({ kind: 'slot', value: f.swatch.cur, act: 'swatch', label: f.label, name: f.id });
  if (f.color) return colorCtl({ id: f.id, value: f.color.value, slots: 'name', label: f.label });   /* 统一的取色（调色盘）；值在同 id 的颜色输入里，dialogSync 照常读 */
  if (f.avatar) return avatarUp(f.avatar.lead, 'xl', { label: tc('control.upload'), accept: 'image/png,image/jpeg,image/webp', msg: tc('control.avatarUploaded') });   /* 和成员表单同一个可上传头像 */
    '<label class="btn btn-sm">' + h(tc('control.upload')) + '<input type="file" accept="image/png,image/jpeg,image/webp" class="sr" data-filemsg="' + h(tc('control.avatarUploaded')) + '"></label>' + btn(tc('common.clear'), { sm: true, act: 'avatarClear' }) + '</div>';
  if (f.opts) return '<div class="opts">' + f.opts.items.map(function (m) { return opt(f.id, m.v, f.opts.cur, m.title, m.sub, { act: 'set', data: ' data-path="dlgf.' + h(f.id) + '.opts.cur"' }); }).join('') +
    (f.opts.custom && f.opts.cur === 'custom' ? '<div class="custom-model"><input class="input mono" id="' + f.opts.custom.id + '" placeholder="' + h(f.opts.custom.placeholder || '') + '" value="' + h(f.opts.custom.value || '') + '"></div>' : '') + '</div>';
  if (f.env) return btn(f.env.toggle || tc('control.envToggle'), { link: true, act: 'toggle', data: ' data-path="dlgf.' + h(f.id) + '.env.open"' }) + (f.env.open ? '<div class="env-rows">' + f.env.rows.map(function (r, i) { return '<div class="env-row"><input class="input mono" id="' + f.id + '-k' + i + '" value="' + h(r[0]) + '" placeholder="KEY" aria-label="' + h(tc('control.envKey')) + '"><input class="input mono" id="' + f.id + '-v' + i + '" value="' + h(r[1]) + '" placeholder="value" aria-label="' + h(tc('kv.value')) + '"></div>'; }).join('') + '</div>' + btn(tc('control.envAdd'), { sm: true, icon: 'plus', act: 'listOp', data: ' data-path="dlgf.' + h(f.id) + '.env.rows" data-op="add" data-shape="pair"' }) : '');
  return '';
}

/* 轮换（组件库的通用行为）：data-rot 的元素同一时刻只露一个子项，多于一个时按节拍轮换（每项 8 拍），悬停暂停。
   纯 CSS：显示哪一项是时间的函数（--rot-t 按 steps(n) 随动画走，子项在 --rot-t 等于自己的 --i 时露出），不存游标、不用计时器；
   诞生时和其它循环一样对齐到大拍（lrow.js 的 animationstart）。rotHtml 给出容器和每项的序号 */
function rotHtml(tag, cls, items, attrs) {
  const n = items.length;
  return '<' + tag + ' class="' + cls + '"' + (n > 1 ? ' data-rot style="--n:' + n + '"' : '') + (attrs || '') + '>' + items.map(function (x, i) { return x.replace(/^<(\w+)/, '<$1 style="--i:' + i + '"'); }).join('') + '</' + tag + '>';
}

/* ───────── 目录登记：这个文件里的原件 ───────── */
Object.assign(LIB_CATALOG, {
  colorCtl: { g: 'basics', inline: true, via: [], ex: function (s) { return colorCtl({ id: 'cat-col', value: s.color.value, label: s.color.label }); } },   /* 取色：组件库原件（PDL 的 color 控件也画它：成员的代表色） */
  resizeHandle: { g: 'structure', inline: true, via: ['shell'], ex: function () { return '<div class="cat-rh">' + resizeHandle({ which: 'catalog', side: 'end', label: tc('catalog.ex.resize'), tip: tc('catalog.ex.resize') }) + '</div><span class="faint">' + h(tc('catalog.ex.resizeHint')) + '</span>'; } },
  cells: { g: 'structure', via: ['prop:ordered', 'shell'], ex: function (s) { return cellsHtml({ key: 'catalog', axis: 'row', items: s.chips.map(function (c, i) { return { key: c, html: btn(c, { sm: true, act: 'noop' }), span: i === 0 ? 'm' : 's', anchor: i < 2 ? 'start' : 'end' }; }) }); } },
  scrollY: { g: 'structure', via: ['prop:scroll', 'type:pop', 'type:chatpage'], ex: function (s) { return '<div class="scroll cat-scroll">' + s.radios.concat(s.chips, s.steps).map(function (t) { return '<p>' + h(t) + '</p>'; }).join('') + '</div>'; } },
  scrollX: { g: 'structure', via: ['type:tabs', 'type:lanes'], ex: function (s) { return '<div class="scroll-x cat-scroll-x"><span class="chips">' + s.chips.concat(s.radios, s.steps).map(function (t) { return chipHtml({ label: h(t) }); }).join('') + '</span></div>'; } },
  tooltip: { g: 'structure', inline: true, via: ['prop:tip', 'prop:help'], ex: function (s) { return btn(s.more, { act: 'noop', data: ' data-tip="' + h(s.sub) + '"' }) + helpTip(s.sub); } },
  toast: { g: 'alerts', inline: true, via: ['act:toast'], ex: function (s) { return toastHtml(s.toneText.ok, { label: tc('common.undo'), act: 'noop', data: '' }, { cls: 'cat-static' }); },
    tones: function (t, s) { return toastHtml(s.toneText[t], null, { cls: 'cat-static', tone: t }); } },
  badge: { g: 'alerts', inline: true, via: ['type:threads', 'shell'], ex: function () { return badge(8) + badge(true) + badge(3, { at: true }) + badge(2, { tone: 'warn' }); },
    tones: function (t) { return badge(3, { tone: t }) + badge(true, { tone: t }); },
    count: function () { return badge(4) + badge(120) + badge(true) + badge(2, { at: true }); } },
  srow: { g: 'rows', via: ['type:settings'], ex: function (s) { return group([srow(s.label, sw(true, 'noop', '', s.label)), srow(s.label2, h(s.value))]); } }
});
/* 窄屏的侧栏抽屉（开关是主题声明的 drawer 按钮：toggle s.navOpen）：开着时根上带 nav-open；换地方（导航完成，引擎的 NAV_RESET）时收起；
   Esc 收起——排在各模块自己的 Esc 之后（启动时才登记，KEY_FNS 的最后一个），别的浮签先收 */
S.navOpen = false;
APP_CLASS.push(function () { return S.navOpen ? 'nav-open' : ''; });
NAV_RESET.push(function (o) { if (!o.popupsOnly) S.navOpen = false; });
onStart('boot', function () { KEY_FNS.push(function (e) { if (e.key !== 'Escape' || !S.navOpen) return false; S.navOpen = false; render(true); return true; }); });
function copyFlash(el) {
  const g = el && el.querySelector && el.querySelector('svg'); if (!g) return;
  const was = g.outerHTML, sz = g.getAttribute('width') || 14;
  el.setAttribute('data-copied', ''); g.outerHTML = icon('check', +sz);
  setTimeout(function () { if (!el.isConnected) return; el.removeAttribute('data-copied'); const c = el.querySelector('svg'); if (c) c.outerHTML = was; }, ms('--hold-copied'));
}
/* 引擎经组件库画的部件（ENGINE_PARTS，见 engine/core.js） */
Object.assign(ENGINE_PARTS, { float: floatHtml, modal: modalHtml, menu: menuHtml, dialog: dialogHtml, dialogSync: dialogSync, toast: toastHtml, undo: undoBar, copied: copyFlash, back: engineBack, md: mdLite,
  icons: function (map) { Object.assign(ICONS, map); },
  framePopup: function (k, pk, d) { return d.view ? pdlView(d.view) : floatPanel({ cls: 'plugin-float', title: d.title, pop: k, body: frame(pk, d.title) }); } });
PAINT_SYNC.push(selSync);
const cafeCheck = checkBox;
/* 没有绑定值的输入：草稿在应用的表单草稿里（状态路径 cs.f，按输入框 id） */
function cafeFld(id, val, ph, o) { return textInput(id, val == null ? ((pathGet('cs.f') || {})[id] || '') : val, ph, o); }
function cafeSel(id, opts, cur, change) { return sel(id, opts, cur, { change: change || 'cafeSel', label: id }); }
function cafeMore(key, k, label, cls) { return rowMore(key, k, label, cls); }
function cafeRadio(g, v, title, sub) { return opt(g, v, (pathGet('cs.f') || {})['r-' + g], title, sub, { act: 'set', data: ' data-path="cs.f.r-' + h(g) + '"', plain: true }); }
function cafeIb(label, ic, act, i, extra) { return btn(label, { sm: true, iconOnly: true, icon: ic, act: act, data: ' data-i="' + i + '"' + (extra || '') }); }

/* 导出只带组件库登记的素材引用，用户自己的背景不属于主题。 */
/* 滑块边拖边更新：自己的数值，和同一个值的其他滑块（同 data-input + data-k）一起跟着动；提交仍在 change */
document.addEventListener('input', function (e) {
  const r = e.target; if (!r.classList || !r.classList.contains('ws-range')) return;
  const same = r.dataset.input && r.dataset.k ? document.querySelectorAll('.ws-range[data-input="' + r.dataset.input + '"][data-k="' + r.dataset.k + '"]') : [r];
  Array.prototype.forEach.call(same, function (x) { if (x !== r) x.value = r.value; const o = x.id && document.getElementById(x.id + '-o'); if (o) o.textContent = r.value + (x.dataset.unit || ''); });
}, true);
