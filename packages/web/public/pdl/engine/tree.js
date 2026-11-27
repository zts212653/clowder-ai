/* ═════════════ 一棵树 ═════════════
   主题是一棵树：布局容器（容器树 pdlTree()：窗口、窄栏、外壳、第二栏、主体、主区、工作台、用户加的容器；它们用 slots 声明自己放哪些内容容器）、
   内容容器（PDL_SLOTS：放入口和分组标题的容器，kids 就是它的孩子，按 id 引用：视图里的插槽块、组件的 slot 属性、布局容器的 slots）、
   视图（PDL_VIEWS）、消息模板（PDL_NODES）、行模板（PDL_ROWS），都按 id 引用，索引顺着引用拼成一棵。
   每个节点用 id 认（入口、分组标题、容器是 id；视图里的叶子是字面 key）。
   生效的树 = 主题声明的 → 当前自定义主题改过的（容器树、内容容器、视图按 id 覆盖）→ 插件插入（pdlInsertsApply）。 */
'use strict';
const PDL_ROOTS = { slots: function () { return PDL_SLOTS; }, views: function () { return PDL_VIEWS; } };
function pdlId(n) { return n ? n.id || n.key || null : null; }
/* 节点自己的 id（主题文档按它认）：视图里的块是字面 key（块上的 id 是表单 / 列表的数据 id、引用的视图）；入口、布局容器是 id / key；用户那份里的插件节点只有 ref */
function pdlNodeId(x) { return x.type ? x.key || null : x.id || x.key || x.ref || null; }
/* 生效的登记表：PDL_SLOTS / PDL_VIEWS 始终是生效的那份——主题声明的原件（PDL_BASE，加载完、插件登记之前记下），
   被当前自定义主题改过的按 id 换成文档里的那份；换完重新套一遍插件的插入。读的地方不用分辨。 */
const PDL_BASE = {};
function pdlBaseTake() { Object.keys(PDL_ROOTS).forEach(function (kind) { PDL_BASE[kind] = Object.assign({}, PDL_ROOTS[kind]()); }); }
onStart('data', pdlBaseTake);
function pdlEffectiveSync() {
  const full = S.pdlDoc && S.pdlDoc.full;
  Object.keys(PDL_BASE).forEach(function (kind) {
    const reg = PDL_ROOTS[kind](), base = PDL_BASE[kind], ov = (full && full[kind]) || {};
    Object.keys(base).forEach(function (rid) { reg[rid] = ov[rid] ? pdlClone(ov[rid]) : base[rid]; });   /* 文档里那份保持干净：插件插入只落在拷贝上 */
    Object.keys(ov).forEach(function (rid) { if (!base[rid]) reg[rid] = pdlClone(ov[rid]); });   /* 用户自己加的容器 */
  });
  pdlEntryReset(); pdlInsertsApply(); pdlOnListen();
  renderForget();   /* 树变了：上一次画的每一块都作废 */
}
PDL_THEME_SYNC.push(pdlEffectiveSync);
function pdlTreeChanged() { pdlTreeReset(); pdlEffectiveSync(); }
function pdlSlotDef(id) { return PDL_SLOTS[id] || null; }
function pdlSlotIds() { return Object.keys(PDL_SLOTS); }
/* 一个内容容器的孩子（id，按顺序；画不画由画的地方按 when / 隐藏决定） */
function pdlKids(slot) { const d = pdlSlotDef(slot); return d ? (d.kids || []).map(pdlId) : []; }
/* 入口：在哪个内容容器里、它的声明 */
let PDL_ENTRY_IX = null;
function pdlEntryIndex() {
  if (PDL_ENTRY_IX) return PDL_ENTRY_IX;
  const ix = {};
  pdlSlotIds().forEach(function (s) { (pdlSlotDef(s).kids || []).forEach(function (n) { const id = pdlId(n); if (id && !ix[id]) ix[id] = { node: n, slot: s }; }); });
  return (PDL_ENTRY_IX = ix);
}
function pdlEntryReset() { PDL_ENTRY_IX = null; PDL_NODE_IX = null; }
function pdlEntry(id) {
  const x = pdlEntryIndex()[id]; if (!x) return null;
  const n = x.node; if (!n.ref) return n;
  const t = pdlEntry(n.ref); return t ? Object.assign({}, t, { id: n.id, ref: n.ref, cell: n.cell, hidden: n.hidden, move: null }) : null;   /* 引用按钮：表现和它指向的入口一样（位置、格子、隐藏是它自己的） */
}
function pdlEntryIds() { return Object.keys(pdlEntryIndex()).filter(function (id) { return id[0] !== '#'; }); }
function pdlSlotOf(id) { const x = pdlEntryIndex()[id]; return x ? x.slot : null; }
/* 移动范围：move 是一个容器 id，或一组容器 id——只能在这些容器的范围里；不写就不限 */
function pdlMoveOk(id, to) {
  const e = pdlEntry(id) || pdlNode(id), m = e && e.move; if (!m) return true;
  return [].concat(m).some(function (c) { return c === to || pdlSlotWithin(to, c) || pdlNodeWithin(to, c); });
}
/* 视图里的容器 to 是不是在容器 c 里面（顺着声明树往上） */
function pdlNodeWithin(to, c) { const hit = pdlTreeIndex().find(function (e) { return pdlNamed(e, [to]); }); for (let x = hit && hit.up; x; x = x.up) if (pdlNamed(x, [c])) return true; return false; }
/* 内容容器 to 是不是在布局容器 c 的范围里（布局容器用 slots 声明自己放哪些内容容器） */
function pdlSlotWithin(to, c) { let hit = false; pdlTreeWalk(pdlTree(), function (n) { if (n.key === c) pdlTreeWalk(n, function (x) { if ((x.slots || []).indexOf(to) >= 0) hit = true; }); }); return hit; }
/* 内容容器在哪个布局容器里 */
function pdlSlotBox(slot) { let at = null; pdlTreeWalk(pdlTree(), function (n) { if ((n.slots || []).indexOf(slot) >= 0) at = n.key; }); return at; }

/* ═════════════ 改自定义主题（spec 主题文档）═════════════
   改动落在自定义主题里：内容容器、视图按 id 覆盖（第一次改时从主题声明复制一份，插件插进来的节点换成引用 { ref }，位置保留），容器树整棵存。
   节点按 id 找：先找它在哪个根（内容容器 / 视图），再在那份拷贝里找到它。移动 = 从原来的位置拿出来，放进目标容器的 after 后面
   （after 不在：按 id 的字典序找位置）。 */
function pdlOwnCopy(x) { return JSON.parse(JSON.stringify(x, function (k, v) { return v && typeof v === 'object' && v.ins ? { ref: v.ins } : v; })); }
function pdlDocNodes(fn) {
  pdlDocEdit(function (full) {
    const own = function (kind, rid) { const m = full[kind] = full[kind] || {}; if (!m[rid]) m[rid] = pdlOwnCopy(PDL_ROOTS[kind]()[rid]); return m[rid]; };
    fn(own);
  });
  pdlEntryReset(); pdlTreeChanged();
}
/* id → 生效的节点（容器树、内容容器、视图；登记表的根按登记 id）：隐藏、格子位置、顺序、显示名都从节点自己读 */
let PDL_NODE_IX = null;
function pdlNodeIndex() {
  if (PDL_NODE_IX) return PDL_NODE_IX;
  const ix = {}, put = function (id, n) { if (id && !ix[id]) ix[id] = n; };
  const walk = function (x) { if (!x || typeof x !== 'object') return; if (Array.isArray(x)) { x.forEach(walk); return; } put(x.id || x.key, x); Object.keys(x).forEach(function (k) { if (x[k] && typeof x[k] === 'object') walk(x[k]); }); };
  walk(pdlTree());
  Object.keys(PDL_ROOTS).forEach(function (kind) { const reg = PDL_ROOTS[kind](); Object.keys(reg).forEach(function (rid) { put(rid, reg[rid]); walk(reg[rid]); }); });
  return (PDL_NODE_IX = ix);
}
function pdlNode(id) { return pdlNodeIndex()[id] || null; }
/* 节点在哪：{ kind, rid, path }——path 是从根到它的孩子数组下标链（在拷贝里按同一条路找回去） */
function pdlNodeAt(id) {
  let hit = null;
  Object.keys(PDL_ROOTS).some(function (kind) {
    const all = PDL_ROOTS[kind]();
    return Object.keys(all).some(function (rid) {
      const root = all[rid], path = rid === id ? [] : pdlPathOf(root, id);
      if (path) hit = { kind: kind, rid: rid, path: path, root: root };
      return !!path;
    });
  });
  return hit;
}
function pdlPathOf(root, id) {
  const walk = function (x, path) {
    if (!x || typeof x !== 'object') return null;
    if (Array.isArray(x)) { for (let i = 0; i < x.length; i++) { const r = walk(x[i], path.concat([i])); if (r) return r; } return null; }
    if (path.length && pdlNodeId(x) === id) return path;   /* 引用按钮有自己的 id（mcp@rail），不按它指向的认 */
    for (const k of Object.keys(x)) { if (x[k] && typeof x[k] === 'object') { const r = walk(x[k], path.concat([k])); if (r) return r; } }
    return null;
  };
  return walk(root, []);
}
function pdlPathGet(root, path) { return path.reduce(function (o, k) { return o[k]; }, root); }
function pdlKidsPlace(list, n, after) {
  let i = after !== undefined ? list.findIndex(function (x) { return pdlNodeId(x) === after; }) : -2;
  if (after === null) { list.unshift(n); return; }
  if (i === -2) { list.push(n); return; }
  if (i < 0) { const id = pdlNodeId(n); i = list.findIndex(function (x) { return String(pdlNodeId(x)) > String(id); }); list.splice(i < 0 ? list.length : i, 0, n); return; }
  list.splice(i + 1, 0, n);
}
/* 移动：to 是目标容器（内容容器 id，或视图里容器节点的 id）；after = 排在哪个兄弟后面（null = 最前，不写 = 最后） */
function pdlNodeMove(id, to, after, props) {
  const a = pdlNodeAt(id), b = pdlNodeAt(to); if (!a || !b) return false;
  pdlDocNodes(function (own) {
    const ra = own(a.kind, a.rid), list = pdlPathGet(ra, a.path.slice(0, -1)), n = list.splice(a.path[a.path.length - 1], 1)[0];
    const rb = own(b.kind, b.rid), box = b.path.length ? pdlPathGet(rb, b.path) : rb, kids = box.kids || box.items || box.blocks || (box.kids = []);
    Object.keys(props || {}).forEach(function (k) { if (props[k] == null) delete n[k]; else n[k] = props[k]; });
    pdlKidsPlace(kids, n, after);
  });
  return true;
}
/* 按 ids 的顺序重排一个内容容器的孩子（分组标题带着它下面的入口一起走）；ids 里没有的留在原来的相对位置之后 */
function pdlKidsOrder(slot, ids) {
  pdlDocNodes(function (own) { const box = own('slots', slot), rank = function (n) { const i = ids.indexOf(pdlId(n)); return i < 0 ? ids.length : i; }; box.kids = box.kids.map(function (n, i) { return [n, i]; }).sort(function (x, y) { return rank(x[0]) - rank(y[0]) || x[1] - y[1]; }).map(function (x) { return x[0]; }); });
}
/* 改一个节点的属性（hidden 隐藏、label 显示名、cell 格子位置、open 打开到哪……）；值为 null 就去掉这个属性 */
function pdlNodeSet(id, props) {
  const a = pdlNodeAt(id); if (!a) return false;
  pdlDocNodes(function (own) { const n = pdlPathGet(own(a.kind, a.rid), a.path); Object.keys(props).forEach(function (k) { if (props[k] == null) delete n[k]; else n[k] = props[k]; }); });
  return true;
}
/* 加一个节点（引用按钮、用户的分组标题）进内容容器；删一个用户加的节点（引用、分组标题） */
function pdlNodeAdd(slot, node, after) { if (!pdlSlotDef(slot)) return false; pdlDocNodes(function (own) { pdlKidsPlace(own('slots', slot).kids, node, after); }); return true; }
function pdlNodeDrop(id) {
  const a = pdlNodeAt(id); if (!a) return false;
  pdlDocNodes(function (own) { const list = pdlPathGet(own(a.kind, a.rid), a.path.slice(0, -1)); list.splice(a.path[a.path.length - 1], 1); });
  return true;
}
/* 容器里用户放过的格子位置（节点自己的 cell）：布局容器（窄栏）按它的 slots 收所有内容容器的孩子 */
function pdlCells(container) {
  const out = {}, box = pdlNode(container); if (!box) return out;
  const kids = box.slots ? [].concat.apply([], box.slots.map(function (s) { return (PDL_SLOTS[s] || {}).kids || []; })) : box.kids || box.items || box.blocks || [];
  kids.forEach(function (n) { if (n && n.cell) out[pdlId(n)] = n.cell; });
  return out;
}
/* 容器的子项顺序：内容容器就是 kids 的顺序；按组件属性排先后的（消息流 / 输入框、输入框上沿三列）由用户写在容器节点的 order 上 */
function pdlOrderOf(container, keys) {
  const want = (pdlNode(container) || {}).order; if (!want) return keys.slice();
  const moved = keys.filter(function (k) { return want.indexOf(k) >= 0; }), seq = want.filter(function (k) { return moved.indexOf(k) >= 0; });
  let i = 0; return keys.map(function (k) { return moved.indexOf(k) >= 0 ? seq[i++] : k; });
}
/* 隐藏：节点自己的 hidden；插件节点（plugin:<插件>/<节点>）插件不在、停用时也不画 */
/* 容器空不空（“没有内容时隐藏”）：它声明的内容容器里都没有画出来的节点；有角色（页面、空间、标签）的容器内容是它的叠，从不算空 */
function pdlCtEmpty(n) {
  if (n.pages || n.space || n.tabs || !(n.slots || []).length) return false;
  return n.slots.every(function (s) { return !pdlKids(s).some(function (id) { return pdlEntry(id) && !pdlNodeHidden(id); }); });
}
function pdlNodeHidden(key) {
  const ref = /^plugin:([^/]+)\//.exec(key); if (ref && !plugOn(ref[1])) return true;
  const n = pdlNode(key); return !!(n && n.hidden);
}
