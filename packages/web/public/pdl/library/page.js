/* 边界：一个含义一个组件、不为接口定制、不按位置推导样式 */
/* 页面结构：页头、详情头、小节、分组、设置行、字段、说明、列表头尾、键值、统计、等宽块、长文本 */
'use strict';
function cellsHtml(o) {
  const r = cellsResolve(o.items, o.saved), gap = function (n) { return n > 0 ? '<span class="cell-gap" style="--u-n:' + n + '"></span>' : ''; };
  const one = function (it) { return '<span class="citem" data-ckey="' + h(it.key) + '" data-anchor="' + it.anchor + '" data-cell="' + it.cell + '" style="--u-span:' + it.span + '"' + (it.locked ? ' data-locked="1"' : o.edit ? ' data-edit="cell"' : '') + '>' + it.html + '</span>'; };
  let cur = 0, head = '';
  r.start.forEach(function (it) { head += gap(it.cell - cur) + one(it); cur = it.cell + it.span; });
  let tail = '';
  r.end.forEach(function (it, i) { const nx = r.end[i + 1]; tail += one(it) + gap(nx ? it.cell - (nx.cell + nx.span) : it.cell); });
  return '<div class="cells cells-' + (o.axis || 'row') + (o.cls ? ' ' + o.cls : '') + '" data-cells="' + h(o.key) + '"' + (o.attrs || '') + '>' + head + '<span class="cells-flex"></span>' + tail + '</div>';
}
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
function muted(t) { return '<span class="t-m muted">' + t + '</span>'; }
/* 返回：唯一的画法（back 含义的图标；主题声明了 showLabel 时后面跟着去处的名字）。去处的名字一直在悬停提示和读屏标签里 */
function backLink(o) { return btn(o.label || o.tip, { sm: true, iconOnly: true, cls: 'back', icon: 'back', act: o.act, data: o.data, tip: o.tip, html: o.label ? '<span class="back-l">' + h(o.label) + '</span>' : '' }); }
/* 引擎的返回（唯一一个）：打开的内容盖住了触发它的地方时出现，回到来源；d.label 是来源自己的标题，d.showLabel 是主题的声明（只画图标还是图标 + 名字）。
   区域标签、主区、被占用的区域、视图下钻（含弹出层的子页）、表单自己的取消都走这里，页面不写自己从哪来；放在哪由引擎的返回槽决定（frame.js 的 BACK） */
function engineBack(d) { return backLink({ act: d.act, data: d.data || '', label: d.showLabel ? d.label : '', tip: tc('frame.backTo', d.label || '') }); }
function scrollRows(k, step, more) { const v = ['--rows:' + k, '--row-step:var(' + step + ')'].concat(more ? [more] : []); return ' data-rows style="' + v.join(';') + '"'; }

/* ───────── 小件（组件库） ───────── */
/* 路径 + “在访达中显示”；只读的设置值 */
function plain(v) { return '<span class="sys-v">' + h(v) + '</span>'; }
/* 列表上方的一行工具：左边若干、右边若干（中间撑开） */
/* 列表上方的工具条：一个操作组（格子），编辑布局时组内的操作可以换位置；items = [{ key, html, span, anchor: start | end }] */
function listBar(o) { return '<div class="cafe-navbar"' + (o.note ? ' data-note="' + o.note + '"' : '') + '>' + cellsHtml({ key: o.key, axis: 'row', items: o.items, saved: pdlCells(o.key), edit: S.editLayout }) + '</div>'; }
function listWrap(html) { return '<div class="cafe-list-wrap">' + html + '</div>'; }
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
function preBlock(t) { return '<pre class="ws-pre">' + h(t) + '</pre>'; }
function chipList(list) { return '<div class="chips">' + list.join('') + '</div>'; }
function chipItem(t, act, data) { return chipHtml({ label: t, act: act, data: data }); }
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
/* ───────── 目录登记：这个文件里的组件 ───────── */
Object.assign(LIB_CATALOG, {
  cells: { g: 'structure', via: ['prop:ordered', 'shell'], ex: function (s) { return cellsHtml({ key: 'catalog', axis: 'row', items: s.chips.map(function (c, i) { return { key: c, html: btn(c, { sm: true, act: 'noop' }), span: i === 0 ? 'm' : 's', anchor: i < 2 ? 'start' : 'end' }; }) }); } },
  scrollY: { g: 'structure', via: ['prop:scroll', 'type:pop', 'type:chatpage'], ex: function (s) { return '<div class="scroll cat-scroll">' + s.radios.concat(s.chips, s.steps).map(function (t) { return '<p>' + h(t) + '</p>'; }).join('') + '</div>'; } },
  scrollX: { g: 'structure', via: ['type:tabs', 'type:lanes'], ex: function (s) { return '<div class="scroll-x cat-scroll-x"><span class="chips">' + s.chips.concat(s.radios, s.steps).map(function (t) { return chipHtml({ label: h(t) }); }).join('') + '</span></div>'; } },
  srow: { g: 'rows', via: ['type:settings'], ex: function (s) { return group([srow(s.label, sw(true, 'noop', '', s.label)), srow(s.label2, h(s.value))]); } }
});
