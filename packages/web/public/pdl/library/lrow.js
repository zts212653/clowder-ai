/* 边界：一个含义一个组件、不为接口定制、不按位置推导样式 */
/* 列表行：所有“一行一项”的列表都用它，面板不再自己写行样式。
   规则只在这里定一次：
   - 行高 --row-h；小行 --row-h-sm（展开区里的子行）
   - 结构固定：前导（头像/图标）→ 标题 + 行内标记（状态点、计时）→ 尾部数据列（状态、元信息）→ 操作（永远是最后一列）
   - 尾部数据列右对齐，在列表容器的 subgrid 列轨上上下对齐（lrCols）；操作占最后一条列轨（acts），同一列表里上下对齐
   - 没有数据列的单行：悬停操作浮在行尾，不占宽度；不可用时置灰，悬停/点击说明原因
   - 展开只有一层：同一个列表一次只展开一行；子行（sm）不能再展开
   - 展开区左边缘对齐标题，不对齐前导 */
'use strict';
/* 数据列（subgrid）：列由行模板声明（cols 的第 i 项就是第 i 列，w 是宽度档）；列表容器按这些声明铺列轨（lrCols），行、行头、行尾一层层 subgrid 到容器的列上，
   所以同一列表里每一列上下对齐（按内容宽的 ctl / auto 列也对齐）。宽度档 icon num id money time label state date 的宽度是 token（--col-*），只当列轨的尺寸用；
   ctl / auto / 没写档：按整列最宽的内容；整列都空：0。行自己不定宽 */
const COL_TIER = { icon: 1, num: 1, id: 1, money: 1, time: 1, label: 1, state: 1, date: 1 };
function lrCols(rows) { const t = lrColTracks(rows); return t ? ' data-cols style="' + t + '"' : ''; }
/* 列轨分两段（行的通用排法：内容 · 空白 · 操作）：数据列（--lr-cols）在悬停操作前面，常显的控件列（ctl：开关、主操作、投给谁）在悬停操作后面、最右。
   返回写在列表容器上的两个变量（没有列 = 空） */
function lrColTracks(rows) {
  const n = rows.reduce(function (m, r) { return Math.max(m, r && r.cols ? r.cols.length : 0); }, 0); if (!n) return '';
  const data = [], ctl = [];
  for (let i = 0; i < n; i++) {
    const cs = rows.map(function (r) { return r && r.cols ? r.cols[i] : null; }).filter(Boolean), w = (cs.find(function (c) { return c.w; }) || {}).w || 'num';
    const full = cs.some(function (c) { return c.v != null && c.v !== ''; });
    (w === 'ctl' ? ctl : data).push(!full ? '0px' : COL_TIER[w] ? 'minmax(0, calc(var(--col-' + w + ') + var(--sp-s)))' : w === 'ctl' ? 'auto' : 'minmax(0, auto)');   /* 每格左边带一个列间距（格子的内边距），整列空的格子没有；容器窄时数据列先让（格子里省略），标题列保住它的最小宽 */
  }
  return '--lr-cols:' + (data.join(' ') || '0px') + ';--lr-ctls:' + (ctl.join(' ') || '0px');
}
/* 开合的状态（组件库唯一的一份）：所有开合——折叠块、展开一块（disclosure）、列表里一次展开一行、树的目录、分组段——都记在 S.folds，键按形状分范围：
   键本身 = 折叠块 / 展开一块（真假）；'row:列表' = 这张列表展开着的那一行；'tree:树' = 展开着的目录 { 路径: 真 }；'sec:段' = 分组段 { c: 收起, m: 露出更多 }。
   只有分组段存进本机（store 'secs'，刷新还在），别的跟着这次打开。状态路径的根是 folds（通用动作 set / toggle 能直接改，比如 disclosure 的默认开合） */
S.folds = {};
const FOLD_ROW = 'row:', FOLD_TREE = 'tree:', FOLD_SEC = 'sec:';
STATE_ROOTS.folds = function () { return S.folds; };

function lrAct(a) {
  if (!a) return '';
  return btn(a.label, { iconOnly: true, sm: true, icon: a.icon, act: a.act, data: (a.data || '') + (a.act === 'menu' ? MENU_DECL : ''), why: a.why, cls: a.why ? 'lr-dis' : '' });
}
/* o: { lead, title, inline, sub, cols:[{v, w, tip, tone, act, data}], acts:[{label, icon, act, data, why}], tone:'run'|'here'|'selected'|'past'|'done', color, bar:{pct, tone, tip},
        expand: html（空串只展开标题全文）, open, list, key, sm, act, data,
        more: html  调用方自己管的展开（可以同时开几行）：给了就画在行下面 } */
/* 行布局：组件库只有五种行布局，行模板只把数据绑到其中一种上（layout 必填；直接调用 lrow 的组件代码也写明）。
   line 单行 · two 双行（标题 + 一行副行，可再带一行 meta）· item 条目（图标 · 标题 + 最多两行简介 · 竖排尾部：上操作、下状态）· tree 树行（缩进 + 展开指示）· record 记录行（紧凑的一行明细，子行高） */
const ROW_LAYOUTS = ['line', 'two', 'item', 'tree', 'record'];
function lrow(o) {
  const cols = o.cols || [], L = ROW_LAYOUTS.indexOf(o.layout) >= 0 ? o.layout : 'line', compact = L === 'record' || L === 'tree';
  const canOpen = !compact && o.expand != null && o.list;
  const click = o.disabled ? '' : canOpen ? ' data-act="fold" data-f="row" data-l="' + h(o.list) + '" data-k="' + h(o.key) + '"' + (o.many ? ' data-many="1"' : '') + ' role="button" tabindex="0" aria-expanded="' + !!o.open + '"' : o.act ? ' data-act="' + o.act + '"' + (o.data || '') + ' role="button" tabindex="' + (o.disabled ? '-1' : '0') + '"' : '';
  const dataCols = cols.filter(function (c) { return c.w !== 'ctl'; }), ctlCols = cols.filter(function (c) { return c.w === 'ctl'; });
  const ctlHtml = ctlCols.map(function (c) { return '<span class="lr-col lr-ctl">' + (c.v || '') + '</span>'; }).join('');
  const colHtml = dataCols.map(function (c) {
    const tag = c.act ? 'button type="button"' : 'span';
    return '<' + tag + ' class="lr-col' + (c.tone ? ' ' + c.tone : '') + (c.act ? ' lr-colbtn' : '') + '" data-w="' + (c.w || 'num') + '"' + (c.act ? ' data-act="' + c.act + '"' + (c.data || '') : '') + (c.tip ? ' data-tip="' + h(c.tip) + '"' : '') + '>' + (c.v == null ? '' : c.v) + '</' + tag.split(' ')[0] + '>';
  }).join('');
  const bar = o.bar && o.bar.pct != null ? '<span class="lr-bar' + (o.bar.tone ? ' ' + o.bar.tone : '') + '" style="--p:' + Math.min(100, o.bar.pct) + '%"' + (o.bar.tip ? ' data-tip="' + h(o.bar.tip) + '"' : '') + ' aria-hidden="true"></span>' : '';
  const acts = (o.acts || []).filter(Boolean), nActs = acts.length || (o.actsHtml ? (o.actsHtml.match(/<button/g) || []).length : 0);   /* actsHtml：调用方已经画好的一组操作按钮（插槽里的操作） */
  /* 展开指示：行本身点了做别的事（树的选中）时，指示是它自己的开合按钮（twAct：开合的参数） */
  const tw = o.twisty ? (o.twisty === 'leaf' ? '<span class="tw" aria-hidden="true"></span>' : o.twAct ? '<button type="button" class="tw" data-open="' + (o.twisty === 'open') + '" data-act="fold" data-f="tree"' + o.twAct + ' aria-label="' + h(tc('common.expand')) + '">' + icon('right', 14) + '</button>' : twisty(o.twisty === 'open')) : '';
  const actsHtml = nActs ? '<span class="lr-acts' + (o.swap ? ' swap' : '') + '">' + (o.actsHtml || acts.map(lrAct).join('')) + '</span>' : '';
  /* 按行对齐的尾部：第一行尾（时间）、第二行尾（角标）；swap 时悬停操作就出现在第一行尾的位置上（同一位置互斥） */
  const aside = o.aside ? '<span class="lr-aside"><span class="lr-aside-t' + (o.swap ? ' swap-d' : '') + '">' + (o.aside[0] || '') + '</span>' + '<span class="lr-aside-b">' + (o.aside[1] || '') + '</span>' + (o.swap ? actsHtml : '') + '</span>' : '';
  const tone = (o.tone ? ' ' + o.tone : '') + (o.cur ? ' selected' : '');
  return '<div class="lr' + tone + (canOpen || o.act ? ' click' : '') + (o.disabled ? ' off' : '') + (o.hook ? ' ' + o.hook : '') + '"' + ' data-layout="' + L + '"' + (o.swap ? ' data-swap' : '') + (o.rootAttrs || '') + (o.orderable && o.key != null ? ' data-okey="' + h(o.key) + '" data-edit="order"' : '') + (canOpen ? ' data-open="' + !!o.open + '"' : '') + (o.note ? ' data-note="' + o.note + '"' : '') + ' style="--acts:' + (nActs && !o.swap && !cols.length ? 'calc(' + nActs + ' * var(--ctl-s) + var(--sp-s))' : '0px') + ';--c:' + (o.color || 'initial') + (o.depth != null ? ';--d:' + o.depth : '') + '">' +
    (o.pre ? '<span class="lr-pre">' + o.pre + '</span>' : '') +
    '<div class="lr-head"' + click + (o.cur ? ' aria-current="' + (o.cur === true ? 'true' : o.cur) + '"' : '') + (o.sel ? ' aria-selected="true"' : '') + (o.disabled ? ' aria-disabled="true"' : '') + (o.headAttrs || '') + (o.twisty && o.twisty !== 'leaf' && !o.twAct ? ' aria-expanded="' + (o.twisty === 'open') + '"' : '') + '>' + (o.orderable ? '<span class="lr-grip" aria-hidden="true">' + icon('grip', 14) + '</span>' : '') + tw + (o.lead || o.leadSlot ? '<span class="lr-lead">' + o.lead + '</span>' : '') +
      '<span class="lr-main"><span class="lr-line"><span class="lr-title">' + o.title + '</span>' + (o.inline || '') + '</span>' + (o.sub ? '<span class="lr-sub' + (o.subLines ? ' clamp" style="--sub-lines:' + o.subLines : '') + '">' + o.sub + '</span>' : '') + (o.meta ? '<span class="lr-sub lr-meta">' + o.meta + '</span>' : '') + '</span>' +
      /* 尾部（行的通用排法：内容 · 空白 · 操作）：数据列（状态、元信息）→ 悬停才出现的操作（改名、删除、⋯：也支持，但少用）→ 常显的控件（开关、主操作：一定支持）在最右。
         有数据列的行（和列表里对齐的行）悬停操作占自己的列轨（看不见也占着，状态不跳）；没有数据列的行，悬停操作浮在常显控件的前面、不占宽度。
         条目布局的竖排尾部（上：开关或主操作）也是常显的，所以悬停操作画在它前面 */
      (o.aside ? '' : aside) +
      ((nActs && !o.swap) || cols.length ? '<span class="lr-end">' + (dataCols.length ? '<span class="lr-cols">' + colHtml + '</span>' : '') + (nActs && !o.swap ? actsHtml : '') + (ctlCols.length ? '<span class="lr-ctls">' + ctlHtml + '</span>' : '') + '</span>' : '') + (o.aside ? aside : '') + bar + '</div>' +
    (canOpen && o.open && o.expand ? '<div class="lr-more lr-exp' + (o.lead ? '' : ' nolead') + '">' + o.expand + '</div>' : '') +   /* 额外内容只在打开时画：收起的行不画、也就不读它要的数据；只有标题全文时不另画展开块。 */
    (o.more ? '<div class="lr-more' + (o.lead ? '' : ' nolead') + '">' + o.more + '</div>' : '') + '</div>';
}
/* 列表：放进统一的 group 底，管理行的展开（默认一次一行；o.many 每行各自开合） */
function lrList(key, items, o) {
  o = o || {};
  /* rows：限行数的列表（组件库唯一的限行机制 scrollRows）：k 整行 + 1 整行渐隐，超出的在列表里滚动 */
  const compact = items.length && items.every(function (it) { return it.layout === 'record' || it.layout === 'tree'; });
  const tr = o.rows ? lrColTracks(items) : '', attrs = o.rows ? (tr ? ' data-cols' : '') + scrollRows(o.rows, compact ? '--row-h-sm' : '--row-h', tr || null) : lrCols(items);
  /* order：可以拖动排序的列表——容器交给引擎的同级换位（data-ocontainer + data-order-act，放下时把新的 key 顺序交给这个动作），行带把手 */
  const ord = o.order ? ' data-ocontainer="list:' + h(key) + '" data-order-act="' + h(o.order) + '"' : '';
  return '<div class="group lr-list' + (o.rows ? ' scroll' : '') + (o.cls ? ' ' + o.cls : '') + '"' + attrs + ord + '>' + (items.length ? items.map(function (it) { return lrow(Object.assign({ list: key, open: rowOpen(key, it.key), many: !!o.many, orderable: !!o.order }, it)); }).join('') : emptyState({ text: o.empty || tc('list.empty'), acts: o.emptyActs || '' })) + '</div>';
}
/* 列表的本地筛选（列表声明 searchable）：一个筛选框，只筛已经读到的项（项里任一文字含查询词），不发请求；查询词是列表自己的状态，按列表 id 记在 LIST_Q */
const LIST_Q = pdlTrack({}, 'LIST_Q');
function listQField(id) { return search('lq-' + id, tc('list.filter'), LIST_Q[id], 'listQ', 'lr-q'); }
function listFind(items, q) {
  q = (q || '').trim().toLowerCase(); if (!q) return items;
  const hit = function (v) { return typeof v === 'string' ? v.toLowerCase().indexOf(q) >= 0 : v && typeof v === 'object' ? Object.keys(v).some(function (k) { return hit(v[k]); }) : false; };
  return items.filter(hit);
}
INPUTS.listQ = function (e) { LIST_Q[e.target.id.slice(3)] = e.target.value; render(true); };
/* 列表的渐进显示：每个列表已经画了几行（按列表记，和筛选一样是列表自己的状态），一页 LIST_PAGE_N 行 */
const LIST_PAGE = pdlTrack({}, 'LIST_PAGE'), LIST_PAGE_N = 20;
A.listMore = function (d) { LIST_PAGE[d.list] = (LIST_PAGE[d.list] || LIST_PAGE_N) + LIST_PAGE_N; render(true); };
/* 展开区里的小标题和一行说明，也只有一种写法 */
/* 加载中：骨架行（列表、弹窗里的列表都用它） */
/* 骨架：唯一的画法。shape 'row'（默认，列表行）或 'card'（卡片网格：预览 + 两行字）；每一块是同一个骨架块、同一个背景档的节拍 */
function skelBar(k) { return '<div class="skel ' + k + '" aria-hidden="true"></div>'; }
function skel(n, shape) {
  const a = []; for (let i = 0; i < n; i++) a.push(shape === 'card' ? '<div class="cgrid-card">' + skelBar('prev') + '<div class="cgrid-meta">' + skelBar('line') + skelBar('line short') + '</div></div>' : skelBar('row'));
  return '<div class="' + (shape === 'card' ? 'cgrid' : 'group') + '" aria-busy="true">' + a.join('') + '</div>';
}
function lrText(html, tone) { return '<div class="lr-text' + (tone ? ' ' + tone : '') + '">' + html + '</div>'; }
/* 树：逐级加载的层级列表（文件树）。规则同样只在这里：每层缩进 16px，箭头在前导前面，行高用小行，悬停操作和数据列沿用列表行。
   kids(path) 返回 [{ name, path, dir, lead?, cols?, acts? }]；第一次展开一个目录时先显示“加载中…”，再出现下一级 */
S.treeLoaded = {};   /* 读过的目录（数据，不是开合状态） */
function ltree(key, kids, o) {
  o = o || {};
  const open = S.folds[FOLD_TREE + key] = S.folds[FOLD_TREE + key] || {}, loaded = S.treeLoaded[key] = S.treeLoaded[key] || {};
  /* 一个目录是一个节点：目录行 + 子级（data-open 开合）。开合是本地更新：已加载过的子级一直画着，收起时由样式藏起来 */
  function walk(path, depth) {
    return kids(path).map(function (n) {
      /* 点行：声明了选中（pick）就是选中这一项，有子级的行由展开指示开合；否则目录行开合、文件行打开。flat：只有一层，没有展开指示 */
      const tg = ' data-l="' + h(key) + '" data-p="' + h(n.path) + '"';
      const row = lrow(Object.assign({ layout: 'tree', depth: depth, twisty: o.flat ? '' : n.dir ? 'closed' : 'leaf', twAct: n.pick && n.dir ? tg : '', title: h(n.name),
        act: n.pick ? n.pick.act : n.dir ? 'fold' : o.fileAct, data: n.pick ? n.pick.data : n.dir ? ' data-f="tree"' + tg : (o.fileData ? o.fileData(n) : '') }, n.row || {}));
      if (!n.dir) return row;
      const isOpen = !!open[n.path]; if (o.ready) loaded[n.path] = true;   /* ready：子级随数据一起给出，不走懒加载 */
      const sub = loaded[n.path] ? walk(n.path, depth + 1) : isOpen ? lrow({ layout: 'tree', depth: depth + 1, twisty: 'leaf', lead: '<span></span>', title: '<span class="faint">' + h(tc('common.loading')) + '</span>' }) : '';
      return '<div class="lr-node" data-open="' + isOpen + '">' + row + (sub ? '<div class="lr-kids">' + sub + '</div>' : '') + '</div>';
    }).join('');
  }
  const body = walk(o.root || '', 0);
  return '<div class="group lr-list lr-tree' + (o.divider ? ' lined' : '') + '">' + (body || emptyState(o.empty || tc('list.emptyFolder'))) + '</div>';
}
/* 展开目录：已加载过的直接本地开合；第一次展开先画“加载中…”，接口返回后再画出下一级（数据变了才重画） */
function foldTree(d, el) {
  const open = S.folds[FOLD_TREE + d.l] = S.folds[FOLD_TREE + d.l] || {}, loaded = S.treeLoaded[d.l] = S.treeLoaded[d.l] || {};
  open[d.p] = !open[d.p];
  const node = el && el.closest('.lr-node');
  if (node && (loaded[d.p] || !open[d.p])) { localOpen(node, open[d.p], el); return; }
  render(true);
  if (open[d.p] && !loaded[d.p]) ioSend('tree:open', { l: d.l, p: d.p });   /* 第一次展开：读下一级（接口返回 tree:loaded 后画出来） */
}
ioOn('tree:loaded', function (e) { (S.treeLoaded[e.l] = S.treeLoaded[e.l] || {})[e.p] = true; render(true); });

/* 列表之间的小标题；可以带一个操作图标，高度固定，带不带图标都一样高 */
/* 组标签（组件库唯一的小标题，principles：一件事一个地方）：一组行上方的小字，或分组列表里一组的标题；可带计数、说明（问号）和组的操作。
   页面里的大小节标题是另一种（section 块的标题），只有这两种 */
/* tip：标题文字的提示（范围这类一句话的补充，不写成标题下的一行说明）
   v：放在哪种列表上（角色变体，样子只差留白）：缺省 = 页面里两组行之间；float = 浮层列表里（菜单、弹出层、启动面板、全部标签）；nav = 侧栏的分组。
   attrs：额外属性（侧栏分组编辑布局时的拖动 / 改名标记），不挑样子 */
function lrSection(t, actions, o) { o = o || {}; const tt = o.html != null ? o.html : h(t); return '<div class="lr-section-label"' + (o.v ? ' data-v="' + o.v + '"' : '') + (o.attrs || '') + '><span class="grow">' + (o.tip ? '<span data-tip="' + h(o.tip) + '">' + tt + '</span>' : tt) + (o.count != null && o.count !== '' ? ' <span class="num">' + h(String(o.count)) + '</span>' : '') + (o.help ? helpTip(o.help) : '') + '</span>' + (actions || '') + '</div>'; }
/* 行内标记：状态点 */
function lrDot(tone, tip, c) { return '<span class="dot"' + (tone ? ' data-tone="' + tone + '"' : '') + (c ? ' style="--c:' + c + '"' : '') + (tip ? ' data-tip="' + h(tip) + '"' : '') + '></span>'; }

/* 一次只展开一行：展开区只在打开时画，开合是一次重画（局部更新只换变了的行，别的行节点不动） */
/* 列表的行展开：默认一次一行（再点收起、点别的换过去）；列表声明 expand: many 时每行各自开合 */
function rowOpen(list, key) { const v = S.folds[FOLD_ROW + list]; return key != null && (v && typeof v === 'object' ? !!v[key] : v === key); }
function foldRow(d) {
  const k = FOLD_ROW + d.l, v = S.folds[k];
  if (d.many) { const o = Object.assign({}, v && typeof v === 'object' ? v : {}); if (o[d.k]) delete o[d.k]; else o[d.k] = true; S.folds[k] = o; }
  else S.folds[k] = v === d.k ? null : d.k;
  render(true);
}


/* 胶囊：收起时范围刚好是一个圆（只露 lead），悬停展开成两端半圆的长条，露出 body。
   lead 和 body 都是内容（通常是身份 + 状态 + 操作），由使用方按胶囊的规则选择：收起时只给头像。
   展开浮在上层，不挤开旁边的元素；离开后停 --reveal-hold 再收回。
   o: { lead, body, act, data, tip, cls, style } */
function capsule(o) {
  /* dir: 'right'（默认，向右展开）| 'left'（底贴住右边，内容从头像左侧长出来）——胶囊朝它所在的那一侧展开；
     有展开内容时不再加原生提示（展开的内容就是提示），只留给读屏的 aria-label */
  const tipAttr = o.tip ? (o.body ? ' aria-label="' + h(o.tip) + '"' : ' data-tip="' + h(o.tip) + '"') : '';
  const st = o.style || '';
  return '<div class="cap' + (o.dir === 'left' ? ' cap-left' : '') + (o.cls ? ' ' + o.cls : '') + '"' + (st ? ' style="' + st + '"' : '') + ' tabindex="0"' + (o.act ? ' role="button" data-act="' + o.act + '"' + (o.data || '') : '') + tipAttr + '>' +
    '<span class="cap-pill"><span class="cap-lead">' + o.lead + '</span>' + (o.body ? '<span class="cap-x">' + o.body + '</span>' : '') + '</span></div>';
}

/* 胶囊堆叠：几个胶囊叠在一起，每项占一个固定的位、压住相邻一项的一半，只露头像。向右长的（输入框、左边消息下面）后一项压前一项，生长端的最后一项完整露出；
   向左长的（你的消息下面，dir: 'left'）镜像：前一项压后一项。悬停一项：它升到最上层、只有它自己向生长方向打开文字（名字 状态 时间；头像在贴住的那一端，向左长的头像在右——布局镜像，文字仍从左往右读），
   盖住生长方向上的邻居；位置不重排，同一时刻只有一项展开。
   展开的层浮在上面（浮层层级），可以盖住旁边的元素；静止时按正常排版占位，不和邻居重叠。size：s（消息下面）| m（输入框上） */
function capStack(items, o) {
  o = o || {}; if (!items.length) return '';
  return '<span class="rstack' + (o.dir === 'left' ? ' end' : '') + (o.size === 'm' ? ' m' : '') + '" style="--n:' + items.length + '"' + (o.label ? ' aria-label="' + h(o.label) + '"' : '') + '><span class="rstack-in">' +
    items.map(function (it, i) { return capsule(Object.assign({}, it, { dir: o.dir, style: (it.style ? it.style + ';' : '') + '--z:' + (o.dir === 'left' ? items.length - i : i + 1) })); }).join('') + '</span></span>';
}

/* 全局节拍：状态循环是一组预设（关键帧名 mo-*：执行中的圈、行上的圆点、录音点、骨架、光标），
   同一个周期 --loop = 2 拍，各自在周期里脉冲固定的次数。相位不进 HTML（节点的“版本”就是它的 outerHTML），整个系统只算一次：
   - 诞生：新出现的循环马上动，接在共用周期现在的位置上（起点放在上一个 2 拍边界，唯一的一次计算）；
   - 同一个位置上的循环（整页重画换掉了节点、状态没变）：接着原来的起点走（照抄起点，不算）；
   - 状态变了（预设换了名字）：先接着放原来的预设（--mo-hold），新预设记在 data-preset-next，等这一圈放完（animationiteration，正好在 2 拍边界上）再换；
     换上的新预设照抄原来的起点，所以从格子上开始。
   “同一个位置”按树认：树键（treeKey，带身份的祖先一路串起来）+ 到最近的带身份祖先的序号 + 伪元素。 */
const BEAT_LIVE = [];
function loopKey(el, pseudo) {
  const p = [pseudo || ''];
  let n = el;
  for (; n && n !== document.body && !(n !== el && nodeId(n)); n = n.parentElement) p.push(n.parentElement ? Array.prototype.indexOf.call(n.parentElement.children, n) : 0);
  return p.join('/') + '@' + (n && n !== document.body ? treeKey(n) : '');
}
/* 不在页面上超过一个周期的记录才丢（同一次重画里换掉的节点要等新节点的 animationstart 来认领） */
RENDER_BEFORE.push(function () {
  const now = document.timeline.currentTime, L = ms('--beat') * 2;
  for (let i = BEAT_LIVE.length - 1; i >= 0; i--) { const x = BEAT_LIVE[i]; if (x.el.isConnected) x.gone = null; else if (x.gone == null) x.gone = now; else if (now - x.gone > L) BEAT_LIVE.splice(i, 1); }
});
function beatAnims(e) { return e.target.getAnimations().concat(e.pseudoElement ? e.target.getAnimations({ subtree: true }).filter(function (a) { return a.effect && a.effect.pseudoElement === e.pseudoElement; }) : []).filter(function (a) { return a.animationName === e.animationName; }); }
document.addEventListener('animationstart', function (e) {
  if (!e.target.getAnimations) return;
  const roll = e.animationName === 'roll-up';
  if (!/^mo-|^rot$/.test(e.animationName) && !roll) return;
  beatAnims(e).forEach(function (a) {
    if (a.__beat) return;
    a.__beat = 1;
    if (roll) {   /* 轮换的一行：时间原点是这个动作开始的时刻（data-at，数据）——过去了多久，动画就接在哪儿 */
      const at = +((e.target.closest('[data-at]') || {}).dataset || {}).at; if (at) a.startTime = at - performance.timeOrigin;
      return;
    }
    const key = loopKey(e.target, e.pseudoElement), i = BEAT_LIVE.findIndex(function (x) { return x.key === key && (x.el === e.target || !x.el.isConnected); }), was = i >= 0 ? BEAT_LIVE.splice(i, 1)[0] : null;
    if (!was) { const L = ms('--beat') * 2; a.startTime = Math.floor(document.timeline.currentTime / L) * L; }   /* 诞生：马上动，接在共用周期现在的位置上（起点是上一个 2 拍边界） */
    else {
      a.startTime = was.start;
      if (was.name !== e.animationName && !was.next && /^mo-/.test(was.name)) {   /* 状态变了：这一圈先放完原来的预设，新预设等着 */
        const t = e.target; t.style.setProperty('--mo-hold', was.name); t.setAttribute('data-preset-next', e.animationName);
        BEAT_LIVE.push({ el: e.target, key: key, name: was.name, start: was.start, gone: null });   /* 换回原来的预设会再来一次 animationstart，接着这个起点 */
        return;
      }
    }
    BEAT_LIVE.push({ el: e.target, key: key, name: e.animationName, start: a.startTime, gone: null });
  });
});
/* 一圈放完（正好在 2 拍边界上）：有等着的新预设就换上 */
document.addEventListener('animationiteration', function (e) {
  const t = e.target; if (!t.hasAttribute || !t.hasAttribute('data-preset-next') || !/^mo-/.test(e.animationName)) return;
  const key = loopKey(t, e.pseudoElement), x = BEAT_LIVE.find(function (r) { return r.el === t && r.key === key; });   /* 元素自己和它的伪元素各有一圈：按同一个键找 */
  if (!x || document.timeline.currentTime - x.start - e.elapsedTime * 1000 > ms('--beat') / 10) return;   /* 接上原来的起点时浏览器会补发一次“过了一圈”（不在边界上），那不是这一圈放完 */
  x.next = 1;
  t.style.removeProperty('--mo-hold'); t.removeAttribute('data-preset-next');
});

/* 触屏（hover: none）：悬停能露出的东西，点一下也能露出——行的操作、胶囊 / 头像堆展开、? 的说明；再点一下或点别处收起。
   胶囊、头像堆、? 第一下只展开（不执行它的动作）；展开后再点：收起，有动作的照常执行 */
const TAP_HOST = '.rstack, .cap, .help-q, .cafe-m, .cafe-trow, .lr, [data-swap]', TAP_PEEK = '.rstack, .cap, .help-q';
window.addEventListener('click', function (e) {
  if (!matchMedia('(hover: none)').matches) return;
  let host = e.target.closest ? e.target.closest(TAP_HOST) : null;
  if (host && host.matches('.cap') && host.closest('.rstack')) { const st = host.closest('.rstack'); st.querySelectorAll('.tap-cap').forEach(function (c) { c.classList.remove('tap-cap'); }); host.classList.add('tap-cap'); host = st; }   /* 头像堆整组散开，点到的那个打开文字 */
  document.querySelectorAll('.tap-on').forEach(function (x) { if (!host || (x !== host && !x.contains(host))) x.classList.remove('tap-on'); });
  if (!host) return;
  const peek = host.matches(TAP_PEEK);
  if (host.classList.contains('tap-on')) { if (peek) { host.classList.remove('tap-on'); tipHide(); if (!host.dataset.act) e.stopPropagation(); } return; }
  host.classList.add('tap-on');
  if (peek) { e.preventDefault(); e.stopPropagation(); if (host.dataset.tip && !host.querySelector('.cap-x')) tipShow(host); }
}, true);

/* 横向滚动道里的胶囊（组件库）：道会裁掉展开层，所以悬停时把胶囊本体（.cap-pill）作为 popover 显示在顶层，锚在自己的胶囊上——节点不搬、不留占位。
   展开态是胶囊本体上的 data-hot（指针在上面），展开 / 收起的过渡照常由样式驱动；离开后去掉 data-hot（样式里收起先停 --reveal-hold），收完再退出顶层。
   最后悬停的在最上层（重新进入顶层）。悬停中的胶囊按位置键（loopKey，和节拍同一个）记在 CAP_HOT，收回的计时按键找到当时的那个胶囊。
   整页重画把节点移出过文档时浏览器会关掉它的顶层状态（不发事件）：没在顶层的本体就是普通的胶囊本体（样式不藏它），指针一动就重新进入顶层 */
const CAP_TOP = '.scroll-x .cap', CAP_HOT = {};   /* 位置键 → 收回的计时（0 = 指针还在上面） */
function capPill(cap) { return cap && cap.querySelector(':scope > .cap-pill'); }
function capLift(cap, hot) {
  const pl = capPill(cap); if (!pl) return;
  if (pl.matches(':popover-open')) pl.hidePopover();   /* 已经在顶层：重新进入，升到最上面 */
  pl.setAttribute('popover', 'manual'); pl.showPopover();
  pl.toggleAttribute('data-hot', hot);
}
function capOff(cap) { const pl = capPill(cap); if (!pl) return; pl.removeAttribute('data-hot'); if (pl.matches(':popover-open')) pl.hidePopover(); pl.removeAttribute('popover'); }
function capFind(k) { return Array.prototype.find.call(document.querySelectorAll(CAP_TOP), function (c) { return loopKey(c) === k; }); }
document.addEventListener('pointerover', function (e) {
  if (e.target.closest && e.target.closest('.edit-layout')) return;   /* 编辑布局是只读的：悬停不展开（看 body 上的 edit-layout） */
  const cap = e.target.closest ? e.target.closest(CAP_TOP) : null; if (!cap || (e.relatedTarget && cap.contains(e.relatedTarget))) return;
  const k = loopKey(cap); clearTimeout(CAP_HOT[k]); CAP_HOT[k] = 0;
  capLift(cap, true);
});
document.addEventListener('pointerout', function (e) {
  const cap = e.target.closest ? e.target.closest(CAP_TOP) : null; if (!cap || (e.relatedTarget && cap.contains(e.relatedTarget))) return;
  const k = loopKey(cap), pl = capPill(cap); if (pl) pl.removeAttribute('data-hot');
  CAP_HOT[k] = setTimeout(function () { delete CAP_HOT[k]; const c = capFind(k); if (c) capOff(c); }, ms('--reveal-hold') + ms('--dur-med'));
});
/* 点了展开层里的东西（跳转、打开详情、停止）：动作照常执行，展开层立刻收回 */
document.addEventListener('click', function (e) { const cap = e.target.closest ? e.target.closest(CAP_TOP) : null; if (!cap) return; const k = loopKey(cap); setTimeout(function () { clearTimeout(CAP_HOT[k]); delete CAP_HOT[k]; const c = capFind(k); if (c) capOff(c); }, 0); });

/* ───────── 消息卡片（msgFrame）：消息流里每条消息的外壳，组件库组件 ─────────
   节点模板只绑定字段、给出正文块；外壳的结构只在这里：
     frame  cat（作者行 + 卡片 + 卡片下方）| mine（你的气泡）| line（系统类卡片）| day（日期分隔）| typing（正在回复）| bare（原样）
     who time badges quote          作者行（quote = 回复引用 replyRef 的数据 { mid, from, text, state }，点了跳到原文）
     card   bubble（正文包在卡片里）| none（正文块自己就是卡片，如来信、提问）
     body   卡片里的内容；below 卡片下方（批注、过程记录）
     delivery  投递状态胶囊（{ who, state, time, detail, open: { act, args } }）；点击只执行声明的打开动作
     tags chips  你的消息上方的标签和引用
     icon title  系统类卡片
     emph   跳转强调（卡片边框闪一圈主题色）；picking / picked 多选
     acts   消息工具条（来自“消息操作”插槽），side 决定靠哪边 */
/* 投递状态（A 发给 B，A 的消息下方）：已投递 B · 时间 / 已读 B · 时间；B 处理中时胶囊持续闪烁，直到 B 这一轮进入终态。
   悬停不显示正文（正文就在当前消息里）。胶囊朝它所在的一侧展开（猫的消息向右，你的消息向左） */
/* 投递状态的文案：已投递 → 已读；处理中“收到，正在回…”；核对中 / 没确认收到 / 没送到 */
/* 投递状态的字在文案包 delivery 里（键和接口的投递状态同名） */
/* 目标是对话的胶囊（跨对话投递）：收起只露对话图标；悬停展开“已投递 → 对话名 · 时间”；点了跳到目标对话里的那一条 */
function capThread(d, dir, verb) {
  if (typeof d.time === 'number') d = Object.assign({}, d, { time: FORMATS.hm(d.time) });
  return capsule({ dir: dir, cls: 'cap-sm cap-thread ' + (d.state || ''), act: 'msgJump', data: ' data-mid="' + h(d.mid || '') + '" data-t="' + h(d.thread) + '"', tip: verb + ' ' + d.title + (d.time ? ' · ' + d.time : ''),
    lead: '<span class="cap-ic">' + icon('chat', 11) + '</span>', body: '<span class="cap-state">' + h(verb) + '</span> <b>' + h(d.title) + '</b>' + (d.time ? ' <span class="num faint">· ' + h(d.time) + '</span>' : '') });
}
/* 状态胶囊（一个组件，两档大小：size 'l' 在输入框上、默认 s 在消息下方）：输入框左上角“正在执行的成员”、你的消息下方的投递 / 已读、成员 A 发给 B 时 A 消息下方 B 的收到 / 已读 / 处理中，都是它。
   只有文字随场景不同；头像、执行中的扩散圈（同一动效、同一节拍）、叠放、展开方式都一样。展开后的一行永远是 [头像] 名字 状态 时间（st 可以带标记时 html 为真） */
function capWho(d, st, extra, html, size) {
  if (typeof d.time === 'number') d = Object.assign({}, d, { time: FORMATS.hm(d.time) });
  const w = whoInfo(d.who), stTxt = html ? st.replace(/<[^>]+>/g, '') : st;
  /* 执行中 / 卡住画在头像上：头像组件自己从成员的实时执行状态读，调用方不传 */
  return { cls: (size === 'm' ? 'cap-m' : 'cap-sm') + ' scap ' + (extra || ''), style: whoVar(d.who), tip: w.name + ' ' + stTxt + (d.time ? ' · ' + d.time : ''),
    lead: whoAva(d.who, { size: size === 'm' ? 'm' : 's', tip: false, live: d.live }), body: '<b>' + h(w.name) + '</b>' + (w.handle ? ' <span class="faint">' + h(w.handle) + '</span>' : '') + ' <span class="cap-state">' + (html ? st : h(st)) + '</span>' + (d.time ? ' <span class="num faint">' + h(d.time) + '</span>' : '') };
}
function msgDelivery(list, dir) {
  if (!list || !list.length) return '';
  const people = list.filter(function (d) { return !d.thread; }), threads = list.filter(function (d) { return d.thread; });
  return '<div class="msg-deliv' + (dir === 'left' ? ' end' : '') + '" aria-label="' + h(tc('delivery.label')) + '">' +
    /* 投递头像的执行状态由应用随投递数据给出（live）：组件只按它闪 / 停 */
    capStack(people.map(function (d) { const st = tcOr('delivery.' + d.state, 'delivery.delivered'), c = capWho(d, st, d.state); if (d.detail) c.tip += ' · ' + d.detail; if (d.open) { c.act = d.open.act; c.data = argAttrs(d.open.args); } return c; }), { dir: dir, label: tc('delivery.members') }) +
    '</div>';
}
/* 接收提示（B 的回复里，显示 A 的头像）：已收到 A · 时间 / 已读 A · 时间；悬停保留收到的正文，点一下跳到 A 的那条消息 */
/* 接收状态的字在文案包 delivery 里（received / read） */
function msgRecv(list) {
  if (!list || !list.length) return '';
  const people = list.filter(function (r) { return !r.thread; }), threads = list.filter(function (r) { return r.thread; });
  return '<span class="msg-recv">' + capStack(people.map(function (r) {
    const st = tc('delivery.' + (r.state === 'read' ? 'read' : 'received')), c = capWho(r, st, 'recv ' + r.state);
    return Object.assign(c, { act: 'msgJump', data: ' data-mid="' + h(r.mid || '') + '"', body: c.body + (r.excerpt ? '<span class="cap-ex">' + h(r.excerpt) + '</span>' : '') });
  }), { label: tc('delivery.received') }) + threads.map(function (r) { return capThread(r, 'right', tc('delivery.from')); }).join('') + '</span>';
}
/* 回复引用（一个组件）：这条消息回应的是哪一条。你引用成员的消息、成员回复收到的消息、A2A 里 B 回应 A 的通知，都是同一个含义、同一个组件：
   ↩ + 头像（共用头像组件，文字行高）+ 名字：内容。紧凑宽度（最多约 24em，且不超过作者行的 45%），超出省略，从不撑满一行。
   r = { mid, from, text, state: 'received' | 'read', busy, time }：回应的是收到的那条时，接收状态就挂在这个头像上（处理中是扩散圈），不再另画接收胶囊。点了跳到原文 */
function replyRef(r) {
  if (!r) return '';
  if (typeof r.time === 'number') r = Object.assign({}, r, { time: FORMATS.hm(r.time) });
  const st = r.state ? tc('delivery.' + (r.state === 'read' ? 'read' : 'received')) : '', name = r.from ? who(r.from, 'text') : '';
  const inner = icon('jump', 13) + (r.from ? whoAva(r.from, { size: 'xs', tip: false }) + '<b class="reply-n">' + h(tc('reply.name', name)) + '</b>' : '') + '<span class="reply-t">' + h(r.text) + '</span>';
  const tip = (r.mid ? tc('reply.jump') : '') + (st ? (r.mid ? ' · ' : '') + (name ? name + ' ' : '') + st + (r.time ? ' ' + r.time : '') : '');
  return r.mid ? '<button type="button" class="reply-ref' + (r.state ? ' ' + r.state : '') + '" data-act="msgJump" data-mid="' + h(r.mid) + '" data-tip="' + h(tip) + '">' + inner + '</button>' : '<span class="reply-ref">' + inner + '</span>';
}
function msgFrame(o) {
  const n = o.notes || {}, note = function (k) { return n[k] ? ' data-note="' + n[k] + '"' : ''; };
  if (o.frame === 'day') return '<div class="day">' + h(o.text) + '</div>';
  if (o.frame === 'bare') return o.body;
  /* 发送者：成员、你、插件、系统同一个 from 结构（没有 from 时用 who） */
  const m = o.side === 'right' ? null : o.from || o.who || null, w = m ? whoInfo(m, o.source) : null;   /* 右边只会是你：不画自己的头像和名字 */
  /* 作者行的头部：名字（成员带 @handle）· 标签（悄悄话、引导）· 时间，都在同一行；你的消息不画自己的头像和名字 */
  const tags = (o.tags || []).map(function (t) { return '<span class="cafe-tagt">' + (t.icon ? icon(t.icon, 12) : '') + (t.parts != null ? t.parts : h(t.text)) + '</span>'; }).join('');
  const head = w || tags || o.time ? '<div class="msg-head"' + note('head') + '>' + (w ? '<b class="msg-name"' + whoHover(w, 'author') + '>' + h(w.name) + '</b>' + (w.handle ? '<span class="h">' + h(w.handle) + '</span>' : '') : '') + tags + (o.time ? '<span class="time num">' + h(o.time + (o.receivedAt && o.receivedAt !== o.time ? tc('message.receivedAt', o.receivedAt) : '')) + '</span>' : '') + '</div>' : '';
  const right = o.side === 'right', isMsg = o.frame === 'msg';
  const open = '<div class="cafe-m' + (o.emph || (o.mid && landed(o.mid)) ? ' emph' : '') + (o.picking ? ' picking' : '') + '" data-mid="' + (o.running ? 'typing' : h(o.mid)) + '"' + (o.running && o.mid ? ' data-run="' + h(o.mid) + '"' : '') + '>' + (o.picking && isMsg && !o.running ? cafeCheck(o.picked === 'mixed' ? 'mixed' : !!o.picked, '<span class="sr">' + h(tc('message.select')) + '</span>', 'cafePick', ' data-mid="' + h(o.mid) + '"') : '') + '<div class="cafe-m-in">';
  if (o.frame === 'plain') return open + o.body + '</div></div>';
  if (o.frame === 'line') return open + '<div class="cafe-sysc">' + icon(o.icon || 'info', 14) + '<div class="grow">' + (o.title ? '<b>' + h(o.title) + '</b>' : '') + o.body + '</div>' + (o.time ? '<span class="faint num vw-12">' + h(o.time) + '</span>' : '') + '</div></div></div>';
  /* 消息（一个模板）：你、成员、插件、系统、定时任务都一样——作者行（头像 · 名字 · 时间 + 接收胶囊 + 引用）→ 标签 / 引用的上下文 → 正文 → 卡片下方（执行记录、补充消息）→ 投递胶囊 → 工具条。
     只有两处不同：side（你的在右、别人的在左，作者行、胶囊展开方向、工具条位置都按这一侧镜像；展开时头像在贴住的那一端，文字本身不镜像）
     和 surface（bubble 气泡 | bar 左竖线 | none 正文块自己就是卡片）。其余部分有数据才画。 */
  const surface = o.surface || 'bar';
  const chips = function (l) { return l && l.length ? '<div class="chips">' + l.map(function (c) { return chipHtml({ icon: c.icon, kind: c.kind ? h(c.kind) : '', label: h(c.label) }); }).join('') + '</div>' : ''; };
  const body = surface === 'none' || !o.body ? o.body || '' : '<div class="' + (surface === 'bubble' ? 'bubble' : 'cat-bubble') + (o.running ? ' msg-body typing' : '') + '">' + o.body + '</div>';   /* 还没有正文（正在回复、还没出第一个字）：不画空的正文块，只剩作者行 + 那一行 */
  return open + '<div class="msg ' + (right ? 'user-msg' : 'cat') + '" data-side="' + (right ? 'right' : 'left') + '" data-surface="' + surface + '"' + (o.jump ? ' data-act="msgJump" data-mid="' + h(o.jump.mid) + '" data-t="' + h(o.jump.thread) + '" data-tip="' + h(o.jump.tip || tc('message.jumpSource')) + '"' : '') + ' style="' + whoVar(m, o.source) + (right ? whoMeBubble() : '') + '">' +
    '<div class="author-row">' + (m ? whoAva(m, { size: 'l', click: !right, source: o.source, turn: o.mid || '', place: 'author' }) : '') + head + msgRecv(o.recv) + replyRef(o.quote) + '</div>' + (o.chips || []).map(chips).join('') +
    body + (o.below || '') + msgDelivery(o.delivery, right ? 'left' : 'right') + (o.acts || '') + '</div></div></div>';
}

/* ───────── 弹出层里的一项（组件库）：视图模型只给数据，这里画 ─────────
   选项 { lead: { who } | { icon, big } | { glyph }, title: 文字 | [文字 | { hl: 命中的字 }], handle, tag, mono, sub, subTone: run | warn, subMono,
          value（右边的当前值）, chev（右箭头：进子页）, go（右边“跳过去 ›”）, cur（已选，打勾）, sel（键盘选中）, act, args, disabled }
   另外三种：{ sep: 1 } 分隔线；{ sec: '小节名', mono }；{ note: '一行说明', tone: warn } */
function popEntry(x) {
  if (x.sep) return '<div class="divider" role="separator"></div>';
  if (x.sec != null) return lrSection(x.sec, '', { v: 'float', html: x.mono ? '<span class="mono">' + h(x.sec) + '</span>' : null });   /* 小节名：组标签（浮层列表里的那种） */
  if (x.note != null) return '<p class="pop-foot' + (x.tone === 'warn' ? ' vw-warn-t' : '') + '">' + h(x.note) + '</p>';
  const tx = function (t) { return Array.isArray(t) ? t.map(function (s) { return typeof s === 'string' ? h(s) : '<mark>' + h(s.hl) + '</mark>'; }).join('') : h(t); };
  const lead = !x.lead ? '' : x.lead.who ? whoAva(x.lead.who, { size: 's', tip: false, health: x.lead.health }) : x.lead.glyph ? glyph(x.lead.glyph, 'pop-glyph') : icon(x.lead.icon, x.lead.big ? 16 : 14);
  const title = (x.mono ? '<span class="mono">' + tx(x.title) + '</span>' : tx(x.title)) + (x.handle ? ' <span class="muted">' + h(x.handle) + '</span>' : '') + (x.tag ? ' <span class="cafe-tagt">' + h(x.tag) + '</span>' : '');
  const sub = x.sub ? (x.subTone ? '<span class="' + (x.subTone === 'run' ? 'pop-run' : 'vw-warn-t') + '">' : '') + (x.subMono ? '<span class="mono">' + h(x.sub) + '</span>' : h(x.sub)) + (x.subTone ? '</span>' : '') : '';
  /* 一项就是一行 lrow（小行）：前导 · 标题 + 说明 · 行尾（当前值、进子页、已选打勾）。
     整行能点（act）时就没有“跳过去”这一列：点行就是去那里，不再在行尾另写一遍 */
  const tail = (x.value != null ? '<span class="lr-meta">' + h(x.value) + '</span>' : '') + (x.go && !x.act ? '<span class="lr-meta">' + h(x.go) + '</span>' : '') + (x.chev ? icon('right', 14) : '') + (x.cur ? icon('check', 14) : '');
  return lrow({ layout: 'record', hook: 'pop-opt', rootAttrs: (x.stay ? ' data-stay' : '') + (x.why ? ' data-tip="' + h(x.why) + '"' : ''), act: x.act, data: argAttrs(x.args), lead: lead, title: title, sub: sub, cur: !!x.cur, sel: !!x.sel, disabled: !!x.disabled, cols: tail ? [{ w: 'ctl', v: tail }] : [] });
}

/* 滚动边缘渐隐：组件库的滚动原件 .scroll 自带（CSS 滚动时间线，见 core.css），这里不再测量 */

/* ───────── 折叠组件：一个机制，shape 两种（middle | bottom），完全声明式 ─────────
   结构和开关都在这里画出（HTML 里写着展开状态 data-open），测量步骤只写 data-foldable（middle 另写切口的 CSS 变量），从不插 DOM，跑几遍结果都一样。
   展开状态在数据里（S.folds[key]）：点开关改数据 → 重画 → HTML 变了，节点不会被当成“没变”复用。
   两种 shape 共用：切口落在整行上、渐隐一行高、同一个开关组件（foldTg：无杆尖角 ⌄ 展开 / ⌃ 收起）。
   bottom：留开头 N 整行（N 是档位 s 3 行 · m 5 行 · l 8 行），由浏览器的行数截断（line-clamp）切，不量行；最后一行从上到下渐隐，开关紧贴在下面居中。
   middle：留开头 FOLD_HEAD 行、结尾 FOLD_TAIL 行；上面一行渐隐、下面一行渐显（互为镜像），开关在右侧、竖直居中在两行之间；展开后留在原切口处。 */
const FOLD_HEAD = 5, FOLD_TAIL = 3, FOLD_MIN_HIDDEN = 4;
const FOLD_LINES = { s: 3, m: 5, l: 8 };   /* 折叠档位 = 收起时完整显示的单位数 k；收起 = k 个完整单位 + 第 k+1 个整单位渐隐；多于 k+1 个单位才折 */
/* 折叠开关（组件库，唯一一个）：折叠块、排队“还有 N 条”都用它；label 可带文字 */
/* 图标（同一族无杆尖角）：bottom 收着 ⌄、展开 ⌃；middle 收着 ⌃⌄（上下都能展开）、展开 ⌄⌃（向里收） */
/* 折叠开关：字形按展开方向定义——往下展开的（bottom）收着是 ⌄、开着是 ⌃；往上展开的（up：输入框上沿的队列）收着是 ⌃、开着是 ⌄；中间折叠是一对 */
function foldTg(open, act, data, label, tip, shape) {
  const ic = shape === 'middle' ? (open ? 'chevin' : 'chevboth') : shape === 'up' ? (open ? 'down' : 'chevup') : (open ? 'chevup' : 'down');
  return '<button type="button" class="fold-tg" data-act="' + act + '"' + (data || '') + ' aria-expanded="' + open + '" aria-label="' + h(tip || label || tc(open ? 'common.collapse' : 'common.expand')) + '" data-tip="' + h(tip || tc(open ? 'common.collapse' : 'common.expand')) + '">' + icon(ic, 14) + (label ? '<span>' + label + '</span>' : '') + '</button>';
}
function foldBox(style, key, html, o) {
  o = o || {};
  const open = !!S.folds[key], k = h(key), tg = foldTg(open, 'fold', ' data-k="' + k + '"', '', style === 'middle' ? tc(open ? 'fold.collapseMiddle' : 'fold.expandMiddle') : '', style);
  if (style === 'middle') return '<div class="fold" data-fold="middle" data-fold-key="' + k + '" data-open="' + open + '"><div class="msg-body fold-head">' + html + '</div>' +
    '<div class="msg-body fold-tail" aria-hidden="true" inert><div class="fold-tail-in">' + html + '</div></div>' + tg + '</div>';   /* 尾巴一直画着，展开时样式藏起来：开关只改属性 */
  /* 单位跟着里面的内容走：包着一个列表（o.items = 项数）时单位是项——一项换行了还是一项，折不折由项数直接决定（多于 k+1 项），不测量；正文的单位是行（line-clamp k+1，最后一行渐隐，截断后溢出才折） */
  const n = FOLD_LINES[o.height] || FOLD_LINES.l, items = o.items != null;
  return '<div class="fold" data-fold="bottom" data-fold-key="' + k + '" data-open="' + open + '" data-lines="' + n + '"' + (items ? ' data-unit="item" data-foldable="' + (o.items > n + 1 ? 1 : 0) + '"' : '') + '><div class="fold-in' + (o.cls ? ' ' + o.cls : '') + '">' + html + '</div>' + tg + '</div>';
}
/* 分组列表的一段（组件库）：侧栏的置顶、对话组、项目、最近……都是它。
   - 只有一个滚动：外面的列表（导航栏）。段里不再套滚动容器。
   - 表头就是调用方给的那一行（比如“置顶 · 12 个对话”），和行一起滚动（组标签从不吸顶）；点表头（fold，data-f="sec"）收起 / 展开整段。
   - 段就是通用的父子关系：表头是父，行是子；缩进、对齐、收起都由这一个分组渲染决定，段不能单独定制。
   - 默认展开还是收起、几条以上折叠（limit 档位）由 PDL 按段的种类声明（groups: { pinned: { collapsed, limit } … }）；用户点过的状态盖在上面。
   - 行默认只显示前 SEC_COUNT[limit] 条，下面是同一个折叠开关（foldTg）“还有 N 条”，原地展开、⌃ 收起。
   - 收起整段、展开更多，按段记住（store 'secs'，刷新还在）。调用方自己管收起状态的段（对话组、项目）传 collapsed。 */
const SEC_COUNT = { s: 5, m: 10, l: 15 };   /* 折叠阈值档位；默认 l = 15 */
(function () { const s = store.get('secs', {}); Object.keys(s).forEach(function (k) { S.folds[FOLD_SEC + k] = s[k]; }); })();   /* 本机记着的分组段（存的格式不变：{ 段: { c, m } }） */
function secSave() { const o = {}; Object.keys(S.folds).forEach(function (k) { if (k.indexOf(FOLD_SEC) === 0) o[k.slice(FOLD_SEC.length)] = S.folds[k]; }); store.set('secs', o); }
function secSt(key, make) { return S.folds[FOLD_SEC + key] || (make ? (S.folds[FOLD_SEC + key] = {}) : null); }
function secCollapsed(key, dflt) { const st = secSt(key); return st && st.c != null ? !!st.c : !!dflt; }
/* ───────── 对话列表（组件库）：一个对话一行 + 分组段。视图模型只给数据，这里画 ─────────
   行 { id, title, time, cur, pinned, renaming, fav, meta: [{ text, tone: run | err }], badge: { kind: draft | at | unread, n }, more: { menu, label } }
   段 { key, head, rows, peek, collapsed, empty, gid }（所有段的行缩进相同：行内容左边和段表头左边对齐，一条规则，段不能单独缩进）；head：{ kind: 'sec', label, n, note } 段名 + “N 个对话”（点了收起整段）、
   { kind: 'group', id, name, n, open } 对话组、{ kind: 'proj', id, name, tip, open, warn, fixed, n, add } 项目；（行 / 表头的 ⋯ 打开对话区的菜单 cafeMenu）{ other: { open, n } } 是“其他项目”开关 */
function rowMore(menu, k, label, cls) { return btn(label || tc('common.moreActions'), { sm: true, iconOnly: true, icon: 'more', cls: cls, act: 'menu', data: ' data-menu="' + menu + '"' + MENU_DECL + (k != null ? ' data-k="' + h(k) + '"' : '') }); }
const TROW_TONE = { run: { cls: 'run', dot: true }, err: { cls: 'cafe-err' } };   /* 行的状态：执行中（圆点按状态表挑节拍预设）、出错 */
/* rn：原地改名的绑定（threads 块声明 rename = { form, path, blur }：回车提交给哪个表单、Esc 关掉哪个状态、失焦执行什么），组件不认识 */
function threadRow(v, rn, root) {
  if (v.renaming && rn) return ('<form class="cafe-trow renaming" data-form="' + rn.form + '"><label class="sr" for="row-rename">' + h(tc('threadRow.name')) + '</label><input class="input" id="row-rename" value="') + h(v.title) + ('" maxlength="200" data-path="' + h(rn.path) + '" data-on-esc="close" data-on-blur="' + rn.blur + '"></form>');
  /* 一项状态：可以带身份（who，颜色是这一项自己的能力，取不到就是组件的中性默认）和执行状态（status，和头像的圈读同一张表）；
     runs：一条对话里有几只猫同时在执行时，按节拍轮流显示（通用轮换 data-rot，悬停不换） */
  const one = function (m) { const tn = TROW_TONE[m.tone]; const c = m.who ? whoInfo(m.who).color : '', st = c ? '--c:' + c : '';
    /* 执行中：圆点是唯一的 .dot（run 色调：身份色 + 状态表的颜色和节奏），不再用伪元素画 */
    const dt = tn && tn.dot ? '<span class="dot" data-tone="run"' + (m.who ? ' data-live="' + h(m.who) + '" data-status="' + h(m.status || '') + '"' : m.status ? ' data-status="' + h(m.status) + '"' : '') + (st ? ' style="' + st + '"' : '') + '></span>' : '';
    return tn ? '<span class="' + tn.cls + '"' + (m.who ? ' data-k="' + h(m.who) + '"' : '') + '>' + dt + h(m.text) + '</span>' : '<span>' + h(m.text) + '</span>'; };   /* data-k：这一项是谁（树键的一段）——轮换里换了顺序，节拍也按成员认，不按位置 */
  const state = [];
  if (v.hub) state.push({ text: tc('threadRow.meta.hub') });
  if (v.bedroom) state.push({ text: tc('threadRow.meta.bedroom') });
  if (v.runs && v.runs.length) state.push({ runs: v.runs.map(function (r) { return { who: r.who, status: r.status, tone: 'run', text: tc('threadRow.meta.run', whoInfo(r.who).name, Math.max(1, Math.round((r.secs || 0) / 60))) }; }) });
  else if (v.failed) state.push({ text: tc('common.status.error'), tone: 'err' });
  else if (v.running && v.who) state.push({ text: tc('threadRow.meta.running', whoInfo(v.who).name) });
  else if (v.note || v.restored) state.push({ text: rn && rn.note ? pv(rn.note, v, root) : v.note });
  else if (v.lastWho) state.push({ text: tc('threadRow.meta.replied', whoInfo(v.lastWho).name) });
  const meta = (v.fav ? ['<span class="cafe-star" data-tip="' + h(tc('threadRow.starred')) + '">' + icon('star', 12) + '</span>'] : []).concat(state.map(function (m) {
    if (!m.runs || m.runs.length < 2) return one(m.runs ? m.runs[0] : m);
    return rotHtml('span', 'trow-rot', m.runs.map(function (r) { return one(r); })); }));
  const n = (v.unread || 0) + (v.pending || 0), tip = [v.unread ? tc('threadRow.unread', v.unread) : '', v.pending ? tc('threadRow.pending', v.pending) : '', v.at ? tc('threadRow.mention', v.mention) : ''].filter(Boolean).join(' · ');
  const bdg = n || v.at ? badge(n || true, { at: v.at, tip: tip }) : '';
  /* 时间和草稿是同一格的状态（有草稿时显示“草稿”，主题色）：悬停时一起让位给操作 */
  const stamp = v.draft && !bdg ? '<span class="trow-draft">' + h(tc('common.status.draft')) + '</span>' : h(rn && rn.time ? pv(rn.time, v, root) : v.time || '');
  /* 一行对话就是一行 lrow：标题 · 第二行状态；行尾按行对齐（时间 / 计数），悬停的“更多”出现在时间的位置上（同一位置互斥）；置顶是左上角的标记 */
  return lrow({ layout: 'item', hook: 'cafe-trow' + (v.pinned ? ' pinned' : ''), rootAttrs: ' data-tid="' + h(v.id) + '"', act: 'thread', data: ' data-id="' + h(v.id) + '"', headAttrs: ' data-tip="' + h(v.title) + '"',
    cur: v.cur ? 'page' : false, title: h(v.title), sub: meta.length ? meta.join(' · ') : '', aside: [stamp, bdg], swap: true,
    actsHtml: rn && rn.more ? (rn.acts || []).map(function (c) { return pvControl(c, v, root); }).join('') + rowMore(menuLive(rowMenuItems(rn.more.items, v, root)), v.id, pv(rn.more.label, v, root)) : '',   /* 悬停时换上来的：声明的操作按钮（acts）+ 更多 */
    acts: rn && rn.more ? [] : [{ icon: 'more', label: tc('threadRow.more', v.title), act: 'menu', data: ' data-menu="' + (rn && rn.menu || '') + '" data-k="' + h(v.id) + '"' }],
    pre: v.pinned ? '<span data-tip="' + h(tc('threadRow.pinned')) + '" aria-label="' + h(tc('threadRow.pinned')) + '">' + icon('pin', 12) + '</span>' : '' });
}
/* 行 / 行内的更多按钮仍是同一个 rowMore；只把菜单项与插槽按声明展开。 */
function rowMenuItems(items, data, root) { return items.flatMap(function (it) { return it.slot ? pdlMenuItems(it.slot, pvArgsObj(it.args, data, root)) : pvMenu([it], data, root); }); }
PDL_COMPONENTS.rowMore = function (p, sc, root) { return rowMore(menuLive(rowMenuItems(p.items, sc, root)), pv(p.k, sc, root), pv(p.label, sc, root)); };
PDL_COMPONENTS.rowMore.catalog = { g: 'rows', view: 'chat.header', get props() { return pdlLoc(pdlQuery({ type: 'component' }).find(function (n) { return n.node.use === 'rowMore'; }).node.props); } };
/* 段头（组件库，一个形式；置顶、最近、项目、对话组都是它）：三格——标题 ·（空白）· [数量 ⇄ 段的操作（项目的 + ⋯）] · 状态箭头（› 收起 / ⌄ 展开）。数量和操作同一格互斥，悬停时操作换上来；箭头是自己的一格，不参与互斥；点了收起 / 展开整段；右边悬停出现段的操作。
   置顶、最近、对话组、项目都是它——不同的只是图标和点了交给谁 */
function secHead(o) {
  /* 整个头是开合的那一下（role=button，和可点的行一样）；段的操作（⋯、+）是它旁边的兄弟格子，不叠在开合按钮上面 */
  return '<div class="cafe-ghead" role="button" tabindex="0"' + (o.act ? ' data-act="' + o.act + '"' : '') + (o.data || '') + ' aria-expanded="' + !!o.open + '"' + (o.tip ? ' data-tip="' + h(o.tip) + '"' : '') + (o.note ? ' data-note="' + o.note + '"' : '') + '><span class="cafe-gbtn"><span class="cafe-glead">' + icon(o.icon, 14) + '<span class="n">' + h(o.name) + '</span>' + (o.extra || '') + '</span>' + (o.n != null ? qty(o.n) : '') + twisty(o.open) + '</span>' + (o.acts ? '<span class="cafe-gacts">' + o.acts + '</span>' : '') + '</div>';
}
/* 段头的绑定在主题的 threads 块里声明（heads[种类] = { icon, act, args, more: { menu, label }, add: { act, args } }，参数里的 @字段 取段头的数据）：
   点表头改哪个状态、⋯ 打开哪个菜单、+ 去哪，组件不认识。kind = sec 的段自己开合（折叠组件的 fold sec），图标按段的 key 声明 */
function threadSecHead(hd, dc, root) {
  const d = (dc.heads || {})[hd.kind] || {}, ic = d.icon && typeof d.icon === 'object' ? d.icon[hd.key] || d.icon['*'] : d.icon;
  if (hd.kind === 'sec') return secHead({ act: 'fold', data: ' data-f="sec" data-k="' + h(hd.key) + '"' + (hd.dflt ? ' data-dflt="1"' : ''), open: !hd.collapsed, icon: ic, name: tc('threadRow.section', hd.key), n: hd.n, note: hd.note });
  const more = d.more ? rowMore(d.more.items ? menuLive(pvMenu(d.more.items, hd, root)) : d.more.menu, hd.id, pv(d.more.label, hd, root), 'cafe-hov') : '', add = hd.add && d.add ? btn(pv(d.add.label, hd, root), { iconOnly: true, icon: 'plus', sm: true, act: d.add.act, data: pvArgs(d.add.args, hd, root), cls: 'cafe-hov' }) : '';
  return secHead({ act: d.act, data: pvArgs(d.args, hd, root), open: hd.open, icon: ic, name: hd.unassigned ? tc('threadRow.unassigned') : hd.name, tip: hd.tip, n: hd.n,
    extra: (hd.warn ? lrDot('warn', hd.warn) : '') + (hd.fixed ? '<span class="t-s faint">' + h(tc('threadRow.fixed')) + '</span>' : ''), acts: hd.add ? add + more : more });
}
/* dc：threads 块的声明（groups 每种段的默认、heads 段头的绑定、other「其他项目」那一段的开合、rename 行的原地改名）。
   「其他项目」是同一种段头（名字 · 数量 · 箭头），点了展开的是它下面的几段（other.sections） */
function threadSections(list, dc, root) {
  dc = dc || {}; const groups = dc.groups || {};
  return (list || []).map(function (s) {
    const dflt = (groups || {})[String(s.key || '').split(':')[0]] || {};
    if (s.other) { const d = dc.other || {}; return secHead({ act: d.act, data: pvArgs(d.args, s.other, root), open: s.other.open, name: tc('threadRow.otherProjects'), n: s.other.n }) + (s.other.open ? threadSections(s.other.sections, dc, root) : ''); }
    return gsection({ key: s.key, collapsed: s.collapsed, dflt: !!dflt.collapsed, step: dflt.limit, rows: s.rows.map(function (v) { return threadRow(v, dc.rename, root); }), peek: (s.peek || []).map(function (v) { return threadRow(v, dc.rename, root); }), empty: s.empty ? emptyState(tc('threadRow.empty', s.empty)) : '',
      attrs: s.gid ? ' data-gid="' + h(s.gid) + '"' : '', head: threadSecHead(Object.assign({ key: s.key, collapsed: s.collapsed != null ? s.collapsed : secCollapsed(s.key, !!dflt.collapsed), dflt: !!dflt.collapsed }, s.head), dc, root) });
  }).join('');
}
function gsection(o) {
  const key = o.key, rows = o.rows || [], n = SEC_COUNT[o.step || 'l'];
  const collapsed = o.collapsed != null ? !!o.collapsed : secCollapsed(key, !!o.dflt), more = !!(secSt(key) && secSt(key).m);
  /* 所有行都画出来，收起 / “还有 N 条”只改段上的属性（data-collapsed / data-more），点开关是本地更新、不重画：
     展开时露 .gsec-rows（多出的几条在 .gsec-x 里，data-more 时才露）；收起时只露 .gsec-peek（需要注意的那几行） */
  const fold = rows.length > n ? secMoreTg(key, more, rows.length - n) : '';
  return '<section class="gsec" data-sec="' + h(key) + '"' + (collapsed ? ' data-collapsed' : '') + (more ? ' data-more' : '') + (o.attrs || '') + '><div class="gsec-h">' + o.head + '</div><div class="gsec-b">' +
    '<div class="gsec-rows">' + (rows.slice(0, n).join('') || (o.empty || '')) + (rows.length > n ? '<div class="gsec-x">' + rows.slice(n).join('') + '</div>' : '') + fold + '</div>' +
    '<div class="gsec-peek">' + (o.peek || []).join('') + '</div></div></section>';
}
function secMoreTg(key, more, extra) { return foldTg(more, 'fold', ' data-f="more" data-k="' + h(key) + '"', more ? '' : tc('fold.moreHtml', '<span class="num">' + extra + '</span>'), more ? tc('common.collapse') : '', 'bottom'); }
/* 段的收起 / 展开：本地更新（段的属性 + 表头箭头），不重画整页。对话组、项目的表头也走它（状态各自存，DOM 一样改） */
function secFlip(el, collapsed) {
  const sec = el && el.closest('.gsec'); if (!sec) { render(true); return; }
  sec.toggleAttribute('data-collapsed', collapsed);
  const b = sec.querySelector(':scope > .gsec-h .cafe-ghead'); if (b) { b.setAttribute('aria-expanded', String(!collapsed));  }
}
function foldSec(d, el) { const st = secSt(d.k, true); st.c = !secCollapsed(d.k, d.dflt === '1'); secSave(); secFlip(el, st.c); };
function foldMore(d, el) {
  const st = secSt(d.k, true); st.m = !st.m; secSave();
  const sec = el && el.closest('.gsec'); if (!sec) { render(true); return; }
  sec.toggleAttribute('data-more', st.m); el.outerHTML = secMoreTg(d.k, st.m, sec.querySelectorAll(':scope .gsec-x > *').length);
};
/* 一段内容按真实排版分成行：每行的中线（文字矩形的中点），行框 = 中线 ± 行高 / 2 */
function foldLines(el) {
  const r = document.createRange(); r.selectNodeContents(el);
  const top = el.getBoundingClientRect().top, mids = [];
  Array.prototype.slice.call(r.getClientRects()).forEach(function (x) { if (x.height < 4) return; const m = (x.top + x.bottom) / 2 - top; if (!mids.some(function (y) { return Math.abs(y - m) < 4; })) mids.push(m); });
  return mids.sort(function (a, b) { return a - b; });
}
/* 量折叠（折叠组件自己的事）：只在折叠块出现或尺寸变化时量（ResizeObserver），不插 DOM、不每次渲染全局扫。
   新出现的折叠块由引擎的进树通知交过来（frame.js treeMatch），不扫页面。middle 量出切口位置写成 CSS 变量；bottom 只判断够不够长 */
function foldMeasure(el) {
  if (el.dataset.fold === 'middle') {
    const head = el.querySelector(':scope > .fold-head'); if (!head) return;
    const lh = parseFloat(getComputedStyle(head).lineHeight) || 26, ls = foldLines(head), n = ls.length;
    if (n < FOLD_HEAD + FOLD_TAIL + FOLD_MIN_HIDDEN) { el.dataset.foldable = '0'; return; }
    const cut = ls[FOLD_HEAD - 1] + lh / 2, from = ls[n - FOLD_TAIL] - lh / 2, end = ls[n - 1] + lh / 2;
    el.style.setProperty('--flh', lh + 'px'); el.style.setProperty('--fh', Math.round(cut) + 'px'); el.style.setProperty('--fs', Math.round(from) + 'px'); el.style.setProperty('--ft', Math.round(end - from) + 'px');
    const tg = el.querySelector(':scope > .fold-tg'), hid = n - FOLD_HEAD - FOLD_TAIL, lab = el.dataset.open === 'true' ? tc('fold.collapseMiddle') : tc('fold.expandMiddleN', hid);
    if (tg && tg.getAttribute('aria-label') !== lab) { tg.setAttribute('aria-label', lab); tg.dataset.tip = lab; }
    el.dataset.foldable = '1'; return;
  }
  if (el.dataset.unit === 'item') return;   /* 列表：折不折在画的时候按项数定好了，不量 */
  const inner = el.querySelector(':scope > .fold-in'); if (!inner) return;
  /* bottom 正文：截断本身就是尺子——套上 line-clamp（k+1 行）后还溢出，才有东西被藏起来；不按行高算。展开着的时候临时套上截断量一次（同一轮里，不绘制） */
  const tmp = el.dataset.open === 'true'; if (tmp) el.setAttribute('data-measure', '');
  const f = inner.scrollHeight > inner.clientHeight + 1 ? '1' : '0';
  if (tmp) el.removeAttribute('data-measure');
  if (el.dataset.foldable !== f) el.dataset.foldable = f;
}
treeMatch('[data-fold]', foldMeasure, true);   /* 进树通知：折叠块进了文档、或尺寸变了，量一次 */
/* 本地更新记版本时：把折叠块上的测量结果去掉、开关换回刚画出来的样子 */
LOCAL_NORM.push(function (root) {
  root.querySelectorAll('[data-fold]').forEach(function (f) {
    if (f.dataset.unit !== 'item') f.removeAttribute('data-foldable'); f.removeAttribute('style');   /* 列表的 data-foldable 是画出来的，不是量的 */
    const tg = f.querySelector(':scope > .fold-tg'), open = f.dataset.open === 'true', shape = f.dataset.fold;
    if (tg) tg.outerHTML = foldTg(open, 'fold', ' data-k="' + h(f.dataset.foldKey) + '"', '', shape === 'middle' ? tc(open ? 'fold.collapseMiddle' : 'fold.expandMiddle') : '', shape);
  });
});
/* 折叠开关：本地更新——改 data-open、换开关、重新量；不重画消息、不重画对话流。改完把所在消息 / 孤岛记下的“版本”更新成现在的样子，
   下次整页重画时这条消息照样复用（工具栏、作者行的节点身份都不变） */
/* 决定结果的详情开合（result 块）：展开状态在数据里，改完重画 */
function foldBlock(d) {
  const k = d.k, open = S.folds[k] = !S.folds[k];
  document.querySelectorAll('[data-fold-key]').forEach(function (f) {
    if (f.dataset.foldKey !== k) return;
    f.setAttribute('data-open', String(open));
    const shape = f.dataset.fold, tg = f.querySelector(':scope > .fold-tg');
    if (tg) tg.outerHTML = foldTg(open, 'fold', ' data-k="' + h(k) + '"', '', shape === 'middle' ? tc(open ? 'fold.collapseMiddle' : 'fold.expandMiddle') : '', shape);
    foldMeasure(f); localSync(f);
  });
}
/* 开合只有一个动作（fold）：f = row（列表里一次展开一行）| tree（目录）| sec（分组段）| more（段里露出更多）| result（重画的开合）；
   path = 状态里的手风琴（同一个值再点一下就收起，v 或 i 是这一项）；什么都没写 = 折叠块（S.folds[k]，本地更新） */
/* 定位到段里的一行之前把它露出来：段收着就展开，在“还有 N 条”里就展开那几条（引擎的 locateNode 经 ENGINE_PARTS.reveal 调） */
ENGINE_PARTS.reveal = function (el) {
  const sec = el.closest('.gsec'); if (!sec) return;
  const key = sec.dataset.sec;
  if (sec.hasAttribute('data-collapsed')) { const st = secSt(key, true); st.c = false; secSave(); secFlip(el, false); }
  if (el.closest('.gsec-x') && !sec.hasAttribute('data-more')) { const t = sec.querySelector('[data-f="more"]'); if (t) foldMore({ k: key }, t); }
};
A.fold = function (d, el) {
  if (d.path) { const v = d.v != null ? d.v : d.i, cur = pathGet(d.path, d); pathSet(d.path, String(cur) === String(castTo(v, cur, d.cast)) && cur != null ? null : v, d); render(true); return; }
  if (d.f === 'row') return foldRow(d, el);
  if (d.f === 'tree') return foldTree(d, el);
  if (d.f === 'sec') return foldSec(d, el);
  if (d.f === 'more') return foldMore(d, el);
  if (d.f === 'queue') return foldQueue(d, el);
  if (d.f === 'result') { S.folds[d.k] = !S.folds[d.k]; render(true); return; }
  foldBlock(d);
};

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

/* 竖叠（vstack，组件库）：底对齐的一列。子项位置的过渡由孤岛复用统一做（data-flip，见 core.js reuseApply），这里不另算 */

/* 提示轮换：见 ui.js 的通用轮换（data-rot） */

/* ───────── 目录登记：这个文件里的原件 ───────── */
Object.assign(LIB_CATALOG, {
  lrow: { g: 'rows', via: ['type:list', 'type:settings'], ex: function (s) { return '<div class="group lr-list">' + s.rows.map(function (r) { return lrow({ layout: 'two', title: h(r.title), sub: h(r.sub), act: 'noop' }); }).join('') + '</div>'; } },
  ltree: { g: 'rows', via: ['type:tree'], ex: function (s) { return ltree('catalog-ltree', function (p) { return (s.tree[p] || []).map(function (n) { return { name: n.name, path: n.path, dir: n.dir, row: { title: '<span class="mono">' + h(n.name) + '</span>' } }; }); }, {}); } },
  threadRow: { g: 'rows', via: ['type:threads'], ex: function (s) { return '<div class="cafe-threads">' + s.threads[0].rows.map(threadRow).join('') + '</div>'; } },
  gsection: { g: 'rows', via: ['type:threads'], ex: function (s) { return threadSections(s.threads, {}); } },
  capsule: { g: 'identity', inline: true, via: ['type:capsules', 'type:notices', 'prop:delivery', 'prop:recv'], ex: function (s) { const r = s.runners[0]; return capsule(capWho({ who: r.who }, r.state, '', false, 'm')); } },
  capStack: { g: 'identity', inline: true, via: ['type:capsules', 'prop:delivery'], ex: function (s) { return capStack(s.runners.concat([{ who: s.extraRunner.who, state: s.statusText.info }]).map(function (r) { return capWho({ who: r.who }, r.state); }), { label: s.title }); } },
  msgAuthor: { g: 'message', via: ['prop:frame'], ex: function (s) { return msgFrame({ frame: 'msg', side: 'left', surface: 'bar', who: s.author.who, time: s.author.time, quote: s.reply, body: '<div class="msg-body">' + h(s.sub) + '</div>' }); } },
  replyRef: { g: 'message', inline: true, via: ['type:reply', 'prop:quote'], ex: function (s) { return replyRef(s.reply); } },
  msgDelivery: { g: 'message', inline: true, via: ['prop:delivery'], ex: function (s) { return msgDelivery(s.delivery, 'left'); } },
  msgRecv: { g: 'message', inline: true, via: ['prop:recv'], ex: function (s) { return msgRecv(s.recv.map(function (r) { return Object.assign({ excerpt: s.sub }, r); })); } },
  popEntry: { g: 'popups', via: ['type:opts'], ex: function (s) { return '<div class="pop-list cat-pop">' + s.pop.map(popEntry).join('') + '</div>'; } },
  foldBottom: { g: 'structure', via: ['type:fold', 'type:content'], ex: function (s) { return foldBox('bottom', 'catalog-fb', '<p>' + h(s.long) + '</p>', { height: 's' }); } },
  foldMiddle: { g: 'structure', via: ['type:content'], ex: function (s) { return foldBox('middle', 'catalog-fm', '<p>' + h(s.long + s.long + s.long) + '</p>'); } }
});
