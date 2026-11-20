/* 边界：引擎只放机制与时机，不认任何具体名字、不为单个位置打补丁 */
/* 页面内容也是页面描述：视图 = 一棵块树（纯数据），只引用组件库。
   渲染引擎读视图描述，从视图模型取字段，用组件库画出来。块、控件、片段只在这个文件里登记（lint：pdl-block）。

   视图模型（VM）是绑定层：把原始数据整理成页面要显示的字段（已经是给人看的文字、状态色等）。

   取值：只有视图描述里的模板字符串会被解析——
     '@a.b'  当前作用域（列表的一项）里的字段；'$.a.b' 视图模型根上的字段；别的字符串原样当文字
     { lit: '…' }  以 @ 或 $. 开头的字面量
     't:包.键' / { t: '包.键', args: [...] }  文案包里的字（见 engine/i18n.js）；视图里给人看的字都写成文案键
     来自视图模型的数据（列表项里的字符串等）永远原样显示，不再当取值路径
     when: '@x' / '!@x'  有值才画 / 没值才画（块、行、列、控件、片段都可以带；空数组算没值）
   词汇（契约见 PDL_SCHEMA：结构属性在下面，块 / 控件的属性在 library/blocks.js）：
     块    box head toolbar section list tree settings form kv stats text label notice tabs split each ordered fold
           steps disclosure frame empty view component pre markdown content search choices tags（整页 = 视图的 page: true + head）
     控件  button（角色 meta / nav / cycle / title）switch seg select search input（rows = 多行）check text（角色 value / meta）status more back chip grow component
           行 = 行模板名或就地的 { layout, … }（五种行布局，见组件库 rows.js ROW_LAYOUTS）；控件也可以直接放在块的位置上
     片段  文字（tone tip mono num strong mark variant） lit who icon glyph dot status chip chips（each：每项的片段）use control hint br roll */
'use strict';
const PDL_VIEWS = {};
/* 块的画法：块类型 → function (块, 作用域, 根)（组件库登记，见 library/blocks.js）；视图引擎只按类型派发 */
const PDL_BLOCKS = {};
/* 视图引擎经组件库画的几样（组件库登记）：node(模板, 作用域, 根) 节点模板；control(控件) 直接放在块位置上的控件；load(块, 状态) 块的读取状态；viewLoad(视图, 状态) 视图的读取状态；
   toc(fn) 画一段并把小节目录换成目录；state(种类, o) 读取状态 / 空状态 */
const PV_DRAW = {};
const PDL_ROWS = {};             /* 行模板：按名字引用 */
const PDL_COMPONENTS = {};
const PDL_REPLACES = {};   /* 插件替换的块：块类型 → [{ pk, use }]（登记在 pdl.js 的 pdlReplacesSet） */
function pdlReplaced(t) { const r = (PDL_REPLACES[t] || []).find(function (x) { return plugOn(x.pk); }); return r ? PDL_COMPONENTS[r.use] : null; }   /* 画块时：启用中的插件替换了它就用插件的 */       /* 组件库里有名字的复合组件：块 component / 片段 use 只能引用这里的 */
const VM = pdlReads('vm');       /* 绑定层：视图模型 */
const REGION_TABS = {};          /* 标签式区域的绑定（状态的读写由区域的拥有方提供，见 pdl.js 的 rt*） */
function rtBind(r, b) { REGION_TABS[r] = b; }
const PDL_NODES = {};
/* 画法是登记的函数，应用按名字给数据——viewFn(名字, 视图模型)。应用不调用组件库 */
const VIEW_FNS = {};
function viewFn(name, vm) { return VIEW_FNS[name](vm); }
/* 有名字的 PDL 片段（主题登记）：视图模型按数据选一行展开时画哪一段，只写片段的名字（PDL_FRAGS.名），不引用主题的代码 */
const PDL_FRAGS = {};            /* 节点模板：keyed 插槽（如 chat.node）按 key 分派到这里；插件按同样格式贡献 */
/* 属性契约（PDL_SCHEMA）：引擎只登记结构属性（_node：任何节点都可以带）和弹窗声明（_popup）；
   每个块 / 控件接受的属性、组件的角色变体（PDL_ROLES）由组件库和它的画法一起登记（library/blocks.js） */
const PDL_SCHEMA = {
  /* 结构属性：任何块 / 控件都可以带（界面树的节点）。key 稳定键（插件和用户层按它定位）；kind 种类决定编辑布局时能怎么动
     （region 区域可以互换、container 容器在父级里按种类允许的方式排序、actions 操作组里的操作只在组内排序、content 页面内容不动）；
     essential 必要元素（不能隐藏）；locked 固定位置（不参与排序、没有编辑标记）；ordered 这个容器的子项可以由用户排序；
     focus 需要专注：遮罩落在它下面一层，它的层抬到遮罩上面（弹窗、区域、卡片、引导里的聚光灯都一样）；
     stay 在弹窗里点它不算“选了一项”（就地切换、多选），声明了 pick 的弹窗不关 */
  /* 弹窗的声明（PDL_POPUPS）：at、exit、drag 三项必填；exit 是 exit 枚举的一个子集 */
  _popup: { at: ['trigger', 'center', 'corner', 'top', 'fill'], within: 1, exit: ['outside', 'esc', 'x', 'pick', 'leave'], drag: ['true', 'false'], focus: ['true', 'false'], fixLayer: ['true'], view: 1, when: 1, state: 1, close: 1, closeArgs: 1, body: ['page'], demo: 1, via: 1 },   /* view 是内容视图，when 是既有 STATE_ROOTS 的状态路径；state 是主人，不作打开条件。 */
  _node: { sources: 1, item: 1, load: 1, loading: 1, error: 1, stale: 1, empty: 1, retry: 1, stay: 1, focus: 1, key: 1, kind: ['region', 'container', 'actions', 'entry', 'action', 'content'], essential: 1, move: 1, locked: 1, ordered: 1, span: ['s', 'm', 'l'] },
};

/* ───────── 本地化 ───────── */
/* 视图描述是静态数据，从不改写。文案键（'t:包.键'，或不带参数的 { t }）在取用时换成当前语言的字：引擎的入口（pvBlocks / pvControl / pvRow / pvParts）
   拿到一段描述就换一次，按描述对象记住结果（换语言时作废）；换出来的对象再进入口时直接用。带参数的 { t, args } 留到取值时（参数是绑定）。
   插件后来登记的描述也一样，不用另存原始描述 */
const PV_LOC = { lang: null, memo: new WeakMap(), done: new WeakSet() };
function pdlLoc(v) {
  if (!v || typeof v !== 'object') return v;
  if (PV_LOC.lang !== S.lang) { PV_LOC.lang = S.lang; PV_LOC.memo = new WeakMap(); PV_LOC.done = new WeakSet(); }
  if (PV_LOC.done.has(v)) return v;
  let x = PV_LOC.memo.get(v); if (!x) { x = pdlLocalizeNode(v); PV_LOC.memo.set(v, x); } return x;
}
function pdlLocalizeNode(v) {
  if (typeof v === 'string') return v[0] === 't' && v[1] === ':' ? tc(v.slice(2)) : v;
  let out = v;
  if (Array.isArray(v)) out = v.map(pdlLocalizeNode);
  else if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    if (typeof v.t === 'string' && Object.keys(v).length === 1) return tc(v.t);
    out = {}; Object.keys(v).forEach(function (k) { out[k] = pdlLocalizeNode(v[k]); });
  }
  if (out && typeof out === 'object') PV_LOC.done.add(out);
  return out;
}

/* ───────── 取值 ───────── */
/* 值的写法：{ of: '@数据', item: 每项的值模板（数组逐项取）, sep: ' · '（数组连成一句，空项跳过）, fmt: 组件库 FORMATS 的名字（时间 / 时长 / 大小 / 数字）,
   slice: [起, 止]（原样截取，不加 …）, max: 18（超出截断加 …）, case: 'lower' | 'upper', gte: N（不小于 N 时为 true：给 map 当键或给 when） } */
function pvOf(v, sc, root) {
  let x = pv(v.of, sc, root); if (x == null) return x;
  if (Array.isArray(x) && v.item) x = x.map(function (y) { return pv(v.item, y, root); });
  if (Array.isArray(x) && v.sep != null) x = x.filter(function (y) { return y != null && y !== ''; }).join(v.sep);
  if (v.fmt) x = ENGINE_PARTS.format(v.fmt, x);
  if (v.slice) x = String(x).slice(pv(v.slice[0], sc, root), v.slice[1] == null ? undefined : pv(v.slice[1], sc, root));
  if (v.max && String(x).length > v.max) x = String(x).slice(0, v.max) + '…';
  if (v.case === 'lower') x = String(x).toLowerCase();
  if (v.case === 'upper') x = String(x).toUpperCase();
  if (v.gte != null) x = x >= pv(v.gte, sc, root);
  return x;
}
/* 画一个组件单元（列表的一项）时打开：记下它读到的页面级的值（'$.' 绑定 → 值），下次比一比就知道这一项要不要重画 */
function pv(v, sc, root) {
  if (v && typeof v === 'object' && v.lit != null) return v.lit;
  if (v && typeof v === 'object' && v.map && 'of' in v) { const k = pvOf(v, sc, root); return pv(k != null && k in v.map ? v.map[k] : v.map._, sc, root); }   /* 按值取：{ of: '@state', map: { error: 'danger', … , _: 默认 } }；键可以先经过下面的写法（比如 gte）；取到的值照常解析（'t:…'、{ t, args }、'@…'） */
  if (v && typeof v === 'object' && 'of' in v) return pvOf(v, sc, root);
  if (v && typeof v === 'object' && typeof v.t === 'string') return tc.apply(null, [v.t].concat((v.args || []).map(function (a) { return pv(a, sc, root); })));   /* 文案键带参数 */
  if (typeof v !== 'string') return v;
  if (v[0] === 't' && v[1] === ':') return tc(v.slice(2));   /* 't:包.键'：文案包里的字（当前语言） */
  if (v === '@') return sc;
  if (v[0] === '@' || v.indexOf('$.') === 0) {
    const base = v[0] === '@' ? sc : root, path = v[0] === '@' ? v.slice(1) : v.slice(2);
    const got = path.split('.').reduce(function (o, k) { return o == null ? o : o[k]; }, base);
    return pvSaid(got) ? pvSaidText(got) : got;
  }
  return v;
}
/* 数据里带来的文案（插件后端返回的 { t, args }，只有这两个键）：和写在 PDL 里的一样按当前语言翻译，参数里套着的也翻译；参数是数据，不再当路径解析 */
function pvSaid(x) { return !!x && typeof x === 'object' && !Array.isArray(x) && typeof x.t === 'string' && Object.keys(x).every(function (k) { return k === 't' || k === 'args'; }); }
function pvSaidText(x) { return tc.apply(null, [x.t].concat((x.args || []).map(function (a) { return pvSaid(a) ? pvSaidText(a) : a; }))); }
function pvOk(w, sc, root) { if (w == null) return true; if (Array.isArray(w)) return w.every(function (x) { return pvOk(x, sc, root); });   /* 一组条件：都成立才算 */
  const neg = w[0] === '!', x = pv(neg ? w.slice(1) : w, sc, root); const ok = Array.isArray(x) ? x.length > 0 : !!x; return neg ? !ok : ok; }
function pvArgs(args, sc, root) {
  if (typeof args === 'string') return argAttrs(pv(args, sc, root) || {});   /* 整组参数来自视图模型：值原样用 */
  const o = {}; Object.keys(args || {}).forEach(function (a) { o[a] = pv(args[a], sc, root); }); return argAttrs(o);
}
function pvArgsObj(args, sc, root) { if (typeof args === 'string') return pv(args, sc, root) || {}; const o = {}; Object.keys(args || {}).forEach(function (a) { o[a] = pv(args[a], sc, root); }); return o; }
/* 一组项（下拉的选项这类）写在 PDL 里时：固定项 + { from, item } 按一组数据展开（item 里 @ 是那一项）；每项的字段按绑定取值，when 不成立的项不出 */
function pvItems(list, sc, root) {
  if (!Array.isArray(list)) return pvList(list, sc, root);
  const out = [];
  const one = function (it, s) { if (Array.isArray(it)) { out.push(it.map(function (x) { return pv(x, s, root); })); return; } if (it && typeof it === 'object' && !pvOk(it.when, s, root)) return; out.push(it && typeof it === 'object' ? pvArgsObj(it, s, root) : it); };
  list.forEach(function (it) { if (it && it.from && it.item) pvList(it.from, sc, root).forEach(function (x) { one(it.item, x); }); else one(it, sc); });
  return out;
}
/* 菜单项（more 的 items）：每项 { label, act, args, when, tone: 'danger', cur, why }；{ from, item } 按一组数据各出一项（item 里 @ 是那一项）；{ scope } 是范围名 */
function pvMenu(items, sc, root) {
  const out = [];
  const one = function (it, s) { if (!pvOk(it.when, s, root)) return; if (it.scope != null) { out.push({ scope: pv(it.scope, s, root) }); return; }
    out.push({ label: pv(it.label, s, root), act: it.act, data: pvArgsObj(it.args, s, root), danger: it.tone === 'danger', cur: !!pv(it.cur, s, root), why: pv(it.why, s, root) || '', help: pv(it.help, s, root) || undefined, stay: !!it.stay }); };
  (items || []).forEach(function (it) { if (it.from) pvList(it.from, sc, root).forEach(function (x) { one(it.item, x); }); else one(it, sc); });
  return out;
}
function pvText(v, sc, root) { const x = pv(v, sc, root); return x == null ? '' : h(String(x)); }
function pvList(v, sc, root) { const x = Array.isArray(v) ? v : pv(v, sc, root); return Array.isArray(x) ? x : []; }
function ctlJoin(a, b) { return (a || '') + (b || ''); }
function pvAnnot(l, sc, root) { if (!l) return null; if (typeof l === 'string') { const t = pv(l, sc, root); if (Array.isArray(t)) return t.map(function (x) { return typeof x === 'string' ? { text: x, pos: 'after' } : x; }); if (t && typeof t === 'object') return t; return t ? { text: t, pos: 'after' } : null; } const t = pv(l.text, sc, root); return t ? { text: t, pos: l.pos || 'after', tone: pv(l.tone, sc, root) } : null; }
function pvNote(n) { return n ? ' data-note="' + n + '"' : ''; }
const PV = { units: {}, ro: 0, inert: 0, ctTitle: '', leadSize: '', load: '', viewId: '', tabKey: '', region: '' };   /* ctTitle：正在画的容器的名字（工作台标签的标题），视图下钻返回的默认名字 */   /* units：按单元画、自己逐项映射 item 的块（组件库登记） */
/* stay 的标记：不占布局的一层（display: contents），弹窗引擎看点击落在不在 [data-stay] 里 */
function pvStay(html) { return html ? '<span class="vw-stay" data-stay>' + html + '</span>' : ''; }
/* item：按数据重复的块 / 控件（from，或写成绑定的 options / items）每一项的字段在这里声明：对每一项按 item 取值（@ 是那一项），盖在这一项的数据上，
   组件照常读这些字段——文字、状态、动作都由主题写，数据只给值 */
function pvItemize(b, sc, root) {
  if (!b || !b.item) return b;
  const key = b.from != null ? 'from' : typeof b.options === 'string' ? 'options' : typeof b.items === 'string' ? 'items' : null; if (!key) return b;
  const o = Object.assign({}, b); o[key] = pvList(b[key], sc, root).map(function (x) { return Object.assign({}, x, pvDeep(b.item, root, x)); }); return o;
}
function pvBlocks(blocks, sc, root) {
  return (pdlLoc(blocks) || []).filter(function (b) { return !(b.key && pdlNodeHidden(b.key)); }).map(function (b) {
    if (b.sources) { const data = pdlSourceOf(b, sc); return pvBlocks([Object.assign({}, b, { sources: null })], data, data); }
    if (!pvOk(b.when, sc, root)) return '';
    if (b.plugin) pdlPluginNeed(b.plugin);   /* 插件插进来的块画出来了：取回它的子树（延迟加载） */
    if (b.type === 'frame') b = pdlFrameOf(b, sc, root);
    const st = b.load ? pv(b.load, sc, root) : '';   /* 块的读取状态（load 绑定到数据层的状态）：加载中 / 出错 / 空都由组件库画，块只声明文字 */
    if (st && st !== 'stale') return PV_DRAW.load(b, st, sc, root);
    if (!PV.units[b.type]) b = pvItemize(b, sc, root);   /* 按单元画的块（组件库登记）自己逐项映射：只有要重画的那一项才映射 */
    const f = pdlReplaced(b.type) || PDL_BLOCKS[b.type] || (PDL_SCHEMA[b.type] ? function (c) { return PV_DRAW.control(c, sc, root); } : null); if (!f) console.error(tc('engine.block.error', b.type)); const x0 = f ? f(b, sc, root) : '',   /* 控件也可以直接放在块的位置上（比如容器的固定件） */ x = st ? PV_DRAW.load(b, st, sc, root) + x0 : x0;
    const y0 = x && pv(b.focus, sc, root) ? '<div class="vw-focus-slot"><div class="vw-focus" data-focus>' + x + '</div></div>' : x, y = b.key ? pvProjected(b.key, y0) : y0; return y && b.stay ? pvStay(y) : y;
  }).join('');   /* focus / stay：包一层标记（遮罩和层级、弹窗的 pick 由引擎推导） */
}
/* 投影：任何有 key 的容器都可以有打开的东西——叠里压着的（cover）盖住它原来的内容（带通用返回），并排打开的（beside）接在后面 */
function pvProjected(key, html) {
  const s = NAV.st[key], top = s && s.length > 1 ? s[s.length - 1] : null, on = NAV.on[key] || [];
  if (!top && !on.length) return html;
  return (top ? PV_DRAW.opened(top, key, true) : html) + on.map(function (f) { return PV_DRAW.opened({ f: f, a: {} }, key, false); }).join('');
}
/* 用给定的视图模型画一个视图的内容（模态窗、对话框的正文：壳由调用方给） */
function pdlSourceOf(node, input) {
  if (!node.sources) return input;
  const pk = node.plugin || (PDL_VIEWS[PV.viewId] || {}).plugin;
  pdlPluginNeed(pk);
  if (ENGINE_PARTS.pluginLoad && !PDL_PLUGIN_FRAGS[pk].loaded) return { load: 'loading' };
  return VM.plugin(pk, node.sources, input);
}
function pdlFrameOf(b, sc, root) {
  const owner = PDL_VIEWS[PV.viewId] || {}, pk = pv(b.plugin, sc, root) || owner.plugin, node = owner.plugin ? PV.viewId : root.node;
  if (!pk || !node) return b;
  pdlPluginNeed(pk);
  if (ENGINE_PARTS.pluginLoad && !PDL_PLUGIN_FRAGS[pk].loaded) return Object.assign({}, b, { src: null, html: null, load: 'loading' });
  const decl = PDL_VIEWS[node], frame = decl.type === 'frame' ? decl : b, data = node === PV.viewId ? root : pdlSourceOf(decl, sc), value = frame.html || frame.src;
  const content = value && value.request ? VM.pluginFrame(pk, value, sc, node) : { src: pv(frame.src, data, data), html: pv(frame.html, data, data) };
  if (content.src) content.src = ioFile(content.src) || content.src;
  return Object.assign({}, b, content, { key: node, load: content.load || data.load || b.load, on: { message: 'pluginFrameMessage' } });
}
function pdlViewOf(id, root) {
  const v = pdlLoc(PDL_VIEWS[id]); if (!v || !root) return '';
  root = pdlSourceOf(v, root);
  const prev = PV.viewId; PV.viewId = id;
  try { return pvBlocks(v.type === 'frame' ? [Object.assign({}, v, { sources: null })] : v.blocks, root, root); } finally { PV.viewId = prev; }
}
/* 视图里的下钻（列表 → 详情盖住了列表）：视图只声明“什么时候是下钻、回去执行哪个动作”（drill），返回由引擎放进返回槽（detail），
   详情自己的头把它画出来——和区域的通用返回是同一个组件。来源的名字默认是这个容器的名字（视图声明的 title，或者工作台标签的标题）；
   来源本身是数据时（弹出层的上一页）才写 label。页面里不手写返回按钮 */
function pdlDrillOf(v, root) {
  const d = (v.drill || []).find(function (x) { return pvOk(x.when, root, root); }); if (!d) return null;
  return { act: d.act, data: pvArgs(d.args, root, root), label: d.label ? pvText(d.label, root, root) : v.title ? pvText(v.title, root, root) : PV.ctTitle };
}
/* 一个信息只说一次：视图里小节头 / 页头已经用行内状态说了的事，提示不再说一遍。画视图之前先收集各个头上的状态文字（只看视图模型根上能定的） */
function pvHeadStatuses(blocks, root) {
  const out = [];
  (function walk(x) {
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (!x || typeof x !== 'object') return;
    if ((x.type === 'head' || x.type === 'section') && pvOk(x.when, root, root)) [].concat(x.actions || []).forEach(function (c) { if (c && c.type === 'status' && pvOk(c.when, root, root)) { const s = pv(c.text, root, root); if (s) out.push(pvSay(s)); } });
    Object.keys(x).forEach(function (k) { if (k !== 'actions' && x[k] && typeof x[k] === 'object') walk(x[k]); });
  })(pdlLoc(blocks));
  return out;
}
function pvSay(s) { return String(s == null ? '' : s).replace(/[。.！!\s]+$/, '').trim(); }
function pvSaidInHead(strong, text) { const msg = pvSay(pvSay(strong) + (text || '')); return !!msg && (PV.said || []).some(function (s) { return s.indexOf(msg) >= 0; }); }   /* 提示说的整句已经包含在某个头的状态里 */
/* 画一个视图：视图描述 + 视图模型 */
function pdlView(id) {
  const v = pdlLoc(PDL_VIEWS[id]); if (!v) return '';
  if (v.plugin) { pdlPluginNeed(v.plugin); if (!v.blocks && v.type !== 'frame') return ''; }   /* 插件的视图：第一次画时取回它的子树（延迟加载）；还没取回时只有节点声明，先画空 */
  const root = v.sources ? pdlSourceOf(v, NAV_CTX ? NAV_CTX.a : {}) : v.plugin && !v.vm ? {} : vmRead(v.vm);   /* 插件视图：数据来自它登记的请求（应用的通用 VM.plugin 去读） */
  if (v.vm && vmFailed(v.vm)) return PV_DRAW.state('error', { text: tc('common.viewError') });   /* 视图模型自己抛错：在这个视图的位置说 */
  if (!root) return v.empty ? PV_DRAW.state('empty', { text: pvText(v.empty, {}, {}) }) : '';
  if (v.type === 'frame') { const prev = PV.viewId; PV.viewId = id; try { return pvBlocks([Object.assign({}, v, { sources: null })], root, root); } finally { PV.viewId = prev; } }
  const placed = backPlaced(v.blocks, root);   /* 视图自己声明了返回放在哪（back 控件）：标题行不取返回 */
  const prevId = PV.viewId, load = root.load || PV.load || '', prevSaid = PV.said;   /* 视图的读取状态：视图模型给的（数据层），或者所在工作台标签的 */
  PV.viewId = id; PV.load = ''; PV.said = pvHeadStatuses(v.blocks, root);
  if (v.readonly) PV.ro++;
  if (placed) BACK.placed++;
  try {
    const body = PV_DRAW.toc(function () { return backIn('detail', pdlDrillOf(v, root), function () { return load ? PV_DRAW.viewLoad(v, load, root) : pvBlocks(v.blocks, root, root); }); });
    if (v.bare) return body;   /* 不包外层：直接放进现有布局的一段（如对话页头部） */
    return '<div class="vw-view' + (v.page ? ' page' + (typeof v.page === 'string' ? ' vw-page-' + v.page : '') : '') + (v.readonly ? ' readonly' : '') + '" data-view="' + id + '">' + body + '</div>';
  } finally { if (v.readonly) PV.ro--; if (placed) BACK.placed--; PV.viewId = prevId; PV.said = prevSaid; }
}

/* ───────── 视图树：导出和按层级查询（agent 不看前端代码也能知道页面长什么样） ─────────
   pdlViewTree()      整棵树：视图、行模板、可用的块和组件
   pdlQuery(f)        遍历所有视图（行模板展开进去），每个节点带 path / type / depth；
                      f: { view, type, depth, maxDepth, binds: '字段名', act: '动作名' } 任意组合 */
function pdlViewTree() { return { views: PDL_VIEWS, rows: PDL_ROWS, blocks: Object.keys(PDL_BLOCKS), components: Object.keys(PDL_COMPONENTS) }; }
function pdlQuery(f) {
  f = f || {}; const out = [];
  const walk = function (node, path, depth, view) {
    if (Array.isArray(node)) { node.forEach(function (n, i) { walk(n, path + '[' + i + ']', depth, view); }); return; }
    if (!node || typeof node !== 'object') return;
    const type = node.type || (path.slice(-4) === '.row' ? 'row' : null);
    if (type) {
      const json = JSON.stringify(node);
      const ok = (!f.type || f.type === type) && (f.depth == null || f.depth === depth) && (f.maxDepth == null || depth <= f.maxDepth) &&
        (!f.binds || json.indexOf('@' + f.binds) >= 0 || json.indexOf('$.' + f.binds) >= 0) && (!f.act || json.indexOf('"act":"' + f.act + '"') >= 0);
      if (ok) out.push({ view: view, path: path, type: type, depth: depth, node: node });
    }
    Object.keys(node).forEach(function (k) {
      const v = node[k];
      if (k === 'row' && typeof v === 'string' && PDL_ROWS[v]) walk(PDL_ROWS[v], path + '.row', depth + 1, view);
      else if (v && typeof v === 'object') walk(v, path + '.' + k, depth + (type ? 1 : 0), view);
    });
  };
  Object.keys(PDL_VIEWS).forEach(function (id) { if (!f.view || f.view === id) walk(PDL_VIEWS[id].blocks, id, 0, id); });
  return out;
}
/* 轮换的一行：节点重新生成时（重画、缓存的 HTML）按开始时刻把相位接上，不从头滚 */

/* 窄屏布局状态变了：分栏换模式，重画 */
const VIEWPORT = pdlTrack({ narrow: matchMedia('(max-width: 900px)').matches }, 'VIEWPORT');   /* 窗口是不是窄屏：界面状态（读过它的块在它变了时重画） */
matchMedia('(max-width: 900px)').addEventListener('change', function (e) { VIEWPORT.narrow = e.matches; render(true); });
