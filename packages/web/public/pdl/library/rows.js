/* 边界：一个含义一个组件、不为接口定制、不按位置推导样式 */
/* 列表行：行、列表、列轨、树、分段、对话行、行的更多、续读、触屏露出 */
/* 列表行：所有“一行一项”的列表都用它，面板不再自己写行样式。
   规则只在这里定一次：
   - 行高 --row-h；小行 --row-h-sm（展开区里的子行）
   - 结构固定：前导（头像/图标）→ 标题 + 行内标记（状态点、计时）→ 尾部数据列（状态、元信息）→ 操作（永远是最后一列）
   - 尾部数据列右对齐，在列表容器的 subgrid 列轨上上下对齐（lrCols）；操作占最后一条列轨（acts），同一列表里上下对齐
   - 没有数据列的单行：悬停操作浮在行尾，不占宽度；不可用时置灰，悬停/点击说明原因
   - 展开只有一层：同一个列表一次只展开一行；子行（sm）不能再展开
   - 展开区左边缘对齐标题，不对齐前导 */
'use strict';
/* list / cards 共用续读尾标（唯一一个）：服务端的下一页（声明的 next）和本地的下一页（渐进显示）都是它。
   还有下一批时末尾是一个 ⋯（悬停“查看更多”），点它就读下一批；滚到附近也会自动读（服务端的下一页、本地的下一页一样；节点重画不续读，离开附近再进入或向下滚轮才触发下一批） */
const LIST_NEXT = {};
function listNextHtml(decl, sc, root) {
  const d = pv(decl, sc, root); if (!d) return '';
  return listNextTail(pv(d.key, sc, root), { act: pv(d.act, sc, root), args: pvArgsObj(d.args, sc, root), enabled: pvOk(d.when, sc, root), busy: !!pv(d.busy, sc, root) });
}
function listNextTail(k, x) {
  LIST_NEXT[k] = x;
  return '<div class="list-next" data-list-next="' + h(k) + '" data-island="list-next:' + h(k) + '">' + (x.enabled && !x.busy ? btn(tc('list.loadMore'), { iconOnly: true, sm: true, icon: 'more', act: 'listNextGo', data: ' data-k="' + h(k) + '"' }) : '') + '</div>';
}
A.listNextGo = function (d) { const x = LIST_NEXT[d.k]; if (x && x.enabled && !x.busy) actFn(x.act)(x.args); };
function listNextRead(el, near) {
  const d = LIST_NEXT[el.dataset.listNext];
  if (!near) { el._nextRead = false; return; }
  if (!d.enabled || d.busy || el._nextRead || !el.checkVisibility()) return;
  el._nextRead = true; actFn(d.act)(d.args, el);
}
nearView('[data-list-next]', listNextRead);
/* 消息流的顶端（和列表的下一页同一个做法）：最早那条消息滚到附近就加载更早的（登记的 STREAM_OLDER；正在加载、已经没有更早的它会拒绝），
   加载完还在附近就接着加载。看的是流里的第一条，不另加节点（流是带间距的 flex，多一个节点就多一段间距） */
function streamOlderRead(el, near) {
  if (!near || !STREAM_OLDER.load || el._olderBusy) return;
  el._olderBusy = true;
  if (STREAM_OLDER.load(function () { el._olderBusy = false; if (el.isConnected && el.__near) streamOlderRead(el, true); }) === false) el._olderBusy = false;
}
nearView('[data-own="stream"] > :first-child', streamOlderRead);
document.addEventListener('wheel', function (e) {
  if (e.deltaY <= 0) return;
  const sc = e.target.closest('.scroll'); if (!sc) return;
  sc.querySelectorAll('[data-list-next]').forEach(function (el) { if (el.closest('.scroll') === sc && el.__near && !LIST_NEXT[el.dataset.listNext].busy) { el._nextRead = false; listNextRead(el, true); } });
}, { passive: true });
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
  const canOpen = L !== 'tree' && o.expand != null && o.list;   /* 记录行声明了展开也能点开（执行轨迹的一步）；树行由树块自己开合 */
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
  /* 行尾的提示（数量 / 状态在前、时间在最右）是一个整体：总在标题那一行、并排；有悬停操作时和操作互斥 */
  const aside = o.aside ? '<span class="lr-aside"><span class="lr-aside-d' + (o.swap ? ' swap-d' : '') + '">' + (o.aside[1] ? '<span class="lr-aside-b">' + o.aside[1] + '</span>' : '') + '<span class="lr-aside-t">' + (o.aside[0] || '') + '</span></span>' + (o.swap ? actsHtml : '') + '</span>' : '';
  const tone = (o.tone ? ' ' + o.tone : '') + (o.cur ? ' selected' : '');
  return '<div class="lr' + tone + (canOpen || o.act ? ' click' : '') + (o.disabled ? ' off' : '') + (o.hook ? ' ' + o.hook : '') + '"' + ' data-layout="' + L + '"' + (o.swap ? ' data-swap' : '') + (o.rootAttrs || '') + (o.orderable && o.key != null ? ' data-okey="' + h(o.key) + '" data-edit="order"' : '') + (canOpen ? ' data-open="' + !!o.open + '"' + (o.titleWrap && o.titleWrap !== 'auto' ? ' data-title-wrap="' + h(o.titleWrap) + '"' : '') : '') + (o.note ? ' data-note="' + o.note + '"' : '') + ' style="--acts:' + (nActs && !o.swap && !cols.length ? 'calc(' + nActs + ' * var(--ctl-s) + var(--sp-s))' : '0px') + ';--c:' + (o.color || 'initial') + (o.depth != null ? ';--d:' + o.depth : '') + '">' +
    (o.pre ? '<span class="lr-pre' + (o.preLive ? ' live' : '') + '">' + o.pre + '</span>' : '') +
    '<div class="lr-head"' + click + (click ? ' data-drag-surface' : '') + (o.cur ? ' aria-current="' + (o.cur === true ? 'true' : o.cur) + '"' : '') + (o.sel ? ' aria-selected="true"' : '') + (o.disabled ? ' aria-disabled="true"' : '') + (o.headAttrs || '') + (o.twisty && o.twisty !== 'leaf' && !o.twAct ? ' aria-expanded="' + (o.twisty === 'open') + '"' : '') + '>' + (o.orderable ? '<span class="lr-grip" aria-hidden="true">' + icon('grip', 14) + '</span>' : '') + tw + (o.lead || o.leadSlot ? '<span class="lr-lead">' + o.lead + '</span>' : '') +
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
function threadRow(v, rn, root, movable) {
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
  else if (v.replied) state.push({ text: tc('threadRow.meta.repliedGeneric') });
  const meta = (v.fav ? ['<span class="cafe-star" data-tip="' + h(tc('threadRow.starred')) + '">' + icon('star', 12) + '</span>'] : []).concat(state.map(function (m) {
    if (!m.runs || m.runs.length < 2) return one(m.runs ? m.runs[0] : m);
    return rotHtml('span', 'trow-rot', m.runs.map(function (r) { return one(r); })); }));
  const n = (v.unread || 0) + (v.pending || 0), tip = [v.unread ? tc('threadRow.unread', v.unread) : '', v.pending ? tc('threadRow.pending', v.pending) : '', v.at ? tc('threadRow.mention', v.mention) : ''].filter(Boolean).join(' · ');
  const bdg = n || v.at ? badge(n || true, { at: v.at, tip: tip }) : '';
  /* 时间和草稿是同一格的状态（有草稿时显示“草稿”，主题色）：悬停时一起让位给操作 */
  const stamp = v.draft && !bdg ? '<span class="trow-draft">' + h(tc('common.status.draft')) + '</span>' : h(rn && rn.time ? pv(rn.time, v, root) : v.time || '');
  /* 一行对话就是一行 lrow：标题 · 第二行状态；行尾按行对齐（时间 / 计数），悬停的“更多”出现在时间的位置上（同一位置互斥）；置顶是左上角的标记 */
  return lrow({ layout: 'item', hook: 'cafe-trow' + (v.pinned ? ' pinned' : ''), rootAttrs: ' data-tid="' + h(v.id) + '"' + (movable ? ' data-edit="move" data-move-key="' + h(v.id) + '"' : ''), act: 'thread', data: ' data-id="' + h(v.id) + '"', headAttrs: ' data-tip="' + h(v.title) + '"',
    cur: v.cur ? 'page' : false, title: h(v.title), sub: meta.length ? meta.join(' · ') : '&#8203;', aside: [stamp, bdg], swap: true,   /* 状态行总在：没有状态时留空一行，所有对话行一样高 */
    actsHtml: rn && rn.more ? (rn.acts || []).map(function (c) { return pvControl(c, v, root); }).join('') + rowMore(menuLive(rowMenuItems(rn.more.items, v, root)), v.id, pv(rn.more.label, v, root)) : '',   /* 悬停时换上来的：声明的操作按钮（acts）+ 更多 */
    acts: rn && rn.more ? [] : [{ icon: 'more', label: tc('threadRow.more', v.title), act: 'menu', data: ' data-menu="' + (rn && rn.menu || '') + '" data-k="' + h(v.id) + '"' }],
    /* 置顶是左上角的标记；主题声明了 pin 就是开关：置顶了一直在，没置顶时悬停这一行才出现，点一下切换（不占行尾的操作位，不挡标题） */
    pre: rn && rn.pin ? '<button type="button" class="lr-pin"' + actAttrs(rn.pin.act, pvArgsObj(rn.pin.args, v, root)) + ' aria-pressed="' + !!v.pinned + '" data-tip="' + h(pv(rn.pin.label, v, root)) + '" aria-label="' + h(pv(rn.pin.label, v, root)) + '">' + icon('pin', 12) + '</button>'
      : v.pinned ? '<span data-tip="' + h(tc('threadRow.pinned')) + '" aria-label="' + h(tc('threadRow.pinned')) + '">' + icon('pin', 12) + '</span>' : '',
    preLive: !!(rn && rn.pin) });
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
    extra: (hd.warn ? lrDot('warn', hd.warn) : '') + (hd.fixed ? '<span class="t-s faint">' + h(tc('threadRow.fixed')) + '</span>' : '') + (hd.kind === 'group' && !hd.open && hd.attention > 0 ? '<span class="t-s faint">' + h(tc('threadRow.groupAttention', hd.attention)) + '</span>' : ''), acts: hd.add ? add + more : more });
}
/* dc：threads 块的声明（groups 每种段的默认、heads 段头的绑定、other「其他项目」那一段的开合、rename 行的原地改名）。
   「其他项目」是同一种段头（名字 · 数量 · 箭头），点了展开的是它下面的几段（other.sections） */
function threadSections(list, dc, root) {
  dc = dc || {}; const groups = dc.groups || {};
  return (list || []).map(function (s) {
    const dflt = (groups || {})[String(s.key || '').split(':')[0]] || {};
    if (s.other) { const d = dc.other || {}; return secHead({ act: d.act, data: pvArgs(d.args, s.other, root), open: s.other.open, name: tc('threadRow.otherProjects'), n: s.other.n }) + (s.other.open ? threadSections(s.other.sections, dc, root) : ''); }
    /* move（主题声明的动作）：对话能拖进别的分组、拖出到不分组的段；段是放下的容器（data-move-act + 它是哪一段）；rowDrop（段的数据）：放在这一段的行上是插进先后（insert）还是放到那一行上（onto） */
    const mvAct = dc.move ? pv(dc.move, root, root) : '', mv = !!mvAct;
    const hd = Object.assign({ key: s.key, collapsed: s.collapsed != null ? s.collapsed : secCollapsed(s.key, !!dflt.collapsed), dflt: !!dflt.collapsed }, s.head);
    const d = (dc.heads || {})[hd.kind] || {};
    return gsection({ key: s.key, collapsed: s.collapsed, dflt: !!dflt.collapsed, step: dflt.limit, rows: s.rows.map(function (v) { return threadRow(v, dc.rename, root, mv); }), peek: (s.peek || []).map(function (v) { return threadRow(v, dc.rename, root, mv); }), peekMore: s.peekMore || 0, peekAct: d.act || '', peekData: d.args ? pvArgs(d.args, hd, root) : '', empty: s.empty ? emptyState(tc('threadRow.empty', s.empty)) : '',
      attrs: (s.gid ? ' data-gid="' + h(s.gid) + '"' : '') + (mv ? ' data-move="threads" data-move-act="' + h(mvAct) + '" data-to="' + h(s.gid || '') + '"' + (s.rowDrop ? ' data-move-rows="' + h(s.rowDrop) + '"' : '') : ''), head: threadSecHead(hd, dc, root) });
  }).join('');
}
function gsection(o) {
  const key = o.key, rows = o.rows || [], n = SEC_COUNT[o.step || 'l'];
  const collapsed = o.collapsed != null ? !!o.collapsed : secCollapsed(key, !!o.dflt), more = !!(secSt(key) && secSt(key).m);
  /* 所有行都画出来，收起 / “还有 N 条”只改段上的属性（data-collapsed / data-more），点开关是本地更新、不重画：
     展开时露 .gsec-rows（多出的几条在 .gsec-x 里，data-more 时才露）；收起时只露 .gsec-peek（需要注意的那几行） */
  const fold = rows.length > n ? secMoreTg(key, more, rows.length - n) : '';
  const peekFold = o.peekMore > 0 && o.peekAct ? '<button type="button" class="fold-tg" data-act="' + h(o.peekAct) + '"' + (o.peekData || '') + '>' + tc('fold.moreHtml', '<span class="num">' + o.peekMore + '</span>') + '</button>' : '';
  return '<section class="gsec" data-sec="' + h(key) + '"' + (collapsed ? ' data-collapsed' : '') + (more ? ' data-more' : '') + (o.attrs || '') + '><div class="gsec-h">' + o.head + '</div><div class="gsec-b">' +
    '<div class="gsec-rows">' + (rows.slice(0, n).join('') || (o.empty || '')) + (rows.length > n ? '<div class="gsec-x">' + rows.slice(n).join('') + '</div>' : '') + fold + '</div>' +
    '<div class="gsec-peek">' + (o.peek || []).join('') + peekFold + '</div></div></section>';
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
/* ───────── 目录登记：这个文件里的组件 ───────── */
Object.assign(LIB_CATALOG, {
  lrow: { g: 'rows', via: ['type:list', 'type:settings'], ex: function (s) { return '<div class="group lr-list">' + s.rows.map(function (r) { return lrow({ layout: 'two', title: h(r.title), sub: h(r.sub), act: 'noop' }); }).join('') + '</div>'; } },
  ltree: { g: 'rows', via: ['type:tree'], ex: function (s) { return ltree('catalog-ltree', function (p) { return (s.tree[p] || []).map(function (n) { return { name: n.name, path: n.path, dir: n.dir, row: { title: '<span class="mono">' + h(n.name) + '</span>' } }; }); }, {}); } },
  threadRow: { g: 'rows', via: ['type:threads'], ex: function (s) { return '<div class="cafe-threads">' + s.threads[0].rows.map(threadRow).join('') + '</div>'; } },
  gsection: { g: 'rows', via: ['type:threads'], ex: function (s) { return threadSections(s.threads, {}); } },
  popEntry: { g: 'popups', via: ['type:opts'], ex: function (s) { return '<div class="pop-list cat-pop">' + s.pop.map(popEntry).join('') + '</div>'; } }
});
