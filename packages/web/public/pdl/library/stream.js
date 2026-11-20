/* 边界：一个含义一个组件、不为接口定制、不按位置推导样式 */
/* 消息流：按单元逐步画出、刻度与刻度的键盘 */
'use strict';
/* 消息导航的键盘（组件库）：焦点在一格刻度上时，上下、Home / End、翻页在刻度之间移动焦点（同一个 keyStep） */
KEY_FNS.push(function (e) {
  const t = e.target; if (!t || !t.classList || !t.classList.contains('cafe-tick')) return false;
  const ticks = Array.from(document.querySelectorAll('button.cafe-tick')), k = keyStep(e, ticks.indexOf(t), ticks.length, { page: true });
  if (k == null) return false; e.preventDefault(); ticks[k].focus(); return true;
});
/* 消息导航的当前位置（组件库）：消息在消息流的视口里时，导航里对应的那一格带 data-vis（高亮）。由视口观察驱动，不在滚动事件里逐帧量；
   观察器跟着消息流走：消息流、消息、刻度进了文档时由引擎的进树通知（treeMatch）接上。只改刻度上的一个属性，不重画 */
const TICK_VIS = new Set(), TICK_IO = { io: null, root: null, inter: new Set() };
function tickVisMark(mid) {
  const on = Array.from(TICK_IO.inter).some(function (m) { return m.isConnected && m.dataset.mid === mid; });
  if (on) TICK_VIS.add(mid); else TICK_VIS.delete(mid);
  document.querySelectorAll('.cafe-tick[data-mid="' + CSS.escape(mid) + '"]').forEach(function (t) { t.toggleAttribute('data-vis', on); });
}
function tickVisRoot(s) {
  if (!s || TICK_IO.root === s) return;
  if (TICK_IO.io) TICK_IO.io.disconnect();
  TICK_IO.root = s; TICK_IO.inter.clear(); TICK_VIS.clear();
  TICK_IO.io = new IntersectionObserver(function (es) {
    const mids = {};
    es.forEach(function (e) { if (e.isIntersecting && e.target.isConnected) TICK_IO.inter.add(e.target); else TICK_IO.inter.delete(e.target); mids[e.target.dataset.mid] = 1; });
    Object.keys(mids).forEach(tickVisMark);
  }, { root: s });
  s.querySelectorAll('[data-stream] > .cafe-m[data-mid]').forEach(function (m) { TICK_IO.io.observe(m); });
}
/* 重画之后按记下的可见消息重新标刻度：可见性只改这一个属性、不写进 HTML——写进去的话，切一个工作台标签让消息流变窄一格，
   视口里的消息就换了，下一次画出来的刻度 HTML 和上一次不同，整块主区跟着重画，滚一下就冒滚动条 */
PAINT_SYNC.push(function () { document.querySelectorAll('.cafe-tick[data-mid]').forEach(function (t) { t.toggleAttribute('data-vis', TICK_VIS.has(t.dataset.mid)); }); });
treeMatch('#stream', tickVisRoot);
treeMatch('#stream [data-stream] > .cafe-m[data-mid]', function (m) { const s = m.closest('#stream'); if (s !== TICK_IO.root) tickVisRoot(s); else TICK_IO.io.observe(m); });
/* 视图引擎经组件库画的入口（PV_DRAW，见 engine/pdl-view.js） */
/* 按身份管自己孩子的列表（组件库通用：消息流、消息导航……；块的根带 data-own="类型"）——每一项是一个单元：按键记下它上次的数据对象、
   读到的页面级的值和界面状态、画出来的 HTML。数据没变由应用决定：没变的一项交来的还是上次那个对象（只比引用，不比内容）；
   主题的 item 映射在单元里面做（PV.units 登记的块），只有要重画的那一项才映射。带变化来源的重画里，这三样都没变的单元只交一个壳（keptStub）；
   DOM 上由 unitsOwn 按键对齐：没变的节点留在原位、变了的换掉、新的插进去、没了的拿掉 */
const UNITS = {};
/* 长列表一下子多出很多新的单元（第一次打开、换了对话）：先画最后（最新的）UNITS_FIRST 个，前面的先留着，原处是通用的读取中；
   之后每一帧补一批（一批比一批多），补的那一下只重画这个列表（它读过 UNITS_HELD 里自己那一项）；补上来的不算新到达。跳到一条还没画的消息时先全画上 */
const UNITS_FIRST = 12, UNITS_HELD = pdlTrack({}, 'UNITS');   /* 还没补上的：界面状态（读过它的列表在补上一批时重画） */
let UNITS_FILLING = false;
function unitsHeld(id, items, keyOf, was) {
  const held = UNITS_HELD[id], keys = items.map(keyOf);
  if (held) {   /* 只留开头那一段、而且后面还有画出来的：别的情况（同一个列表换了一组项）就全画 */
    held.keys.forEach(function (k) { if (keys.indexOf(k) < 0) held.keys.delete(k); });
    let lead = 0; while (lead < keys.length && held.keys.has(keys[lead])) lead++;
    if (held.keys.size && lead === held.keys.size && lead < keys.length) return held.keys;
    delete UNITS_HELD[id];
  }
  if (UNITS_FILLING) return null;   /* 补画（含全画上）的这一下不再留 */
  let lead = 0; while (lead < keys.length && !was[keys[lead]]) lead++;
  const n = Math.min(lead, keys.length - UNITS_FIRST); if (n <= UNITS_FIRST) return null;
  UNITS_HELD[id] = { keys: new Set(keys.slice(0, n)), batch: UNITS_FIRST };
  settleHold(new Promise(function (done) { unitsFill(id, done); }));
  return UNITS_HELD[id].keys;
}
function unitsFill(id, done) {
  requestAnimationFrame(function () {
    const held = UNITS_HELD[id]; if (!held) { done(); return; }
    const keys = Array.from(held.keys); held.batch *= 2;
    keys.slice(Math.max(0, keys.length - held.batch)).forEach(function (k) { held.keys.delete(k); });   /* 先补挨着已画部分的那些 */
    if (!held.keys.size) delete UNITS_HELD[id]; else held.left = held.keys.size;   /* 还剩几个：读过它的列表重画 */
    UNITS_FILLING = true; try { render(true); } finally { UNITS_FILLING = false; }
    if (UNITS_HELD[id]) unitsFill(id, done); else done();
  });
}
ENGINE_PARTS.unitsAll = function () {
  const ids = Object.keys(UNITS_HELD); if (!ids.length) return false;
  ids.forEach(function (id) { delete UNITS_HELD[id]; });
  UNITS_FILLING = true; try { render(true); } finally { UNITS_FILLING = false; }
  return true;
};
function unitsHtml(id, items, keyOf, draw, root) {
  const was = UNITS[id] || {}, now = {}, rootNow = {};   /* 页面级的值对每一项都一样：这一次只算一遍 */
  const rootSame = function (r) { if (!(r[0] in rootNow)) rootNow[r[0]] = JSON.stringify(root[r[0]]); return rootNow[r[0]] === r[1]; };
  const held = unitsHeld(id, items, keyOf, was);
  let heldAt = false;
  const html = items.map(function (it) {
    const key = keyOf(it), u = was[key];
    if (held && held.has(key)) { if (heldAt) return ''; heldAt = true; return '<div class="units-held" data-units-held>' + viewState('loading', { count: 3 }) + '</div>'; }
    if (u && RENDER_CHANGED && u.gen === RENDER_GEN && (u.item === it || u.json === JSON.stringify(it)) && !readsHit(u.reads, RENDER_CHANGED) && u.rootReads.every(rootSame)) {   /* 这一项的数据：同一个对象，或者值一样 */
      readsReplay(u.reads, true); now[key] = u; return u.html ? keptStub('unit:' + id + '|' + key, u.html) : '';
    }
    /* 交给这一项的根是一个会记读取的代理：读到根上哪个字段就记下它和它的值（嵌套子视图用它们自己的根，不在这里） */
    const reads = new Set(), rootReads = [], seen = {}, at = new Proxy(root, { get: function (t, k) { if (typeof k === 'string' && !seen[k]) { seen[k] = 1; rootReads.push([k, JSON.stringify(t[k])]); } return t[k]; } });
    READ_SCOPES.push(reads);
    let out; try { out = draw(it, at); } finally { READ_SCOPES.pop(); }
    reads.forEach(function (r) { for (let i = 0; i < READ_SCOPES.length; i++) READ_SCOPES[i].add(r); });
    now[key] = { item: it, json: JSON.stringify(it), gen: RENDER_GEN, reads: reads, rootReads: rootReads, html: out }; return out;
  }).join('');
  UNITS[id] = now;
  return html;
}
function unitsItem(b, it, root) { return b.item ? Object.assign({}, it, pvDeep(b.item, root, it)) : it; }
/* DOM 上的对齐：nodeKey(节点) 给出它的键（没有键的按出现顺序和原来的比，一样就留着）；
   hook 是组件自己在对齐时要做的（消息流的到达动效）：start(live, next, old) → 这一次的上下文，kept(原节点)，added(新节点, 同键的原节点, 上下文) */
function unitsOwn(nodeKey, hook) {
  return function (live, next) {
    const old = new Map(), loose = [];
    Array.prototype.forEach.call(live.childNodes, function (c) { const k = nodeKey(c); if (k) old.set(k, c); else loose.push(c); });
    const ctx = hook ? hook.start(live, next, old) : null;
    let li = 0;
    const plan = Array.prototype.map.call(next.childNodes, function (n) {
      const k = nodeKey(n), o = k ? old.get(k) : null;
      if (o && (n.dataset.kept || NODE_HTML.get(o) === streamVer(n))) { if (hook) hook.kept(o); return o; }   /* 这一项没变（只交了壳，或画出来一样）：原节点留着 */
      if (n.dataset && n.dataset.kept) return n;   /* 只交了壳、这里没有原节点：由 keptFill 换回完整的 */
      if (!k) { const c = loose[li++]; if (c && c.isEqualNode(n)) return c; }
      if (n.nodeType === 1) { NODE_HTML.set(n, streamVer(n)); if (hook) hook.added(n, o, ctx); }
      return n;
    });
    placeKids(live, plan);
  };
}
/* 消息流：单元的键——正在回复的占位按它的回合（data-run），其余按消息 id；新出现的消息有到达动效（这条流画之前就有、至少一条消息还在才算；正式消息接替占位不再到达） */
function streamUnitKey(it) { return it.kind === 'typing' ? 'typing:' + it.mid : String(it.mid); }
function streamNodeKey(n) { return n.nodeType === 1 ? (n.dataset.run ? 'typing:' + n.dataset.run : n.dataset.mid || null) : null; }
OWN.stream = unitsOwn(streamNodeKey, {
  start: function (live, next, old) {
    return { hadTyping: old.has('typing') || Array.prototype.some.call(live.children, function (c) { return c.dataset.mid === 'typing'; }),
      had: Array.prototype.some.call(next.children, function (n) { const k = streamNodeKey(n); return k && k.indexOf('typing:') !== 0 && old.has(k); }) };
  },
  kept: function (o) { o.classList.remove('arrive'); },
  added: function (n, o, c) { if (!o && c.had && !UNITS_FILLING && (n.dataset.mid === 'typing' || !c.hadTyping)) n.classList.add('arrive'); }
});
/* 消息导航：一格一个单元，按消息 id */
OWN.ticks = unitsOwn(function (n) { return n.nodeType === 1 ? n.dataset.mid || null : null; });
Object.assign(PV.units, { stream: 1, ticks: 1 });
