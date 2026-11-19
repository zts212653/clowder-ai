/* 边界：一个含义一个组件、不为接口定制、不按位置推导样式 */
/* 折叠：内容折叠、查看更多、开合的唯一动作 */
'use strict';
/* 开合的状态（组件库唯一的一份）：所有开合——折叠块、展开一块（disclosure）、列表里一次展开一行、树的目录、分组段——都记在 S.folds，键按形状分范围：
   键本身 = 折叠块 / 展开一块（真假）；'row:列表' = 这张列表展开着的那一行；'tree:树' = 展开着的目录 { 路径: 真 }；'sec:段' = 分组段 { c: 收起, m: 露出更多 }。
   只有分组段存进本机（store 'secs'，刷新还在），别的跟着这次打开。状态路径的根是 folds（通用动作 set / toggle 能直接改，比如 disclosure 的默认开合） */
S.folds = {};
const FOLD_ROW = 'row:', FOLD_TREE = 'tree:', FOLD_SEC = 'sec:';
STATE_ROOTS.folds = function () { return S.folds; };

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
/* 查看更多（折叠的 more）：数据说后面还有（全文还没读、还有下一批……）时，开关一直在，写“查看更多”；展开时执行声明的读取。读到了数据就不再说有更多，回到普通的折叠 */
const FOLD_MORE = {};
function foldBox(style, key, html, o) {
  o = o || {};
  const open = !!S.folds[key], k = h(key), more = o.more && !open ? o.more : null;
  if (o.more) FOLD_MORE[key] = o.more; else delete FOLD_MORE[key];
  const tg = more ? foldTg(false, 'fold', ' data-k="' + k + '"', tc('fold.viewMore'), tc('fold.viewMore'), style) : foldTg(open, 'fold', ' data-k="' + k + '"', '', style === 'middle' ? tc(open ? 'fold.collapseMiddle' : 'fold.expandMiddle') : '', style);
  if (style === 'middle') return '<div class="fold" data-fold="middle" data-fold-key="' + k + '" data-open="' + open + '"><div class="msg-body fold-head">' + html + '</div>' +
    '<div class="msg-body fold-tail" aria-hidden="true" inert><div class="fold-tail-in">' + html + '</div></div>' + tg + '</div>';   /* 尾巴一直画着，展开时样式藏起来：开关只改属性 */
  /* 单位跟着里面的内容走：包着一个列表（o.items = 项数）时单位是项——一项换行了还是一项，折不折由项数直接决定（多于 k+1 项），不测量；正文的单位是行（line-clamp k+1，最后一行渐隐，截断后溢出才折） */
  const n = FOLD_LINES[o.height] || FOLD_LINES.l, items = o.items != null;
  return '<div class="fold" data-fold="bottom" data-fold-key="' + k + '" data-open="' + open + '" data-lines="' + n + '"' + (more ? ' data-more' : '') + (items ? ' data-unit="item" data-foldable="' + (o.items > n + 1 ? 1 : 0) + '"' : '') + '><div class="fold-in' + (o.cls ? ' ' + o.cls : '') + '">' + html + '</div>' + tg + '</div>';
}
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
    if (tg && !f.hasAttribute('data-more')) tg.outerHTML = foldTg(open, 'fold', ' data-k="' + h(f.dataset.foldKey) + '"', '', shape === 'middle' ? tc(open ? 'fold.collapseMiddle' : 'fold.expandMiddle') : '', shape);
  });
});
/* 折叠开关：本地更新——改 data-open、换开关、重新量；不重画消息、不重画对话流。改完把所在消息 / 孤岛记下的“版本”更新成现在的样子，
   下次整页重画时这条消息照样复用（工具栏、作者行的节点身份都不变） */
/* 决定结果的详情开合（result 块）：展开状态在数据里，改完重画 */
function foldBlock(d) {
  const k = d.k, open = S.folds[k] = !S.folds[k];
  if (open && FOLD_MORE[k]) { actFn(FOLD_MORE[k].act)(FOLD_MORE[k].args); render(true); return; }   /* 查看更多：读剩下的，重画（读到之前照样展开着） */
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
/* ───────── 目录登记：这个文件里的组件 ───────── */
Object.assign(LIB_CATALOG, {
  foldBottom: { g: 'structure', via: ['type:fold', 'type:content'], ex: function (s) { return foldBox('bottom', 'catalog-fb', '<p>' + h(s.long) + '</p>', { height: 's' }); } },
  foldMiddle: { g: 'structure', via: ['type:content'], ex: function (s) { return foldBox('middle', 'catalog-fm', '<p>' + h(s.long + s.long + s.long) + '</p>'); } }
});
