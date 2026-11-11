/* 边界：引擎只放机制与时机，不认任何具体名字、不为单个位置打补丁 */
/* 页面描述（PDL）：入口、插槽、摆放、页面里的块，以及渲染它们的引擎。
   外壳（窄栏、对话侧栏的入口区、设置菜单、工作台启动面板）、页面插槽（输入框工具、消息操作）、
   行插槽（工作台每种列表行的悬停操作）都从这份描述生成。
   摆放分层：核心默认 → 插件（manifest 里的 pdl 段，见 data.js）→ 用户调整（存在这台设备上）。
   规则在所有层之上：设置入口始终在窄栏；成员、插件扩展、系统配置始终留在设置菜单（拖出去是复制）。 */
'use strict';



/* ═════════════ 描述 ═════════════ */

/* 能力条件；插件注册时会加上 plugin.<id> */
const WHEN = pdlReads('when');

/* 弹窗：盖在投影上的、用完即弃的内容。每个弹窗只声明三件事：
   - at 初始位置：trigger 跟着触发它的东西（元素；点击处 / 选中的文字 / 光标由打开它的动作给出，引擎在那里放一个看不见的锚点，见 ui.js 的 spotAt），或者相对它所在的地方固定（center 窗口中间 / corner 容器的角 / top 窗口顶部 / fill 铺满）。都是相对的，没有页面坐标；
   - exit 退出方式：outside 点外面 · esc · x（只有声明了 x 才画 ×）· pick 在里面执行了一个动作（留在原弹窗里的除外：换了一页，或者节点声明了 stay）· leave 指针离开（共用的悬停规则）；
   - drag 能否拖：拖动是相对初始位置的偏移，只在这次打开期间有效。
   另外两条和弹窗无关的声明：focus 遮罩（任何 PDL 节点都能声明）；fixLayer 进栈后下面的弹窗不能被提到它上面（确认框 / 对话框链）。
   state：触发它的是一个状态（不是元素），状态结束它就关；close：关闭动作（退出方式都走它，离开前的未保存确认在容器层，见 frame.js 的 leave）；body：框架给内容的那一层（page = 和对话流同一层）。
   demo：组件目录里“打开看看”依次执行的动作（组件目录用）；via：除了 demo 的动作，还有哪些 PDL 会打开它（目录数“使用几处”用） */
const PDL_POPUPS = {};
/* 身份组件悬停时做什么（触发元素的声明）：按身份种类，值是动作名；成员 → 打开成员悬停卡 */
const PDL_WHO = {};   /* 成员悬停卡只在消息的作者行（作者头像 + 名字）；别的放置处（成员列表、胶囊、叠放、已读、输入框）没有 */
function popExits(k, how) { return ((PDL_POPUPS[k] || {}).exit || []).indexOf(how) >= 0; }

/* 入口：movable 能否拖动、keep 只能待在哪些插槽、scope 页面 / 行插槽里的元素 */
/* 工作台里的工具也是入口：拖到窄栏或侧栏，点了在右侧打开 */

/* 插槽：display 怎么画；accepts 接受哪些入口；itemActions 进入这个插槽的每个入口都叠加的操作；scope 页面 / 行插槽 */
const PDL_SLOTS = {};
/* 页面插槽里的元素：按 when 决定出不出现，按 use 选组件库里的哪个组件来画 */

/* 行插槽：每种列表行一个，面板只交出这一行的数据（ctx），按钮由 lrow 统一画。
   一个行操作：title（可以用 {key} 引用这一行的数据）、icon、open.action、args（属性名: ctx 里的键）、
   need（这一行有这个数据才出现，'!x' 表示没有才出现）、guard（[规则名, 参数]：为什么现在不能用）、when */
const PDL_GUARDS = {};


/* 页面里的块：系统配置的小节顺序和出现条件 */
const PDL_PAGES = {};

/* ═════════════ 插件注册 ═════════════
   插件的入口、摆放、贡献、节点、图标合并进来；入口的条件自动是“插件已启用”。图标注册在插件自己的命名空间（plugin:<id>/…）。
   被打开的东西是 views 里的一个节点：PDL 视图，或 type: 'frame' 的独立页面（src、route、bridge、focus）；panel 是它在标签式容器里那一项的标题和图标 */
const PDL_PLUGINS = [];        /* 已注册（已安装）的插件，按安装顺序 */
const PDL_PLUGIN_REQ = {};   /* 插件 → 它登记的请求（名字 → { path 插件内相对路径, method, query }）；读写都走宿主的通用转发 /api/plugins/<id>/<path> */
const PDL_INSERT_SKIPS = {};   /* 插件 → 没插进去的插入（[{ id, reason }]，插件详情里可见） */
const PDL_PLUGIN_FRAGS = {};   /* 插件 → 它登记的 PDL 片段（生效的描述里列出它提供了什么） */     /* 插件 → 它对宿主的操作（和用户层同一种格式） */
/* ═════════════ 插槽基数：keyed / chain / single ═════════════
   贡献项：{ id, slot, key?（keyed）, match?（chain）, priority?（越小越先）, when?, plugin?, … 其余是这一项的数据（节点模板、卡片描述、提示内容） }
   核心的默认项也走 pdlContribute，所以插件和核心是同一种数据。 */
const PDL_SLOT_ITEMS = {};
/* 插件只能“加”：keyed 插槽里插件不能占用核心已有的 key（拒绝并记下，插件详情里可见）；
   排序时核心项永远在插件项之前，插件的 priority 只在插件之间比较——插件替换不了核心模板。 */
const PDL_SLOT_REJECTS = {};   /* 插件 → [{ slot, key, reason }] */
function pdlContribute(slot, item) {
  const list = PDL_SLOT_ITEMS[slot] = PDL_SLOT_ITEMS[slot] || [];
  if (item.plugin && item.key != null && PDL_SLOTS[slot] && PDL_SLOTS[slot].cardinality === 'keyed' && list.some(function (x) { return !x.plugin && x.key === item.key; })) {
    (PDL_SLOT_REJECTS[item.plugin] = PDL_SLOT_REJECTS[item.plugin] || []).push({ slot: slot, key: item.key, reason: 'host' }); return;
  }
  list.push(Object.assign({ priority: 100 }, item));
}
function pdlSlotItems(slot) { return (PDL_SLOT_ITEMS[slot] || []).filter(function (x) { return pdlWhen(x.when); }).sort(function (a, b) { return ((a.plugin ? 1 : 0) - (b.plugin ? 1 : 0)) || (a.priority - b.priority); }); }
/* keyed：按 key 取节点模板；只有核心项和插件新登记的 key（插件不能遮蔽核心） */
function pdlKeyed(slot, key) { const hit = pdlSlotItems(slot).find(function (x) { return x.key === key || (x.keys && x.keys.indexOf(key) >= 0); }); if (hit && hit.plugin) pdlPluginNeed(hit.plugin); return hit ? hit.node : null; }   /* keys：一个模板画几种类型 */
/* typed：按渲染类型取模板。类型写成“容器.子类型……”，取最长的、已登记且可用的前缀——插件不在（没装、停用）时逐级退回宿主的容器；
   一个都没有返回 null（调用方画默认）。降级关系写在类型名里，跟着数据走，不靠插件的声明 */
function pdlTyped(slot, type) {
  for (let t = String(type || ''); t; t = t.lastIndexOf('.') > 0 ? t.slice(0, t.lastIndexOf('.')) : '') { const n = pdlKeyed(slot, t); if (n) return n; }
  return null;
}
/* chain：ctx 里的字段包含 match 里写的文字就算认领；都不认领返回 null（用默认渲染） */
function pdlMatch(m, ctx) { return Object.keys(m || {}).every(function (k) { return ctx[k] != null && String(ctx[k]).indexOf(m[k]) >= 0; }); }
function pdlChain(slot, ctx) { return pdlSlotItems(slot).find(function (x) { return pdlMatch(x.match, ctx); }) || null; }
/* single：只放一个，核心项优先，其次插件里 priority 小的 */
function pdlSingle(slot) { return pdlSlotItems(slot)[0] || null; }

/* 核心的默认项：消息节点模板（views-chat.js 的 PDL_NODES）、输入框上方的提示 */

/* 通用 PDL 片段登记：内置模块和插件写入同一组表。
   pk / plug 只提供插件来源、启停条件与图标命名空间；不决定内容用哪套渲染。 */
/* 片段里给人看的名字（入口标题、面板标签）：t:键 在登记时取文案（插件的文案先登记）；别的原样 */
function pdlText(x) { return typeof x === 'string' && x.indexOf('t:') === 0 ? tc(x.slice(2)) : x; }
/* 插件的视图带上它是谁的：有 sources 的视图向应用的通用 VM.plugin 要数据；视图里用通用插件动作（plugin）的参数补上插件 id */
function pdlTagActs(x, pk) { if (Array.isArray(x)) { x.forEach(function (y) { pdlTagActs(y, pk); }); return; } if (!x || typeof x !== 'object') return; if (x.act === 'plugin') x.args = Object.assign({}, x.args, { plugin: pk }); Object.keys(x).forEach(function (k) { pdlTagActs(x[k], pk); }); }
/* 片段里的节点（视图、独立页面）、请求、弹窗：登记时一次，延迟加载的插件取回子树时再一次（inserts 是它登记过的插入，找弹窗归哪个入口） */
function pdlRegisterNodes(frag, pk, inserts) {
  const owner = pk ? { plugin: pk } : {};
  Object.keys(frag.views || {}).forEach(function (id) { const v = frag.views[id]; if (pk) { v.plugin = pk; pdlTagActs(v.blocks, pk); } if (v.panel) v.panel = v.panel.map(pdlText); PDL_VIEWS[id] = v; });
  if (pk && frag.requests) PDL_PLUGIN_REQ[pk] = frag.requests;
  Object.keys(frag.popups || {}).forEach(function (k) {
    const d = frag.popups[k], f = Object.keys(PDL_VIEWS).find(function (id) { return PDL_VIEWS[id].popup === k; });
    const ins = (inserts || []).find(function (x) { return ((x.node || {}).open || {}).node === f; }), entry = ins ? (pk ? 'plugin:' + pk + '/' : '') + ins.id : null;
    const body = Object.assign({}, d, f && PDL_VIEWS[f].type !== 'frame' ? { view: f } : {});   /* 视图节点画视图；独立页面画通用浮窗里的框 */
    PDL_POPUPS[k] = Object.assign({}, d, owner, { close: 'close', closeArgs: { path: 's.popOn.{k}' } }, entry ? { demo: [{ act: 'open', args: { ref: entry } }] } : {});
    POPUPS[k] = function () { return S.popOn[k] && (!pk || plugOn(pk)) ? ENGINE_PARTS.framePopup(k, pk, body) : ''; };
  });
}
/* 延迟加载：宿主给了加载口 ENGINE_PARTS.pluginLoad(插件) → Promise<子树> 时，插件登记的是索引（插入、模板、行、图标、文案、节点的声明）；
   子树（视图的内容、弹窗、请求、app.js）在它第一次投影时取回：画到它插进来的节点、它的模板，或者打开它的节点。取回后登记、再画。
   没有加载口时登记的就是整个片段。插件撤掉时一起忘掉 */
const PDL_PLUGIN_LOADED = {};
function pdlPluginNeed(pk) {
  if (!ENGINE_PARTS.pluginLoad || !PDL_PLUGIN_FRAGS[pk] || PDL_PLUGIN_LOADED[pk]) return;
  const at = PDL_PLUGIN_LOADED[pk] = ENGINE_PARTS.pluginLoad(pk).then(function (sub) {
    const frag = PDL_PLUGIN_FRAGS[pk]; if (PDL_PLUGIN_LOADED[pk] !== at || !frag) return;
    pdlRegisterNodes(sub, pk, frag.inserts);
    PDL_PLUGIN_FRAGS[pk] = Object.assign({}, frag, { views: Object.assign({}, frag.views, sub.views), popups: sub.popups, requests: sub.requests, loaded: true });
    if (frag.inserts) pdlTreeChanged(); else renderForget();   /* 插入可能锚在刚取回的子树里：从头再插一遍 */
    render(true);
  });
}
treeMatch('[data-entry^="plugin:"]', function (el) { const id = el.dataset.entry; pdlPluginNeed(id.slice(7, id.indexOf('/'))); });   /* 插件插进来的节点进了文档（进树通知） */
function pdlRegister(frag, pk, plug) {
  const big = pk && pdlLimitWhy(frag); if (big) { PDL_SLOT_REJECTS[pk] = [{ key: pk, slot: '', reason: big }]; return; }   /* 上限（主题文档）：插件片段登记时校验一次，超了整个不登记 */
  const owner = pk ? { plugin: pk } : {}, cond = pk ? 'plugin.' + pk : null;
  const ns = function (ic) { return ic && frag.icons && frag.icons[ic] && pk ? 'plugin:' + pk + '/' + ic : ic; };
  Object.keys(frag.icons || {}).forEach(function (n) { const one = {}; one[ns(n)] = frag.icons[n]; ENGINE_PARTS.icons(one); });
  if (frag.icon && plug) plug.icon = ns(frag.icon);
  if (pk) WHEN[cond] = function () { return plugOn(pk); };
  Object.keys(frag.rows || {}).forEach(function (id) { if (pk) pdlTagActs(frag.rows[id], pk); PDL_ROWS[id] = frag.rows[id]; });   /* 插件自己的行模板（名字由插件起，建议带上它的前缀） */
  if (frag.i18n) defineI18nPack(frag.ns, frag.i18n);   /* 插件的文案：按语言分（{ zh: {…}, en: {…} }），键在它的 ns 下，视图里写 t:<ns>.<键> */
  pdlRegisterNodes(frag, pk, frag.inserts);
  (frag.templates || []).forEach(function (x) {   /* 模板登记（按类型画，不是摆放） */
    const item = Object.assign({}, x, owner, { icon: ns(x.icon), id: pk ? 'plugin:' + pk + '/' + x.id : x.id });
    if (cond) item.when = x.when ? [cond, x.when] : cond;
    pdlContribute(x.slot, item);
  });
  /* 插进来的节点：名字是文案键的换成文字，图标是自己带的加上前缀（和模板一样） */
  const inserts = (frag.inserts || []).map(function (x) { return x.node ? Object.assign({}, x, { node: Object.assign({}, x.node, { title: pdlText(x.node.title), icon: ns(x.node.icon) }) }) : x; });
  /* 内置模块的插入就是主题的一部分：登记时直接放进主题声明（不带 ins，不随插件重算） */
  if (!pk) inserts.forEach(function (x) { if (!pdlInsertOne(pdlTreeIndex(), x, Object.assign({ id: x.id }, x.node))) throw new Error('builtin insert ' + x.id + ' found no anchor'); });
  if (pk) {
    PDL_PLUGIN_FRAGS[pk] = Object.assign({}, frag, { inserts: inserts });
    PDL_PLUGINS.push(pk);
    if (frag.inserts) pdlTreeChanged(); else renderForget();   /* 定义变了：上一次画的都作废 */
  }
}
/* 插件装上、更新、卸下时应用重读片段：先撤掉它登记过的（按它登记的片段逐项撤），再按新片段登记。
   图标和文案在插件自己的命名空间里，留着不会被引用，重新登记时覆盖 */
function pdlUnregister(pk) {
  const frag = PDL_PLUGIN_FRAGS[pk]; if (!frag) return;
  Object.keys(frag.views || {}).forEach(function (id) { if (PDL_VIEWS[id] && PDL_VIEWS[id].plugin === pk) delete PDL_VIEWS[id]; });
  Object.keys(frag.rows || {}).forEach(function (id) { delete PDL_ROWS[id]; });
  Object.keys(frag.popups || {}).forEach(function (k) { delete PDL_POPUPS[k]; delete POPUPS[k]; delete S.popOn[k]; });
  Object.keys(PDL_SLOT_ITEMS).forEach(function (slot) { PDL_SLOT_ITEMS[slot] = PDL_SLOT_ITEMS[slot].filter(function (x) { return x.plugin !== pk; }); });
  [PDL_PLUGIN_REQ, PDL_PLUGIN_FRAGS, PDL_SLOT_REJECTS].forEach(function (m) { delete m[pk]; });
  delete WHEN['plugin.' + pk]; delete PDL_PLUGIN_LOADED[pk];
  PDL_PLUGINS.splice(PDL_PLUGINS.indexOf(pk), 1);
  if (frag.inserts) pdlTreeChanged(); else renderForget();   /* 从主题文档重算一遍（用户放过的插件节点还是引用，插件回来时回到原处） */
}
/* ═════════════ 插入点═════════════
   插件把自己的节点插进这棵树（容器树、内容容器、视图、消息模板、行模板；按树算，和屏幕上画没画出来无关）。
   定位：anchor 是一个公开的节点 id——容器 id、入口 id、块的字面 key、动作名 act；with 是一组条件（都要成立），每条
   { anchors（其中之一）, direction: up | down | any, depth }。depth 全文一种数法：0 是锚点所在的容器（锚点本身是容器时就是它自己），
   往上每层加 1，超过根就停在根。插入：at before | after 相对锚点本身；inside 放进它（after: 兄弟 id，那个兄弟不在时按 id 字典序）；
   写了 depth 时参照点换成往上第 depth 层的容器。命中几处插几处，同一个容器只插一次；一处都没有就用 fallback，还没有就跳过并记下。
   插进来的节点带 ins 和 key（都是 plugin:<插件>/<节点 id>），只在运行时的树上——每次插件登记 / 撤销都先拿掉再从头插；
   用户挪过它（自定义主题里有 { ref: 它 }）就放在用户放的地方。 */
const PDL_INS_LISTS = ['kids', 'blocks', 'items', 'rows', 'ctls', 'body', 'side', 'lanes'];
/* 树的索引：每个节点 { node, list（它所在的数组；经对象属性挂着的为 null）, up（它的容器）, rid（登记表里的根：它的登记 id） }。
   共用的模板对象在每个用到它的地方各算一次；一条祖先链上同一个对象只走一次 */
function pdlTreeIndex() {
  const all = [], roots = new Set();
  const walk = function (x, up, path) {
    Object.keys(x).forEach(function (k) {
      const v = x[k], one = function (y, list) { if (path.has(y)) return; const e = { node: y, list: list, up: up }; all.push(e); path.add(y); walk(y, e, path); path.delete(y); };
      if (Array.isArray(v)) v.forEach(function (y) { if (y && typeof y === 'object' && !Array.isArray(y)) one(y, v); });
      else if (v && typeof v === 'object' && !path.has(v)) { if (v.type) one(v, null); else { path.add(v); walk(v, up, path); path.delete(v); } }
    });
  };
  const root = function (n, rid) { if (!n || typeof n !== 'object' || roots.has(n)) return; roots.add(n); const e = { node: n, list: null, up: null, rid: rid }; all.push(e); walk(n, e, new Set([n])); };
  root(pdlTree(), null);
  [PDL_SLOTS, PDL_VIEWS, PDL_NODES, PDL_ROWS].forEach(function (reg) { Object.keys(reg).forEach(function (id) { if (!reg[id].cardinality) root(reg[id], id); }); });   /* 带基数的是模板登记（按类型取模板），不是树上的容器 */
  return all;
}
function pdlLeafName(n) { const lit = function (v) { return typeof v === 'string' && !/^[@$]/.test(v) ? v : null; }; return [lit(n.key), lit(n.act), lit(n.id)]; }
function pdlEName(e) { return pdlLeafName(e.node).concat(e.rid ? [e.rid] : []); }
function pdlNamed(e, names) { const ns = pdlEName(e); return names.some(function (x) { return ns.indexOf(x) >= 0; }); }
function pdlIsBox(n) { return PDL_INS_LISTS.some(function (k) { return Array.isArray(n[k]); }); }
/* 第 depth 层的容器：0 是锚点所在的容器（锚点本身是容器时就是它自己），超过根停在根 */
function pdlLevel(e, depth) { let c = pdlIsBox(e.node) ? e : e.up || e; for (let i = 0; i < (depth || 0) && c.up; i++) c = c.up; return c; }
function pdlWithin(e, scope, depth) { let x = e.up; for (let d = 0; x && (depth == null || d <= depth); d++, x = x.up) if (x === scope) return true; return false; }
function pdlWithOk(all, e, cond) {
  const c0 = pdlLevel(e, 0), depth = cond.depth || 0, dir = cond.direction || 'up', names = [].concat(cond.anchors || []);
  return all.some(function (o) {
    if (o === e || !pdlNamed(o, names)) return false;
    const upOk = (dir === 'up' || dir === 'any') && pdlWithin(o, pdlLevel(e, depth));
    const downOk = (dir === 'down' || dir === 'any') && pdlWithin(o, c0, depth);
    return upOk || downOk;
  });
}
function pdlAnchorFind(all, spec) {
  return all.filter(function (e) { return pdlNamed(e, [spec.anchor]) && (spec.with || []).every(function (c) { return pdlWithOk(all, e, c); }); });
}
function pdlInsertOne(all, ins, node) {
  const hits = pdlAnchorFind(all, ins), done = new Set();
  hits.forEach(function (e) {
    const ref = ins.depth == null ? e : pdlLevel(e, ins.depth);
    const list = ins.at === 'inside' ? ref.node[ins.part || PDL_INS_LISTS.find(function (k) { return Array.isArray(ref.node[k]); })] : ref.list;   /* part：组件的哪一部分（块列表属性，比如消息的 below） */
    if (!list || done.has(list)) return; done.add(list);
    const copy = pdlClone(node);
    if (ins.at === 'inside') pdlKidsPlace(list, copy, ins.after);
    else { const i = list.indexOf(ref.node); list.splice(ins.at === 'before' ? i : i + 1, 0, copy); }
  });
  return done.size;
}
function pdlInsertsApply() {
  pdlTreeIndex().forEach(function (e) { const i = e.node.ins && e.list ? e.list.indexOf(e.node) : -1; if (i >= 0) e.list.splice(i, 1); });
  Object.keys(PDL_INSERT_SKIPS).forEach(function (pk) { delete PDL_INSERT_SKIPS[pk]; });
  const all = PDL_PLUGINS.slice().sort().reduce(function (a, pk) {
    return a.concat((PDL_PLUGIN_FRAGS[pk].inserts || []).map(function (x) { return { pk: pk, ins: x }; }));
  }, []).sort(function (a, b) { return (a.ins.priority || 100) - (b.ins.priority || 100); });
  all.forEach(function (x) {
    const pk = x.pk, ins = x.ins, ref = 'plugin:' + pk + '/' + ins.id;
    const node = Object.assign({}, ins.node, { ins: ref, key: ref, id: ref, plugin: pk });
    const tree = pdlTreeIndex(), mine = tree.filter(function (e) { return e.node.ref === ref && e.list; });
    if (mine.length) { mine.forEach(function (e) { const own = Object.assign({}, e.node); delete own.ref; e.list.splice(e.list.indexOf(e.node), 1, Object.assign(pdlClone(node), own)); }); return; }   /* 用户放过它：放在用户放的地方，用户改的属性（隐藏、格子、名字、开到哪）照旧 */
    if (pdlInsertOne(tree, ins, node)) return;
    if (ins.fallback && pdlInsertOne(tree, Object.assign({ id: ins.id }, ins.fallback), node)) return;
    if (ENGINE_PARTS.pluginLoad && !PDL_PLUGIN_FRAGS[pk].loaded) return;   /* 锚点可能在它还没取回的子树里：取回后重算，在那之前不算找不到 */
    (PDL_INSERT_SKIPS[pk] = PDL_INSERT_SKIPS[pk] || []).push({ id: ins.id, anchor: ins.anchor, reason: 'missing' });
  });
  pdlEntryReset();
  PV_LOC.lang = null;   /* 本地化的副本按节点缓存：树变了重新取 */
}

/* ═════════════ 加载规则（主题声明完之后调用；声明在 theme/<主题>/layout.js，规则在引擎） ═════════════ */
/* 节点模板用“插槽/键”声明归属，进入对应的 keyed 插槽。 */
function pdlNodeSlots() { Object.keys(PDL_NODES).forEach(function (k) { const at = k.indexOf('/'); if (at < 0) return; const slot = k.slice(0, at), key = k.slice(at + 1); pdlContribute(slot, { id: 'core/' + key, key: key, node: PDL_NODES[k] }); }); }
/* ═════════════ 摆放 ═════════════ */
function pdlClone(o) { return JSON.parse(JSON.stringify(o)); }
/* when 可以是多个条件，全部满足才出现 */
/* 条件（一个或一组，都成立才算）：能力条件的名字（WHEN，应用登记），或者对这一处上下文 sc 的条件——'@字段' / '!@字段'（pvOk，比如消息操作的“这条是成员发的”）。
   引擎不认条件和字段的名字，它们来自声明 */
function pdlWhen(w, sc) { if (!w) return true; return (Array.isArray(w) ? w : [w]).every(function (x) { if (/^!?@/.test(x)) return pvOk(x, sc || {}, sc || {}); return WHEN[x] ? !!WHEN[x]() : false; }); }
S.pdlSkin = 'default';   /* 由当前主题决定（pdl-doc.js 的 pdlThemeSync） */
/* ═════════════ 界面树：区域 → 容器 → 操作组 → 项（同一棵树服务三件事：用户编辑、插件定位、显示 / 隐藏） ═════════════
   由 PDL 本身生成（布局里的区域、外壳插槽、页面描述里带 key 的块、页面插槽），不是手写的清单。 */
const PDL_REGION_ESSENTIAL = { rail: true, main: true };   /* 窄栏（设置入口在这）和主区不能隐藏 */
function pdlViewNodes(blocks, out) {
  (blocks || []).forEach(function (b) {
    if (!b || typeof b !== 'object') return;
    const here = b.key ? { key: b.key, kind: b.kind || 'action', essential: !!b.essential, locked: !!b.locked, label: b.key, children: [] } : null;
    const kids = here ? here.children : out;
    if (b.type === 'view' && PDL_VIEWS[b.id]) pdlViewNodes(PDL_VIEWS[b.id].blocks, kids);
    if (b.type === 'slot' && PDL_SLOTS[b.slot]) { if (here) here.slot = b.slot; }
    ['blocks', 'items', 'head', 'bar', 'top', 'body', 'dock', 'side'].forEach(function (f) { if (Array.isArray(b[f])) pdlViewNodes(b[f], kids); });
    if (Array.isArray(b.lanes)) b.lanes.forEach(function (l) { pdlViewNodes(l.items, kids); });
    if (here) out.push(here);
  });
  return out;
}
function pdlNodeTree() {
  const slotNode = function (s) {
    const d = PDL_SLOTS[s];
    return { key: s, kind: d.scope ? 'actions' : 'container', label: null, title: d.label, slot: s,
      children: (d.kids || []).filter(function (n) { return !n.type && !n.ref; }).map(function (n) { const k = pdlId(n); return { key: k, kind: pdlKindOf(k), title: n.title, essential: !!n.essential || !!n.move, plugin: n.plugin || null, children: [] }; }) };
  };
  /* 区域里的节点：区域声明了 nodes { view, slots }（这个区域代表的那一页的视图、页里的插槽）就是那一页的节点 + 这些插槽；否则是这个布局容器用 slots 声明的内容容器 */
  return pdlLayout().order.map(function (r) {
    const rd = pdlLayout().regions[r], nd = rd.nodes, box = pdlNode(r) || {};
    const kids = nd ? pdlViewNodes(PDL_VIEWS[nd.view].blocks, []).concat((nd.slots || []).map(slotNode)) : (box.slots || []).filter(function (s) { return PDL_SLOTS[s]; }).map(slotNode);
    return { key: 'region:' + r, kind: 'region', title: rd.label, essential: true, children: kids };
  });
}
function pdlNodeFind(key, nodes) { for (const n of nodes || pdlNodeTree()) { if (n.key === key) return n; const f = pdlNodeFind(key, n.children); if (f) return f; } return null; }
/* 隐藏：节点自己的 hidden（不是删除：升级、恢复都只是把开关打开）。必要元素永远不隐藏 */
A.pdlHideToggle = function (d) {
  const k = d.k, n = pdlNodeFind(k); if (!n || n.essential) return;
  pdlNodeSet(k, { hidden: pdlNodeHidden(k) ? null : true });
  render(true);
};

/* 插件加进菜单插槽的项：交给菜单（宿主自己的项写在 MENU_FNS 里） */
function pdlMenuItems(slot, data) {
  if (pdlNodeHidden(slot)) return [];
  return pdlKids(slot).map(function (id) {
    const e = pdlEntry(id); if (!e || !pdlWhen(e.when) || pdlNodeHidden(id)) return null;
    return { label: e.title, act: e.open.action, data: Object.assign({ entry: id }, e.open.args, data || {}) };
  }).filter(Boolean);
}
/* 分组标题：键是稳定的 '#键'，显示文字是节点的 label（用户改过的），否则来自文案包；用户自己加的标题（文案包里没有）直接显示键后面的字 */
function pdlHeadLabel(id) {
  const own = (pdlEntry(id) || {}).label; if (own) return own;
  const k = 'pdlDoc.heads.' + id.slice(1), v = tc(k); return v === k ? id.slice(1) : v;
}
/* 窄栏里有没有这个入口（它自己，或指向它的引用按钮） */
function pdlRailRef(id) { return ['rail.top', 'rail.bottom'].map(function (s) { return (PDL_SLOTS[s].kids || []).find(function (n) { return n.id === id || n.ref === id; }); }).find(Boolean) || null; }
function pdlInRail(id) { return !!pdlRailRef(id); }

/* ═════════════ 渲染 ═════════════ */
/* frame：插件界面在哪个区域打开（main 整页、overlay 浮窗、panel 右侧工作台） */
/* ═════════════ 布局：逻辑区域（两层：默认 → 覆盖；渲染只用合并后的结果） ═════════════
   默认：区域的顺序和属性（工作台是标签式区域）；皮肤的布局数据叠在上面。区域的先后就是容器树的先后（pdlTree，自定义主题里整棵存）；
   入口开到哪写在入口（和它所在的容器）上（pdlOpenOf）。
   区域顺序在编辑布局里拖区域顶上的把手调整（区域是同级节点之间换位置，里面的东西跟着走）；窄栏放着设置入口，固定不动。
   受保护区域 = 放着设置入口的那个区域（由摆放推出，不按位置写死），永远不能被占用。 */
const PDL_LAYOUT = {};
/* 空间（第二栏显示什么）：主页 home、属于它的路由 routes（prefix：插件页面的路由前缀）；没列出的路由属于 fallback 空间。
   start：打开时进入它的主页；threadView：显示当前对话的路由；panel：工作台在这个空间里（threadRoutes：跟着对话的面板在哪些路由显示）；own：进出它的路由就换空间 */
const PDL_SPACES = {};
const PDL_LAYOUT_SKINS = {};   /* 皮肤自己的布局数据（区域顺序、入口在哪打开）；返回带不带上一层的标题不是皮肤的开关，按容器 / 打开方式声明 */
/* 结构页里加的容器（容器树上不在默认树里的）：它用 slots 声明自己的内容容器 ct:<键>（在自定义主题里），编辑布局时可以把入口拖进来 */
function pdlTreeWalk(n, f, p) { f(n, p); (n.kids || []).forEach(function (k) { pdlTreeWalk(k, f, n); }); }
function pdlTreeBuiltin(k) { let hit = false; pdlTreeWalk(PDL_LAYOUT.tree, function (n) { if (n.key === k) hit = true; }); return hit; }
/* ───────── 结构（主题计算器的“结构”页编辑的容器树）─────────
   只编辑容器：加、删（只有空的能删）、移动 / 换父容器、属性（名字、方向、在父容器里的份额）。元素只在页面的编辑布局里移动，从不删除。
   锁（都由声明推出，不认名字）：空间的结构（空间容器 = 分组标题，页面容器 = 详情）锁住；内置容器只能在父容器里换顺序（它们的画法和位置有关），用户加的容器可以换父容器。
   每次编辑都是对当前主题文档的一次编辑（系统主题先自动复制，带撤销） */
function pdlCtInfo(k) {
  const t = pdlTree(); let node = null, parent = null;
  pdlTreeWalk(t, function (n, p) { if (n.key === k) { node = n; parent = p; } });
  if (!node) return null;
  const builtin = pdlTreeBuiltin(k), entries = pdlKids('ct:' + k).length;
  const locked = !!node.space || !!node.pages || !parent;
  const accepts = !builtin || (node.kids && node.kids.length > 0);   /* 能放子容器：用户加的盒子、内置的布局容器（有子容器的） */
  const empty = !builtin && !(node.kids && node.kids.length) && !entries;
  const hosts = pdlEntryIds().filter(function (id) { const e = pdlEntry(id), o = e.open && !e.open.ref && !e.ref ? pdlOpenOf(id) : null; return o && o.target === k; });   /* 开在这里的按钮（真声明；引用跟着真声明） */
  return { node: node, parent: parent, builtin: builtin, locked: locked, accepts: accepts, empty: empty, hosts: hosts,
    whyDel: locked ? tc('structure.whyLocked') : !empty ? tc('structure.whyNotEmpty') : hosts.length ? tc('structure.whyHosting') : '',   /* 内置容器放着内置内容，永远不空；有按钮开在这里的先迁移承载 */
    whyMove: locked ? tc('structure.whyLocked') : '' };
}
function pdlTreeEdit(fn, also) {
  const t = pdlClone(pdlTree()); fn(t);
  pdlDocEdit(function (full) { full.layout = Object.assign({}, full.layout || {}, { tree: t }); if (also) also(full); });
  pdlTreeChanged();
}
function pdlTreeFind(t, k) { let r = null; pdlTreeWalk(t, function (n, p) { if (n.key === k) r = { n: n, p: p }; }); return r; }
/* 加一个子容器（空的：页面上不占地方，编辑布局时是虚线的落点） */
function pdlCtAdd(parentKey) {
  const info = pdlCtInfo(parentKey); if (!info || !info.accepts) return null;
  const key = 'c' + Date.now().toString(36); let n = 1; pdlTreeWalk(pdlTree(), function (x) { if (!pdlTreeBuiltin(x.key)) n += 1; });
  const label = tc('structure.newName', n);
  pdlTreeEdit(function (t) { const f = pdlTreeFind(t, parentKey); f.n.kids = (f.n.kids || []).concat([{ key: key, label: label, dir: 'column', span: 'fit', hideEmpty: true, slots: ['ct:' + key] }]); },
    function (full) { full.slots = full.slots || {}; full.slots['ct:' + key] = { display: 'icon', label: label, accepts: '*', kids: [] }; });
  return key;
}
function pdlCtDel(k) { const info = pdlCtInfo(k); if (!info || info.whyDel) return false; pdlTreeEdit(function (t) { const f = pdlTreeFind(t, k); f.p.kids = f.p.kids.filter(function (x) { return x.key !== k; }); }, function (full) { if (full.slots) delete full.slots['ct:' + k]; }); return true; }
/* 移动：放到 target 的前面 / 后面（同一个父容器里换顺序，或者换父容器）或里面（成为它的最后一个子容器） */
function pdlCtMoveWhy(k, target, zone) {
  const a = pdlCtInfo(k), b = pdlCtInfo(target); if (!a || !b || k === target) return 'x';
  if (a.whyMove) return a.whyMove;
  let inside = false; pdlTreeWalk(a.node, function (n) { if (n.key === target) inside = true; }); if (inside) return 'x';
  const parent = zone === 'inside' ? b.node : b.parent; if (!parent) return 'x';
  if (zone === 'inside' && !b.accepts) return tc('structure.whyNoKids');
  if (a.builtin && parent.key !== a.parent.key) return tc('structure.whyBuiltinMove');
  return '';
}
function pdlCtMove(k, target, zone) {
  if (pdlCtMoveWhy(k, target, zone)) return false;
  pdlTreeEdit(function (t) {
    const f = pdlTreeFind(t, k); f.p.kids = f.p.kids.filter(function (x) { return x.key !== k; });
    const g = pdlTreeFind(t, target);
    if (zone === 'inside') { g.n.kids = (g.n.kids || []).concat([f.n]); return; }
    const sib = g.p.kids, i = sib.indexOf(g.n); sib.splice(zone === 'after' ? i + 1 : i, 0, f.n);
  });
  return true;
}
/* 单个按钮改开到哪（迁移承载也是它）：改的是按钮自己的 open（锚点 = 选的容器，层级 0），在当前主题文档里 */
function pdlOpenRebind(id, to) {
  const e = pdlEntry(id), o = pdlOpenOf(id); if (!e || !o || o.forced) return false;
  const open = Object.assign({}, e.open, { anchor: to, as: o.as }); delete open.depth;
  pdlNodeSet(id, { open: open });
  return true;
}
function pdlCtSet(k, props) { pdlTreeEdit(function (t) { const f = pdlTreeFind(t, k); Object.assign(f.n, props); }); }
/* 当前主题文档里的布局覆盖（只读这里；改的时候走 pdlDocEdit，在系统主题上会先复制出自定义主题） */
function pdlLayoutMerge(base, ov) {
  if (!ov) return base;
  if (ov.order) base.order = ov.order.slice();
  Object.keys(ov.regions || {}).forEach(function (k) { base.regions[k] = Object.assign({}, base.regions[k] || {}, ov.regions[k]); });
  return base;
}
function pdlLayout() {
  const L = pdlLayoutMerge(pdlClone(PDL_LAYOUT), PDL_LAYOUT_SKINS[S.pdlSkin] || null);
  /* 区域的顺序就是它们在生效的容器树里的先后（用户拖区域 = 改树，pdlTreeOrder） */
  const order = []; pdlTreeWalk(pdlTree(), function (n) { if (L.order.indexOf(n.key) >= 0 && order.indexOf(n.key) < 0) order.push(n.key); });
  L.order = order.concat(L.order.filter(function (k) { return order.indexOf(k) < 0; }));
  return L;
}
/* 生效的容器树：当前主题文档里的（full.layout.tree：结构页、编辑布局拖区域都改它）或默认的。结果按主题文档缓存（主题换了 / 文档改了就作废） */
let PDL_TREE_C = null;
function pdlTreeReset() { PDL_TREE_C = null; }
PDL_THEME_SYNC.push(pdlTreeReset);
function pdlTree() {
  if (PDL_TREE_C) return PDL_TREE_C;
  const f = S.pdlDoc && S.pdlDoc.full, ut = f && f.layout && f.layout.tree;
  return (PDL_TREE_C = pdlClone(ut || PDL_LAYOUT.tree));
}
/* 编辑布局拖区域：按拖完的顺序（区域键，跨了 flat 容器）重排树里每一层的孩子 */
function pdlTreeOrder(list) {
  const keys = function (n) { return [n.key].concat([].concat.apply([], (n.kids || []).map(keys))); };
  const sortKids = function (n) {
    (n.kids || []).forEach(sortKids);
    if (!n.kids) return;
    const rank = function (k) { const xs = keys(k).map(function (x) { return list.indexOf(x); }).filter(function (i) { return i >= 0; }); return xs.length ? Math.min.apply(null, xs) : -1; };
    const ranked = n.kids.filter(function (k) { return rank(k) >= 0; }).sort(function (a, b) { return rank(a) - rank(b); });
    let i = 0; n.kids = n.kids.map(function (k) { return rank(k) >= 0 ? ranked[i++] : k; });
  };
  pdlTreeEdit(sortKids);
}
/* ═════════════ 打开═════════════
   入口的 open：{ page | view | frame | space | action, anchor?, depth?, as? } 或 { ref: 另一个入口, args? }。开到哪写在触发它的入口上：
   入口自己写了 anchor / depth / as 就用它；没写用所在容器（内容容器，或放它的布局容器）声明的 opens；容器的 opens 带 force 时一律按容器的。
   anchor 是一个 id（入口、内容容器、布局容器），depth 从锚点所在的容器往上数（锚点是容器时就是它自己），超过根停在根。
   as：cover 进目标容器的叠（导航，返回照通用返回）；beside 和它的兄弟并排（标签式容器里是一项）；float 进弹窗栈。
   没有触发者的节点（只从地址进来的）用它自己声明的 open。 */
/* 从锚点往外的容器链：内容容器 → 放它的布局容器 → …；锚点在视图里时顺着声明树往上（只算容器），出了视图的根接上触发元素所在的布局容器链 */
function pdlOpenChain(anchor, el) {
  const out = [];
  let box = null;
  if (pdlSlotDef(anchor)) { out.push(anchor); box = pdlSlotBox(anchor); }
  else if (pdlSlotOf(anchor)) { const s = pdlSlotOf(anchor); out.push(s); box = pdlSlotBox(s); }
  else if (ctNode(anchor)) box = anchor;
  else {
    const hit = pdlTreeIndex().find(function (e) { return pdlNamed(e, [anchor]); }); if (!hit) return out;
    for (let x = pdlIsBox(hit.node) ? hit : hit.up; x && !x.rid; x = x.up) if (pdlIsBox(x.node) && x.node.key) out.push(x.node.key);
    return out.concat(el ? trigChain(el).chain : ctAnc(ctPages()));
  }
  for (let c = box; c; c = ctParent(c)) out.push(c);
  return out;
}
function pdlOpenTarget(spec, el) {
  const chain = pdlOpenChain(spec.anchor, el); if (!chain.length) return ctPages();
  const c = chain[Math.min(spec.depth || 0, chain.length - 1)];
  return pdlSlotDef(c) ? pdlSlotBox(c) || ctPages() : c;   /* 内容容器自己没有叠：开进放它的布局容器 */
}
function pdlOpenOf(id, el) {
  const e = pdlEntry(id); if (!e || !e.open) return null;
  let o = Object.assign({}, e.open), owner = id;
  if (o.ref) { const t = pdlEntry(o.ref); if (!t || !t.open) return null; owner = o.ref; o = Object.assign({}, t.open, o.args ? { args: Object.assign({}, t.open.args, o.args) } : {}); }   /* 引用：照真声明打开，参数可以覆盖 */
  if (o.action || o.space) return o;
  const slot = pdlSlotOf(owner), box = slot && pdlSlotBox(slot), rule = ((slot && pdlSlotDef(slot)) || {}).opens || (box && (pdlNode(box) || {}).opens) || null;
  const own = o.as || o.anchor ? { anchor: o.anchor || owner, depth: o.depth, as: o.as } : null;
  const use = rule && rule.force ? rule : own || rule || { anchor: ctPages(), as: 'cover' };
  o.as = use.as || 'cover'; o.target = use.as === 'float' ? null : pdlOpenTarget(use, el); o.forced = !!(rule && rule.force);
  if (o.node && PDL_VIEWS[o.node]) { const n = PDL_VIEWS[o.node]; o.focus = !!n.focus; o.popup = n.popup || null; }
  return o;
}
/* 一个页面的真声明：打开它的那个入口（不是引用）；没有就是 null（页面开到页面容器） */
function pdlPageDecl(page) { return pdlEntryIds().find(function (id) { const o = (pdlEntry(id) || {}).open || {}; return o.page === page && !o.ref; }) || null; }
/* 一个节点归哪个入口（谁打开它）；没有就用它自己声明的 open */
function pdlNodeOwner(n) { return pdlEntryIds().find(function (id) { const o = (pdlEntry(id) || {}).open || {}; return o.node === n && !o.ref; }) || null; }
function pdlNodeOpen(n) { const owner = pdlNodeOwner(n); if (owner) return pdlOpenOf(owner); const own = (PDL_VIEWS[n] || {}).open; return own ? Object.assign({ node: n, as: own.as || 'cover', target: own.as === 'float' ? null : pdlOpenTarget(own) }) : { node: n, as: 'cover', target: ctPages() }; }
function pdlNodeCur(n, o) {
  if (o.as === 'float') return !!S.popOn[o.popup];
  if (REGION_TABS[o.target]) return rtCur(o.target) === n;   /* 开进标签式容器：那一项就是它 */
  return !!navFrameAt('node:' + n);
}
function pdlCur(id) {
  const e = pdlEntry(id), o = pdlOpenOf(id); if (!o) return false;
  if (o.space) return space() === o.space;
  if (o.node && PDL_VIEWS[o.node]) return pdlNodeCur(o.node, o);
  if (REGION_TABS[o.target]) return rtCur(o.target) === (o.node || ENGINE_PARTS.rtPageKey(o.target, id));
  if (o.page) return S.route === o.page || (e.also || []).indexOf(S.route) >= 0;
  if (o.action && e.on) return !!S[e.on];
  return false;
}
/* 行插槽：给出这一行的操作（交给 lrow 的 acts） */
function pdlNeed(n, c) { return (Array.isArray(n) ? n : n ? [n] : []).every(function (k) { return k[0] === '!' ? !c[k.slice(1)] : !!c[k]; }); }
function pdlFill(t, c) { return t.replace(/\{(\w+)\}/g, function (_, k) { return c[k] == null ? '' : c[k]; }); }
function pdlActs(slot, c) {
  return pdlKids(slot).map(function (id) {
    const e = pdlEntry(id); if (!e || !pdlWhen(e.when) || !pdlNeed(e.need, c)) return null;
    /* 守卫给原因（数据）；入口声明了 why 时按它写成字（行上下文 + guard = 守卫给的原因） */
    const g = e.guard && PDL_GUARDS[e.guard[0]] ? PDL_GUARDS[e.guard[0]](c, e.guard[1]) : '', why = g && e.why ? pv(e.why, Object.assign({}, c, { guard: g }), c) : g || '';
    const data = Object.keys(e.args || {}).map(function (a) { return ' data-' + a + '="' + h(c[e.args[a]] == null ? '' : c[e.args[a]]) + '"'; }).join('') + (e.plugin ? ' data-entry="' + id + '"' : '');
    return { label: pdlFill(e.title, c), icon: e.icon, act: e.open.action, data: argAttrs(e.open.args) + data, why: why };
  }).filter(Boolean);
}
/* 标签式容器的工具菜单（布局声明 chrome.tools，比如工作台的启动面板）：里面的页面入口变成容器里的一项（组件库的 rtPage），
   打开 frame 的入口在插件启用时登记成一项，停用 / 挪出去时拿掉（正开着就收起容器） */
const PANEL_FRAMES = {};   /* 标签式容器 → 这一轮登记成一项的 frame 键（下一轮不在了就拿掉） */
function pdlPanelSync() {
  Object.keys(REGION_TABS).forEach(function (r) {
    const slot = rtCfg(r).tools; if (!slot) return;
    const list = pdlKids(slot), now = {};
    ENGINE_PARTS.rtPagePrune(r, pdlEntryIds().filter(function (id) { const o = pdlOpenOf(id); return o && o.target === r && !pdlNodeHidden(id); }));   /* 不再开到这里的入口：它的项收起 */
    list.forEach(function (id) { const e = pdlEntry(id); if (e && e.open && e.open.page && pdlWhen(e.when) && !pdlNodeHidden(id)) ENGINE_PARTS.rtPage(r, id); });
    /* 开到这个容器的节点（入口放在哪都一样：开到哪由入口决定）：登记成一项，键是节点 id */
    pdlEntryIds().forEach(function (id) {
      const e = pdlEntry(id), n = e && e.open && !e.open.ref && e.open.node, nd = n && PDL_VIEWS[n]; if (!nd || !pdlWhen(e.when) || pdlNodeHidden(id)) return;
      const o = pdlOpenOf(id); if (!o || o.target !== r) return;
      now[n] = true; if (!PANEL_VIEWS[n]) PANEL_VIEWS[n] = nd.panel || [e.title, e.icon, '', e.group || rtCfg(r).pageGroup, ''];
    });
    Object.keys(PANEL_FRAMES[r] || {}).forEach(function (vk) { if (!now[vk]) { delete PANEL_VIEWS[vk]; if (rtCur(r) === vk) navTabs(r).open = false; } });
    PANEL_FRAMES[r] = now;
  });
}
beforeRender(pdlPanelSync);


/* ═════════════ 动作 ═════════════ */
/* 声明里不是参数的键（打开到哪、怎么开） */
const OPEN_KEYS = { ref: 1, page: 1, node: 1, backLabel: 1, action: 1, space: 1, anchor: 1, depth: 1, as: 1, exit: 1, path: 1, v: 1, cast: 1, from: 1, entry: 1 };   /* from / entry：触发者在哪个插槽里、它是哪个入口（编辑布局用），不是参数 */
function pdlOpenSpec(d, el) {
  if (el === undefined) el = ACT_FROM;   /* 程序里的打开：按正在处理的那次操作的触发者算 */
  const args = {}; Object.keys(d).forEach(function (k) { if (!OPEN_KEYS[k]) args[k] = d[k]; });
  if (d.ref) { const o = pdlOpenOf(d.ref, el); if (!o) return; if (o.space) { spaceOpen(o.space); return; } if (o.action) { actFn(o.action)(Object.assign({}, o.args, args), null); return; } pdlOpenNode(Object.assign({}, o, { args: Object.assign({}, o.args, args) }), el, d.ref); return; }   /* 引用：照真声明打开，参数覆盖同名的 */
  const m = d.page && !PAGES[d.page] && /^([a-zA-Z]+)-(.+)$/.exec(d.page);   /* 页名-参数（地址的写法）：拆开 */
  if (m && PAGES[m[1]]) { d = Object.assign({}, d, { page: m[1] }); args.p = m[2]; }
  if (d.page && !d.anchor) { pagesOpen(d.page, args, el, { ask: true, exit: d.exit ? String(d.exit).split(',') : null }); return; }   /* 页面，没写开在哪：开到页面容器（从内容里开别的空间的页面时盖在原处，见 pagesOpen） */
  const as = d.as || 'cover', target = as === 'float' ? null : pdlOpenTarget({ anchor: d.anchor, depth: d.depth }, el);
  if (d.node && REGION_TABS[target]) { ENGINE_PARTS.openTab(target, d.node); return; }   /* 标签式容器里的一项：和入口打开它同一条路 */
  pdlOpenNode({ page: d.page, node: d.node, args: args, as: as, target: target, exit: d.exit ? String(d.exit).split(',') : null }, el);
}
/* 节点上的事件：入口写 on: { <事件>: { open } }（点击就是入口自己的 open）。声明过的每种事件在文档上只听一次；
   事件落在一个入口（data-entry）上、它声明了这个事件，就照声明打开，触发处是指针所在的点（浮着开的贴着它） */
const PDL_ON = {};
function pdlOnListen() {
  pdlEntryIds().forEach(function (id) { Object.keys((pdlEntry(id) || {}).on || {}).forEach(function (ev) { if (!PDL_ON[ev]) { PDL_ON[ev] = true; document.addEventListener(ev, pdlOnEvent, true); } }); });
}
function pdlOnEvent(e) {
  const el = e.target.closest && e.target.closest('[data-entry]'), d = el && pdlEntry(el.dataset.entry), on = d && pdlWhen(d.when) && d.on && d.on[e.type];
  if (!on || !on.open) return;
  e.preventDefault(); e.stopPropagation();
  spotOpen('point', el, { left: e.clientX, top: e.clientY, width: 1, height: 1 }, function (spot) { pdlOpenSpec(on.open, spot); });
}
/* 打开一个算好的 open（入口、引用、程序里按地址进来的都走这里） */
function pdlOpenNode(o, el, id) {
  const nd = o.node ? PDL_VIEWS[o.node] : null; if (o.node && nd && nd.plugin && !plugOn(nd.plugin)) return;
  if (nd && nd.plugin) pdlPluginNeed(nd.plugin);
  if (o.as === 'float') { S.popOn[nd.popup] = !S.popOn[nd.popup]; render(true); return; }   /* 浮窗之间不互斥（弹窗栈管层级） */
  if (REGION_TABS[o.target]) { rtReveal(o.target, o.node || ENGINE_PARTS.rtPage(o.target, id)); return; }   /* 标签式容器：变成它的一项 */
  const f = nd ? 'node:' + o.node : o.page;
  if (o.as === 'beside') { const on = NAV.on[o.target] = NAV.on[o.target] || []; if (on.indexOf(f) < 0) on.push(f); render(true); return; }   /* 并排：已经开着就不再开一份；关由它自己（close { beside }） */
  if (!ctNode(o.target)) { const c = o.target; navLeave(navIdsFrom(c, 1), function () { navStack(c); navPushRaw(c, f, o.args || {}, navTitleAt(el), false); navAfter(); }); return; }   /* 视图里的容器：压进它自己的叠，返回在它左上角 */
  if (nd) {
    const at = navFrameAt('node:' + o.node);   /* 入口还露在外面时再点一下就关掉 */
    if (at) { if (navDepth(at) > 1) navBack(at); else navClose(at); return; }
    navReset({ popupsOnly: true });
    navOpen({ f: 'node:' + o.node, a: o.args || {}, into: o.target, push: !!nd.focus, exit: o.exit || nd.exit, backLabel: o.backLabel }, el); return;
  }
  if (o.page && o.target === ctPages()) { pagesOpen(o.page, o.args || {}, el, { exit: o.exit }); return; }   /* 主区：只换主区，第二栏不变 */
  if (o.page) navOpen({ f: o.page, a: o.args || {}, into: o.target }, el);
}
/* 切换空间：只有这里改第二栏（空间容器的栈顶）；页面容器切到这个空间上次停的那一页（没去过：它的主页）。切走的空间不销毁，它的页面隐藏着留下（proj.js navHide），回来时原样回来。
   已经在这个空间：回到它的主页 */
function spaceOpen(v) {
  const t = v !== S.space && navSpaceTarget(v);
  if (!t) { go((PDL_SPACES[v] || {}).home || S.route); return; }
  navSwitchC(ctPages(), t.f, t.a, null, false, function () { S.space = v; });
};
/* 关掉一个打开的节点（close { node }）：在栈里就返回一层，在栈底就关掉它所在的覆盖 */
function nodeClose(k) { const at = navFrameAt('node:' + k); if (at) { if (navDepth(at) > 1) navBack(at); else navClose(at); } }
/* 固定到窄栏 / 从窄栏取下（显式添加副本；编辑布局拖动是移动）：在窄栏里（上方或下方）就取下，否则放进上方。k 是入口的规范键。窄栏立即变化就是反馈 */
A.rail = function (d) {
  const id = d.k; if (!pdlEntry(id)) return;
  const n = pdlRailRef(id);
  if (n && n.ref) pdlNodeDrop(n.id); else if (!n) pdlNodeAdd('rail.top', { id: id + '@rail', ref: id });   /* 固定 = 窄栏里放一个引用按钮（它自己在窄栏里的不算固定） */
  render(true);
};
/* 查看页面描述（主题计算器 ⋯）：对话框里是生效的 PDL，确认 = 复制（复制不弹提示） */
DIALOGS.pdl = function () {
  return { title: tc('entryLayout.visibility.title'), text: tc('entryLayout.visibility.text'), doc: { json: true, text: JSON.stringify(pdlEffective(), null, 2) }, ok: tc('common.copy'), wide: true, on: function () { copyText(JSON.stringify(pdlEffective(), null, 2)); } };
};
/* 恢复默认布局：能撤回 */
RESETS.layout = { get: function () { return pdlThemes().active; }, set: function (v) { const t = pdlThemes(); t.active = v; pdlThemesSave(t); pdlThemeSync(); }, def: function () { return PDL_SYS_THEMES[0].id; }, text: function () { return tc('entryLayout.reset.toast'); } };

/* ═════════════ 编辑布局 ═════════════
   入口在对话侧栏标题的 ⋯ 菜单里。平时什么都不能拖；进入编辑后，所有看得见的导航容器一起进入编辑（窄栏、侧栏、设置菜单、工作台启动面板），
   编辑条的 × 或 Esc 退出。换空间时一直保持编辑——窄栏在每个空间都在，用它把入口带到另一个空间（先拖到窄栏，再从窄栏拖进新露出来的容器）。
   能拖到哪儿由节点在 PDL 里的种类决定，不按节点单独标：
   - 入口（打开一个页面 / 工具 / 浮窗 / 空间的）：可以跨容器移动；
   - 动作（只执行一个操作的）：只能在自己的容器里调整顺序；
   - 设置菜单里的项：锚定在设置里——拖出去是在新位置放一个快捷方式，原项不动；设置菜单里只能调整分组标题的顺序和分组名；
   - 锁定的（窄栏的品牌标志、设置入口只能在窄栏）不能拿走；
   - 页面内容（表单、表格、设置行、成员详情、面板正文）跟着数据结构走，不在编辑布局的范围里。
   每次调整都是对用户完整布局文档的一次编辑（pdlDocEdit）。 */
function pdlKindOf(id) {
  const e = pdlEntry(id); if (!e) return null;
  if (e.scope) return 'content';
  const o = e.open || {};
  return o.page || o.node || o.space || o.ref || e.on ? 'entry' : 'action';
}
S.editLayout = false;
/* 编辑布局是一个状态（s.editLayout）：进入 = set，结束 = close；body 上的 edit-layout 跟着状态走 */
function editLayoutSync() { document.body.classList.toggle('edit-layout', !!S.editLayout); if (!S.editLayout && S.editLeaf) { S.editLeaf = null; editLeafShow(null); } }   /* 结束编辑：悬停叶子的小标签一起收掉 */
onRender(editLayoutSync);
/* 分组标题改名（编辑布局里）：写进主题文档的 labels */
ENT.navHead = { get: function (id) { return { id: id, name: pdlHeadLabel(id) }; }, title: function () { return tc('pdlDoc.renameTitle'); }, rename: function (x, v) { pdlNodeSet(x.id, { label: v }); } };

/* ───────── 拖动（只在编辑布局时） ─────────
   用的是组件库唯一的拖动机制（core.js 的 EDGE_DRAG，和弹窗框架同一个手势）：可编辑的节点（data-edit）边缘出现移动光标，按住拖；
   编辑布局时点节点本身不做任何事（不会误点进去）。节点的种类决定能放到哪：
   entry 入口 → 任意插槽 / 窄栏的格子 / 工作台；head 分组标题 → 同一插槽里两个分组之间；cell 格子容器里的项 → 同一个容器的任意一格；
   order / region 容器、区域 → 同级之间换位置（兄弟用 FLIP 让位）；tool 工作台工具 → 插槽。 */
const DRAG = { id: null, from: null, head: null };
function dropTarget(e) {
  const slotEl = e.target.closest && e.target.closest('[data-slot]'); if (!slotEl || PDL_SLOTS[slotEl.dataset.slot].scope) return null;
  const horiz = getComputedStyle(slotEl).flexDirection === 'row';
  const kids = Array.prototype.slice.call(slotEl.children).filter(function (k) { return k.dataset.entry || k.dataset.head; });
  let before = null;
  for (const k of kids) { const r = k.getBoundingClientRect(); if (horiz ? e.clientX < r.left + r.width / 2 : e.clientY < r.top + r.height / 2) { before = k; break; } }
  return { slot: slotEl.dataset.slot, el: slotEl, before: before };
}
function clearMarks() { document.querySelectorAll('.drop-before, .drop-end, .pdl-over').forEach(function (x) { x.classList.remove('drop-before', 'drop-end', 'pdl-over'); }); const c = document.getElementById('cell-drop'); if (c) c.remove(); }
function endDrag() { DRAG.id = null; DRAG.from = null; DRAG.head = null; clearMarks(); document.body.classList.remove('pdl-dragging'); const b = document.getElementById('pdl-bin'); if (b) b.remove(); }
/* 一次放下是否允许：返回拒绝的原因（文案键），允许返回 '' */
function pdlDropWhy(id, from, to) {
  if (DRAG.head) return to === from ? '' : 'pdlDoc.settingsFixed';
  if (!pdlMoveOk(id, to)) return 'pdlDoc.stayInContainer';   /* 声明了移动范围（move）的只能在范围里 */
  if (((pdlEntry(id) || pdlNode(id) || {}).scope === 'row') !== (((pdlSlotDef(to) || {}).scope) === 'row')) return 'pdlDoc.stayInContainer';   /* 行里的操作（要行的数据）只进行的容器 */
  if (PDL_SLOTS[to] && PDL_SLOTS[to].accepts === 'page') { const o = pdlOpenOf(id); if (!o || !(o.page || o.node)) return 'pdlDoc.stayInContainer'; }   /* 只收页面的插槽（标签式容器的工具插槽）：只有打开页面 / 视图的入口放得进去 */
  return '';
}
/* 格子容器里鼠标对着哪一格：靠近起始端算从头数，靠近结束端算从尾数（结束端放下的项贴着尾巴，窗口大小变了也贴着） */
function cellAt(box, e, span) {
  const col = box.classList.contains('cells-col'), r = box.getBoundingClientRect(), cs = getComputedStyle(box);
  const size = parseFloat(cs.getPropertyValue('--cell')) || 32, len = col ? r.height : r.width, pos = (col ? e.clientY - r.top : e.clientX - r.left);
  const a0 = parseFloat(col ? cs.paddingTop : cs.paddingLeft) || 0, a1 = parseFloat(col ? cs.paddingBottom : cs.paddingRight) || 0;
  const hit = e.target && e.target.closest && e.target.closest('.citem');   /* 落在别的项上：占它那一格（同一端、同一格号），它往后让 */
  if (hit && hit.parentElement === box) return { anchor: hit.dataset.anchor, cell: +hit.dataset.cell, size: size, col: col, r: r, a0: a0, a1: a1 };
  if (pos < len / 2) return { anchor: 'start', cell: Math.max(0, Math.floor((pos - a0) / size)), size: size, col: col, r: r, a0: a0, a1: a1 };
  return { anchor: 'end', cell: Math.max(0, Math.floor((len - pos - a1) / size) - ((span || 1) - 1)), size: size, col: col, r: r, a0: a0, a1: a1 };
}
/* 落点提示：一块和 span 一样大的高亮，画在那一格上 */
function cellMark(box, at, span) {
  /* 落点画在格子容器里面：从哪一端数第几格、占几格（格号和格宽来自结构），不用页面坐标 */
  let m = document.getElementById('cell-drop'); if (!m || m.parentElement !== box) { if (m) m.remove(); m = document.createElement('div'); m.id = 'cell-drop'; box.appendChild(m); }
  m.className = 'cell-drop ' + at.anchor; m.setAttribute('style', '--u-cell:' + at.cell + ';--u-n:' + (span || 1));
}
/* 放下：位置写进当前主题文档的 cells[容器]（place 操作）；重叠时新放的占位，原来的往后让（cellsResolve） */
function cellPlace(container, key, at) { const cell = { cell: { anchor: at.anchor, cell: at.cell, t: Date.now() } }; const e = pdlTreeIndex().find(function (x) { return pdlNamed(x, [key]); }); if (e && e.up && !pdlNamed(e.up, [container])) pdlNodeMove(key, container, undefined, cell); else pdlNodeSet(key, cell); }   /* 换了格子容器：节点挪过去（带上格子位置） */

/* 入口放下（插槽、窄栏格子、工作台、移出） */
function entryDrop(e) {
  const id = DRAG.id, from = DRAG.from, head = DRAG.head, ent = pdlEntry(id);
  if (e.target.closest && e.target.closest('#pdl-bin')) {   /* 移出：引用按钮删掉；入口隐藏（声明了必要、移动范围的不移出） */
    if (!ent || ent.essential || ent.move) return;
    if (ent.ref) pdlNodeDrop(id); else pdlNodeSet(id, { hidden: true });
    return;
  }
  /* 窄栏：一列格子，放到任意一格；放在起始一半进“上方”，结束一半进“下方” */
  const rail = !head && e.target.closest && e.target.closest('[data-cells="rail"]');
  if (rail) {
    const at = cellAt(rail, e, 1), to = at.anchor === 'start' ? 'rail.top' : 'rail.bottom';
    if (pdlDropWhy(id, from, to)) return;   /* 放不下：回到原处 */
    pdlNodeMove(id, to, undefined, { cell: { anchor: at.anchor, cell: at.cell, t: Date.now() } });
    return;
  }
  const ws = e.target.closest && e.target.closest('[data-tools]');   /* 放进标签式容器：组件声明的落点（data-tools = 容器的工具插槽，比如启动面板、标签条） */
  const t = ws ? null : dropTarget(e), to = ws && !head ? ws.dataset.tools : (t || {}).slot;
  if (!to) return;
  if (pdlDropWhy(id, from, to)) return;   /* 放不下：回到原处 */
  if (ws) {
    const r = pdlSlotBox(to);
    if (from !== to) pdlNodeMove(id, to);
    pdlPanelSync(); rtReveal(r, ENGINE_PARTS.rtPageKey(r, id), { preview: undefined, args: null }); return;
  }
  const beforeKey = t.before ? (t.before.dataset.entry || t.before.dataset.head) : null;
  const kids = pdlKids(to).filter(function (x) { return x !== id; });
  if (head) {   /* 分组标题带着它下面的入口一起移动，只能落在两个分组之间 */
    const list = pdlKids(to), at = list.indexOf(id); let end = at + 1; while (end < list.length && list[end][0] !== '#') end += 1;
    const block = list.slice(at, end), rest = list.filter(function (x) { return block.indexOf(x) < 0; });
    let idx = beforeKey ? rest.indexOf(beforeKey) : rest.length; if (idx < 0) idx = rest.length;
    while (idx > 0 && idx < rest.length && rest[idx][0] !== '#') idx += 1;
    rest.splice.apply(rest, [idx, 0].concat(block)); pdlKidsOrder(to, rest); return;
  }
  const bi = beforeKey ? kids.indexOf(beforeKey) : -1;
  pdlNodeMove(id, to, bi < 0 ? undefined : bi === 0 ? null : kids[bi - 1]);   /* 放在 beforeKey 前面 = 放在它前一个兄弟后面 */
}

/* 拖动中：节点跟着鼠标（translate），自己不挡命中检测；落点用鼠标下面的元素判断 */
function under(e, self) { self.style.pointerEvents = 'none'; const t = document.elementFromPoint(e.clientX, e.clientY); self.style.pointerEvents = ''; return { target: t || document.body, clientX: e.clientX, clientY: e.clientY }; }
EDGE_DRAG.push({
  find: function (t) {
    if (!t || !t.closest) return null;
    const el = t.closest('[data-edit]'); if (!el || el.dataset.locked) return null;
    if (!S.editLayout) { const box = el.dataset.edit === 'order' && el.parentElement && el.parentElement.closest('[data-ocontainer]'); if (!box || !box.dataset.orderAct) return null; }   /* 平时只有会话状态的容器能拖（它声明了顺序存哪：data-order-act）；主题的布局只在编辑布局时动 */
    return { el: el, whole: true };   /* 编辑布局时整块都是抓手（平时的窗口只有边缘） */
  },
  start: function (el, e0) {
    const kind = el.dataset.edit, sx = e0.clientX, sy = e0.clientY;
    const follow = function (e) { el.style.translate = (e.clientX - sx) + 'px ' + (e.clientY - sy) + 'px'; };
    const done = function () { el.style.translate = ''; el.classList.remove('edit-drag'); document.body.classList.remove('pdl-dragging'); editShow(null); };
    el.classList.add('edit-drag'); document.body.classList.add('pdl-dragging');
    /* 拖的时候把“能放在哪”画出来：入口 → 所有接收入口的容器；别的 → 只有它自己的容器（连同格子） */
    editShow(kind === 'entry' || kind === 'tool' ? document.querySelectorAll('[data-slot]:not([data-scope]), [data-cells="rail"], [data-tools]') : [el.closest(kind === 'cell' ? '[data-cells]' : kind === 'head' ? '[data-slot]' : '[data-ocontainer]') || el.parentElement]);
    if (kind === 'entry' || kind === 'head' || kind === 'tool') {
      if (kind === 'head') { DRAG.head = el.dataset.head; DRAG.id = el.dataset.head; DRAG.from = el.dataset.from; }
      else if (kind === 'entry') { DRAG.id = el.dataset.entry; DRAG.from = el.dataset.from || null; }
      else { const slot = el.closest('[data-tools]').dataset.tools; DRAG.id = ENGINE_PARTS.rtPageEntry(pdlSlotBox(slot), el.dataset.k); DRAG.from = slot; }
      if (DRAG.from && !DRAG.head && !document.getElementById('pdl-bin')) document.body.insertAdjacentHTML('beforeend', ENGINE_PARTS.dragBin(tc('entryLayout.actions.dragBin', PDL_SLOTS[DRAG.from].label)));
      return {
        move: function (e) {
          follow(e); clearMarks(); const u = under(e, el);
          const bin = u.target.closest && u.target.closest('#pdl-bin'); if (bin) { bin.classList.add('pdl-over'); return; }
          const rail = !DRAG.head && u.target.closest && u.target.closest('[data-cells="rail"]');
          if (rail) { const at = cellAt(rail, u, 1); if (!pdlDropWhy(DRAG.id, DRAG.from, at.anchor === 'start' ? 'rail.top' : 'rail.bottom')) cellMark(rail, at, 1); return; }
          const ws = u.target.closest && u.target.closest('[data-tools]');
          if (ws && !DRAG.head && !pdlDropWhy(DRAG.id, DRAG.from, ws.dataset.tools)) { ws.classList.add('pdl-over'); return; }
          const t = dropTarget(u); if (!t || pdlDropWhy(DRAG.id, DRAG.from, t.slot)) return;
          if (t.before) t.before.classList.add('drop-before'); else t.el.classList.add('drop-end');
        },
        end: function (e, moved) { const u = under(e, el); done(); if (moved) entryDrop(u); endDrag(); render(true); }
      };
    }
    if (kind === 'cell') {   /* 格子容器里的项：放到任意一格；移动范围（move）允许的话也能放进别的格子容器 */
      const span = +getComputedStyle(el).getPropertyValue('--u-span') || 1, key = el.dataset.ckey;
      let at = null, to = null;
      return {
        move: function (e) { follow(e); const u = under(e, el), b = u.target.closest && u.target.closest('[data-cells]'); clearMarks(); to = b && b.dataset.cells !== 'rail' && !pdlDropWhy(key, null, b.dataset.cells) ? b : null; at = to ? cellAt(to, u, span) : null; if (at) cellMark(to, at, span); },
        end: function (e, moved) { done(); clearMarks(); if (moved && at) cellPlace(to.dataset.cells, key, at); render(true); }
      };
    }
    /* order / region：同级之间换位置（兄弟 FLIP 让位）；放下记一条 order[容器] */
    const box = el.parentElement && el.parentElement.closest('[data-ocontainer]'); if (!box || el.parentElement !== box) { done(); return null; }
    return {
      move: function (e) {
        follow(e); const u = under(e, el);
        let sib = u.target; while (sib && sib.parentElement !== box) sib = sib.parentElement;   /* 鼠标下面属于这个容器的那一个兄弟（里面可能还套着别的可编辑节点） */
        if (!sib || sib === el || !sib.dataset.okey || sib.dataset.locked) return;
        const r = sib.getBoundingClientRect(), horiz = getComputedStyle(box).flexDirection === 'row' || getComputedStyle(box).display === 'grid';
        const after = horiz ? e.clientX > r.left + r.width / 2 : e.clientY > r.top + r.height / 2, ref = after ? sib.nextElementSibling : sib;
        if (ref === el || (ref === el.nextElementSibling && !after)) return;
        el.style.translate = ''; flipMove(box, function () { box.insertBefore(el, ref); });
      },
      end: function (e, moved) {
        done(); if (!moved) return;
        const keys = Array.prototype.slice.call(box.children).filter(function (k) { return k.dataset.okey; }).map(function (k) { return k.dataset.okey; });
        if (box.dataset.orderAct && actFn(box.dataset.orderAct)) { actFn(box.dataset.orderAct)(Object.assign(actionArgs(box), { keys: keys })); return; }   /* 顺序存在别处的容器（工作台的标签是会话状态）：容器声明交给哪个动作 */
        const c = box.dataset.ocontainer;
        if (c === 'app.regions' || c === 'main.split') pdlTreeOrder(keys); else pdlNodeSet(c, { order: keys });   /* 区域 = 改容器树的先后；组件属性排先后的容器 = 节点的 order */
        render(true);
      }
    };
  }
});
/* 编辑布局时悬停一个有公开名字的叶子（格子里的项、插槽里的入口）：叶子下方贴一个小标签，显示它的名字，可以复制它的定位——
   按唯一（名字不唯一时加上最少的 with，层数多留一层余量）或直接（同名的都算）。格子里的项是插入点（inserts）；插槽里的入口用 ops 的路径 */
S.editLeaf = null;
document.addEventListener('mouseover', function (e) {
  if (!S.editLayout || !e.target.closest || e.buttons) return;   /* 拖动中不出标签 */
  const el = e.target.closest('[data-ckey], [data-entry]'); if (!el) return;
  const box = el.closest('[data-cells], [data-slot]'), entry = !el.dataset.ckey;
  const leaf = { name: el.dataset.ckey || el.dataset.entry, entry: entry, within: entry ? el.dataset.from : box ? box.dataset.cells || box.dataset.slot : '' };   /* 入口按它所在的插槽（窄栏的格子合了上下两个插槽） */
  if (S.editLeaf && S.editLeaf.name === leaf.name && S.editLeaf.within === leaf.within) return;
  S.editLeaf = leaf; editLeafShow(null); EDIT_LEAF.t = setTimeout(function () { editLeafShow(el); }, ms('--tip-delay'));   /* 和提示一样停一下才出，换一个叶子先收起 */
});
const EDIT_LEAF = { el: null, t: 0 };
/* 按下（开始拖动、点别处）就收起标签，不挡住拖放的落点 */
document.addEventListener('pointerdown', function (e) { if (S.editLeaf && !(e.target.closest && e.target.closest('.edit-leaf'))) { S.editLeaf = null; editLeafShow(null); } }, true);
function editLeafShow(at) {
  if (!EDIT_LEAF.el) { EDIT_LEAF.el = document.createElement('div'); EDIT_LEAF.el.className = 'edit-leaf'; EDIT_LEAF.el.setAttribute('popover', 'manual'); document.body.appendChild(EDIT_LEAF.el); }
  const t = EDIT_LEAF.el; clearTimeout(EDIT_LEAF.t);
  if (!at) { t.hidePopover(); anchorTo('editLeaf', null); return; }
  if (!S.editLeaf) return;
  t.innerHTML = ENGINE_PARTS.editLeaf(S.editLeaf); t.style.setProperty('--u-anchor', anchorTo('editLeaf', at, function () { editLeafShow(null); })); t.showPopover();
}
function pdlAnchorSpec(leaf, unique) {
  if (leaf.entry) return { anchor: leaf.name, at: 'after' };   /* 入口的 id 全树唯一 */
  const all = pdlTreeIndex(), plain = { anchor: leaf.name }, hits = pdlAnchorFind(all, plain);
  if (!unique || hits.length < 2) return plain;
  const inBox = function (e) { for (let x = e.up; x; x = x.up) if (x.node.key === leaf.within || x.rid === leaf.within) return true; return false; };
  const target = hits.find(inBox) || hits[0], only = function (spec) { const r = pdlAnchorFind(all, spec); return r.length > 0 && r.every(function (x) { return x.node === target.node; }); };
  for (let d = 0; d < 6; d++) {
    const scope = pdlLevel(target, d), names = [];
    all.forEach(function (o) { if (o !== target && scope && pdlWithin(o, scope)) pdlLeafName(o.node).forEach(function (n) { if (n && n !== leaf.name && names.indexOf(n) < 0) names.push(n); }); });
    const hit = names.find(function (n) { return only({ anchor: leaf.name, with: [{ anchors: [n], depth: d }] }); });
    if (hit) return { anchor: leaf.name, with: [{ anchors: [hit], depth: only({ anchor: leaf.name, with: [{ anchors: [hit], depth: d + 1 }] }) ? d + 1 : d }] };
  }
  return plain;
}
/* 编辑布局是只读的：点什么都不打开（不会误点进去、不会误触发），悬停展开、提示也关掉；只有编辑条、弹窗的 ×、分组改名这些编辑控件照常 */
document.addEventListener('click', function (e) {
  if (!S.editLayout || !e.target.closest) return;
  if (e.target.closest('[data-pop="editbar"], .edit-leaf, .pdl-head-act, [data-act="close"][data-popup]')) return;
  e.stopImmediatePropagation(); e.preventDefault();
}, true);
function editShow(list) { document.querySelectorAll('.edit-home').forEach(function (x) { x.classList.remove('edit-home'); }); Array.prototype.forEach.call(list || [], function (x) { if (x) x.classList.add('edit-home'); }); }

/* 系统配置的小节顺序：来自用户文档（页面内容不在编辑布局的范围里，没有拖动入口） */
function sysOrder() { return PDL_PAGES.system.blocks.map(function (b) { return b.id; }); }

/* ═════════════ 生效的描述（agent 读到的就是这个） ═════════════ */
function pdlEffective() {
  const slots = {};
  Object.keys(PDL_SLOTS).forEach(function (s) {
    const d = PDL_SLOTS[s]; if (!d.kids) return;   /* 模板登记（按类型画的）不在这里 */
    const items = pdlKids(s).filter(function (id) { return id && id[0] !== '#'; }).map(function (id) {
      const e = pdlEntry(id);
      if (!e) return { id: id, state: 'unknown' };
      const it = { id: id, title: e.title, open: e.open, when: e.when || null, visible: pdlWhen(e.when), current: pdlCur(id), badge: e.badge && BADGES[e.badge] ? BADGES[e.badge]() : null };
      if (e.move) it.move = e.move; if (e.ref) it.ref = e.ref; if (e.hidden) it.hidden = true;
      return it;
    }).filter(function (it) { const e = pdlEntry(it.id); return !e || !e.plugin || plugOn(e.plugin); }).map(function (it) {
      const e = pdlEntry(it.id);
      if (e) {
        it.from = e.plugin ? 'plugin:' + e.plugin : 'core'; if (e.use) it.use = e.use; if (e.open.node && PDL_VIEWS[e.open.node]) it.node = e.open.node;
        if (d.scope === 'row') { if (e.need) it.need = e.need; if (e.guard) it.guard = e.guard; if (e.args) it.args = e.args; }
      }
      return it;
    });
    slots[s] = { display: d.display, items: items, accepts: d.accepts || '*', itemActions: d.itemActions || [], scope: d.scope || 'shell' };
  });
  const pages = { system: { blocks: sysOrder().map(function (id) { const b = PDL_PAGES.system.blocks.find(function (x) { return x.id === id; }) || {}; return { id: id, when: b.when || null, visible: pdlWhen(b.when) }; }) } };
  return { pdl: '0.1', layout: S.layout || 'three', theme: S.tweaks.skin + '/' + stMode(), route: S.route, tabs: Object.keys(REGION_TABS).reduce(function (o, r) { o[r] = rtCur(r); return o; }, {}), userAdjusted: !!S.pdlDoc,
    rules: ['rules apply above every layer, plugins cannot override'], slots: slots, pages: pages,
    plugins: PDL_PLUGINS.map(function (k) { const f = PDL_PLUGIN_FRAGS[k]; return { id: k, enabled: plugOn(k), inserts: f.inserts || [], insertsSkipped: PDL_INSERT_SKIPS[k] || [], nodes: Object.keys(f.views || {}) }; }),
    merge: ['theme tree', 'custom theme (by id)', 'plugin inserts (priority, then plugin id)'], guards: Object.keys(PDL_GUARDS), slotItems: Object.keys(PDL_SLOT_ITEMS).reduce(function (o, k) { o[k] = { cardinality: PDL_SLOTS[k] && PDL_SLOTS[k].cardinality, items: PDL_SLOT_ITEMS[k].map(function (x) { return { id: x.id, key: x.key || null, match: x.match || null, priority: x.priority, plugin: x.plugin || null, active: pdlWhen(x.when) }; }) }; return o; }, {}), skin: S.pdlSkin, views: pdlViewTree(),
    layout: { defaults: PDL_LAYOUT, skin: PDL_LAYOUT_SKINS[S.pdlSkin] || null, effective: pdlLayout() }, popups: PDL_POPUPS, popupStack: (S.popOrder || []).slice(), projection: navSnapshot(), tree: pdlTree(), space: space() };
}

/* ───────── 标签式区域（布局数据里 tabs: true 的区域）─────────
   宿主画控制条：首页标签 + 打开过的内容（每个一个标签，可固定、可关、预览标签会被下一个预览替换）+ 放不下的“还有 N 个”+ 区域动作；
   内容区上方是通用“返回”。标签状态按区域存，由区域的绑定方提供（rtBind）；控制条的样子和动作来自布局数据 regions[r].chrome。 */

/* ═════════════ 主题的 PDL 数据 ═════════════
   主题是纯数据（主题包的 pdl.json；内置主题由构建从 theme/<主题>/pdl/*.json 生成调用）。按原来的顺序填进各个登记表：
   frags 是有名字的片段，别处写 { $frag: 名 } 引用（加载时换成同一个对象）；视图、行、节点模板里的文案在画的时候取，
   其余部分（入口、面板、分组、配色名……）在这里取一次；{ $panels: 容器 } 是那个标签式容器的工具入口（组件库按面板登记生成）；
   空间的 routesFrom 把这些插槽里入口打开的页面加进它的路由；nav 是空间 → 画第二栏的视图；modules 按内置模块登记 */
const PDL_THEME = {};   /* 当前主题的清单：id、name、version、contractVersion（theme.yaml 去掉 pdl 段） */
function pdlThemeLoad(pdl, manifest) {
  Object.assign(PDL_THEME, manifest);
  const frags = {}, expand = function (x) {
    if (Array.isArray(x)) return x.map(expand);
    if (!x || typeof x !== 'object') return x;
    if (x.$t) return tc.apply(null, [x.$t].concat(x.args));   /* 带参数的文案：加载时取一次 */
    if (x.$frag) { if (!frags[x.$frag]) { frags[x.$frag] = {}; frags[x.$frag] = expand(pdl.frags[x.$frag]); } return frags[x.$frag]; }
    const o = {}; Object.keys(x).forEach(function (k) { o[k] = expand(x[k]); }); return o;
  };
  const text = function (x) {
    if (typeof x === 'string') return x.indexOf('t:') === 0 ? tc(x.slice(2)) : x;
    if (Array.isArray(x)) return x.map(text);
    if (!x || typeof x !== 'object') return x;
    const o = {}; Object.keys(x).forEach(function (k) { o[k] = text(x[k]); }); return o;
  };
  Object.keys(pdl.frags || {}).forEach(function (n) { PDL_FRAGS[n] = expand({ $frag: n }); });
  Object.assign(PDL_VIEWS, expand(pdl.views || {})); Object.assign(PDL_ROWS, expand(pdl.rows || {})); Object.assign(PDL_NODES, expand(pdl.nodes || {}));
  Object.assign(PANEL_VIEWS, text(pdl.panels || {})); Object.assign(TITLES, text(pdl.titles || {}));
  WS_GROUPS.push.apply(WS_GROUPS, text(pdl.panelGroups || [])); BUILTIN_THEMES.push.apply(BUILTIN_THEMES, text(pdl.palettes || [])); PDL_SYS_THEMES.push.apply(PDL_SYS_THEMES, pdl.sysThemes || []);
  Object.assign(PDL_POPUPS, expand(pdl.popups || {})); Object.assign(PDL_WHO, pdl.who || {});
  const slots = text(expand(pdl.slots || {})), entries = {};
  Object.keys(slots).forEach(function (s) { (Array.isArray(slots[s].kids) ? slots[s].kids : []).forEach(function (e) { if (e && e.id) entries[e.id] = e; }); });
  Object.keys(slots).forEach(function (s) { const k = slots[s].kids; if (k && k.$panels) slots[s].kids = ENGINE_PARTS.panelEntries(k.$panels, entries); });
  Object.assign(PDL_SLOTS, slots);
  Object.assign(PDL_LAYOUT, text(expand(pdl.layout || {}))); Object.assign(PDL_PAGES, expand(pdl.pages || {}));
  const spaces = expand(pdl.spaces || {});
  Object.keys(spaces).forEach(function (k) { const sp = spaces[k]; (sp.routesFrom || []).forEach(function (s) { sp.routes = sp.routes.concat(PDL_SLOTS[s].kids.map(pdlId)); }); delete sp.routesFrom; });
  Object.assign(PDL_SPACES, spaces);
  pdlNodeSlots();
  (pdl.contributions || []).forEach(function (c) { pdlContribute(c.slot, text(c.item)); });
  Object.keys(pdl.nav || {}).forEach(function (sp) { const id = pdl.nav[sp]; NAV_OVERRIDE[sp] = function () { return PDL_VIEWS[id].vm ? pdlView(id) : pdlViewOf(id, {}); }; });
  (pdl.modules || []).forEach(function (m) { pdlRegister(expand(m)); });
  if (pdl.tokens) themeTokens(pdl.tokens);
}
