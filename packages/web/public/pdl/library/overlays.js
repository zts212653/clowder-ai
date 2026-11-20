/* 边界：一个含义一个组件、不为接口定制、不按位置推导样式 */
/* 浮层：菜单、浮窗、对话框、模态框；引擎经组件库画的部件（ENGINE_PARTS）在这里登记 */
'use strict';

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
PDL_COMPONENTS.floatHtml = function (o, sc, root) { const label = pv(o.label, sc, root), pop = pv(o.close, sc, root); return floatHtml({ cls: pv(o.className, sc, root), label: label, head: pop ? '<span class="u-strong grow">' + h(label) + '</span>' + popX(pop) : '', body: pvBlocks(o.blocks, sc, root) }); };   /* close：弹窗名，头上是名字和 ×（弹窗声明了 exit x 时） */
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
  /* rows：正文最多几行（容器自己声明；超出在正文里滚），不写就跟内容走；两种都不超出页面 */
  /* noFieldFocus：正文里有自己的一套输入（比如“挂载规则”底部的添加框），刚打开时不要把焦点丢进去、把正文滚到底 */
  /* key：画在哪个弹窗里（缺省是通用对话框 dialog；未保存确认 confirm、对话区的模态窗、主题计算器也是这个组件）；alert：要你先回答才能继续（alertdialog）；acts：底部按钮的声明（btnsHtml），代替 ok / 取消；
     actions：标题行里 × 前面的操作（头：标题 · 空白 · 操作 · ×）；modal: false 不是模态（没有遮罩的工具窗）；form：表单名（通用对话框有 ok 提交时默认为 dialog）；工具内容只用同一外壳，不隐式成为表单 */
  const k = d.key || 'dialog', tid = 'dlg-t' + (d.key ? '-' + String(d.key).replace(/\W/g, '-') : ''), form = d.form || (!d.key && d.ok ? 'dialog' : ''), tag = form ? 'form' : 'section';
  const body = typeof d.body === 'object' ? pvBlocks([d.body], d, d) : d.body;
  const text = d.text && typeof d.text === 'object' ? pvParts(d.text.parts, d.text.data, d.text.data) : d.text;   /* 写成片段的正文先画出来：画出来是空的就和没有正文一样 */   /* 声明的 PDL 正文每次按当前 VM 画，不在打开弹窗时存成一份旧 HTML。 */
  return '<' + tag + ' class="dialog' + (d.wide ? ' dialog-wide' : '') + (d.layout === 'viewport' ? ' dialog-viewport' : d.layout === 'fill' ? ' dialog-fill' : '') + (d.span === 'full' ? ' dialog-full' : '') + '"' + (d.rows ? ' style="--dlg-rows: ' + Number(d.rows) + '"' : '') + (d.noFieldFocus ? ' data-no-field-focus' : '') + toneAttr(d.tone || (d.danger ? 'danger' : '')) + ' role="' + (d.alert ? 'alertdialog' : 'dialog') + '"' + (d.modal === false ? '' : ' aria-modal="true"') + ' aria-labelledby="' + tid + '"' + (form ? ' data-form="' + form + '"' : '') + '><div class="dlg-head"><h3 id="' + tid + '">' + h(d.title) + helpTip(d.help) + '</h3>' + (d.actions || '') + popX(k) + '</div>' +
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
function floatPanel(o) { return floatHtml({ cls: o.cls, label: o.title, head: '<span class="u-strong grow">' + h(o.title) + '</span>' + popX(o.pop), body: '<div class="u-p-foot scroll">' + o.body + '</div>', bare: true }); }   /* 小窗的内容在小窗里滚动：插件界面框量的是内容的高度，比窗高时不越出窗外 */

/* 模态窗（对话区的“整理、导入、开局……”）：标题（说明进 ?）+ 关闭、可滚动的内容、底部按钮；整窗是一个表单，可拖动 */
function modalHtml(o) {
  return dialogHtml({ key: o.key || 'chat.modal', form: o.form, title: o.title, help: o.help, wide: o.wide, error: o.error, body: o.body, acts: btnsHtml(o.foot) ? o.foot : null });   /* 同一个对话框组件，不另画一份头 */
}
/* 限行数的列表（组件库）：最多露 k 整行，再加 1 整行渐隐到透明（和折叠同一条规则：k 个完整单位 + 1 个整单位渐隐），一眼看得出还有更多。
   step 是这个列表行高的 token；列表放得下就不滚、不渐隐。 */
const MENU_ROWS = 10;

/* ───────── 表单弹窗（组件库）：字段全是数据，开合 / 切换 / 增删都改数据再重画；输入随时写回字段，重画不丢 ─────────
   字段：chips { vals, kind, ph, label, empty }、swatch { cur }、avatar { text, tint }、opts { items: [{ v, title, sub }], cur, custom: { id, placeholder } }、
         env { open, rows: [[k, v]], toggle: '高级配置（可选）' }、kv（只读键值）、type / min / maxv（数字框）、foot / footTone / links（字段下的一行） */
function dlgFootHtml(f) {
  const t = f.foot ? (f.footTone ? '<span class="' + f.footTone + '-t">' + h(f.foot) + '</span>' : h(f.foot)) : '';
  return t + (f.links || []).map(dlgLink).join('');
}
function dlgLink(l) { return l.href ? '<a class="btn btn-text" href="' + h(l.href) + '" target="_blank" rel="noopener">' + h(l.label) + icon('openExternal', 12) + '</a>' : btn(l.label, { link: true, act: l.act, data: l.msg ? ' data-msg="' + h(l.msg) + '"' : '' }); }
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
/* 引擎经组件库画的部件（ENGINE_PARTS，见 engine/core.js） */
Object.assign(ENGINE_PARTS, { float: floatHtml, modal: modalHtml, menu: menuHtml, dialog: dialogHtml, dialogSync: dialogSync, toast: toastHtml, undo: undoBar, copied: copyFlash, back: engineBack, md: mdLite,
  icons: function (map) { Object.assign(ICONS, map); },
  framePopup: function (k, pk, d) { return d.view ? pdlView(d.view) : floatPanel({ cls: 'plugin-float', title: d.title, pop: k, body: pdlView(Object.keys(PDL_VIEWS).find(function (id) { return PDL_VIEWS[id].popup === k; })) }); } });
