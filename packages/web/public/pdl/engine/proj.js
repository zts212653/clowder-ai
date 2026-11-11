/* 边界：引擎只放机制与时机，不认任何具体名字、不为单个位置打补丁 */
/* 投影引擎：运行时状态、三个动作、生效目标、覆盖层级、被盖住的层。这里只有状态和规则，没有画法（画在 frame.js 的 render）。
   三样东西分开：
   - PDL：静态的完整描述——容器树（pdlTree，主题文档里）和哪种内容开到哪个容器；
   - 运行时状态：一个小的、可序列化的对象 NAV——每个容器一栈 { f 帧, a 参数 }、弹窗栈、焦点；
   - 数据：store / 接口。
   渲染 = project(PDL, NAV, 数据)：每个容器画它栈顶的那一层。被盖住的层留在 DOM 里（content-visibility: hidden + inert），DOM 就是缓存；
   数据变了它们记成过期，重新露出来时重画一次；出栈的层销毁；每栈最多 NAV_CAP 层，超出时最早被盖住的那层被逐出。
   从外面切换一个容器（换空间、窄栏 / 侧栏里的页面入口）是隐藏不是销毁：切走的栈是兄弟（NAV.kept），切回来原样回来。
   引擎不认容器、页面、面板的名字：容器的角色都是容器树上的声明（pages / space / tabs / cover）。 */
'use strict';
const NAV = pdlTrack({ st: {}, fwd: {}, tabs: {}, pop: [], focus: null, seq: 0, kept: {}, spLast: {}, on: {} }, 'NAV');   /* on[容器]：和它的孩子并排打开的节点（beside） */   /* 导航也是界面状态：读过它的块在它变了时重画 */   /* kept[容器]：被切走的兄弟（从外面切换掉的栈，留着）；spLast[空间]：离开这个空间时它的页面（回来时回到这里） */
const NAV_CAP = 5;
let DATA_VER = 0;
const LAYER_DOM = {};    /* 层 id → 它在 DOM 里的元素（缓存，不进状态） */
let NAV_CTX = null;      /* 正在画的那一层（S.route / S.param 在画它时读它的帧和参数） */

/* ───────── 容器树（PDL 的声明） ───────── */
function ctNodes() { const out = {}; const walk = function (n, p) { out[n.key] = { n: n, p: p }; (n.kids || []).forEach(function (k) { walk(k, n.key); }); }; walk(pdlTree(), null); return out; }
function ctNode(k) { const x = ctNodes()[k]; return x ? x.n : null; }
function ctParent(k) { const x = ctNodes()[k]; return x ? x.p : null; }
/* 从 k 往上到根（含 k 本身） */
function ctAnc(k) { const all = ctNodes(), out = []; for (let c = k; c && all[c]; c = all[c].p) out.push(c); return out; }
/* 按声明找角色：页面容器（空间的页面在它的栈里）、空间容器（第二栏）、标签式容器 */
function ctRole(prop) { const all = ctNodes(); return Object.keys(all).find(function (k) { return !!all[k].n[prop]; }) || null; }
function ctPages() { return ctRole('pages'); }
function ctSpaceC() { return ctRole('space'); }
/* 能被覆盖的容器 = 有子容器的容器：它的底层是“画它的子容器”（'@'），覆盖它的内容压在上面 */
function ctCoverable(k) { const n = ctNode(k); return !!(n && n.kids && n.kids.length); }
/* 覆盖层级：容器树上的容器键（由内到外）。默认层级是容器声明的 cover（主题 PDL 里的属性，比如身体容器 cover: 身体） */
function ctLevels() { const all = ctNodes(); return Object.keys(all).filter(function (k) { return ctCoverable(k) || all[k].n.pages; }); }

/* ───────── 栈 ───────── */
function navId() { NAV.seq += 1; return 'L' + NAV.seq; }
function navLayer(f, a) { return { id: navId(), f: f, a: a || {} }; }
function navBase(c) {
  if (ctCoverable(c)) return navLayer('@');
  if (c === ctPages()) return navLayer(startRoute());
  if (c === ctSpaceC()) return navLayer(routeSpace(startRoute()));
  const r = navTabOf(c); if (r) return navLayer(r.k);
  const n = ctNode(c); if (n && n.tabs) return navLayer(rtHome(c));
  return navLayer('@');
}
function navStack(c) { if (!NAV.st[c] || !NAV.st[c].length) NAV.st[c] = [navBase(c)]; return NAV.st[c]; }
function navTop(c) { const s = navStack(c); return s[s.length - 1]; }
function navDepth(c) { return navStack(c).length; }
/* 标签式容器里一项的栈键：容器 + '/' + 项 */
function navTabKey(r, k) { return r + '/' + k; }
function navTabOf(c) { const i = String(c).indexOf('/'); return i > 0 ? { r: c.slice(0, i), k: c.slice(i + 1) } : null; }
/* 一层开的是哪个节点（node:<id>，视图或独立页面）；页面层不是 */
function navNodeOf(l) { return l && String(l.f).indexOf('node:') === 0 ? PDL_VIEWS[l.f.slice(5)] || null : null; }
/* 一层是不是页面（帧是路由），开的是节点时取它声明的路由 */
function navRouteOf(l) {
  if (!l || l.f === '@') return null;
  if (String(l.f).indexOf('node:') === 0) { const nd = navNodeOf(l); return nd && nd.route ? nd.route : null; }
  return PAGES[l.f] ? l.f : null;
}

/* ───────── 焦点：最外面一个盖着的投影层；没有就是页面容器的栈顶。S.route / S.param 读它（画某一层时读那一层） ───────── */
function navCovers() { return ctLevels().filter(ctCoverable).sort(function (a, b) { return ctAnc(a).length - ctAnc(b).length; }); }   /* 由外到内 */
function navFocusC() {
  const cs = navCovers();
  for (let i = 0; i < cs.length; i++) if (navTop(cs[i]).f !== '@') return cs[i];
  return ctPages();
}
/* 正在画的那一层是页面就读它；标签式容器里的层是容器的项（键可能和某个页面同名，比如工作台的 home），不是页面 */
function navRouteLayer() { if (NAV_CTX && navRouteOf(NAV_CTX.l) && !(String(NAV_CTX.c).split('/')[0] in REGION_TABS)) return NAV_CTX.l; return navTop(navFocusC()); }
Object.defineProperty(S, 'route', { configurable: true, get: function () { return navRouteOf(navRouteLayer()); }, set: function () {} });
Object.defineProperty(S, 'param', { configurable: true, get: function () { const l = navRouteLayer(); return l && l.a.p != null ? l.a.p : null; }, set: function () {} });
Object.defineProperty(S, 'space', { configurable: true, get: function () { return ctSpaceC() ? navTop(ctSpaceC()).f : null; }, set: function (v) { if (v && ctSpaceC()) { const t = navTop(ctSpaceC()); if (t.f !== v) { const b = (NAV.st[ctPages()] || [])[0]; if (b) NAV.spLast[t.f] = { f: b.f, a: b.a }; NAV.st[ctSpaceC()] = [navLayer(v)]; } } } });   /* 换空间：记下离开的空间停在哪一页（它的层留着，见 navHide） */
Object.defineProperty(S, 'popOrder', { configurable: true, get: function () { return NAV.pop; }, set: function (v) { NAV.pop = v; } });
/* 画一层时：把它设成当前的那一层（页面读 S.route / S.param / navArg） */
function navWith(c, l, fn) { const prev = NAV_CTX; NAV_CTX = { c: c, l: l }; try { return fn(); } finally { NAV_CTX = prev; } }
/* 当前这一层的参数（视图模型读它：下钻到哪一项、分视图是哪个）。不在画的时候，读焦点那一层 */
function navArg(k, c) { const l = c ? navTop(c) : NAV_CTX ? NAV_CTX.l : navTop(navFocusC()); return l && l.a ? l.a[k] : undefined; }

/* ───────── 触发元素的容器链（从 DOM 读：层 data-lc、容器 data-c、视图里的分栏 data-ct），再接上容器树的祖先 ───────── */
function trigChain(t) {
  const inner = []; let c0 = null, lc = null;
  for (let e = t && t.closest ? t : null; e && e !== document.body; e = e.parentElement) {
    const d = e.dataset || {};
    if (d.ct && !lc) inner.push(d.ct);
    if (d.lc && !lc) { lc = d.lc; inner.push(d.lc); }
    if (d.c) { c0 = d.c; break; }
  }
  if (!c0 && t && t.closest && t.closest('.pop-host[data-pop]')) { const k = t.closest('.pop-host[data-pop]').dataset.pop, o = anchorEl(POP_TRIG[k]); if (o && o !== t) return trigChain(o); }   /* 弹窗里的触发：按打开这个弹窗的元素算 */
  const tab = lc && navTabOf(lc);
  const tree = ctAnc(tab ? tab.r : c0 || '');
  return { inner: inner, lc: lc, chain: inner.concat(tree.filter(function (x) { return inner.indexOf(x) < 0; })) };
}
/* 默认层级：从触发处往外，第一个声明了 cover 的容器给出的层级 */
/* 从内容里打开、没说开到哪：触发处往外第一个声明了 opens 的容器（容器的默认去处） */
function navCoverDefault(chain) { for (let i = 0; i < chain.length; i++) { const n = ctNode(chain[i]); if (n && n.opens && n.opens.as !== 'beside') return pdlOpenTarget(n.opens); } return null; }
/* 生效目标：声明的容器看得见就是它，看不见就是最近的看得见的祖先（窄屏收起、工作台收起、主题里没有这个容器） */
let CT_SHOWN = {};   /* 上一次投影画出来（看得见）的容器：由 render 记下，不量 DOM */
function ctVisible(k) { return !!CT_SHOWN[k]; }
function navEffective(k) { let c = k; while (c && ctNode(c) && !ctVisible(c)) c = ctParent(c); return c || pdlTree().key; }

/* ───────── 数据变了：被盖住的层记成过期（露出来时重画一次） ───────── */
function navStale() { DATA_VER += 1; }

/* ───────── 离开（容器层的唯一一处，frame.js 的 leave）：要被盖住 / 出栈 / 换掉的层 ───────── */
function navEls(ids) { const out = []; ids.forEach(function (id) { document.querySelectorAll('[data-layer="' + id + '"]').forEach(function (el) { out.push(el); }); }); return out; }
/* 一个栈从下标 i 起往上的层（离开时要检查的） */
function navIdsFrom(c, i) { return navStack(c).slice(i).map(function (l) { return l.id; }); }
/* 盖住 c 的那些层（c 的祖先上压着的投影）：打开 / 切换到 c 时它们都离开 */
/* 盖着 c 的层：祖先里能覆盖的容器，栈里不是“画子容器”（'@'）的那些——从外面切换进来时底层本身就是内容 */
function navCoverFrom(a) { return navStack(a)[0].f === '@' ? 1 : 0; }
function navCoveringIds(c) { const out = []; ctAnc(ctParent(c) || '').forEach(function (a) { if (ctCoverable(a)) out.push.apply(out, navIdsFrom(a, navCoverFrom(a))); }); return out; }
function navUncover(c) { ctAnc(ctParent(c) || '').forEach(function (a) { if (!ctCoverable(a) || navDepth(a) <= navCoverFrom(a)) return; navDrop(navStack(a).slice(navCoverFrom(a))); NAV.st[a] = [navCoverFrom(a) ? navStack(a)[0] : navLayer('@')]; }); }
function navDrop(ls) { ls.forEach(function (l) { (LAYER_DOM[l.id] || []).forEach(function (el) { el.remove(); }); delete LAYER_DOM[l.id]; }); }

/* ───────── 三个动作 ─────────
   open：压进生效目标的栈（目标是触发元素的容器或它的祖先 ⇔ 盖住了触发处 ⇔ 有返回）；目标不在祖先链上 = 从外面切换这个容器（换掉它的栈，没有返回）。
   back / close：出栈。switch：换掉栈顶（不出返回）。被另一层投影盖住 = 离开，先过未保存确认；被弹窗盖住不算离开。 */
function navPushRaw(c, f, a, title, bl, exit) {
  const s = navStack(c), top = s[s.length - 1], l = navLayer(f, a);
  top.t = title != null ? title : top.t; top.v = DATA_VER;
  if (exit && exit.length) l.exit = exit;
  if (bl) l.bl = 1;   /* 这次打开声明了返回旁边写上一层的标题 */
  s.push(l); NAV.fwd[c] = [];
  while (s.length > NAV_CAP) { const i = ctCoverable(c) || !ctNode(c) ? 1 : 0, ev = s.splice(i, 1); navDrop(ev); }   /* 逐出最早被盖住的一层（结构底层不逐出）；它从不带未保存的修改：盖住它时已经确认过 */
}
/* 按打开方式声明返回旁边写上一层的标题：动作参数 backLabel，或者触发处所在的视图声明了 backLabel（从对话里打开的都带「‹ 对话标题」）；默认不写 */
function navBackLabel(o, t) {
  if (o.backLabel != null) return !!o.backLabel;
  if (!t || !t.closest) return false;
  if (t.dataset.backLabel != null) return t.dataset.backLabel !== 'false';
  for (let v = t.closest('[data-view]'); v; v = v.parentElement && v.parentElement.closest('[data-view]')) { const d = PDL_VIEWS[v.dataset.view]; if (d && d.backLabel != null) return !!d.backLabel; }
  return false;
}
function navOpen(o, from) {
  const t = from === undefined ? ACT_FROM : from, tc0 = t ? trigChain(t) : { inner: [], lc: navFocusC(), chain: ctAnc(navFocusC()) }, chain = tc0.chain;   /* 程序打开（没有触发元素）：按在焦点那一层里打开算 */
  let want = o.into === '.' ? tc0.lc || ctPages() : o.into || navCoverDefault(chain) || (o.exit && navCoverDefault(ctAnc(ctPages()))) || ctPages();
  const T = navEffective(want);
  const host = T, push = !!o.push || !!(o.exit && o.exit.length) || chain.indexOf(T) >= 0 || o.into === '.';
  const title = o.title != null ? o.title : navTitleAt(t), bl = navBackLabel(o, t);
  const tn = ctNode(T);
  if (tn && tn.tabs) { navLeave(navCoveringIds(T), function () { navUncover(T); rtOpenContent(T, o, t); navAfter(); }); return T; }   /* 开进标签式容器：变成它的一项（绑定方说是哪一项） */
  if (push) {
    navLeave(navIdsFrom(host, navDepth(host) - 1).concat(navCoveringIds(host)), function () { navUncover(host); navPushRaw(host, o.f, o.a, title, bl, o.exit); navAfter(); });
    return host;
  }
  navSwitchC(host, o.f, o.a);
  return host;
}
/* 从外面切换容器 c：c 的栈换成这一层；盖着 c 的层离开。
   切走的栈是兄弟，不销毁（navHide）：隐藏 + inert 留在 DOM 里，数据变了记成过期，再切回来（同一个底层）时原样回来——滚动位置、展开状态、输入框里的东西都在。
   能覆盖的容器底层也被换掉（再关就回到底层），它的栈不留。before：在离开检查之后、换栈之前做的事（换空间） */
function navSwitchC(c, f, a, then, force, before) {
  const own = navIdsFrom(c, 0), dirty = !force && navEls(own).some(leaveDirty);
  (force ? function (ids, fn) { fn(); } : navLeave)(own.concat(navCoveringIds(c)), function () {   /* force：程序里的切换（没有触发元素，比如保存之后跳转），不问 */
    if (before) before();
    navUncover(c);
    const s = navStack(c), k = navKey(f, a);
    if (navKey(s[0].f, s[0].a) === k && !ctCoverable(c)) { navDrop(s.slice(1)); NAV.st[c] = [s[0]]; }   /* 切到自己的底层：上面的层出栈，底层露出来 */
    else { navHide(c, dirty); const back = navKeptTake(c, k); NAV.st[c] = back ? back.st : [navLayer(f, a)]; NAV.fwd[c] = back ? back.fwd : []; }
    navAfter(); if (then) then();
  });
}
/* 哪些容器留切走的兄弟：不能覆盖、不是标签式的容器（页面容器） */
function navKeeps(c) { const n = ctNode(c); return !!n && !ctCoverable(c) && !n.tabs; }
/* 兄弟栈按底层认（帧 + 参数） */
function navKey(f, a) { return f + '|' + JSON.stringify(a || {}); }
/* 切走一个栈：留着（栈顶记下现在的数据版本，离开时放弃过修改的整栈记成过期）；能覆盖的容器不留。
   上限和栈一样是 NAV_CAP：所有留着的兄弟一共超过 NAV_CAP 层时，最久没看的那个整栈逐出（它们都过了离开检查，没有未保存的修改，逐出是安全的） */
function navHide(c, stale) {
  const s = NAV.st[c] || []; if (!s.length) return;
  if (!navKeeps(c)) { navDrop(s); return; }
  s[s.length - 1].v = DATA_VER; if (stale) s.forEach(function (l) { l.v = -1; });
  const k = navKey(s[0].f, s[0].a), kept = NAV.kept[c] = (NAV.kept[c] || []).filter(function (x) { if (navKey(x.st[0].f, x.st[0].a) !== k) return true; navDrop(x.st); return false; });
  kept.push({ st: s, fwd: NAV.fwd[c] || [] });
  const n = function () { return kept.reduce(function (m, x) { return m + x.st.length; }, 0); };
  while (kept.length > 1 && n() > NAV_CAP) navDrop(kept.shift().st);
}
function navKeptTake(c, k) { const kept = NAV.kept[c] || [], i = kept.findIndex(function (x) { return navKey(x.st[0].f, x.st[0].a) === k; }); return i < 0 ? null : kept.splice(i, 1)[0]; }
/* 容器 c 留着的兄弟的层（画的时候放在 c 里，隐藏） */
function navKeptLayers(c) { return [].concat.apply([], (NAV.kept[c] || []).map(function (x) { return x.st; })); }
/* 切到空间 v：回到它上次停的那一页（那一页的栈留着就原样回来），没去过就是它的主页 */
function navSpaceTarget(v) { const l = NAV.spLast[v], home = (PDL_SPACES[v] || {}).home; return l && PAGES[l.f] ? l : home ? { f: home, a: {} } : null; }
/* 换掉栈顶（同一个容器里的切换：分栏里选另一项、工具里的分视图）：不改深度、不出返回 */
function navReplace(c, f, a) { const top = navTop(c); if (f != null) top.f = f; top.a = a || {}; }   /* 同一层换内容：层不变（滚动由通常的重画规则保持） */
function navBack(c) {
  if (navDepth(c) < 2) return false;
  navLeave([navTop(c).id], function () { const s = navStack(c), l = s.pop(); navDrop([l]); (NAV.fwd[c] = NAV.fwd[c] || []).push({ f: l.f, a: l.a, t: l.t, bl: l.bl, exit: l.exit }); navAfter(); });
  return true;
}
function navForward(c) {
  const fw = NAV.fwd[c]; if (!fw || !fw.length) return false;
  navLeave([navTop(c).id], function () { const x = fw.pop(), keep = fw.slice(); navPushRaw(c, x.f, x.a, x.t, x.bl, x.exit); NAV.fwd[c] = keep; navAfter(); });
  return true;
}
/* 关掉容器 c 里换上来的内容（入口再点一下）：回到底层 */
function navClose(c) { navLeave(navIdsFrom(c, 0), function () { navDrop(navStack(c)); NAV.st[c] = [navBase(c)]; navAfter(); }); }
/* 导航的收尾（登记的钩子）：换地方时，旧地方弹出来的东西收起——引擎自己的菜单，加上各层登记在 NAV_RESET 里的（浮窗、抽屉……）。
   o.popupsOnly：导航刚开始（还要过离开检查），只收弹出的东西；抽屉这类布局状态等导航真正完成（navAfter）才收 */
const NAV_RESET = [];
function navReset(o) { S.menu = null; NAV_RESET.forEach(function (f) { f(o || {}); }); }
/* 动作结束后：收起菜单和抽屉（navReset）、写地址（core.js 的 navHash）、重画 */
function navAfter() { navReset(); navHash(); render(true); }
/* 离开：要离开的层里有改过没存的表单，先确认 */
function navLeave(ids, then) { const els = navEls(ids); if (!els.length) { then(); return; } leave(els, then); }
/* 压栈时记下被盖住那一层的名字（返回的提示）：触发处所在的分栏标题，或者那一层自己的标题 */
function navTitleAt(t) {
  const pane = t && t.closest && t.closest('[data-ct^="pane"]'), ph = pane && pane.querySelector('h1, h2'); if (ph) return navText(ph);
  const ly = t && t.closest && t.closest('[data-layer]'), ttl = ly && ly.querySelector('[data-title]');
  if (ttl) return navText(ttl);
  const ct = t && t.closest && t.closest('[data-c]'), top = ct && navTop(ct.dataset.c), e = top && pdlEntry(top.f);   /* 所在容器没有标题元素：用打开它当前这一层的入口的名字（设置菜单 = 「设置」） */
  if (e && e.title) return e.title;
  return navTitleNow();
}
/* 焦点那一层现在的名字：它自己的标题元素，或者功能模块登记的名字（对话页 = 对话名），或者路由的标题。
   标题元素是组件自己声明的标题位（data-title：页头的标题、对话页头的标题），引擎不认组件的类名 */
function navTitleNow() {
  const ly = document.querySelector('[data-layer~="' + navTop(navFocusC()).id + '"]'), ttl = ly && ly.querySelector('[data-title]');
  return ttl ? navText(ttl) : (NAV_TITLE && NAV_TITLE()) || TITLES[S.route] || '';
}
/* 标题的文字：不含标题里的图形（名字后的 ?、图标这类 role=img / aria-hidden 的东西） */
function navText(el) { const c = el.cloneNode(true); c.querySelectorAll('[role="img"], [aria-hidden="true"]').forEach(function (x) { x.remove(); }); return c.textContent.trim(); }
let NAV_TITLE = null;   /* 没有标题元素时的名字（对话页 = 对话名）：功能模块登记 */
/* 一个栈的返回（引擎的返回控件）：深于 1 才有；同一个帧换了参数（视图里的下钻：列表 → 详情）放进详情的返回槽，否则是页的返回 */
function navBackOf(c, label) { const s = navStack(c); if (s.length < 2) return null; const a = s[s.length - 2], b = s[s.length - 1]; if ((b.exit || []).indexOf('x') >= 0) return null; return { act: 'back', data: ' data-c="' + c + '"', label: label != null ? label : a.t || '', role: a.f === b.f ? 'detail' : 'page', showLabel: !!(b.bl || (ctNode(c) || {}).backLabel) }; }   /* 返回旁边写不写上一层的标题：这次打开声明的，或者容器声明的，默认不写 */
/* 在某个帧打开着吗（入口的当前项、入口再点一下关掉） */
function navFrameAt(f) { return Object.keys(NAV.st).find(function (c) { const s = NAV.st[c]; return s.length && s[s.length - 1].f === f; }) || null; }

/* ───────── 标签式容器：一组打开的项，一次显示一项；每项一栈（自己的返回 / 前进）；会话状态只存一份 ─────────
   NAV.tabs[r] = { list: [{ k, pin, preview }], open, closed, split }（组件可以在上面记自己的界面状态，比如全部标签开没开）；当前项是容器 r 自己那一栈的栈顶（从别的项里点过来 = 压栈，有返回）。 */
function navTabs(r) { if (!NAV.tabs[r]) NAV.tabs[r] = { list: [], open: false }; return NAV.tabs[r]; }
function navTabCur(r) { const s = NAV.st[r]; return s && s.length ? s[s.length - 1].f : null; }

/* ───────── 快照 / 恢复（检查和代理用）：整个运行时状态就是一个 JSON ───────── */
function navSnapshot() { return JSON.parse(JSON.stringify(Object.assign({ st: NAV.st, fwd: NAV.fwd, tabs: NAV.tabs, kept: NAV.kept, spLast: NAV.spLast, pop: NAV.pop, focus: navFocusC(), seq: NAV.seq }, ENGINE_PARTS.navState()))); }
function navRestore(o) {
  Object.keys(LAYER_DOM).forEach(function (id) { navDrop([{ id: id }]); });
  const x = JSON.parse(JSON.stringify(o));
  NAV.st = x.st || {}; NAV.fwd = x.fwd || {}; NAV.tabs = x.tabs || {}; NAV.kept = x.kept || {}; NAV.spLast = x.spLast || {}; NAV.pop = []; NAV.seq = x.seq || NAV.seq; NAV.focus = x.focus;   /* 弹窗用完即弃：恢复时不恢复弹窗 */
  ENGINE_PARTS.navRestore(x);
  navAfter();
}
