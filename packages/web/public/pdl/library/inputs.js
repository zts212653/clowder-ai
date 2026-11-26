/* 边界：一个含义一个组件、不为接口定制、不按位置推导样式 */
/* 输入类：输入框、选择、成员选择、取色、单选 / 勾选、字段与字段错误、搜索、补全提示、标签 / 键值编辑器 */
'use strict';
/* 勾选标记（方框 + 勾）：唯一的画法。勾选控件（cafe-check）、目标勾选、只读清单都用它；on 也可以由外层的 aria-checked / 原生 :checked 给 */
function checkInd(on) { return '<span class="box' + (on ? ' on' : '') + '" aria-hidden="true">' + icon('check', 12) + '</span>'; }
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
/* 单选项：o.act 换成自己的动作（默认 radio），o.plain 标题不加粗 */
function opt(g, v, cur, title, sub, o) { o = o || {}; return '<div class="opt" role="radio" tabindex="0" aria-checked="' + (v === cur ? 'true' : 'false') + '" data-act="' + (o.act || 'radio') + '" data-g="' + g + '" data-v="' + h(v) + '"' + (o.data || '') + '><span class="radio"></span><div class="row-main"><div class="' + (o.plain ? 'u-w-normal ' : '') + 'row-title">' + h(title) + '</div>' + (sub ? '<div class="row-sub">' + h(sub) + '</div>' : '') + '</div></div>'; }
/* 勾选框按钮：[框] 标签（标签是已经转义好的片段） */
function checkBox(on, label, act, data, disabled) { return '<button type="button" class="cafe-check" role="checkbox" aria-checked="' + (on === 'mixed' ? 'mixed' : !!on) + '" data-act="' + act + '"' + (data || '') + (disabled ? ' disabled' : '') + '>' + checkInd() + label + '</button>'; }
/* 单行输入框：o.mono 等宽、o.max 最长、o.disabled、o.input 输入时的处理（默认 cafeField） */
function textInput(id, val, ph, o) { o = o || {}; return '<input class="input' + (o.mono ? ' mono' : '') + '" id="' + id + '" value="' + h(val == null ? '' : val) + '" placeholder="' + h(ph || '') + '" data-input="' + (o.input || 'cafeField') + '"' + (o.max ? ' maxlength="' + o.max + '"' : '') + (o.disabled ? ' disabled' : '') + (o.type ? ' type="' + o.type + '"' : '') + (o.k != null ? ' data-k="' + h(o.k) + '"' : '') + '>'; }
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
/* 返回：唯一的画法（back 含义的图标 + 去处的名字）；没有名字时只有图标，名字进 aria-label */
/* 缩略图单选的一项（组件库）：一个小窗口（窄栏、侧栏、页面、一张卡片、强调色的一笔），颜色是数据（这套主题在某个外观下的几个值），写成 --u-* 交给样式。
   thumb 给一份就是一个窗口；给两份就左右各半（自动 = 左浅右深）。下面是名字；当前项用标准的选中样式 */
function modeThumb(x, act, args) {
  const win = function (c) { const v = Object.assign({}, snapTokens(c.palette, c.mode), (themeVals(c.palette) || {})[c.mode] || {}); return '<span class="thumb-win" style="--u-rail:' + h(v['bg-rail']) + ';--u-nav:' + h(v['bg-nav']) + ';--u-page:' + h(v['bg-page']) + ';--u-group:' + h(v['bg-group']) + ';--u-fg:' + h(v['fg-muted']) + ';--u-accent:' + h(v.accent) + '"><i class="tw-rail"></i><i class="tw-nav"></i><i class="tw-page"><b class="tw-card"></b><b class="tw-dot"></b></i></span>'; };
  return '<button type="button" class="thumb-opt" role="radio" aria-checked="' + !!x.active + '"' + actAttrs(act, Object.assign({}, args, { v: x.v })) + '><span class="thumb' + (x.thumb.length > 1 ? ' split' : '') + '">' + x.thumb.map(win).join('') + '</span><span class="thumb-l">' + h(tc('modeThumb.label', x.v)) + '</span></button>';
}
function checkMark(on, act, data, label) { return '<button type="button" class="cafe-check" role="checkbox" aria-checked="' + !!on + '" aria-label="' + h(label || tc('common.select')) + '" data-act="' + act + '"' + (data || '') + '>' + checkInd() + '</button>'; }   /* 只有方框的勾选：同一个勾选组件（cafe-check），不另画一种 */
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

/* ───────── 表单里的两个编辑器（组件库） ─────────
   chipBox：可增删的一组标签（@ 名字、擅长标签、额外参数）；表单里改的是草稿（重画），弹窗里直接改 DOM。
   kvEditor：键值对（环境变量、标头）或一列值（参数）；值可以掩码、可以显示；只读时只列出键名 */
/* 标签编辑器（组件库唯一一个）：一排标签 + 同一排里加一项的输入框。chips 是画好的标签；id / kind / k：一列字的编辑器（chipAdd / chipDel 按它们找数据） */
function tagEditor(o) {
  return '<div class="chips tag-ed"' + (o.id ? ' id="' + h(o.id) + '" data-kind="' + h(o.kind || '') + '" data-k="' + h(o.k || '') + '"' : '') + '>' + (o.chips.length ? o.chips.join('') : o.empty ? '<span class="faint chip-empty">' + h(o.empty) + '</span>' : '') + (o.field || '') + '</div>';
}
function chipBox(id, vals, o) {
  o = o || {};
  const ed = argAttrs({ for: id, kind: o.kind || '', k: o.k || '' });   /* 增删的动作拿到的参数：哪个编辑器（for）、哪种值（kind）、草稿里的哪一格（k）、哪一项（v）——动作不回头读页面 */
  return tagEditor({ id: id, kind: o.kind, k: o.k, empty: o.empty || tc('chip.empty'), chips: vals.map(function (v) { return chipHtml({ label: h(v), attrs: ' data-v="' + h(v) + '"', x: o.lock && o.lock === v ? '' : chipX('chipDel', ed + argAttrs({ v: v }), tc('chip.remove', v)) }); }),
    field: goField({ add: true, id: id + '-in', placeholder: o.ph || tc('common.add'), label: o.label || tc('common.add'), go: 'chipAdd', data: ed, goLabel: tc('common.add') }) });   /* 加一项：回车或框尾的勾号提交（表单输入的唯一规则） */
}
function kvEditor(o) {
  /* path：草稿在状态里的位置（通用动作 listOp / toggle 用；增删是 listOp，显示 / 隐藏值是 toggle 这一行的第 3 格） */
  const P = function (p) { return o.path ? ' data-path="' + h(p) + '"' + (o.single ? '' : ' data-shape="pair"') : ''; };
  const A = function (a, extra, p) { return ' data-act="' + a + '" data-l="' + h(o.key) + '"' + P(p || o.path) + (extra || ''); };
  if (o.ro) return o.rows.length ? '<span class="chips">' + o.rows.map(function (r) { return chipHtml({ cls: 'mono', label: h(r.k) }); }).join('') + '</span>' : '<span class="muted">' + h(o.empty || tc('common.none')) + '</span>';
  const inp = function (key, val, ph, extra) { return '<input class="input mono" data-draft="' + key + '"' + (o.input ? ' data-input="' + o.input + '"' : '') + ' value="' + h(val) + '" placeholder="' + h(ph || '') + '"' + (extra || '') + '>'; };
  return '<div class="cap-kvs">' + o.rows.map(function (r, i) {
    const del = btn(tc(o.single ? 'kv.deleteItem' : 'kv.deleteRow'), { sm: true, iconOnly: true, icon: 'delete', data: A(o.del, ' data-i="' + i + '" data-op="del"') });
    if (o.single) return '<div class="cap-kv cap-arg">' + inp(o.key + ':' + i, r.v, r.ph, ' aria-label="' + h(tc('kv.itemN', i + 1)) + '"') + del + '</div>';
    return '<div class="cap-kv">' + inp(o.key + ':' + i + ':k', r.k, o.keyPh || tc('kv.key'), ' aria-label="' + h(tc('kv.key')) + '"') + '<div class="cap-pw">' + inp(o.key + ':' + i + ':v', r.v, r.ph || tc('kv.value'), ' type="' + (r.show ? 'text' : 'password') + '" aria-label="' + h(tc('kv.valueOf', r.k)) + '"') +
      btn(tc(r.show ? 'kv.hide' : 'kv.show'), { sm: true, iconOnly: true, icon: 'eye', data: A(o.eye, ' data-i="' + i + '"', o.path + '.' + i + '.2'), pressed: !!r.show }) + '</div>' + del + '</div>';
  }).join('') + btn(o.add, { sm: true, icon: 'plus', act: o.del, data: ' data-l="' + h(o.key) + '" data-op="add"' + P(o.path) }) + '</div>';
}

/* ───────── 多行输入：按内容长高（grow）、同行补全（complete）─────────
   grow：浏览器按内容定高度（CSS field-sizing: content，见 core.css），最少 --ta-rows-min 行、最多 --ta-rows-max 行，再多就在框里滚动；不量、不改 style。
   complete：候选里第一条以已输入内容开头的（至少输入了 2 个字、光标在末尾），剩下的部分淡色接在已输入的字后面（同一行）；
   Tab / → 采纳，接着打字就覆盖掉。都是组件自己的本地行为：打字不重画 */
const TA_COMPLETE = {}, TA_GHOST_CSS = {};
/* 覆盖层和输入框同一套排版：已输入的字透明占位，只露出后面的淡色部分。排版抄成一条按输入框 id 的样式规则（组件自己的样式表），
   不写在覆盖层的 style 上——重画会把元素的属性换回声明的样子；每次更新补全时重抄（输入框的内边距可能随状态变） */
function taGhostStyle(ta) {
  const cs = getComputedStyle(ta), pad = ['Top', 'Right', 'Bottom', 'Left'].map(function (d) { return (parseFloat(cs['padding' + d]) + parseFloat(cs['border' + d + 'Width'])) + 'px'; }).join(' ');   /* 覆盖层没有边框：输入框的边框宽度算进内边距 */
  const rule = '.ta-wrap:has(> #' + CSS.escape(ta.id) + ') > .ta-ghost { font-family: ' + cs.fontFamily + '; font-size: ' + cs.fontSize + '; font-weight: ' + cs.fontWeight + '; font-style: ' + cs.fontStyle + '; line-height: ' + cs.lineHeight + '; letter-spacing: ' + cs.letterSpacing + '; text-indent: ' + cs.textIndent + '; white-space: ' + cs.whiteSpace + '; word-break: ' + cs.wordBreak + '; overflow-wrap: ' + cs.overflowWrap + '; padding: ' + pad + '; }';
  if (TA_GHOST_CSS[ta.id] === rule) return;
  TA_GHOST_CSS[ta.id] = rule;
  let st = document.getElementById('ta-ghost-css'); if (!st) { st = document.createElement('style'); st.id = 'ta-ghost-css'; document.head.appendChild(st); }
  st.textContent = Object.keys(TA_GHOST_CSS).map(function (k) { return TA_GHOST_CSS[k]; }).join('\n');
}
function taGhost(ta) {
  const g = ta.parentElement && ta.parentElement.querySelector(':scope > .ta-ghost'); if (!g) return;
  const list = TA_COMPLETE[ta.id] || [], v = ta.value, end = ta.selectionStart === v.length && ta.selectionEnd === v.length;
  const hit = v.length >= 2 && end ? list.find(function (x) { return typeof x === 'string' && x.indexOf(v) === 0 && x.length > v.length; }) || '' : '';
  if (!hit) {
    if (g.children[0].textContent) g.children[0].textContent = '';
    if (g.children[1].textContent) g.children[1].textContent = '';
    delete ta.dataset.ghost;
    return;
  }
  taGhostStyle(ta);
  g.children[0].textContent = v; g.children[1].textContent = hit.slice(v.length);
  ta.dataset.ghost = hit;   /* 滚动对齐交给下面的 scroll 监听：打字时不读 scrollTop（读它会让整页先排一次版） */
}
document.addEventListener('input', function (e) { const t = e.target; if (t && t.tagName === 'TEXTAREA' && TA_COMPLETE[t.id]) taGhost(t); }, true);
document.addEventListener('selectionchange', function () { const t = document.activeElement; if (t && t.tagName === 'TEXTAREA' && TA_COMPLETE[t.id]) taGhost(t); });
document.addEventListener('scroll', function (e) { const t = e.target; if (t && t.tagName === 'TEXTAREA') { const g = t.parentElement.querySelector(':scope > .ta-ghost'); if (g) g.scrollTop = t.scrollTop; } }, true);
KEY_FNS.push(function (e) {
  const t = e.target; if (!t || t.tagName !== 'TEXTAREA' || !t.dataset.ghost || e.isComposing || (e.key !== 'Tab' && e.key !== 'ArrowRight') || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return false;
  if (t.selectionStart !== t.value.length || t.selectionEnd !== t.value.length || document.querySelector('.pop-host')) return false;   /* 开着弹层时 Tab 是选候选（弹层自己的键） */
  e.preventDefault(); t.value = t.dataset.ghost; t.setSelectionRange(t.value.length, t.value.length); t.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
});
treeMatch('.ta-wrap > textarea', taGhost);
/* ───────── 目录登记：这个文件里的组件 ───────── */
Object.assign(LIB_CATALOG, {
  colorCtl: { g: 'basics', inline: true, via: [], ex: function (s) { return colorCtl({ id: 'cat-col', value: s.color.value, label: s.color.label }); } },   /* 取色：组件库原件（PDL 的 color 控件也画它：成员的代表色） */
});
