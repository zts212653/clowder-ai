/* 边界：一个含义一个组件、不为接口定制、不按位置推导样式 */
/* 按钮类：按钮、标签胶囊、开关、分段、下拉按钮、展开箭头、复制 */
'use strict';
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

/* 返回：通用组件。工作台的“‹ 来源”、区域被占用时的“‹ 返回”都用它 */
/* 展开指示（组件库，唯一一个）：分组、树、手风琴、工作台折叠段、过程记录的“展开”都用它——向右的箭头，展开时转 90°（由所在按钮的 aria-expanded 或 data-open 决定，开关只改属性）。
   内容折叠（消息中间 / 底部折叠、排队“还有 N 条”）是另一个角色，用 foldTg */
function twisty(open) { return '<span class="tw" data-open="' + !!open + '" aria-hidden="true">' + icon('right', 14) + '</span>'; }   /* 展开指示只有一个尺寸 */
/* 下拉按钮：文字 + ▾，点开菜单 menu（pressed 表示筛选生效中） */
function dropBtn(label, menu, o) { o = o || {}; return '<button type="button" class="cafe-drop" data-act="' + (o.act || 'menu') + '" data-menu="' + menu + '"' + (o.pressed ? ' aria-pressed="true"' : '') + (o.tip ? ' data-tip="' + h(o.tip) + '"' : '') + '><span class="cafe-ellip">' + h(label) + '</span>' + icon('down', 12) + '</button>'; }
/* 可滚动列表的容器（二级栏里的对话列表） */
/* 现有筛选下拉按钮的 PDL 入口；菜单和文案声明在主题里。 */
PDL_COMPONENTS.dropBtn = function (p, sc, root) { return dropBtn(pv(p.label, sc, root), menuLive(pvMenu(p.items, sc, root)), { tip: pv(p.tip, sc, root), pressed: pv(p.pressed, sc, root) }); };
PDL_COMPONENTS.dropBtn.catalog = { g: 'basics', view: 'nav.cafe.shell', get props() { return pdlLoc(PDL_VIEWS['nav.cafe.shell'].blocks[0].props.bar.items.find(function (x) { return x.key === 'group'; }).control.props); } };
function copyFlash(el) {
  const g = el && el.querySelector && el.querySelector('svg'); if (!g) return;
  const was = g.outerHTML, sz = g.getAttribute('width') || 14;
  el.setAttribute('data-copied', ''); g.outerHTML = icon('check', +sz);
  setTimeout(function () { if (!el.isConnected) return; el.removeAttribute('data-copied'); const c = el.querySelector('svg'); if (c) c.outerHTML = was; }, ms('--hold-copied'));
}

/* { act, args } → data-act + data-*（操作的统一写法） */
function wgAct(a) { return a ? actAttrs(a.act, a.args) : ''; }
/* 一个图标按钮：{ label, icon, act, args, pressed, tip, primary } */
function wgBtn(b, o) {
  o = o || {};
  return btn(b.label, { primary: !!b.primary, iconOnly: !b.text, icon: b.icon, sm: o.sm !== false, act: b.act, data: argAttrs(b.args) + (b.tip ? ' data-tip="' + h(b.tip) + '"' : ''), pressed: b.pressed != null ? !!b.pressed : null, disabled: !!b.disabled });
}
