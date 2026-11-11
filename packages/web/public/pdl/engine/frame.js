/* 边界：引擎只放机制与时机，不认任何具体名字、不为单个位置打补丁 */
/* 应用外框（组件库）：图标、窄栏、二级栏外壳和入口项、按布局数据把区域摆出来并重画（区域引擎）。
   页面内容来自 PAGES / 视图描述，这里只管外框和重画（保持滚动、焦点、消息节点复用） */
'use strict';

/* ───────── 进树通知（引擎能力，唯一的一处）─────────
   一个通用、看不见的引擎部件（和看不见的锚点同一类）：页面上唯一的一个观察者，只看“有子树加进了文档”，把加进来的元素交给登记的引擎钩子（treeIn）。
   画的地方（整页重画、弹窗局部更新、只重画一条消息、孤岛、本地换掉的开关……）不用管谁要知道；钩子里没有组件名。
   回调在本轮脚本结束后、绘制前到；同一轮里要读钩子结果的先 treeFlush() 同步取走还没处理的记录 */
const TREE_IN = [];
function treeIn(fn) { TREE_IN.push(fn); }
function treeAdded(recs) { const ns = []; recs.forEach(function (r) { r.addedNodes.forEach(function (n) { if (n.nodeType === 1) ns.push(n); }); }); if (ns.length) { SETTLE.n++; TREE_IN.forEach(function (fn) { fn(ns); }); } }
const TREE_MO = new MutationObserver(treeAdded);
TREE_MO.observe(document.body, { childList: true, subtree: true });
function treeFlush() { treeAdded(TREE_MO.takeRecords()); }
/* ───────── 静止信号（引擎能力，只读、不改行为）─────────
   window.__settled() 返回一个 promise：字体读完，并且整整一帧里没有重画、没有在等启动阶段的异步读、没有进树的子树、没有在跑的动效时兑现。
   动效 = 有限次、每次不长于 --dur-slow 的动画 / 过渡（含它的延迟，例如 --reveal-hold 后才收回的）；无限循环的状态预设、滚动驱动的渐隐、
   按时长显示信息的停留（--roll-hold 的轮换、--dur-emph 的落点强调）不算——它们的时长本身是被测的东西。给检查脚本用来代替固定的等待；页面自己不读它 */
const SETTLE = { n: 0, hold: 0 };
/* 静止前要等的异步工作（组件的异步渲染这类）：登记一个 promise，完成前不算静止 */
function settleHold(p) { SETTLE.hold++; return Promise.resolve(p).finally(function () { SETTLE.hold--; SETTLE.n++; }); }
function settleBusy() { const max = ms('--dur-slow'); return RENDERING || START_WAIT > 0 || SETTLE.hold > 0 || document.getAnimations().some(function (a) { if (a.playState !== 'running' && a.playState !== 'pending' || a.timeline !== document.timeline) return false; const t = a.effect && a.effect.getComputedTiming(); return !!t && isFinite(t.endTime) && t.duration <= max; }); }
window.__settled = function () {
  return (document.fonts ? document.fonts.ready : Promise.resolve()).then(function () { return new Promise(function (res) {
    let last = -1, quiet = 0;
    const tick = function () { const n = SETTLE.n; if (!settleBusy() && n === last) quiet++; else quiet = 0; last = n; if (quiet >= 1) res(true); else requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }); });
};
/* 按选择器取进树的元素（同一个钩子的通用写法）：加进来的子树里（含它自己）匹配 sel 的元素交给 fn；resize 时再挂一个 ResizeObserver（尺寸变了再交一次）。
   需要量自己尺寸的组件（折叠、排队胶囊）用它登记；引擎不认它们 */
function treeMatch(sel, fn, resize) {
  const ro = resize ? new ResizeObserver(function (es) { es.forEach(function (e) { if (e.target.isConnected) fn(e.target); }); }) : null;
  treeIn(function (ns) { ns.forEach(function (n) { (n.matches(sel) ? [n] : []).concat(Array.prototype.slice.call(n.querySelectorAll(sel))).forEach(function (el) { if (ro) ro.observe(el); fn(el); }); }); });
}
/* 视口附近（数据流的时机，和 onRender 并列，规则见 core.js onRender 上面的注释）：nearView(sel, fn)——滚动区里匹配 sel 的节点
   进入 / 离开“可见区上下各 --near-rows 行”（行模数 --row-h-1）时交给 fn(el, true / false)；一开始就不在附近的不通知。
   只通知、不重画：条目附带的数据（每条消息的附加记录这类）在条目到了附近才读，读回来照常推进来、同一帧只画一次；引擎不认识数据来源 */
function nearView(sel, fn) {
  const ios = new Map();
  const ioFor = function (root) {
    if (ios.has(root)) return ios.get(root);
    const cs = getComputedStyle(document.documentElement), m = Math.round((parseFloat(cs.getPropertyValue('--near-rows')) || 9) * (parseFloat(cs.getPropertyValue('--row-h-1')) || 44)) + 'px';
    const io = new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        const el = e.target, was = el.__near, now = e.isIntersecting;
        if (!el.isConnected) { io.unobserve(el); return; }   /* 换掉的节点不再看（重画换了新节点会重新登记） */
        if (was === now || (was === undefined && !now)) { el.__near = now; return; }
        el.__near = now; fn(el, now);
      });
    }, { root: root, rootMargin: m + ' 0px ' + m + ' 0px' });
    ios.set(root, io); return io;
  };
  const watch = function (el) { if (el.__nearSeen) return; el.__nearSeen = true; ioFor(el.closest('.scroll')).observe(el); };
  treeMatch(sel, watch);
  document.querySelectorAll(sel).forEach(watch);   /* 登记时已经在页面上的也看 */
}
/* 滚动区的锚点（规则见 core.js anchorTake）：滚动区里的内容进树或尺寸变了，按窗口的锚点还原——所有局部变化（一条消息重画、流式输出、展开收起、图片读完）走这一处 */
treeMatch('.scroll > *', function (el) { anchorKeep(el.parentElement); }, true);
/* 窄栏：入口来自页面描述的“窄栏上方 / 下方”插槽（见 pdl.js） */
let RENDERING = false;

/* ───────── 弹窗栈（引擎） ─────────
   开着的弹窗按打开先后排成一栈（后开的在上）：每个弹窗包在 .pop-host[data-pop] 里，层级 = 它在栈里的位置。弹窗从不画在容器里，都盖在投影上。
   每个弹窗只声明 at（初始位置）、exit（退出方式）、drag（能否拖）；下面每条行为都只读这三项，不按弹窗写分支：
   - 打开：进栈（压在最上面），同时记下触发它的元素（POP_TRIG）和它属于谁（POP_OWNER：触发元素所在的弹窗 / 容器，或者声明的 state）；
   - 按下某个弹窗：它升到最上面，但不越过它上面的 fixLayer 弹窗；
   - 关闭：Esc 只关最上面一个（它声明了 esc 时）；× 只在声明了 x 时画；outside 点外面关；pick 选了一项就关；leave 指针离开就关；
   - 连带关闭：一个弹窗或容器关掉（或者不在了），属于它的弹窗一起关。
   遮罩只有一层（#scrim，在应用外，重画不会重建），由 focus 声明推导（和关法无关）：最上面一个声明了 focus 的东西下面一层——
   弹窗（按栈位置）、声明了 focus 的投影层（插件界面框，proj.js）、或者页面里就地聚焦的任何 PDL 节点（data-focus，引导里的“聚光灯”：布局不动，只把它的层抬到遮罩上面）；都没有就没有遮罩。
   每次栈变化都只是重新推导，没有单独的打开 / 关闭处理；出现、消失淡入淡出（--dur-med），换层不闪。 */
const POP_OWNER = {}, POP_TRIG = {};
/* 声明的 view 按 when 状态路径打开；state 仍只表示主人。组件自己的交互内容继续经既有 POPUPS 登记。 */
function popContent(k) {
  if (POPUPS[k]) return POPUPS[k]();
  const d = PDL_POPUPS[k] || {};
  return d.view && (!d.when || pathGet(d.when)) ? pdlView(d.view) : '';
}
/* 每个弹窗自己读的（开不开、画什么）单独记下：变化只碰到某个弹窗时只更新它（renderLocal → popRefresh），不走整页 */
const POP_READS = {};
function popRead(k, fn) {
  const reads = new Set(), own0 = READ_OWN; READ_SCOPES.push(reads); READ_OWN = reads;
  try { return fn(); } finally { READ_SCOPES.pop(); READ_OWN = own0; POP_READS[k] = reads; }
}
function popLayer() {
  const open = {};
  Object.keys(Object.assign({}, POPUPS, PDL_POPUPS)).forEach(function (k) { const html = popRead(k, function () { return popContent(k); }); if (html) open[k] = html; });
  S.popOrder = S.popOrder.filter(function (k) { if (!open[k]) delete ANCHORED[k]; return open[k]; });
  Object.keys(open).forEach(function (k) { if (S.popOrder.indexOf(k) < 0) popPush(k, open); });
  return S.popOrder.map(function (k, i) { return ctKid({ key: 'popup:' + k, html: popHost(k, open[k], i) }); }).join('') + ctKid({ key: 'overlays:end', html: '' });
}
/* 弹窗的外壳。data-pop 是弹窗名；别的元素上同名的参数（比如 cafePop 按钮的 data-pop）不算 */
const POP_SEL = '.pop-host[data-pop]';
/* 进栈：触发它的元素是这次动作的来源（ACT_FROM，点击分发记下的）；它属于谁：
   声明了 state → 那个状态；触发元素在某个弹窗里 → 那个弹窗（那个弹窗已经因为这一下关了——选了一项——就交给那个弹窗的主人）；
   否则 → 触发元素所在的容器（最近的视图 / 树键）。程序打开的（没有触发元素）不属于谁 */
function popPush(k, open) {
  const d = PDL_POPUPS[k] || {}, t = ACT_FROM && ACT_FROM.closest ? ACT_FROM : null;
  S.popOrder.push(k);
  POP_TRIG[k] = t ? anchorOf(t) : null;
  if (d.at === 'trigger' && t && !ANCHORED[k]) popAnchor(k, t);   /* 跟着触发它的元素（打开它的动作已经指定了锚点的除外：程序打开、锚在输入框上） */
  if (t && t.dataset.spot && SPOTS[t.dataset.spot]) SPOTS[t.dataset.spot].pop = k;   /* 看不见的锚点（ui.js）：跟着用它的弹窗走 */
  if (d.state) { POP_OWNER[k] = { state: d.state }; return; }
  const host = t && t.closest(POP_SEL);
  if (host) {
    let p = host.dataset.pop;
    while (p && p !== k && !open[p]) { const o = POP_OWNER[p]; if (!o || !o.pop) { POP_OWNER[k] = o || null; return; } p = o.pop; }
    POP_OWNER[k] = p && p !== k ? { pop: p } : null; return;
  }
  const c = t && t.closest('[data-view], [data-okey]');
  POP_OWNER[k] = c ? { sel: c.dataset.view != null ? '[data-view="' + CSS.escape(c.dataset.view) + '"]' : '[data-okey="' + CSS.escape(c.dataset.okey) + '"]' } : null;
}
/* 弹窗锚在一个元素上（at: trigger）：引用那个元素的锚点名（ui.js 的锚定），元素重画后不在了就按声明的关法关掉 */
function popAnchor(k, el) { return anchorTo(k, el, function () { if (S.popOrder.indexOf(k) >= 0) popClose(k, true); }); }
/* 程序打开的浮窗（没有触发元素）：锚在第一个对得上的元素上；对不上就锚结构上的容器（窄栏、主区）。app 只给选择器，不碰页面 */
function popAnchorAt(k, sel) { return popAnchor(k, document.querySelector(sel) || document.querySelector('.rail') || document.querySelector('.main-col') || document.body); }
function popAnchorVar(k) { const a = ANCHORED[k]; return a ? ';--u-anchor:' + a.name : ''; }
/* 一个弹窗的外壳：初始位置类（pop-<at>）+ 栈位置；框架（第一个子元素）能不能拖由 drag 声明（见 core.js） */
function popHost(k, html, i) {
  /* 窗口组件的通用设置：声明了 focus（有遮罩的窗口）的弹窗，缺省就用 page 层的身——和回放剧场同一条路；
     显式写 body: 'page' / 'shell' 可以覆盖。有背景图时是图 + 半透明的页面底色（--bg-veil 是主窗口那一层的透明度），
     没有时就是页面底色。没有 focus 的浮层（菜单、下拉）不走这条，仍然是组件自己的面 */
  const d = PDL_POPUPS[k] || {}, page = d.body === 'page' || (d.focus && !d.body), bg = page ? bgState() : null, img = bg && bg.shell;
  return '<div class="pop-host pop-' + (d.at || 'center') + (page ? ' pop-body-page' + (img ? ' has-img' : '') : '') + '" data-pop="' + k + '"' + (d.within ? ' data-within="' + h(d.within) + '"' : '') + (page ? ' data-bg-owner="' + h(ctPages()) + '"' : '') + ' style="--u-pz:' + (i || 0) + popAnchorVar(k) + (img ? ';--page-img:url(&quot;' + img + '&quot;)' : '') + '">' + html + '</div>';
}
/* 只更新一个弹窗（输入框孤岛这类局部更新用，不整页重画）：开着就换内容；刚打开就压到栈顶；刚关掉就出栈。之后照常重新推导遮罩、连带关闭 */
function popRefresh(k) {
  const host = document.querySelector('.pop-host[data-pop="' + k + '"]'), html = popContent(k);
  SHELL.ov = null;   /* 浮层就地改过：下一次整页画浮层时不能按上次画的 HTML 当作没变 */
  if (host && html) { const t = document.createElement('template'); t.innerHTML = html; patchKids(host, t.content); const a = ANCHORED[k]; if (a) host.style.setProperty('--u-anchor', a.name); keySelShow(host); return; }
  if (host) { host.remove(); delete ANCHORED[k]; S.popOrder = S.popOrder.filter(function (x) { return x !== k; }); }
  else if (html) { const open = {}; open[k] = 1; S.popOrder.forEach(function (x) { open[x] = 1; }); popPush(k, open); const layer = SHELL.el.nextElementSibling, t = document.createElement('template'); t.innerHTML = ctKid({ key: 'popup:' + k, html: popHost(k, html, S.popOrder.length - 1) }); layer.insertBefore(t.content, groupsOf(layer).find(function (g) { return g.key === 'overlays:end'; }).mark); recordSegs(layer); }
  scrimSync(); popSnap(); anchorCheck(); popCascade();
}
/* 列表的键盘选择：选中项（aria-selected / 焦点）始终在可视范围内，到边时里层滚动跟上（所有可键盘选择的列表共用） */
/* 键盘在一列项里移动（唯一的一份）：菜单、弹出层的候选（焦点留在输入框，移的是选中项）、消息导航的刻度都用它，只给出新的序号。
   i = 现在的序号（-1 = 还没有），n = 项数；o.wrap 首尾相接（菜单、候选），o.flip 列表倒着画（朝上展开的候选：往下键是往序号小的走），
   o.page 还认 Home / End / PageUp / PageDown（刻度）。不是这些键时返回 null */
function keyStep(e, i, n, o) {
  o = o || {}; if (!n) return null;
  let d = { ArrowDown: 1, ArrowUp: -1 }[e.key];
  if (d != null) { if (o.flip) d = -d; return o.wrap ? ((i < 0 ? (d > 0 ? -1 : 0) : i) + d + n) % n : Math.max(0, Math.min(n - 1, i + d)); }
  const to = o.page ? { Home: 0, End: n - 1, PageDown: i + 5, PageUp: i - 5 }[e.key] : null;
  return to == null ? null : Math.max(0, Math.min(n - 1, to));
}
function keySelShow(el) { const x = el && (el.matches('[aria-selected="true"], :focus') ? el : el.querySelector('.lr-head[aria-selected="true"]')); if (x) x.scrollIntoView({ block: 'nearest' }); }
/* 栈位置写回外壳的层级（不重画） */
function popZ() { document.querySelectorAll(POP_SEL).forEach(function (h) { h.style.setProperty('--u-pz', S.popOrder.indexOf(h.dataset.pop)); }); scrimSync(); }
/* 按下一个弹窗：升到最上面；它上面有 fixLayer 的弹窗时，只升到那一个下面 */
function popRaise(k) {
  const o = S.popOrder, i = o.indexOf(k); if (i < 0) return;
  let j = o.length; for (let n = i + 1; n < o.length; n++) if ((PDL_POPUPS[o[n]] || {}).fixLayer) { j = n; break; }
  if (j - 1 === i) return;
  o.splice(i, 1); o.splice(j - 1, 0, k); popZ();
}
document.addEventListener('pointerdown', function (e) { const host = e.target.closest && e.target.closest(POP_SEL); if (host) popRaise(host.dataset.pop); }, true);
/* 连带关闭：主人关了（弹窗出栈、容器不在了、状态结束了），属于它的弹窗一起关（不再问未保存：离开主人时已经问过）。
   “不在了”指看不见：触发元素 / 主人容器所在的层被投影盖住或切走（.layer-covered、inert）也算，不只是从页面里删掉 */
function popUnseen(el) { return !el || !el.isConnected || !!el.closest('.layer-covered, [inert]'); }
function popCascade() {
  S.popOrder.slice().forEach(function (k) {
    if (S.popOrder.indexOf(k) < 0) return;
    const o = POP_OWNER[k], all = function (sel) { const xs = document.querySelectorAll(sel); return xs.length && ![].some.call(xs, function (x) { return !popUnseen(x); }); };
    const gone = (POP_TRIG[k] && !(o && o.state) && (treeFlush(), all('[data-aname="' + CSS.escape(POP_TRIG[k]) + '"]'))) || (o && (o.state ? !S[o.state] : o.pop ? S.popOrder.indexOf(o.pop) < 0 : !document.querySelector(o.sel) || all(o.sel)));
    if (gone) { POP_OWNER[k] = null; popClose(k, true); }
  });
}
onRender(popCascade);
function popTopFocus() { for (let i = S.popOrder.length - 1; i >= 0; i--) if ((PDL_POPUPS[S.popOrder[i]] || {}).focus) return i; return -1; }
let SPOT_LAYERS = [];
function scrimSync() {
  document.documentElement.toggleAttribute('data-pops', S.popOrder.length > 0);   /* 有弹层开着：根上一个标记，样式按它选（比 :has() 便宜，重画时不连带整页重新算样式） */
  let el = document.getElementById('scrim');
  if (!el) { el = document.createElement('div'); el.id = 'scrim'; el.setAttribute('aria-hidden', 'true'); document.body.appendChild(el); }
  const i = popTopFocus(), occFocus = !!document.querySelector('.app.occ-focus'), spot = i < 0 && !occFocus && Array.prototype.some.call(document.querySelectorAll('[data-focus]'), function (n) { return !n.closest('.layer-covered'); });   /* 被盖住的层还没重画，里面过期的聚光灯不算 */
  if (i >= 0) el.style.setProperty('--u-sz', i);
  el.classList.toggle('occ', i < 0 && occFocus);
  el.classList.toggle('spot', spot);
  el.classList.toggle('on', i >= 0 || occFocus || spot);
  /* 弹层落在哪个容器里：声明的容器（看不见就往上退）；容器画了但没有占位（比如工作台铺满时被收起的主区）也往上退 */
  document.querySelectorAll('.pop-host[data-within]').forEach(function (host) { let c = navEffective(host.dataset.within), target = document.querySelector('[data-c="' + CSS.escape(c) + '"]');
    while (target && !target.getClientRects().length && ctParent(c)) { c = navEffective(ctParent(c)); target = document.querySelector('[data-c="' + CSS.escape(c) + '"]'); } host.style.setProperty('--u-within', anchorOf(target)); });
  /* 聚焦的是整棵子树：沿用原生顶层 + CSS 锚点，尺寸容器不再裁切其越界内容。
     原节点留在原来的 DOM 里，占位只保留原有布局；普通弹窗仍按现有栈排列。 */
  const focused = Array.from(document.querySelectorAll('[data-focus]')).filter(function (n) { return !n.closest(POP_SEL) && !n.closest('.layer-covered'); });
  focused.forEach(function (n) { n.parentElement.style.setProperty('--u-focus-h', n.getBoundingClientRect().height + 'px'); });
  const pops = focused.length ? S.popOrder.map(function (k) { return document.querySelector(POP_SEL + '[data-pop="' + CSS.escape(k) + '"]'); }) : [];
  const groupEnd = pops.findLastIndex(function (n) { return !!n.querySelector('[data-focus]'); }) + 1;
  const order = !focused.length ? [] : i < 0 ? pops.slice(0, groupEnd).concat(focused, pops.slice(groupEnd)) : pops.slice(0, i).concat(focused, [el], pops.slice(i));
  if (order.length === SPOT_LAYERS.length && order.every(function (n, k) { return n === SPOT_LAYERS[k] && n.matches(':popover-open'); })) return;
  const active = document.activeElement;
  SPOT_LAYERS.forEach(function (n) { if (n.matches(':popover-open')) n.hidePopover(); n.removeAttribute('popover'); });
  order.forEach(function (n) { n.setAttribute('popover', 'manual'); n.showPopover(); });
  SPOT_LAYERS = order;
  if (active.isConnected && document.activeElement !== active) active.focus({ preventScroll: true });
}
treeMatch('[data-focus]', scrimSync, true);

/* ───────── 离开（容器层的唯一一处） ─────────
   离开一个容器（关掉弹窗；主区返回、切换）前：容器里有改过没存的表单，先压一个确认弹窗“放弃未保存的修改？”（它声明了 focus + fixLayer）；没改过直接走。
   改没改过有两种来源，判断都只看“表单在不在这个容器里”：
   - 有草稿的表单（成员、MCP、插件配置）：登记在 DIRTY（core.js，formDraft），草稿 vs 原值；离开时丢掉草稿；
   - 其余弹窗里的表单：打开时记下各字段的值（POP_SNAP），离开时比较；提交（submit）后重新记。搜索框里是查询，不算改动。 */
const POP_SNAP = {};
function popVals(host) { return Array.prototype.filter.call(host.querySelectorAll('form input, form textarea, form select'), function (el) { return !el.closest('.search'); }).map(function (el) { return el.type === 'checkbox' || el.type === 'radio' ? String(el.checked) : el.value; }).join('\u0001'); }
function popSnap() {
  const live = {}; let focused = false;
  document.querySelectorAll(POP_SEL).forEach(function (host) { const k = host.dataset.pop; live[k] = 1; if (!(k in POP_SNAP)) { POP_SNAP[k] = popVals(host); focused = popFocus(host) || focused; } });
  Object.keys(POP_SNAP).forEach(function (k) { if (!live[k]) delete POP_SNAP[k]; });
  return focused;
}
/* 刚打开的弹窗的默认焦点：有可输入的字段就落在第一个字段；没有就落在声明的按钮上（默认“取消”，focus: 'confirm' 时是确认），回车就按它 */
function popFocus(host) {
  const f = (host.querySelector('[data-no-field-focus]') ? null : host.querySelector('input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([disabled]), textarea:not([disabled])')) || host.querySelector('[data-autofocus]');
  if (f && (PDL_POPUPS[host.dataset.pop] || {}).focus) { f.focus(); return true; }
  return false;
}
document.addEventListener('submit', function (e) { const host = e.target.closest && e.target.closest(POP_SEL); if (host) POP_SNAP[host.dataset.pop] = popVals(host); }, true);
/* 容器 el 里改过没存的表单：草稿表单（DIRTY）+ 容器里（或容器本身）的弹窗表单 */
function leaveDirty(el) {
  const hosts = el.matches(POP_SEL) ? [el] : Array.prototype.slice.call(el.querySelectorAll(POP_SEL));
  return DIRTY.filter(function (x) { return x.dirty() && el.querySelector('form[data-form="' + x.form + '"]'); }).length > 0 || hosts.some(function (h) { return h.dataset.pop in POP_SNAP && popVals(h) !== POP_SNAP[h.dataset.pop]; });
}
/* el：一个容器，或者一组（投影的几层一起离开：被盖住、出栈、换掉，见 proj.js） */
function leave(el, then) {
  const els = !el ? [] : Array.isArray(el) ? el : [el];
  const drafts = DIRTY.filter(function (x) { return els.some(function (e) { return e.querySelector('form[data-form="' + x.form + '"]'); }); });
  const go2 = function () { drafts.forEach(function (x) { if (x.drop) x.drop(); }); then(); };
  if (!els.some(leaveDirty)) { go2(); return; }
  S.popConfirm = { then: go2 }; render(true);
}
/* 关一个弹窗：离开检查之后执行它声明的 close；force = 不问（连带关闭、确认过放弃） */
function popClose(k, force) {
  const host = document.querySelector('.pop-host[data-pop="' + k + '"]');
  const shut = function () { delete POP_SNAP[k]; const act = (PDL_POPUPS[k] || {}).close; if (act && actFn(act)) actFn(act)(Object.assign({ k: k }, (PDL_POPUPS[k] || {}).closeArgs)); else render(true); };
  if (force) shut(); else leave(host, shut);
}
/* Esc：只关最上面一个弹窗，而且它要声明了 esc */
function popEsc() { const k = S.popOrder[S.popOrder.length - 1]; if (!k || !popExits(k, 'esc')) return false; popClose(k); return true; }
/* 点击在弹窗 k 里：点在它自己里，或者点在属于它的弹窗里（从它里面打开的） */
function popWithin(k, t) {
  const host = t.closest(POP_SEL);
  for (let p = host && host.dataset.pop, n = 0; p && n < 32; n++) { if (p === k) return true; const o = POP_OWNER[p]; p = o && o.pop; }
  return false;
}
/* 点在打开 k 的那个触发元素上：由触发元素的动作自己开关，不算点外面 */
function popOnTrigger(k, t) { const el = anchorEl(POP_TRIG[k]); return !!el && el.contains(t); }
/* 点外面（outside）：唯一的一处，在点击分发之前（捕获阶段），所以点到的动作照常执行、在关掉之后。点在遮罩上、点在按下之前就在输入的那个字段里不算。
   选了一项（pick）：在弹窗里执行了一个动作（[data-act]），动作执行完弹窗还开着、还在同一页，就关掉它。留在弹窗里的两种：动作换了一页（弹窗内容的 data-page 变了），
   或者节点声明了 stay（[data-stay]：就地切换、多选）。这一下打开的别的弹窗交给它的主人，不跟着关 */
let POP_TYPING = null, POP_PICK = null;
document.addEventListener('pointerdown', function () { POP_TYPING = document.activeElement; }, true);   /* 按下之前就在输入的那个字段 */
function popPage(k) { const el = document.querySelector('.pop-host[data-pop="' + k + '"] [data-page]'); return el ? el.dataset.page : ''; }
document.addEventListener('click', function (e) {
  const t = e.target; POP_PICK = null; if (!t.closest || t.closest('#scrim')) return;
  const typing = t === POP_TYPING && /^(INPUT|TEXTAREA)$/.test(t.tagName), host = t.closest(POP_SEL), act = t.closest('[data-act]');
  if (host && act && host.contains(act) && !t.closest('[data-stay]') && popExits(host.dataset.pop, 'pick')) POP_PICK = { k: host.dataset.pop, page: popPage(host.dataset.pop), before: S.popOrder.slice() };
  S.popOrder.slice().reverse().forEach(function (k) {
    if (S.popOrder.indexOf(k) < 0 || popWithin(k, t)) return;
    if (popExits(k, 'outside') && !typing && !popOnTrigger(k, t)) popClose(k);
  });
}, true);
document.addEventListener('click', function () {   /* 在点击分发（core.js）之后 */
  const p = POP_PICK; POP_PICK = null;
  if (!p || S.popOrder.indexOf(p.k) < 0 || popPage(p.k) !== p.page) return;
  S.popOrder.forEach(function (j) { const o = POP_OWNER[j]; if (p.before.indexOf(j) < 0 && o && o.pop === p.k) POP_OWNER[j] = POP_OWNER[p.k] || null; });
  popClose(p.k);
});
/* 指针离开（leave）：共用的悬停规则——从弹窗或它的触发元素离开后保持 --reveal-hold，还没回来（回到弹窗或触发元素）就关 */
let POP_LEAVE = 0;
document.addEventListener('pointerout', function (e) {
  if (!e.target.closest) return;
  const host = e.target.closest(POP_SEL), k = host ? host.dataset.pop : S.popOrder.slice().reverse().find(function (x) { return popExits(x, 'leave') && popOnTrigger(x, e.target); });
  if (!k || !popExits(k, 'leave')) return;
  const box = function () { return document.querySelector('.pop-host[data-pop="' + k + '"]'); }, to = e.relatedTarget, b = box();
  if (to && ((b && b.contains(to)) || popOnTrigger(k, to))) return;
  clearTimeout(POP_LEAVE); POP_LEAVE = setTimeout(function () { const b2 = box(), t = anchorEl(POP_TRIG[k]); if (b2 && !b2.matches(':hover') && !(t && t.matches(':hover')) && S.popOrder.indexOf(k) >= 0) popClose(k); }, ms('--reveal-hold'));
});
/* 放弃修改再离开（离开确认的“放弃”）：引擎的一处；“继续编辑”就是 close { path: 's.popConfirm' } */
A.popDiscard = function () { const c = S.popConfirm; S.popConfirm = null; if (c && c.then) c.then(); else render(true); };
STATE_ROOTS.tabs = function () { return NAV.tabs; };

/* ───────── 返回（引擎，唯一的一处）─────────
   打开的内容盖住了触发处，引擎在画那个容器之前把它的返回放进返回槽（BACK）：page 是容器本身的返回（主区的来源、工作台里从别的工具点过来、被占用的区域），
   detail 是容器里下钻的返回（列表 → 详情）。返回从不省略，也从不画在窗口角上：容器里第一个标题行把它画在自己的头里
   （页头、详情头、弹出层的头、作为页头的工具条）；内容里声明了“返回放在这里”（PDL 的 back 控件，比如表单自己的取消）时，标题行不画，返回就是那个控件；
   一个标题行都没有的容器，引擎在它顶上画一行只放返回的头。返回旁边写不写上一层的标题按容器（结构里的 backLabel）或按打开方式（动作参数 backLabel）声明，默认只有图标，名字在悬停提示里 */
const BACK = { page: null, detail: null, placed: 0 };
function backIn(role, d, fn) {
  if (!d) return fn();   /* 这一层没有返回：不遮住外层放进来的 */
  const prev = BACK[role]; BACK[role] = d;
  let html = '', rest = null;
  try { html = fn(); } finally { rest = BACK[role]; BACK[role] = prev; }
  return rest ? backHead(rest) + html : html;
}
/* 标题行取走返回：详情头先取下钻的返回，没有就取容器本身的；内容里声明了返回的位置时标题行不取 */
function backTake(role) {
  if (BACK.placed) return '';
  const k = role === 'detail' && BACK.detail ? 'detail' : 'page', d = BACK[k]; if (!d) return '';
  BACK[k] = null; return backHtml(d);
}
function backHtml(d) { return ENGINE_PARTS.back(d); }   /* 名字写不写由返回槽里的描述带着（navBackOf：按容器或按打开方式声明），没有主题级开关 */
function backHead(d) { return '<div class="back-head">' + backHtml(d) + '</div>'; }
/* 内容自己声明了返回放在哪（back 控件）：引擎在画之前看一眼（只看视图模型根上能定的条件），声明了就让标题行不取 */
function backPlaced(node, root) {
  if (Array.isArray(node)) return node.some(function (x) { return backPlaced(x, root); });
  if (!node || typeof node !== 'object') return false;
  if (node.when && String(node.when).replace('!', '').indexOf('$.') === 0 && !pvOk(node.when, root, root)) return false;
  if (node.type === 'back') return true;
  return Object.keys(node).some(function (k) { const v = node[k]; return v && typeof v === 'object' && backPlaced(v, root); });
}

/* ───────── 局部重画：外壳按容器分开换 ─────────
   外壳 HTML 在容器拼接的地方带一个标记注释（<!--pk:键-->，见 mountShell / ctKid）：窄栏、侧栏、身体，身体的几个孩子（主区、工作台）。
   画之前把新的一版按标记切开，和上一次画的那一版比：这一段 HTML 没变，就连节点一起留着不动（滚动位置、悬停、正在跑的过渡都不受影响）；
   变了只换这一段，同一个父容器里的其他容器不受牵连。容器里面的内容仍然是一整块 HTML，换的时候一起换。
   投影的层（被盖住 / 切走的页面）仍由 navCapture / navPlace 管：它们本来就不在这次画的东西里 */
const PK = 'pk:';
const SEG = {};   /* 段键 → 上一次画出来的 HTML（不含标记）：这一段有没有变 */
const SHELL = { key: null, el: null, ov: '' };   /* 外壳：容器树的键、根元素、上一次画的浮层 */
function tickless(html) { return typeof html === 'string' ? html.replace(/(<[^>]* data-tick="[^"]*"[^>]*>)[^<]*/g, '$1') : html; }
function segHtml(nodes) { return nodes.map(function (n) {
  if (n.nodeType !== 1) return n.nodeType === 3 ? n.textContent : '';
  /* 已登记的计时文字由节拍更新，不使整段内容过期；实际节点和显示值不动。 */
  if (n.querySelector('[data-tick]')) { n = n.cloneNode(true); n.querySelectorAll('[data-tick]').forEach(function (t) { t.textContent = ''; }); }
  return n.outerHTML;
}).join(''); }
/* 按标记注释把一层的孩子切成几段：{ key, mark, nodes }，nodes 不含标记本身 */
function groupsOf(el) {
  const out = []; let cur = null;
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 8 && n.data.indexOf(PK) === 0) { cur = { key: n.data.slice(PK.length), mark: n, nodes: [] }; out.push(cur); continue; }
    if (cur) cur.nodes.push(n);
  }
  return out;
}
function hasMark(el) {
  for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 8 && n.data.indexOf(PK) === 0) return true;
  return false;
}
/* 属性照新的一版抄，不换元素；运行时锚点名仍由进树机制维护，不因局部更新消失。 */
function syncAttrs(live, next) {
  const cursor = live.style.cursor;   /* 边缘拖动的光标由当前指针维护，内容更新不清掉它。 */
  /* 拖动位置由框架持有；内容声明不清空运行时的位置。 */
  if (live.hasAttribute('data-dragged')) {
    next.setAttribute('data-dragged', '');
    next.style.setProperty('--drag-x', live.style.getPropertyValue('--drag-x'));
    next.style.setProperty('--drag-y', live.style.getPropertyValue('--drag-y'));
  }
  let i, a;
  for (i = 0; i < next.attributes.length; i++) { a = next.attributes[i]; if (live.getAttribute(a.name) !== a.value) live.setAttribute(a.name, a.value); }
  for (i = live.attributes.length - 1; i >= 0; i--) { a = live.attributes[i]; if (a.name !== 'data-aname' && !next.hasAttribute(a.name)) live.removeAttribute(a.name); }
  if (cursor) live.style.cursor = cursor;
}
/* 同一个元素就地改属性、再往下比孩子；返回 false 表示结构不同，交给调用处整块换 */
/* 自己管孩子的组件（data-own="类型"）：引擎只管它在不在、换它自己的属性，不往里比——孩子交给组件登记的更新函数（新旧两份） */
const OWN = {};
function patchEl(live, next) {
  if (!live || !next || live.nodeType !== 1 || next.nodeType !== 1 || live.tagName !== next.tagName) return false;
  const own = next.getAttribute('data-own');
  if (own && live.getAttribute('data-own') === own && OWN[own]) { syncAttrs(live, next); OWN[own](live, next); return true; }
  if (next.hasAttribute('data-kept') && live.getAttribute('data-view') === next.getAttribute('data-view')) return true;   /* 这次没重画的子视图（ctLeaf 交回上一次的结果）：整棵留着，不往里比 */
  /* 输入框的值以渲染为准（和整页重画一样）：输入时值已经写进状态、渲染又画回来，所以不同就是应用改了它（发送后清空、换了对话的草稿）；值一样就不碰（光标不动） */
  if (live.tagName === 'TEXTAREA') { syncAttrs(live, next); const v = next.defaultValue; if (live.defaultValue !== v) live.defaultValue = v; if (live.value !== v) live.value = v; return true; }
  if (live.tagName === 'INPUT') { syncAttrs(live, next); if (live.type === 'checkbox' || live.type === 'radio') { if (live.checked !== next.hasAttribute('checked')) live.checked = next.hasAttribute('checked'); } else if (live.type !== 'file' && live.value !== (next.getAttribute('value') || '')) live.value = next.getAttribute('value') || ''; return true; }
  syncAttrs(live, next);
  patchKids(live, next);
  return true;
}
/* 孩子按身份对着改：有身份的（投影的层、视图、id / data-k 这类键）按身份找原来那个，没身份的按出现顺序找同标签同类名的；
   对上了就地改，对不上的才是新的。被盖住 / 切走的层在新的一版里是槽位（template[data-slot]）：原样留着、在这里盖上（缓存的层不在这里就交给 navPlace 放回）。
   消息和孤岛不就地改：内容一样留着，不一样交给 reuseApply 按版本换。最后由 placeKids 摆：留下的顺序没变就一个都不挪 */
function kidKey(n) {
  if (n.nodeType !== 1) return null;
  if (n.dataset.layer) return 'layer:' + n.dataset.layer + '|' + (n.dataset.lc || '');
  if (n.dataset.view) return 'view:' + n.dataset.view;
  const id = nodeId(n); return id ? 'id:' + id : null;
}
function kidPatch(o, n) {
  if (!o) return n;
  if (o.nodeType === 3 && n.nodeType === 3) { if (o.textContent !== n.textContent) o.textContent = n.textContent; return o; }
  if (o.nodeType === 1 && n.nodeType === 1 && o.tagName === n.tagName && !n.matches(REUSE_SEL) && patchEl(o, n)) return o;
  return o.isEqualNode(n) ? o : n;
}
function patchKids(live, next) {
  if (hasMark(next)) { patchSegs(live, next); return true; }
  const byKey = new Map(), loose = [], plan = [], spots = [];
  Array.prototype.forEach.call(live.childNodes, function (l) {
    if (l._covered) return;
    if (l.nodeType === 1 && l.hasAttribute('data-spot')) { spots.push(l); return; }   /* 看不见的锚点是运行时放进来的，不是画出来的内容：原样留着 */
    const k = kidKey(l); if (k && !byKey.has(k)) byKey.set(k, l); else if (!k) loose.push(l);
  });
  Array.prototype.slice.call(next.childNodes).forEach(function (n) {   /* 拷下来再走：放进页面的新节点会从 next 里挪走 */
    if (n.nodeType === 1 && n.tagName === 'TEMPLATE' && n.hasAttribute('data-slot')) {
      const els = (LAYER_DOM[n.dataset.slot] || []).filter(function (e) { return e._covered && e.parentNode === live; });
      if (!els.length) { plan.push(n); return; }
      els.forEach(function (e) { layerCover(e); plan.push(e); });
      return;
    }
    const k = kidKey(n); let o = null;
    if (k) { o = byKey.get(k) || null; byKey.delete(k); }
    else { const c = n.nodeType === 1 ? n.className : null, i = loose.findIndex(function (l) { return l.nodeType === n.nodeType && (c === null || (l.tagName === n.tagName && String(l.className).split(' ')[0] === String(c).split(' ')[0])); }); if (i >= 0) o = loose.splice(i, 1)[0]; }
    plan.push(kidPatch(o, n));
  });
  placeKids(live, plan.concat(spots));
  return true;
}
/* 按定好的顺序摆孩子（引擎和自己管孩子的组件共用）：先拿掉不用的，再按顺序放；留下的节点顺序没变就一个都不挪 */
function placeKids(live, plan) {
  const use = new Set(plan);
  Array.prototype.slice.call(live.childNodes).forEach(function (c) { if (!use.has(c)) c.remove(); });
  let cursor = live.firstChild;
  plan.forEach(function (n) { if (n === cursor) cursor = cursor.nextSibling; else live.insertBefore(n, cursor); });
}
/* 段的形状：个数、类型、标签名。投影放回层的时候会把 <template data-slot> 换成一个层（或者拿掉），live 那边的形状就和刚画的 HTML 不同了，
   这时不能“整段留着”——照新的一版重画这一层，槽位由 navPlace 再放回去 */
function sameShape(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].nodeType !== b[i].nodeType) return false;
    if (a[i].nodeType === 1 && a[i].tagName !== b[i].tagName) return false;
  }
  return true;
}
/* 按标记切开的几段：没变的留着节点，变了的就地改或整段换；顺序变了只挪节点（moveBefore，不离开文档） */
function patchSegs(live, next) {
  const olds = groupsOf(live), news = groupsOf(next), by = {}, want = {};
  olds.forEach(function (s) { by[s.key] = s; });
  news.forEach(function (s) { want[s.key] = 1; });
  olds.forEach(function (s) { if (!want[s.key]) { s.mark.remove(); s.nodes.forEach(function (n) { n.remove(); }); } });
  let cursor = null;
  news.forEach(function (s) {
    const sig = segHtml(s.nodes), old = by[s.key], anchor = cursor ? cursor.nextSibling : live.firstChild;
    if (old && old.mark !== anchor) { live.moveBefore(old.mark, anchor); old.nodes.forEach(function (n) { live.moveBefore(n, anchor); }); }
    if (old && SEG[s.key] === sig && sameShape(old.nodes, s.nodes)) {   /* 这一段和上次画的一样：节点整个留着 */
      cursor = old.nodes[old.nodes.length - 1] || old.mark;
      return;
    }
    SEG[s.key] = sig;
    const one = old && old.nodes.length === 1 && s.nodes.length === 1 && old.nodes[0].nodeType === 1 && s.nodes[0].nodeType === 1;
    if (one && patchEl(old.nodes[0], s.nodes[0])) {   /* 同一个容器：就地改，只换里面的内容 */
      cursor = old.nodes[0];
      return;
    }
    const nodes = [s.mark].concat(Array.prototype.slice.call(s.nodes));
    nodes.forEach(function (n) { live.insertBefore(n, anchor); });
    if (old) { old.mark.remove(); old.nodes.forEach(function (n) { n.remove(); }); }
    cursor = nodes[nodes.length - 1];
  });
}
/* 记下整棵树里每个段的签名（整页重建之后用） */
function recordSegs(node) {
  if (!node) return;
  if (node.nodeType === 1) {
    const gs = groupsOf(node);
    if (gs.length) gs.forEach(function (s) { SEG[s.key] = segHtml(s.nodes); s.nodes.forEach(recordSegs); });
    else Array.prototype.forEach.call(node.children, recordSegs);
  } else if (node.nodeType === 11) Array.prototype.forEach.call(node.childNodes, recordSegs);
}
/* 浮层共用局部更新：每个弹窗独立分段，提示条与撤销在末段。 */
function paintOverlays(app, ov) {
  if (SHELL.ov === ov) return;
  const t = document.createElement('template'); t.innerHTML = '<div class="overlay-host">' + ov + '</div>';
  const host = app.nextElementSibling;
  if (host) patchEl(host, t.content.firstElementChild);
  else { app.after(t.content); recordSegs(app.nextElementSibling); }
  SHELL.ov = ov;
}

/* 画外壳：同一棵容器树、同一个根元素时只换变了的那几段，别的容器一个节点都不动 */
function mountShell(cls, style, key, pieces, ov) {
  const head = '<div class="' + cls + '" data-c="' + key + '" data-ocontainer="app.regions" style="' + style + '">';
  const body = pieces.map(function (p, i) { return '<!--' + PK + (p.key || '#' + i) + '-->' + projTag(p); }).join('');
  const app = root.firstElementChild;
  if (SHELL.el && SHELL.el === app && app.isConnected && SHELL.key === key) {
    const tpl = document.createElement('template');
    tpl.innerHTML = head + body + '</div>';
    patchEl(app, tpl.content.firstElementChild);
    paintOverlays(app, ov);
    return;
  }
  Object.keys(SEG).forEach(function (k) { delete SEG[k]; });   /* 换了一棵树：上一次的段签名都作废 */
  root.innerHTML = head + body + '</div>';
  SHELL.el = root.firstElementChild; SHELL.key = key; SHELL.ov = null;
  paintOverlays(SHELL.el, ov);
  recordSegs(SHELL.el);
}
/* 容器拼接处的标记（组件库拼身体的几个孩子时用） */
function ctKid(k) { return '<!--' + PK + k.key + '-->' + projTag(k); }

/* 变了什么由渲染自己比出来：谁改的都一样（宿主、数据推送、动作、计时器），调用方只说“画”，不报改了什么。
   - 界面状态（pdlTrack 登记的 S、CS、NAV……）：上一次渲染时的样子，顶层键 → 值，值是对象时连同它的内容（改到多深都算）；
   - 视图模型：每一块画的时候读到的视图模型（vmRead）记下名字、参数、上下文和值；渲染开头按原来的上下文重算一遍，和上次的值比。
   读过变了的东西的块重画，其余交回上一次的一块；第一次渲染（还没有记录）全部画 */
let STATE_SNAP = null;
function stateSnap() {
  const snap = new Map();
  TRACKED.forEach(function (x, raw) { Object.keys(raw).forEach(function (k) { const v = raw[k]; snap.set(x.name + '.' + k, v && typeof v === 'object' ? [v, JSON.stringify(v)] : [v]); }); });
  return snap;
}
function stateChanged(before, after) {
  const out = [];
  after.forEach(function (v, k) { const b = before.get(k); if (!b || b.length !== v.length || (v.length === 2 ? v[1] !== b[1] : v[0] !== b[0])) out.push('~' + k); });   /* 对象比内容（读取器每次给的是新对象，内容一样就是没变） */
  before.forEach(function (_, k) { if (!after.has(k)) out.push('~' + k); });
  return out;
}
/* 读到的应用数据（pdlReads 登记的函数）：键（~vm:类:名字|参数）→ { fn 取现在登记的函数, args, ctx 画它时的上下文, json 值, src 它读到的数据来源 } */
const VM_SEEN = new Map();
function vmJson(v) { try { return JSON.stringify(v); } catch (e) { return null; } }   /* 比不了的值（循环引用）：每次都算变了 */
let VM_REDO = false;   /* 正在重算：里面套着调的别的数据函数不更新记录（不然轮到比它时已经是新值） */
function vmSeen(name, fn, args, v, got) {
  if (!READ_SCOPES.length || VM_REDO) return;
  const k = '~vm:' + name + (args.length ? '|' + vmJson(args) : '');   /* ~ 开头：界面这边的读取，不是要向宿主要的数据来源 */
  readNote(k);
  const src = new Set(); got.forEach(function (r) { if (r[0] !== '~') src.add(r); });
  VM_SEEN.set(k, { fn: fn, at: fn(), args: args, ctx: { tab: PV.tabKey, nav: NAV_CTX }, json: vmJson(v), src: src });
}
function vmChanged() {
  const out = [], tab = PV.tabKey, nav = NAV_CTX, scope = new Set(), own = READ_OWN;
  READ_SCOPES.push(scope); READ_OWN = null; VM_REDO = true;   /* 重算不算哪一块读的 */
  try {
    VM_SEEN.forEach(function (e, k) {
      PV.tabKey = e.ctx.tab; NAV_CTX = e.ctx.nav;
      const f = e.fn(); if (f !== e.at) { out.push(k); return; }   /* 函数换掉了（重新登记）：算变了 */
      const got = new Set(); READ_SCOPES.push(got);
      let v = null; try { v = typeof f === 'function' ? f.apply(null, e.args) : null; } catch (err) { v = null; } finally { READ_SCOPES.pop(); }
      const j = vmJson(v), more = Array.from(got).some(function (r) { return r[0] !== '~' && !e.src.has(r); });   /* 要读的数据来源多了（读回来的数据带出新的依赖）：重画一次，画的时候登记 */
      if (j === null || j !== e.json || more) out.push(k);
    });
  } finally { READ_SCOPES.pop(); READ_OWN = own; VM_REDO = false; PV.tabKey = tab; NAV_CTX = nav; }
  return out;
}
/* 不在页面上的视图模型不再比：画完以后，哪一块都没读的记录拿掉 */
function vmPrune() {
  const live = new Set();
  const add = function (reads) { if (reads) reads.forEach(function (r) { if (r.indexOf('~vm:') === 0) live.add(r); }); };
  Object.keys(CT_PIECE).forEach(function (k) { if (CT_PIECE[k]) add(CT_PIECE[k].reads); });
  add(SHELL_READS); Object.keys(POP_READS).forEach(function (k) { add(POP_READS[k]); });
  VM_SEEN.forEach(function (_, k) { if (!live.has(k)) VM_SEEN.delete(k); });
}
function render(keep) {
  if (!START_BOOT) return;   /* 启动途中的事件、读回来的数据先只改状态，第一屏在 boot 阶段统一画 */
  RENDER_BEFORE.forEach(function (f) { f(keep); });   /* 画之前的钩子先跑：宿主在这里开这一轮的读取集合，重算视图模型时读到的数据来源也登记得上 */
  RENDER_CHANGED = STATE_SNAP ? stateChanged(STATE_SNAP, stateSnap()).concat(vmChanged()) : null;
  try { if (!RENDER_CHANGED || !renderLocal(keep, RENDER_CHANGED)) renderAll(keep); } finally { RENDER_CHANGED = null; STATE_SNAP = stateSnap(); vmPrune(); }
}
/* 定义变了（容器树、插件片段、主题文档）：上一次画的每一块都作废，下一次全部重画 */
let RENDER_GEN = 0;   /* 第几代定义：组件自己留的画法（列表单元）按它作废 */
function renderForget() { Object.keys(CT_PIECE).forEach(function (k) { delete CT_PIECE[k]; }); VM_SEEN.clear(); SHELL_READS = null; RENDER_GEN++; }
/* 浮层（提示条、撤销、弹窗宿主）单独记它读了什么：只碰到它时只重画浮层那一段（paintOverlays），不走整页 */
let OV_READS = null;
function overlaysRead() {
  const reads = new Set(), own0 = READ_OWN; READ_SCOPES.push(reads); READ_OWN = reads;
  try { return overlays(); } finally { READ_SCOPES.pop(); READ_OWN = own0; OV_READS = reads; reads.forEach(function (r) { for (let i = 0; i < READ_SCOPES.length; i++) READ_SCOPES[i].add(r); }); }
}
/* 弹窗里正在填的字段：重画不能把人填的内容冲掉（同一个弹窗、同一个字段 id 原样放回）。
   只留没绑状态的字段（对话框里临时填的）；绑了状态的（data-input / data-change：输入时写进状态、渲染画回来）以渲染为准 */
function popFieldsTake() {
  const popVal = {};
  document.querySelectorAll(':is(' + POP_SEL + ') :is(input:not([type=file]), textarea, select)[id]:not([data-input], [data-change])').forEach(function (el) { popVal[el.closest(POP_SEL).dataset.pop + '#' + el.id] = el.type === 'checkbox' || el.type === 'radio' ? el.checked : el.value; });
  return popVal;
}
function popFieldsPut(popVal) {
  Object.keys(popVal).forEach(function (k) { const i = k.indexOf('#'), host = document.querySelector('[data-pop="' + k.slice(0, i) + '"]'), el = host && host.querySelector('#' + CSS.escape(k.slice(i + 1))); if (!el) return; if (el.type === 'checkbox' || el.type === 'radio') el.checked = popVal[k]; else el.value = popVal[k]; });
}
function renderAll(keep) {
  SETTLE.n++;
  const ae = document.activeElement, fid = ae && ae !== document.body && ae.id ? ae.id : null, fsel = fid && typeof ae.selectionStart === 'number' ? [ae.selectionStart, ae.selectionEnd] : null;   /* 有 id 的元素重画后把焦点还给它（输入框连选区一起） */
  const sc = {}, anchors = {};
  /* 重画前后保持每个滚动区（组件库的 .scroll）的位置：按 所在视图 + 类名 + id + 同类里的第几个 记（被盖住的层不算，它们自己记，见 navCapture）。
     视图里的滚动区：重画后这个视图还在（比如分栏左边的列表，选了一项换了详情），位置就留着；换成别的视图才从头开始 */
  const scKeys = function (sel) { const n = {}; return Array.prototype.filter.call(document.querySelectorAll(sel || '.scroll'), function (el) { return !el.closest('.layer-covered'); }).map(function (el) { const v = el.closest('[data-view]'), b = (v ? v.dataset.view + '|' : '') + el.className.split(' ')[0] + (el.id || ''); n[b] = (n[b] || 0) + 1; return [el, b + ':' + n[b]]; }); };
  const scrolls = scKeys();
  scrolls.forEach(function (x) {
    const el = x[0]; if (!keep && !el.closest(POP_SEL + ', [data-view]')) return;
    sc[x[1]] = el.scrollTop;
    anchors[x[1]] = anchorTake(el);   /* 窗口的锚点：重画前取，重画后同一个滚动区按它还原 */
  });   /* 弹窗里的滚动位置任何重画都留住。 */
  const sxSel = function (el) { const c = el.querySelector(':scope > [aria-selected="true"]'); return c ? c.textContent : null; };
  const sx = {}; scKeys('.scroll-x').forEach(function (x) { if (keep || x[0].closest(POP_SEL + ', [data-view]')) sx[x[1]] = { l: x[0].scrollLeft, sel: sxSel(x[0]) }; });   /* 横向滚动区（标签条、胶囊道）同样留住位置：固定一个标签只把它挪进固定区，条不跟着滚；选中的换了一项才把它滚进视野 */
  const FOC = 'button, input, textarea, select, [tabindex]';
  const pfHost = ae && ae.closest && ae.closest(POP_SEL), pf = pfHost && !fid ? { k: pfHost.dataset.pop, i: Array.prototype.indexOf.call(pfHost.querySelectorAll(FOC), ae) } : null;   /* 弹窗里落在按钮上的焦点（回车要按的那个）也要跟着重画留住 */
  const popVal = popFieldsTake();   /* 不然应用改了值（选中刚建的组）会被旧值盖回去：绑了状态的字段以渲染为准 */
  const shellReads = new Set(), shellOwn = new Set(); READ_SCOPES.push(shellReads); READ_OWN = shellOwn;   /* 外壳、弹窗自己读的（不在任何一块里）：碰到了就得走整页这一遍 */
  let fresh, pieces, ov, cls, style;
  try {
    const t = S.tweaks, bg = bgState();
    space(); ctGridSync();
    fresh = navCapture();   /* 投影：被盖住的层从 DOM 里记下（缓存），这一次要盖住的层记下滚动位置 */
    CT_SHOWN = {}; PROJ_FOCUS = false;
    pieces = projPieces(pdlTree().key); ov = overlaysRead();
    const inflow = pieces.filter(function (x) { return x.col; });
    const hasNav = inflow.some(function (x) { return x.drawer; });
    cls = ['app', hasNav ? '' : 'no-nav', PROJ_FOCUS ? 'occ-focus' : ''].concat(APP_CLASS.map(function (fn) { return fn(); }), [t.lines ? 't-lines' : '', t.sans ? 't-sans' : '', t.compact ? 't-compact' : '', bg.shell ? 'bg-shell' : '']).filter(Boolean).join(' ');
    style = (S.navW ? '--nav-w:' + S.navW + 'px;' : '') + '--app-cols:' + inflow.map(function (x) { return x.col; }).join(' ') + ';--app-cols-n:' + inflow.filter(function (x) { return !x.drawer; }).map(function (x) { return x.col; }).join(' ') + (bg.shell ? ';--shell-img:url(&quot;' + bg.shell + '&quot;);--veil-g:' + bg.g + '%' : '');
  } finally { READ_SCOPES.pop(); READ_OWN = null; }
  SHELL_READS = shellReads; SHELL_OWN = shellOwn;
  const keep0 = reuseNodes();   /* 节点复用：画之前记下现有的消息和孤岛（按树键） */
  RENDERING = true;   /* 换掉整页时，正在编辑的输入框会失焦：这不是用户离开，失焦动作不该触发（见 ui.js） */
  mountShell(cls, style, pdlTree().key, pieces, ov);
  RENDERING = false;
  keptFill();
  const back = navPlace(fresh);   /* 被盖住的层放回原位（隐藏、inert）；重新露出来的层：没过期就换回缓存的节点，过期就用刚画的 */
  popFieldsPut(popVal);
  PAINT_SYNC.forEach(function (f) { f(); });
  scrimSync();
  const popFocused = popSnap();
  if (!popFocused && pf && pf.i >= 0 && S.popOrder[S.popOrder.length - 1] === pf.k) { const host = document.querySelector('[data-pop="' + pf.k + '"]'), el = host && host.querySelectorAll(FOC)[pf.i]; if (el) el.focus(); }
  reuseApply(keep0);
  applyTheme();
  treeFlush();   /* 先让进树钩子（折叠的测量这类会改高度的）跑完：在还没收起的高度上还原，收起后内容就挪走了（先 treeFlush 再还原） */
  const short = [];   /* 还原时内容还不够高（被截短）的滚动区：画完后的钩子补齐内容（读数、测量）后再还原一次 */
  scKeys().forEach(function (x) { const el = x[0], k = x[1]; if (sc[k] != null) { el.scrollTop = sc[k]; if (el.scrollTop < sc[k] - 1) short.push([el, sc[k]]); } });   /* 新画出来的 stick-end 本来就在底部 */
  scKeys('.scroll-x').forEach(function (x) { const o = sx[x[1]]; if (!o || sxSel(x[0]) !== o.sel) return; x[0].scrollLeft = o.l; });
  back();   /* 新的层从头开始；重新露出来的层回到被盖住时的位置 */
  S.justAdded = null;
  [document.scrollingElement, document.body, root.firstElementChild].forEach(function (el) { if (el && el.scrollLeft) el.scrollLeft = 0; });
  if (fid && !popFocused) { const el = document.getElementById(fid), fp = el && el.closest(POP_SEL); if (el && !el.closest('.layer-covered') && (!fp || S.popOrder[S.popOrder.length - 1] === fp.dataset.pop)) { el.focus(); if (fsel) try { el.setSelectionRange(fsel[0], fsel[1]); } catch (e) { /* 某些输入类型不支持选区 */ } } }
  RENDER_AFTER.forEach(function (f) { f(keep); });
  short.forEach(function (x) { if (x[0].isConnected) x[0].scrollTop = x[1]; });
  const restored = scKeys();
  restored.forEach(function (x) { anchorApply(x[0], anchors[x[1]]); ANCHOR.set(x[0], anchorTake(x[0])); });
}

/* ───────── 投影：按容器树画每个容器的栈顶 ─────────
   一块（piece）= 父容器网格里的一项 { html, col 列宽（不在排版里的为空）, drawer 窄屏收成抽屉, layer 它属于哪些底层 }。
   能被覆盖的容器（有子容器）：栈顶是 '@' 时画子容器，否则画覆盖它的那一层；平铺的容器（flat）没有自己的盒子，子容器排在父容器的网格里。
   内置容器的画法登记在 CT_DRAW（窄栏、侧栏、身体、主区、工作台）；没登记的（结构页里加的容器）画成一个盒子 + 入口插槽，空的时候网格把它收掉。 */
const CT_DRAW = {};
let PROJ_FOCUS = false;
/* 按变化重画：每个叶子容器（覆盖层、没有子容器的容器）和页面里的子视图（view 块）画的时候记下它读到的界面状态（~S.键……）和视图模型（~vm:名字），
   和这次画出的一块。渲染开头比出变了的（render），读过的变了的容器重画，没读过的交回上一次的一块——
   和上次一样的段 patchSegs 整段留着，节点（连同局部更新改过的内容）不碰。宿主的数据来源（pdlReadSet 登记的）也记在块名下：没重画的块读的照样算“还需要” */
const CT_PIECE = {};
let RENDER_CHANGED = null, READ_SINK = null;
/* 正在画的每一层都记下这次读取 */
function readNote(key) { for (let i = 0; i < READ_SCOPES.length; i++) READ_SCOPES[i].add(key); if (READ_OWN) READ_OWN.add(key); }
/* 应用每次重画开头拿一个读取集合：往里登记的来源同时记到正在画的容器名下 */
function pdlReadSet() { const set = new Set(), add = set.add; set.add = function (key) { for (let i = 0; i < READ_SCOPES.length; i++) READ_SCOPES[i].add(key); if (READ_OWN) READ_OWN.add(key); return VM_REDO ? set : add.call(set, key); }; READ_SINK = set; return set; }   /* 渲染开头重算时读到的不算“还需要”（重算的里面有已经不在页面上的） */
function readsHit(reads, changed) {
  for (const r of reads) for (let i = 0; i < changed.length; i++) { const c = changed[i]; if (r === c || r.indexOf(c + '.') === 0 || c.indexOf(r + '.') === 0) return true; }
  return false;
}
/* 这次没重画的一块（子视图、自己管孩子的组件里的单元）只画一个壳：开头的标签带 data-kept="键"，里面是空的——不拼、不解析它的 HTML。
   比对时对上了原来那个就整个留着；对不上（外面那层是新的）由 keptFill 按键换回完整的 HTML。键只在这一次渲染里有效 */
const KEPT_HTML = {};
function keptStub(k, html) {
  KEPT_HTML[k] = html;
  const m = /^<(\w+)[^>]*/.exec(html);
  return m[0].replace(/^<\w+/, '$& data-kept="' + h(k) + '"') + '></' + m[1] + '>';
}
const KEPT_RE = /<(\w+) data-kept="([^"]*)"[^>]*><\/\1>/g;
function keptExpand(html) { return html.indexOf(' data-kept="') < 0 ? html : html.replace(KEPT_RE, function (m, tag, k) { return keptExpand(KEPT_HTML[k.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&amp;/g, '&')]); }); }
function keptFill() {
  document.querySelectorAll('[data-kept]').forEach(function (n) {
    const t = document.createElement('template'); t.innerHTML = KEPT_HTML[n.dataset.kept];
    const r = t.content.firstElementChild; Array.prototype.forEach.call(n.attributes, function (a) { if (a.name !== 'data-kept') r.setAttribute(a.name, a.value); });   /* 壳上后来加的（容器键、所属的层）照抄 */
    n.replaceWith(t.content);
  });
  Object.keys(KEPT_HTML).forEach(function (k) { delete KEPT_HTML[k]; });
}
/* 没重画的一块读的来源照样算“还需要”；界面这边的读取（~）只交给外层的记录。
   mine：交上来的是这一块自己的一部分（组件里的列表单元），算它自己读的；子视图交上来的不算 */
function readsReplay(reads, mine) {
  const own = READ_OWN; if (!mine) READ_OWN = null;
  reads.forEach(function (r) { if (r[0] !== '~' && READ_SINK) READ_SINK.add(r); else { for (let i = 0; i < READ_SCOPES.length; i++) READ_SCOPES[i].add(r); if (mine && own) own.add(r); } });
  READ_OWN = own;
}
function ctLeaf(k, sig, draw) {
  const was = CT_PIECE[k];
  const back = JSON.stringify([BACK.page, BACK.detail, BACK.placed]);   /* 外层交下来的返回也是这一块的输入：标题行可能取走了它 */
  if (RENDER_CHANGED && was && was.sig === sig && was.back === back && !readsHit(was.reads, RENDER_CHANGED)) {   /* RENDER_CHANGED 为空数组时什么都不用重画 */
    readsReplay(was.reads);
    was.took.forEach(function (r) { BACK[r] = null; });   /* 上次画的时候取走了外层的返回：这次照样取走，外层不再另画一个 */
    if (was.focus) PROJ_FOCUS = true;
    return typeof was.piece === 'string' ? (/^<div class="vw-view/.test(was.piece) ? keptStub(k, was.piece) : was.piece) : Object.assign({}, was.piece, { html: keptStub(k, was.piece.html) });   /* 只交一个壳：比对时原来那棵整个留着（patchEl） */
  }
  const reads = new Set(), own = new Set(), own0 = READ_OWN, focus0 = PROJ_FOCUS, up = CT_UP.slice(), ctx = { tab: PV.tabKey, nav: NAV_CTX, back: { page: BACK.page, detail: BACK.detail, placed: BACK.placed } };
  READ_SCOPES.push(reads); READ_OWN = own; CT_UP.push(k);
  let x;
  try { PROJ_FOCUS = false; x = draw(); } finally { READ_SCOPES.pop(); READ_OWN = own0; CT_UP.pop(); }
  if (typeof x === 'string' && k.indexOf('view:') === 0) x = x.replace(/^(<[a-zA-Z][^>]*)>/, '$1 data-pv="' + h(k) + '">');   /* 子视图的根带上自己的键：只重画它时按键找到它的节点（有的视图画出来没有视图的外框） */
  const focus = PROJ_FOCUS; PROJ_FOCUS = focus0 || focus;
  reads.forEach(function (r) { for (let i = 0; i < READ_SCOPES.length; i++) READ_SCOPES[i].add(r); });
  const took = ['page', 'detail'].filter(function (r) { return ctx.back[r] && !BACK[r]; });
  const full = typeof x === 'string' ? keptExpand(x) : x && Object.assign({}, x, { html: keptExpand(x.html) });   /* 记下的是完整的一块：里面没重画的子块交的是壳，换回它们的内容（下次整块交回时不缺） */
  CT_PIECE[k] = x ? { sig: sig, back: back, took: took, reads: reads, own: own, up: up, ctx: ctx, draw: draw, focus: focus, piece: full } : null;
  /* 重画出来和上一次一模一样（按时间重算了、显示没变）：当作没变，原来的节点整个留着——不比对，本地展开、滚动这类运行时的状态不受影响 */
  if (RENDER_CHANGED && was && typeof x === 'string' && tickless(full) === tickless(was.piece) && /^<div class="vw-view/.test(full)) return keptStub(k, full);
  return x;
}
/* 只重画子视图（数据推送的快路）：变了的来源只碰到页面上某几个子视图自己读的东西（外壳、容器、弹窗自己都没读）时，
   不走整页那一遍——这几个子视图各自按上次的上下文重画，就地比对进它自己的节点；里面没变的单元照旧留着。
   读取登记照常：画之前的钩子开一份新的读取集合，页面上其余部分读的照旧算“还需要”。外层容器记下的那一块过期了，下次轮到它时重画 */
const CT_UP = [];
function pieceOne(p) { if (p.one == null) { const t = document.createElement('template'); t.innerHTML = p.piece; p.one = t.content.childElementCount === 1; } return p.one; }
let SHELL_READS = null, SHELL_OWN = null;
function renderLocal(keep, changed) {
  if (!keep || !SHELL_READS || readsHit(SHELL_OWN, changed)) return false;
  const hit = Object.keys(CT_PIECE).filter(function (k) { return CT_PIECE[k] && readsHit(CT_PIECE[k].own, changed); });
  const targets = [], pops = Object.keys(POP_READS).filter(function (k) { return readsHit(POP_READS[k], changed); });
  for (const k of hit) {
    const p = CT_PIECE[k];
    if (p.up.some(function (u) { return hit.indexOf(u) >= 0; })) continue;   /* 外层也要重画：由外层带着 */
    if (k.indexOf('view:') !== 0 || typeof p.piece !== 'string' || !pieceOne(p)) return false;   /* 子视图画出来不止一个根（无外框的视图）：按键只找得到第一个，走整页这一遍 */
    const els = Array.prototype.filter.call(document.querySelectorAll('[data-pv="' + CSS.escape(k) + '"]'), function (e) { return !e.closest('.layer-covered'); });
    if (els.length !== 1) return false;   /* 找不到它自己的那个节点（被盖住、同一视图画了几处）：走整页这一遍，没变的照样留着 */
    const host = els[0].closest(POP_SEL);
    if (host) { if (pops.indexOf(host.dataset.pop) < 0) pops.push(host.dataset.pop); continue; }   /* 弹窗里的子视图靠弹窗的上下文画：交给这个弹窗整个刷新 */
    targets.push({ k: k, p: p, el: els[0] });
  }
  const ov = OV_READS && readsHit(OV_READS, changed);
  readsReplay(SHELL_READS);   /* 页面上其余部分读的照旧需要 */
  if (!targets.length && !pops.length && !ov) { applyTheme(); RENDER_AFTER.forEach(function (f) { f(keep); }); return true; }   /* 主题的值（透明度、字号……）是根上的样式变量，不在任何一块里 */   /* 读过变了的东西的一个都没有：什么都不画 */
  SETTLE.n++; RENDERING = true;
  targets.forEach(function (t) {
    const tab = PV.tabKey, nav = NAV_CTX, back = Object.assign({}, BACK); PV.tabKey = t.p.ctx.tab; NAV_CTX = t.p.ctx.nav; Object.assign(BACK, t.p.ctx.back); CT_UP.push.apply(CT_UP, t.p.up);
    try { t.x = ctLeaf(t.k, t.p.sig, t.p.draw); } finally { PV.tabKey = tab; NAV_CTX = nav; Object.assign(BACK, back); CT_UP.length = 0; }
    t.tpl = document.createElement('template'); t.tpl.innerHTML = t.x || '';
  });
  if (targets.some(function (t) { return t.tpl.content.childElementCount > 1; })) { RENDERING = false; return false; }   /* 重画出来不止一个根：换不进它原来那一个节点，走整页这一遍（这几块已经是新的，整页照样认它们变了） */
  const fields = popFieldsTake(), keep0 = reuseNodes();   /* 节点复用（孤岛、组件自己的节点）：和整页那一遍一样，画完内容没变就换回原节点 */
  if (ov) paintOverlays(SHELL.el, overlaysRead());
  targets.forEach(function (t) {
    if (CT_PIECE[t.k] && tickless(CT_PIECE[t.k].piece) === tickless(t.p.piece)) return;   /* 只有会走的字不同（节拍自己更新它）：和上一次一样，节点不碰 */
    if (CT_PIECE[t.k]) CT_PIECE[t.k].reads.forEach(function (r) { SHELL_READS.add(r); });
    t.p.up.forEach(function (u) { if (CT_PIECE[u]) CT_PIECE[u].sig = null; });
    const n = t.tpl.content.firstElementChild; if (!n || !patchEl(t.el, n)) t.el.replaceWith(t.tpl.content);
  });
  RENDERING = false;
  pops.forEach(function (k) { popRead(k, function () { popRefresh(k); }); });   /* 打开、更新、关掉都由 popRefresh 管 */
  keptFill();
  popFieldsPut(fields);
  PAINT_SYNC.forEach(function (f) { f(); });
  scrimSync();
  reuseApply(keep0);
  applyTheme();
  treeFlush();
  RENDER_AFTER.forEach(function (f) { f(keep); });
  return true;
}
function projPieces(k) {
  const n = ctNode(k); if (!n) return [];
  if (ctCoverable(k)) {
    const s = navStack(k), top = s[s.length - 1];
    CT_SHOWN[k] = true;
    if (top.f !== '@') {
      const cover = ctLeaf('cover:' + k, top.id + '|' + top.f, function () { return projCover(k, top); }), slots = projSlots(s.slice(0, -1));
      if (CT_DRAW[k]) return [CT_DRAW[k]([cover].concat(slots), null, true)];
      if (n.flat || k === pdlTree().key) return [cover].concat(slots);
      return [ENGINE_PARTS.ctBox(k, n, [cover].concat(slots), null)];
    }
    const kids = [].concat.apply([], (n.kids || []).map(function (x) { return projPieces(x.key); }));
    if (CT_DRAW[k]) return [CT_DRAW[k](kids, s[0].id, false)];
    if (n.flat || k === pdlTree().key) { kids.forEach(function (x) { x.layer = (x.layer ? x.layer + ' ' : '') + s[0].id; }); return kids; }
    return [ENGINE_PARTS.ctBox(k, n, kids, s[0].id)];
  }
  const s = NAV.st[k], top = s && s[s.length - 1];
  if (top && top.f !== '@' && !(n.pages || n.space || n.tabs)) {   /* 没有子容器的容器也有自己的叠：开着东西就画打开的那一层；有角色的容器（页面、空间、标签）的叠由它自己的组件画 */
    CT_SHOWN[k] = true;
    return [ENGINE_PARTS.ctBox(k, n, [ctLeaf('cover:' + k, top.id + '|' + top.f, function () { return projCover(k, top); })], null)];
  }
  const d = CT_DRAW[k]; let x = ctLeaf('leaf:' + k, '', function () { return d ? d() : ENGINE_PARTS.ctBox(k, n, [], null); });
  if (!x) return [];
  CT_SHOWN[k] = true;   /* 画出来的容器都开得进去：空的、因为空而隐藏的也一样（开了就不空了） */
  if ((x.empty != null ? x.empty : pdlCtEmpty(n)) && n.hideEmpty && !S.editLayout) {   /* 没有内容时隐藏（容器的开关）：节点还在（落点、选中描边按 data-c 找它），不占地方；编辑布局时照画，好往里放 */
    x = Object.assign({}, x, x.col ? { col: '0' } : {}); x.html = x.html.replace(/^(<[a-z]+)/, '$1 hidden');
  }
  if (!x.bare && !/^<[a-z]+[^>]* data-c="/.test(x.html)) x.html = x.html.replace(/^(<[a-z]+)/, '$1 data-c="' + k + '"');   /* 容器的根元素带它的键（触发处的容器链从这里读） */
  return [x];
}
/* 每一块的 HTML 带上它属于的底层（data-layer，可以有几个：窗口的底层、外壳的底层……） */
function projTag(x) {
  if (!x.layer) return x.html;
  const m = /^<[^>]*>/.exec(x.html), head = m ? m[0] : '';
  if (/ data-layer="/.test(head)) return head.replace(/ data-layer="([^"]*)"/, function (_, had) { return ' data-layer="' + had + ' ' + x.layer + '"'; }) + x.html.slice(head.length);
  return x.html.replace(/^(<[a-z]+)/, '$1 data-layer="' + x.layer + '"');
}
/* 被盖住的层：先放一个占位，画完换成缓存的节点（navPlace） */
function projSlots(ls) { return ls.filter(function (l) { return LAYER_DOM[l.id]; }).map(function (l) { return { key: 'layer:' + l.id, html: '<template data-slot="' + l.id + '"></template>', col: '' }; }); }
/* 覆盖一个容器的那一层：页面或插件界面框；声明了 focus 的有遮罩 */
function projCover(c, l) {
  const fr = navNodeOf(l);
  if (fr && fr.focus) PROJ_FOCUS = true;
  const html = navWith(c, l, function () { const bk = navBackOf(c); return backIn(bk ? bk.role : 'page', bk, function () { return ENGINE_PARTS.layerExit(c, l) + projFrame(l); }); });
  /* 覆盖层的面就是主窗口的面：同一张全局图 + 页面容器的不透明度（--bg-veil），不是另一种不透明的底。
     面（底色 + 背景图）画在容器上，滚动层在它里面：滚动的边缘渐隐透出的是容器自己的面，不是后面外壳的背景图 */
  return { key: 'cover:' + c, html: '<section class="cover' + (fr && fr.focus ? ' occ' : '') + '" data-bg-owner="' + h(ctPages()) + '" data-layer="' + l.id + '" data-lc="' + h(c) + '"' + (fr ? ' data-occ="' + h(l.f.slice(5)) + '"' : '') + '><div class="scroll cover-in"' + ctGridAttr(c) + '>' + html + '</div></section>', col: 'minmax(0, 1fr)' };
}
/* 一层的内容：页面（路由）或插件界面框（它声明的路由） */
function projFrame(l) { const nd = navNodeOf(l); if (nd && nd.type !== 'frame') return pdlView(l.f.slice(5)); const r = navRouteOf(l); return r && PAGES[r] ? PAGES[r]() : ''; }   /* 帧声明了视图就画视图，否则是路由对应的页面 */
/* 画之前：记下 DOM 里每一层（缓存）；这一次要被盖住的层记下滚动位置（它的滚动区和它所在的滚动容器）。返回新出现的层 */
function navVisible() {
  const out = {};
  const walk = function (k) {
    const n = ctNode(k); if (!n) return;
    if (CT_DRAW[k] && CT_DRAW[k].hidden && CT_DRAW[k].hidden()) return;   /* 容器的画法说它这次被盖住（hidden）：它的层不算看得见，按盖住的层收起、露出来时还原 */
    if (ctCoverable(k)) { const top = navTop(k); out[top.id] = 1; if (top.f === '@') (n.kids || []).forEach(function (x) { walk(x.key); }); return; }
    if (n.tabs) { const ts = navTabs(k); if (ts.open) ENGINE_PARTS.tabVisible(k).forEach(function (x) { if (x) out[navTop(navTabKey(k, x)).id] = 1; }); return; }
    if (n.pages) out[navTop(k).id] = 1;
  };
  walk(pdlTree().key); return out;
}
function navLive() { const ids = {}; Object.keys(NAV.st).forEach(function (c) { NAV.st[c].forEach(function (l) { ids[l.id] = l; }); }); Object.keys(NAV.kept).forEach(function (c) { navKeptLayers(c).forEach(function (l) { ids[l.id] = l; }); }); return ids; }   /* 留着的兄弟（切走的栈）也活着 */
/* 一层里的滚动区按键认（id + 类名 + 同键的第几个），不按下标：重画以后多一个少一个滚动区（折叠、代码块）不会对错位置 */
function layerScrollKeys(el) { const n = {}; return Array.prototype.map.call(el.querySelectorAll('.scroll'), function (x) { const b = (x.id || x.dataset.covid || '') + '|' + x.className.split(' ')[0]; n[b] = (n[b] || 0) + 1; return [x, b + ':' + n[b]]; }); }
function layerScroll(el) { const host = el.parentElement && el.parentElement.closest('.scroll'), inner = {}; layerScrollKeys(el).forEach(function (x) { inner[x[1]] = x[0].scrollTop; }); return { host: host ? host.scrollTop : 0, inner: inner, self: el.scrollTop }; }
function layerScrollSet(el, r) {
  if (!r) return;
  treeFlush();   /* 露出来的层也一样：进树钩子（量过的高度、折叠）先落定再还原 */
  const host = el.parentElement && el.parentElement.closest('.scroll'); if (host) host.scrollTop = r.host;
  el.scrollTop = r.self || 0;
  layerScrollKeys(el).forEach(function (x) { if (r.inner[x[1]] != null) x[0].scrollTop = r.inner[x[1]]; });
}
/* 被盖住的层不占 id（文档里同一个 id 只属于看得见的那一层）：盖住时收起，露出来时放回 */
function layerIds(el, on) {
  [el].concat(Array.prototype.slice.call(el.querySelectorAll(on ? '[data-covid]' : '[id]'))).filter(function (x) { return !on || !x.closest('.layer-covered'); }).forEach(function (x) {
    if (on && x.dataset.covid) { x.id = x.dataset.covid; delete x.dataset.covid; } else if (!on && x.id) { x.dataset.covid = x.id; x.removeAttribute('id'); }
  });
}
function layerCover(e) { e.classList.add('layer-covered'); e.inert = true; layerIds(e, false); }
function navCapture() {
  const vis = navVisible(), live = navLive(), found = {};
  document.querySelectorAll('[data-layer]').forEach(function (el) {
    el.dataset.layer.split(' ').forEach(function (id) { (found[id] = found[id] || []).push(el); if (!vis[id] && !el._covered) { el._sc = layerScroll(el); el._covered = true; } });
  });
  const had = Object.assign({}, LAYER_DOM);
  Object.keys(found).forEach(function (id) { LAYER_DOM[id] = found[id]; });
  Object.keys(LAYER_DOM).forEach(function (id) { if (!live[id]) delete LAYER_DOM[id]; });
  return function (id) { return !had[id]; };
}
/* 一层的版本：画出它时的 HTML，里面的可复用节点（消息、孤岛）只留壳——它们各自有版本、自己局部更新（节点复用）；
   层的版本只看它们以外的部分（筛选、查询、选中这类界面状态），也不含输入框里的字。切走时没重画就改了的界面状态，回来时版本不同 = 过期 */
function layerVer(el) { const c = el.cloneNode(true); c.querySelectorAll(REUSE_SEL).forEach(function (n) { n.replaceChildren(); }); c.querySelectorAll('textarea').forEach(function (n) { n.textContent = ''; }); c.querySelectorAll('input').forEach(function (n) { n.removeAttribute('value'); });
  /* 运行时的打扮不算版本：锚点名、刻度的“在视口里”、复制后的一闪、折叠量出来的记号都是画完之后加上去的，
     留着的层带着它们、刚画出来的一版还没有——不剥掉的话，切走再回来会被当成“界面状态变了”，换掉整个层 */
  [c].concat(Array.prototype.slice.call(c.querySelectorAll('*'))).forEach(function (n) { n.removeAttribute('data-aname'); n.removeAttribute('data-vis'); n.removeAttribute('data-copied'); n.removeAttribute('data-foldable'); if (n.classList && n.classList.contains('arrive')) n.classList.remove('arrive'); });
  c.querySelectorAll('[data-tick]').forEach(function (n) { n.textContent = ''; });   /* 会走的字（节拍钟每拍写一次，core.js tickSync）不是界面状态 */
  return c.outerHTML; }   /* 输入框里的东西是用户的，节点本身就是它的来源（留着的节点原样带着） */
/* 画之后：占位换成缓存的节点（盖住：隐藏 + inert）；重新露出来的层（缓存的节点是被盖住的）没过期就换回缓存的节点、过期就留着刚画的，
   都回到被盖住时的滚动位置；新出现的层从头开始。返回一个在恢复完通常的滚动位置之后执行的函数 */
function navPlace(isFresh) {
  const live = navLive(), vis = navVisible(), later = [];
  document.querySelectorAll('template[data-slot]').forEach(function (tp) {
    const els = (LAYER_DOM[tp.dataset.slot] || []).filter(function (e) { return e._covered && !e.contains(tp); });   /* 槽位在缓存的层自己里面（这一层就是刚放回来的那个）：不能拿它去换自己里面的占位 */
    els.forEach(layerCover);
    if (els.length) tp.replaceWith.apply(tp, els); else tp.remove();
  });
  const sig = function (e) { return Array.prototype.map.call(e.querySelectorAll('[data-layer]'), function (x) { return x.dataset.layer; }).join(','); };
  document.querySelectorAll('[data-layer]').forEach(function (el) {
    if (!el.isConnected || el.classList.contains('layer-covered') || el.closest('.layer-covered')) return;
    const ids = el.dataset.layer.split(' ');
    ids.forEach(function (id) {
      const cache = LAYER_DOM[id], l = live[id];
      const ver = el.dataset.lc && navKeeps(el.dataset.lc) ? layerVer(el) : null;   /* 会被切走的层（页面容器的）：记下画出它时的版本 */
      if (!cache || !l) { el._v = ver; if (isFresh(id)) later.push(function () { const host = el.parentElement && el.parentElement.closest('.scroll'); if (host && el.dataset.lc) host.scrollTop = 0; }); return; }
      const old = cache.find(function (c) { return c._covered && c !== el && (c.dataset.c || '') === (el.dataset.c || '') && c.dataset.layer === el.dataset.layer; });
      if (!old) { el._v = ver; return; }
      const stale = l.v !== DATA_VER || sig(old) !== sig(el) || (ver != null && old._v != null && old._v !== ver);   /* 切走时没重画就改了的界面状态（筛选、查询……）：版本不同也算过期 */
      if (stale) el._v = ver;
      const r = old._sc;
      if (stale) { later.push(function () { layerScrollSet(el, r); }); }
      else { old.classList.remove('layer-covered'); old.inert = false; old._covered = false; old.querySelectorAll('[data-layer]').forEach(function (x) { if (x.dataset.layer.split(' ').every(function (i) { return vis[i]; })) { x._covered = false; x.classList.remove('layer-covered'); x.inert = false; } }); layerIds(old, true); el.replaceWith(old); later.push(function () { layerScrollSet(old, r); }); }
      old._covered = false; l.v = undefined;
    });
  });
  return function () { if (later.length) treeFlush(); later.forEach(function (f) { f(); }); };   /* 先让进树钩子（折叠的测量这类会改高度的）跑完，再回到原来的滚动位置 */
}

/* 容器网格：结构里每个容器声明 grid { cols, gap, gutter }；引擎把它写成一份样式（--g-n / --g-gap / --g-pad），容器的盒子带 data-grid="键"。
   窗口的网格写在根上（弹窗、浮层在窗口里）。主题文档里的结构没有 grid 时，内置容器用默认结构的声明。列宽、占几列由组件库的 CSS 算（core.css 容器网格） */
let CT_GRID_CSS = '', CT_GRID_EL = null;
function ctGridOf(n) { if (n.grid) return n.grid; let d = null; pdlTreeWalk(PDL_LAYOUT.tree, function (x) { if (x.key === n.key) d = x.grid; }); return d; }
function ctGridSync() {
  const out = [];
  pdlTreeWalk(pdlTree(), function (n, p) { const g = ctGridOf(n); if (!g) return; out.push((p ? '[data-grid="' + n.key + '"]' : ':root') + ' { --g-n: ' + (+g.cols || 1) + '; --g-gap: var(--sp-' + (g.gap || 'xl') + '); --g-pad: ' + (g.gutter ? 'var(--gutter-' + g.gutter + ')' : '0px') + '; }'); });
  out.push(ENGINE_PARTS.ctSurfaceCss());
  const css = out.join('\n'); if (css === CT_GRID_CSS) return; CT_GRID_CSS = css;
  if (!CT_GRID_EL) { CT_GRID_EL = document.createElement('style'); document.head.appendChild(CT_GRID_EL); }
  CT_GRID_EL.textContent = css;
}
function ctGridAttr(k) { return ' data-grid="' + h(k) + '"'; }
function rtCfg(r) { return (pdlLayout().regions[r] || {}).chrome || {}; }
/* ───────── 标签式容器─────────
   会话状态只存一份（proj.js 的 NAV.tabs[r]：打开的项、固定、预览、并排）；当前项是容器 r 自己那一栈的栈顶，
   每一项有自己的栈（项里的下钻、返回 / 前进）；没显示的项留在 DOM 里（盖住、过期、露出来时重画）。
   组件库（library/shell.js 的标签式容器组件）把同一份数据画成三种视图：标签条（rtChrome）、收起的竖条（rtStripe）、全部标签（rtOverflow），菜单 / 菜单条 / 把手的状态也在那里。
   区域的拥有方只绑定面板、标题、图标、徽标（rtBind）。 */
function rtHome(r) { return (rtCfg(r).home || {}).key; }
function rtTabs(r) { return navTabs(r).list; }
function rtTab(r, k) { return rtTabs(r).find(function (t) { return t.k === k; }); }
function rtHas(r, k) { return k === rtHome(r) || !!rtTab(r, k); }
function rtKeys(r) { return [rtHome(r)].concat(rtTabs(r).map(function (t) { return t.k; })).filter(Boolean); }
function rtEnsure(r, k, preview) {
  if (!k || rtHas(r, k)) return;
  const tabs = rtTabs(r);
  if (preview) { const i = tabs.findIndex(function (t) { return t.preview; }); if (i >= 0) { navDrop(NAV.st[navTabKey(r, tabs[i].k)] || []); delete NAV.st[navTabKey(r, tabs[i].k)]; tabs.splice(i, 1, { k: k, preview: true }); return; } }   /* 预览标签被下一个预览替换 */
  tabs.push({ k: k, preview: !!preview });
}
/* 显示一项（标签条上点它、竖条、程序打开）：切换——容器的栈换成这一项，没有返回；容器收起着就展开 */
function rtShow(r, k) { const ts = navTabs(r); ts.open = true; if (navTabCur(r) !== k) { NAV.st[r] = [navLayer(k)]; NAV.fwd[r] = []; } const b = REGION_TABS[r]; if (b && b.afterSwitch) b.afterSwitch(k); }
/* 打开一项：从这个容器里的另一项点过来（触发处在容器里 = 容器是它的祖先）→ 压栈，有返回；从外面 → 切换。view：直接落在那一项的某个分视图（换掉那一项的栈顶参数） */
function rtOpen(r, k, o) {
  o = o || {};
  rtEnsure(r, k, o.preview); const ts = navTabs(r);
  if (o.args) { const sk = navTabKey(r, k); navStack(sk); navReplace(sk, null, Object.assign({}, navTop(sk).a, o.args)); }
  const chain = trigChain(o.from === undefined ? ACT_FROM : o.from).chain, cur = navTabCur(r);
  if (ts.open && cur && cur !== k && chain.indexOf(r) >= 0 && chain.indexOf(navTabKey(r, cur)) >= 0) { navTop(r).t = REGION_TABS[r].title(cur); NAV.st[r].push(navLayer(k)); NAV.fwd[r] = []; ts.open = true; const b = REGION_TABS[r]; if (b.afterSwitch) b.afterSwitch(k); }
  else rtShow(r, k);
}
/* 容器 r 现在显示的项（收着时为空） */
function rtCur(r) { return navTabs(r).open ? navTabCur(r) : null; }
/* 打开标签式容器 r 的一项（入口、open { panel }、程序打开）：从容器里的另一项点过来 = 压进容器的栈（有返回）；从外面 = 切换（rtOpen）。
   盖着容器的投影层（比如盖住身体的成员详情）先离开。容器属于声明了 panel 的空间：在别的空间打开它的内容时切到那个空间。
   区域的通用动作：区域名来自声明（容器树的 tabs、入口 / 插件界面框的 region），引擎不认哪个区域 */
function rtReveal(r, k, o) {
  const from = ACT_FROM;
  navLeave(navCoveringIds(r), function () {
    navUncover(r);
    rtOpen(r, k, Object.assign({ from: from }, o || {})); S.menu = null;
    const ps = panelSpace(); if (space() !== ps) { S.space = ps; if (!inPanelSpace(S.route)) { go(PDL_SPACES[ps].home); return; } }
    render(true);
  });
}
/* 开进标签式容器的内容（proj.js 的 navOpen，目标是标签式容器且看得见）：绑定方把内容换成一项，作为预览项打开 */
function rtOpenContent(r, o, t) { const b = REGION_TABS[r], k = b.content ? b.content(o.f, o.a) : o.f; if (b.exists(k)) rtOpen(r, k, { from: t, preview: true }); }
function rtClose(r, k) {
  const ts = navTabs(r), tabs = ts.list, i = tabs.findIndex(function (t) { return t.k === k; }); if (i < 0) return;
  tabs.splice(i, 1);
  navDrop(NAV.st[navTabKey(r, k)] || []); delete NAV.st[navTabKey(r, k)];
  const was = navTabCur(r);
  NAV.st[r] = (NAV.st[r] || []).filter(function (l) { return l.f !== k; });   /* 访问栈里去掉这一项（返回不会回到关掉的项） */
  if (was === k || !NAV.st[r].length) { const n = tabs[i] || tabs[i - 1]; rtShow(r, n ? n.k : rtHome(r)); }
}
/* 固定的标签永远在最左边（像浏览器的固定标签）；拖动随时可以（容器声明了顺序存在哪，data-order-act），但固定的只在固定的里面换、没固定的只在没固定的里面换——
   跨过边界放下会回到自己那一段（固定 / 取消固定用图钉，不靠拖）。固定标签的先后就是固定的先后（组件库记着，菜单和菜单条也按它排）：拖固定的标签改的是它 */
function tabPinned(r, k) { return ENGINE_PARTS.tabPinned(r, k); }   /* 这一项固定了没有（固定只有一份，组件库管着；应用经这里读） */
function rtNormalize(ts, r) {
  const pins = ENGINE_PARTS.tabPins(r);   /* 固定和开着是两件事：开着的固定项排在最左、按固定的先后；固定的也能关 */
  const pin = function (t) { return pins.indexOf(t.k) >= 0; }, p = ts.list.filter(pin).sort(function (x, y) { return pins.indexOf(x.k) - pins.indexOf(y.k); }), u = ts.list.filter(function (t) { return !pin(t); });
  p.forEach(function (t) { t.preview = false; });   /* 固定只有一份（组件库管着、会记住）：标签条、竖条、菜单都读它 */ ts.list.splice.apply(ts.list, [0, ts.list.length].concat(p, u));
}
beforeRender(function () { Object.keys(REGION_TABS).forEach(function (r) { rtNormalize(navTabs(r), r); }); });   /* 固定是用户记着的偏好：每次画之前让开着的固定标签按它排（启动时也对） */
/* 关掉一批标签（关其他 / 关全部未固定）能撤回：撤回 = 标签列表、当前项回到原样（各自的栈从头开始） */
function rtCloseMany(r, which, text) {
  const ts = navTabs(r), before = JSON.stringify(ts.list), cur = navTabCur(r);
  const gone = rtTabs(r).filter(which); if (!gone.length) return;
  gone.forEach(function (t) { rtClose(r, t.k); });
  if (rtHas(r, cur)) rtShow(r, cur); else rtShow(r, rtHome(r));
  undoShow({ text: text, undo: function () { ts.list.splice.apply(ts.list, [0, ts.list.length].concat(JSON.parse(before))); rtShow(r, cur); } });
}
/* 区域标签只有一个动作（tab）：op 是 TAB_OPS 里的名字。引擎这里只有通用的标签栈：show | close | pin | order；
   标签式容器组件自己的操作（全部标签、并排、批量关闭、菜单的固定……）由组件库登记进同一张表（library/shell.js）。
   变化本身就是反馈（标签出现、消失、图钉亮起），不弹提示；能撤回的给撤销提示 */
const RT_CLOSED = [];   /* 关掉一项之后（组件登记 fn(区域)：比如标签关光了，自己的弹窗跟着收起） */
const TAB_OPS = {
  show: function (d, r) { if (d.k !== navTabCur(r) || !navTabs(r).open) { rtShow(r, d.k); render(true); } },
  /* 关一个标签：直接关，不给提示（标签消失本身就是反馈，再开从菜单点一下就行）；批量关仍能撤回（rtCloseMany） */
  close: function (d, r) { const sk = navTabKey(r, d.k); navLeave(NAV.st[sk] ? NAV.st[sk].map(function (l) { return l.id; }) : [], function () {
    rtClose(r, d.k); RT_CLOSED.forEach(function (f) { f(r); });
    render(true);
  }); },
  pin: function (d, r) { const t = rtTab(r, d.k); if (!t) return; ENGINE_PARTS.tabPin(r, d.k); t.preview = false; rtNormalize(navTabs(r), r); render(true); },
  order: function (d, r) {
    const ts = navTabs(r), keys = d.keys || [], moved = ts.list.filter(function (t) { return keys.indexOf(t.k) >= 0; }).sort(function (a, b) { return keys.indexOf(a.k) - keys.indexOf(b.k); });
    let i = 0; ts.list.forEach(function (t, j) { if (keys.indexOf(t.k) >= 0) ts.list[j] = moved[i++]; });   /* 只重排拖动的那一段里出现的标签，其余原地不动 */
    ENGINE_PARTS.tabPinOrder(r, ts.list.filter(function (t) { return ENGINE_PARTS.tabPinned(r, t.k); }).map(function (t) { return t.k; }));
    rtNormalize(ts, r); render(true);
  }
};
/* 没写区域的：容器树里声明了 tabs 的那个容器 */
A.tab = function (d) { TAB_OPS[d.op](d, d.r || ctRole('tabs')); };
/* 预览标签：双击它变成正式标签（像浏览器 / 编辑器的预览标签）；标签的字从斜体变正常就是反馈 */
document.addEventListener('dblclick', function (e) {
  const el = e.target.closest && e.target.closest('[data-rt-tab]'); if (!el) return;
  const r = el.dataset.r, t = rtTab(r, el.dataset.rtTab); if (t && t.preview) { t.preview = false; render(true); }
});
/* 一项的内容：这一项自己的栈深于 1（项里下钻了）→ 详情的返回，回到上一层；否则容器的栈深于 1（从别的项点过来）→ 页的返回，回到那一项。
   项的标题是视图里返回的默认名字 */
function rtBody(r, k, fn, stack) {
  const b = REGION_TABS[r], sk = stack || navTabKey(r, k), cur = !stack && k === navTabCur(r);
  const sub = !stack && navDepth(sk) > 1 ? navBackOf(sk, b.title(k)) : null, from = !sub && cur ? navBackOf(r) : null, prevT = PV.ctTitle, prevK = PV.tabKey;
  PV.ctTitle = b.title(k); PV.tabKey = k;
  try { return backIn('detail', sub, function () { return backIn('page', from, fn); }); } finally { PV.ctTitle = prevT; PV.tabKey = prevK; }
}
/* 预览窗：居中、可拖动、点外面关闭（内容是一个视图） */
/* 返回 / 前进（引擎唯一的一处）：出栈 / 压回，离开前过未保存确认（proj.js） */

function wsTitle(k) { return (PANEL_VIEWS[k] || [k])[0]; }
/* 浮窗的盒子（非模态、内容会滚）：面和滚动分两层（阴影画在外层，滚动和渐隐在里层）。样式类由登记弹窗的一方给（锚在哪、多宽是那个类的事），内容是视图 */
function popPanel(cls, label, body) { return ENGINE_PARTS.float({ cls: cls, label: label, body: body }); }   /* 浮层的壳是组件库的（floatHtml），引擎只转交 */
