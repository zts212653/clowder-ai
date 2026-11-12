/* 边界：引擎只放机制与时机，不认任何具体名字、不为单个位置打补丁 */
/* Clowder 控制台 · 公共部分：图标、状态、组件、外壳、渲染、动作分发。各区域文件往注册表里加页面、面板、动作、菜单。 */
'use strict';
/* ───────────── Icons ───────────── */
/* 图标在 icons.js（组件库的图标登记，一处） */

/* 图标（路径数据，24 网格、1.75 描边、圆端点，和 shell 一致）。
   来源：packages/ui/src/ShellIcons.tsx（ShellGlyph / WorksIcon / MemoryBookStarIcon，外壳入口用的那一套）、
   packages/web/src/components/hub-icons.tsx（HubIcon，设置 / 工作台入口用的那一套）。那里没有的含义用自己的字形（同网格、同描边） */


/* 文字输出的最后一步：转义；PDL 里的文案键（'t:包.键'）不管从哪条路径到这里，都换成当前语言的字 */
function h(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

/* ───────────── 启动─────────────
   各层加载时只登记（组件、声明、动作、视图模型），不读数据；所有脚本加载完（DOMContentLoaded）之后按阶段跑：
   data 应用从接口读数据 → early 应用里依赖数据的初始化（PDL 之前的那些模块）→ pdl 插件的 PDL 片段 → doc 主题文档（当前主题、升级）→
   late 依赖主题文档的初始化（工作台的各个面板）→ boot 打开第一屏。返回 Promise 的函数要等它完成才进下一阶段。同一阶段里按登记的先后跑（就是脚本的加载顺序：engine → platform → library → theme → app） */
const START = { data: [], early: [], pdl: [], doc: [], late: [], boot: [] };
function onStart(phase, fn) { START[phase].push(fn); }
let START_WAIT = 0, START_BOOT = false;   /* START_BOOT：进入最后一个阶段（boot，画第一屏）之前，任何地方调 render 都不画 */   /* 正在等某个阶段返回的异步读（静止信号把它算作忙） */
document.addEventListener('DOMContentLoaded', async function () {
  for (const p of Object.keys(START)) {
    if (p === 'boot') START_BOOT = true;
    const ps = START[p].map(function (fn) { try { return fn(); } catch (e) { console.error(e); } }).filter(function (r) { return r && typeof r.then === 'function'; });   /* 同步的阶段照旧同步跑；一步失败报出来，其余照常 */
    if (ps.length) { START_WAIT++; (await Promise.allSettled(ps)).forEach(function (r) { if (r.status === 'rejected') console.error(r.reason); }); START_WAIT--; }   /* 只有真的返回了 Promise 才等 */
  }
});   /* 一个阶段里的函数可以返回 Promise：下一个阶段等它（第一屏要用的本地素材先读完再画） */
/* ───────────── State ───────────── */
const store = {
  get: function (k, d) { try { const v = localStorage.getItem('clowder-proto3:' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set: function (k, v) { try { localStorage.setItem('clowder-proto3:' + k, JSON.stringify(v)); } catch (e) { /* 存储不可用时忽略 */ } }
};
/* 读取记录（按数据 / 状态局部更新，见 frame.js 的 ctLeaf）：正在画的容器各有一个集合，画的时候读到的来源记进去。
   界面状态（S、应用的 CS）套一层只记读取的代理：画的时候读到的顶层键记成 ~S.键 / ~CS.键（读出来的仍是原对象，身份不变）；
   声明式的 set / toggle / pick 按路径知道改了哪个顶层键，只重画读过它的容器 */
const READ_SCOPES = [], TRACKED = new Map();
let READ_OWN = null;   /* 正在画的那一块自己读的（不含它里面的子视图、单元交上来的）：数据只碰到某个子视图自己读的东西时，只重画它（frame.js renderLocal） */
function pdlTrack(o, name) {
  if (TRACKED.has(o)) return TRACKED.get(o).proxy;
  const proxy = new Proxy(o, { get: function (t, k) { if (READ_SCOPES.length && typeof k === 'string') { for (let i = 0; i < READ_SCOPES.length; i++) READ_SCOPES[i].add('~' + name + '.' + k); if (READ_OWN) READ_OWN.add('~' + name + '.' + k); } return t[k]; } });
  TRACKED.set(o, { proxy: proxy, name: name });
  return proxy;
}
/* 应用登记给界面读的数据函数（视图模型、身份、计数、条件……）：画的时候的每一次调用连同参数和结果记在正在画的那一块名下，
   下次渲染开头照原样重算、比出变没变（frame.js vmSeen / vmChanged）；不在画的时候调用不记 */
function pdlReads(kind, o) {
  const raw = {}, now = function (k) { return function () { return raw[k]; }; };   /* 重算时用现在登记的那个函数（换掉了就是新的） */
  const p = new Proxy({}, { set: function (t, k, fn) { raw[k] = fn; t[k] = typeof fn !== 'function' ? fn : function () { const args = Array.prototype.slice.call(arguments); while (args.length && args[args.length - 1] === undefined) args.pop(); if (!READ_SCOPES.length) return fn.apply(this, args); const got = new Set(); READ_SCOPES.push(got); let v; try { v = fn.apply(this, args); } finally { READ_SCOPES.pop(); } vmSeen(kind + ':' + String(k), now(k), args, v, got); return v; }; return true; } });   /* 画的时候：连同这次调用读到的数据来源一起记下 */
  Object.keys(o || {}).forEach(function (k) { p[k] = o[k]; });
  return p;
}
const S = pdlTrack({
  /* 路由、参数、空间、弹窗栈都由投影的运行时状态推出（proj.js 的 S.route / S.param / S.space / S.popOrder）；应用自己的字段由应用登记（app/state.js） */
  menu: null, dialog: null, toast: null,
  popOn: {}, justAdded: null,
  tweaks: store.get('tweaks', { lines: false, sans: false, compact: false, theme: 'light' }),   /* 配色的默认值来自主题数据（themeDefault） */
  plugins: {},   /* 插件装没装、开没开（应用在启动时从插件列表定） */
  lang: 'zh',
  messages: null
}, 'S');
function plugOn(k) { const p = S.plugins[k]; return !!(p && p.installed && p.on); }


/* ───────────── Rail + nav ───────────── */
/* 空间：第二栏显示什么。只有“切换空间”的入口（窄栏的 C、设置齿轮）会改它，打开内容从不改它。
   声明了 own 的空间（不属于产品界面的页面）单独算一个空间。 */
/* 路由属于哪个空间、工作台属于哪个空间：都读空间声明（PDL_SPACES，pdl.js），引擎不认空间名和路由名 */
function routeSpace(r) { const ks = Object.keys(PDL_SPACES); return ks.find(function (k) { const s = PDL_SPACES[k]; return (s.routes || []).indexOf(r) >= 0 || (s.prefix && r.indexOf(s.prefix) === 0); }) || ks.find(function (k) { return PDL_SPACES[k].fallback; }); }
function startRoute() { const k = Object.keys(PDL_SPACES).find(function (x) { return PDL_SPACES[x].start; }); return PDL_SPACES[k].home; }
function threadView() { return PDL_SPACES[panelSpace()].threadView; }   /* 显示当前对话的那个路由 */
function panelSpace() { return Object.keys(PDL_SPACES).find(function (k) { return PDL_SPACES[k].panel; }); }
function inPanelSpace(r) { return routeSpace(r) === panelSpace(); }
/* 工作台面板的范围：面板登记里声明 scope: 'thread'（内容跟着当前对话）的，只在空间声明的 threadRoutes 里显示，不记成“上次的面板” */
function space() { if (!S.space) S.space = routeSpace(S.route); return S.space; }
/* 二级栏的外壳：标题行、可滚动的内容、底部；右边缘是可以拖动的分隔线（宽度记在这台设备上）。所有二级栏都用它画 */

/* ───────────── 注册表：各区域文件往里加 ───────────── */
const PAGES = {};
const TITLES = {};
const MENU_FNS = {};
/* 单选组（radio 动作）：功能模块登记自己的分组 RADIO_GROUPS[组] = function (值)，和 MENU_FNS 一样 */
const RADIO_GROUPS = {};
/* 入口的计数徽标：入口声明 badge: 名字，功能模块登记 BADGES[名字]() 返回数（和 WHEN 一样，引擎不认入口 id） */
const BADGES = pdlReads('badge');
const CHANGES = {};
const FORMS = {};
/* 区域可以替换的外壳部分：NAV_OVERRIDE[space]() 返回整个二级列表 HTML；OVERLAY_OVERRIDE.inbox() 返回待办浮窗 HTML；KEY_FNS 里的函数返回 true 表示已处理按键 */
const NAV_OVERRIDE = {};
const OVERLAY_OVERRIDE = {};
/* 弹窗登记：POPUPS[key]() 返回这个弹窗现在的内容（没开就返回 ''）；key 对应 PDL_POPUPS 里的声明。栈、层级、遮罩由引擎推导（frame.js） */
const POPUPS = {};
/* 工作台（标签式容器）的面板：PANEL_VIEWS[键] = [标题, 图标, 范围, 分组, 说明]（主题声明）；WS_GROUPS = [[分组, 名字]]（主题声明，最后一组是“其他”）；PANELS[键](键) 画面板的内容（应用登记） */
const PANEL_VIEWS = {}, WS_GROUPS = [], PANELS = {};
const KEY_FNS = [];
/* 引擎经组件库画的部件：组件库加载时登记，引擎只按这几个名字调用，不认识组件——
   fieldErr()            把字段错误（FIELD_ERR）画到字段下面
   menu(m) / dialog(d)   菜单、对话框的内容（弹窗栈里的 menu / dialog）
   modal(o)              模态（标题、正文、底部按钮的声明，见组件库 btnsHtml）
   toast(…) / undo(…)    提示条、撤销条
   copied(el)            复制之后那个图标原地变勾
   back(d)               返回按钮（返回槽里的描述）
   ctBox(键, 结点, 子块, 底层)  结构页里加的容器（盒子 + 入口插槽）
   md(源文)              Markdown → HTML（消息正文、说明）
   whoText(身份, o)      身份的显示文字
   icons({ 名: 字形 })    登记字形（插件自带的图标，命名空间 plugin:<包>/<名>）
   pluginPop(弹窗, 插件, 声明)  插件自己的弹窗（浮动小窗 + 插件框）
   dragBin(字)           拖动入口时出现的“移出”区
   dialogSync(d)         把对话框里正在填的值读回 d.fields（每种字段的读法是对话框组件的事）
   其余见各自的调用处（overlays、返回、视图的读取状态……） */
const ENGINE_PARTS = {};
/* 数据口：引擎和组件库经它和数据层说话，不认识接口门面。宿主（应用）启动时把门面接上：ioConnect({ send, on, act, file })。
   ioSend(事件, 内容) 发给数据层；ioOn(事件, fn) 听数据层推来的事件（接上之前登记的，接上时补挂）；动作表里没有的名字经 act 找；file(路径) 服务端文件的地址；now() 数据层的时钟 */
const IO = { port: null, subs: [] };
function ioConnect(port) { IO.port = port; IO.subs.forEach(function (s) { port.on(s[0], s[1]); }); IO.subs = []; }
function ioSend(ev, payload) { if (IO.port) IO.port.send(ev, payload); }
function ioOn(ev, fn) { if (IO.port) IO.port.on(ev, fn); else IO.subs.push([ev, fn]); }
function ioNow() { return IO.port && IO.port.now ? IO.port.now() : Date.now(); }   /* 现在几点：数据层的时钟 */
function ioFile(path) { return IO.port && IO.port.file ? IO.port.file(path) : ''; }
/* 身份的数据（应用登记）：组件库的身份组件（who.js）、选成员、提及、徽标只经这里读数据，不认识应用的数据——
   member(id) 成员（找不到给第一个）· members() 全部成员 · me() 你 · plugins() 插件（按 id）· builtinConnector(id) 宿主内置的连接器 ·
   health() 回调授权健康（没有就 null）· live(id, 回合) 执行状态 · handleId(句柄) 句柄是哪个成员 */
const WHO_DATA = pdlReads('who', { member: function () { return null; }, members: function () { return []; }, me: function () { return {}; }, plugins: function () { return {}; }, builtinConnector: function () { return false; }, health: function () { return null; }, live: null, handleId: function () { return null; } });
/* 根元素上的状态类（各层登记：返回类名或空串），画在外壳的固定类之后 */
const APP_CLASS = [];
/* 整页画完、弹窗里正在填的值放回之后，组件同步自己的显示（下拉按钮上的字……）：组件库登记 */
const PAINT_SYNC = [];

/* ───────────── Overlays ───────────── */
/* PDL 里声明的菜单（more 控件的 items）：画的时候按当前数据算出各项，按内容登记成一个键；点开时先找这里 */
const MENU_LIVE = {};
function menuLive(items) { const s = JSON.stringify(items); let x = 5381; for (let i = 0; i < s.length; i++) x = (x * 33 + s.charCodeAt(i)) | 0; const k = 'pdl:' + (x >>> 0).toString(36); MENU_LIVE[k] = items; return k; }
/* 打开时才有数据的菜单：PDL_VIEWS['menu.<名>'] 的 items（同 more 的 items，可带 from / item），数据 = 视图的 VM + 打开时的参数 */
function menuItems(key, args) {
  const v = pdlLoc(PDL_VIEWS['menu.' + key]);
  if (v) { const root = Object.assign({}, v.vm ? vmRead(v.vm) || {} : {}, args || {}); return pvMenu(v.items, root, root); }
  return MENU_LIVE[key] || (MENU_FNS[key] ? MENU_FNS[key]() : []);
}
POPUPS.menu = function () { return S.menu ? ENGINE_PARTS.menu(S.menu) : ''; };
/* 菜单贴着打开它的元素（组件库的锚定）；那个元素不在了，菜单就收起 */
function menuAnchor(el) { popAnchor('menu', el); }
POPUPS.dialog = function () { return S.dialog ? ENGINE_PARTS.dialog(S.dialog) : ''; };
/* 声明里的一组值整个按绑定取值（'$.x' / 't:…' / { t, args }，嵌套的对象和数组逐层取）；函数原样留着 */
/* 数组里的 { from, item } 按一组数据展开（item 里 @ 是那一项），带 when 的项不成立就不要 */
function pvDeep(x, root, sc) {
  sc = sc || root;
  if (typeof x === 'string') return pv(x, sc, root);
  if (Array.isArray(x)) return [].concat.apply([], x.map(function (y) {
    if (y && typeof y === 'object' && y.from && y.item) return pvList(y.from, sc, root).map(function (z) { return pvDeep(y.item, root, z); });
    if (y && typeof y === 'object' && !Array.isArray(y) && y.when != null && !pvOk(y.when, sc, root)) return [];
    return [pvDeep(y, root, sc)];
  }));
  if (x && typeof x === 'object' && Object.getPrototypeOf(x) === Object.prototype) { if (typeof x.t === 'string' || x.lit != null) return pv(x, sc, root);
    if ('of' in x) { if (!x.map) return pv(x, sc, root); const k = pvOf(x, sc, root); return pvDeep(k != null && k in x.map ? x.map[k] : x.map._, root, sc); }   /* 值的写法 / 值映射：取到的值再整个解析 */
    const o = {}; Object.keys(x).forEach(function (k) { if (k !== 'when') o[k] = pvDeep(x[k], root, sc); }); return o; }
  return x;
}
/* 对话框的字和表单在主题里声明：PDL_VIEWS['dlg.<kind>'] 的 title / help / text / ok / danger / focus / fields / doc / panes / foot / ack / sync / wide / noFieldFocus，
   数据 = 视图的 VM + 打开时的参数（args）；有 blocks 时正文就是这个视图。打开时解析成完整的描述放进 S.dialog（确定、字段同步、分栏都照常走），
   声明里没写的项用打开时给的；确定之后做什么（on）仍由打开它的动作给 */
const DIALOG_KEYS = ['title', 'help', 'text', 'ok', 'danger', 'focus', 'fields', 'doc', 'panes', 'foot', 'ack', 'sync', 'wide', 'noFieldFocus'];
function dialogOf(d) {
  const v = d.kind && pdlLoc(PDL_VIEWS['dlg.' + d.kind]); if (!v) return d;
  const root = Object.assign({}, v.vm ? vmRead(v.vm) || {} : {}, d.args || {}), out = Object.assign({}, d);
  DIALOG_KEYS.forEach(function (k) { if (v[k] !== undefined) out[k] = pvDeep(v[k], root); });
  if (v.text && typeof v.text === 'object' && !v.text.t) out.text = { parts: v.text, data: root };   /* 正文写成片段：画的时候按片段画（数据里的字都转义） */
  if (v.blocks) out.body = v.vm ? { type: 'view', id: 'dlg.' + d.kind } : { type: 'view', id: 'dlg.' + d.kind, data: '$.args' };   /* 没有自己的 VM 的对话框视图：数据就是打开时的参数 */
  /* okAct / okArgs：确定就执行这个动作（打开时没给 on 的时候），返回值照 on 处理（false 留着、promise 等着）；
     打开时给了 on 而主题声明了 okArgs（默认名字这类）：确定时把解析好的 okArgs 交给 on */
  const okArgs = function () { return pvArgsObj(v.okArgs || {}, root, root); }, given = d.on;
  if (v.okAct && !given) out.on = function () { return A[v.okAct](okArgs()); };
  else if (v.okArgs && given) out.on = function () { return given(okArgs()); };
  return out;
}
/* 弹窗（modal）外框的字在主题里声明：PDL_VIEWS['modal.<kind>'] 的 title / help / wide / submitLabel / scanLabel，数据是这个弹窗正文的数据 */
const MODAL_KEYS = ['title', 'help', 'wide', 'submitLabel', 'scanLabel'];
function modalFrame(kind, data) {
  const v = pdlLoc(PDL_VIEWS['modal.' + kind]), out = {}; if (!v) return out;
  MODAL_KEYS.forEach(function (k) { if (v[k] !== undefined) out[k] = pvDeep(v[k], data || {}); });
  return out;
}
/* 插件拥有的弹窗（插件描述里的 popups，pdl.js 登记）：开着的记在 S.popOn[弹窗名]；插件停用 / 卸载时它拥有的弹窗一起关（按声明的 plugin，不按插件名） */
function pluginPopsClose(pk) { Object.keys(PDL_POPUPS).forEach(function (k) { if (PDL_POPUPS[k].plugin === pk) delete S.popOn[k]; }); }
function overlays() {
  let o = popLayer();
  /* 各模块登记的浮层（待办、Skill / MCP 预览窗……），各自决定现在要不要出现 */
  Object.keys(OVERLAY_OVERRIDE).forEach(function (k) { o += OVERLAY_OVERRIDE[k](); });
  if (S.toast) o += ENGINE_PARTS.toast(S.toast, S.toastAct, { tone: S.toastTone });
  const u = UNDO.cur; if (u) o += ENGINE_PARTS.undo(u.text, (u.acts || []).concat([{ label: tc('common.undo'), act: 'undo' }]));
  return o;
}
/* ───────── 撤销─────────
   能撤回的动作（归档、移出对话组、取消固定、关标签、忽略、移到回收站、封存……）立即执行，再给一条带“撤销”的提示，留 --hold-undo；
   只有撤回不了的（永久删除、卸载、停掉正在跑的、重建索引……）才先确认。动作自己声明怎么撤回：用 undoable 包起来，返回 { text, undo }
   （undo 是撤回的函数；acts 可以再带别的文字操作，比如“查看”），引擎画提示、管保留时间。同一时间只有一条：新的接替旧的（旧的就此生效）。
   保留时间到了只把这条提示从页面上拿掉（局部），不整页重画 */
const UNDO = pdlTrack({ cur: null }, 'UNDO');   /* 现在这一条撤销提示：界面状态 */
let undoTimer = 0;
function undoShow(r) {
  UNDO.cur = { text: r.text, undo: r.undo, acts: r.acts || [] }; clearTimeout(undoTimer);
  undoTimer = setTimeout(function () { UNDO.cur = null; const t = document.querySelector('.toast[data-undo]'); if (t) t.remove(); }, ms('--hold-undo'));
  render(true);
}
function undoable(fn) { return function (d, el) { const r = fn(d, el); if (r && r.undo) undoShow(r); else if (r && r.text) toast(r.text); return r; }; }   /* 没有要撤回的（比如本来就是默认值）：只给一条轻提示 */
function undoDrop() { UNDO.cur = null; clearTimeout(undoTimer); }

/* ───────────── Render ───────────── */
const root = document.getElementById('app');
/* 提示：组件库里唯一的悬停提示。所有组件把提示文字写进 data-tip（不用原生 title）；
   悬停或键盘聚焦 --tip-delay（0.7s）后出现在目标下方（放不下就在上方），离开、按下、滚动、按键立刻消失 */
const TIP = { el: null, t: 0, at: null };
function tipHide() { clearTimeout(TIP.t); TIP.at = null; if (TIP.el) { TIP.el.classList.remove('on'); TIP.el.hidePopover(); } if (typeof ANCHORED !== 'undefined' && ANCHORED.tip) anchorTo('tip', null); }
/* 被截断的字（单行省略、多行截断）悬停看全文：哪里都一样，不靠组件逐个标。从指到的元素往上看几层，第一个字被截断的就是它 */
function tipClipped(el) {
  for (let i = 0; el && i < 4 && el !== document.body; i++, el = el.parentElement) {
    if (el.matches('[data-tip], button, a, input, textarea, select')) return null;
    const cs = getComputedStyle(el);
    if (cs.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1 || cs.webkitLineClamp !== 'none' && el.scrollHeight > el.clientHeight + 1) return el;
  }
  return null;
}
function tipShow(el) {
  if (!el.isConnected || !(el.dataset.tip || tipClipped(el) === el)) return;
  if (!TIP.el) { TIP.el = document.createElement('div'); TIP.el.className = 'ui-tip'; TIP.el.setAttribute('role', 'tooltip'); TIP.el.setAttribute('popover', 'manual'); document.body.appendChild(TIP.el); }
  const t = TIP.el, g = el.closest('[data-tip-group]'); t.textContent = el.dataset.tip || el.innerText.trim();   /* 被截断的字：提示就是它自己的全文 */
  t.classList.toggle('side', !!g && g.dataset.tipGroup === 'inline');   /* 竖排的提示组（组件声明 data-tip-group="inline"）：提示放在侧边，不盖住同组的其他项 */
  t.style.setProperty('--u-anchor', anchorTo('tip', el, tipHide)); t.showPopover(); t.classList.add('on');   /* 位置由锚定决定：引用目标自己的锚点名，目标下方，放不下翻到上方（目标同时是别的浮层的锚点也不冲突） */
}
function tipArm(el) { if (el === TIP.at) return; const group = el && el.closest('[data-tip-group]'), continuous = group && TIP.at && group === TIP.at.closest('[data-tip-group]') && TIP.el && TIP.el.classList.contains('on'); if (continuous) { TIP.at = el; tipShow(el); return; } tipHide(); if (!el || !(el.dataset.tip || tipClipped(el) === el) || el.hasAttribute('data-hover') || S.editLayout) return;   /* 悬停会打开东西的元素不再出提示 */   /* 编辑布局时不出提示 */ TIP.at = el; TIP.t = setTimeout(function () { tipShow(el); }, ms('--tip-delay')); }
document.addEventListener('mouseover', function (e) { tipArm(e.target.closest ? e.target.closest('[data-tip]') || tipClipped(e.target) : null); });
document.addEventListener('mouseout', function (e) { if (!TIP.at) return; const group = TIP.at.closest('[data-tip-group]'); if (e.relatedTarget && (TIP.at.contains(e.relatedTarget) || group && group.contains(e.relatedTarget))) return; tipHide(); });
document.addEventListener('focusin', function (e) { const el = e.target.closest && e.target.closest('[data-tip]'); if (el && el.matches(':focus-visible')) tipArm(el); });
['mousedown', 'keydown', 'focusout'].forEach(function (k) { document.addEventListener(k, tipHide, true); });
document.addEventListener('scroll', tipHide, true);
/* 悬停打开（共用的悬停规则）：触发元素声明 data-hover="动作名"（参数和 data-act 一样从 data-* 来），指针停 --tip-delay 后执行这个动作，
   触发元素就是这次动作的来源（ACT_FROM，弹窗按它锚定、记主人）。关掉由弹窗自己声明的 leave 负责（frame.js）。编辑布局时不触发；触屏上点一下走 data-act */
const HOVER = { at: null, t: 0 };
function hoverArm(el) {
  if (el === HOVER.at) return; clearTimeout(HOVER.t); HOVER.at = el; if (!el || S.editLayout) return;
  HOVER.t = setTimeout(function () { const fn = actFn(el.dataset.hover); if (!fn || !el.isConnected || !el.matches(':hover')) return; ACT_FROM = el; try { fn(actionArgs(el), el); } finally { ACT_FROM = null; } }, ms('--tip-delay'));
}
document.addEventListener('mouseover', function (e) { hoverArm(e.target.closest ? e.target.closest('[data-hover]') : null); });
/* 渲染钩子：整页 HTML 写进去之前 / 之后要做的事，各模块登记。
   beforeRender：后登记的先跑；onRender：按登记顺序跑。 */
const RENDER_BEFORE = [], RENDER_AFTER = [];
/* 主题换了 / 主题文档改了之后要重新落到页面上的东西（配色值、字号与动态效果）：各模块登记自己的同步（pdl-doc 的 pdlThemeSync 调用） */
const PDL_THEME_SYNC = [];
function beforeRender(fn) { RENDER_BEFORE.unshift(fn); }
/* 一次渲染画完。读数据只有一条规则，在这个时机做：要读的集合 = 这次投影实际读到的数据来源（不显示的元素判断时也读，算在内）；和上一次比差异——
   新出现的拉一次（周期来源开始按间隔拉），离开的停拉、停收推送、保留最后一份，再出现的先画保留的再拉一次。拉 = 完整状态，推 = 增量；合并按 id 比差异，没变的保持原引用。
   动作打开的目标进了投影，按同一条规则读；没有目标的动作（导出等）是动作自己的请求，不算数据来源。
   不在挂载时全读，不为某个页面加读取清单、定时器或分支。引擎只给时机，不认识数据来源。
   条目附带的数据（每条消息自己的附加记录这类，一条一个请求）不在渲染时读：条目到了可见区附近才读（nearView，frame.js），离开就不再要；读回来同样按 id 合并推进来 */
function onRender(fn) { RENDER_AFTER.push(fn); }

/* 路径的来源（登记表）：文件 / 文件夹的改名、删除走同一套流程（ws-code.js 的 wcRename / wcDelete），数据怎么改由来源自己说——
   { count(p)：连同里面一共几项, text(n)：危险确认框的正文, rename(p, 新名字), remove(p) }。ws：工作区文件（ws-code.js）；fs：本机文件夹（cafe.js，选择项目） */
const PATH_STORES = {};
/* ───────── 节点复用（一套）、局部更新、消息流的滚动 ─────────
   消息（流的直接子项）和孤岛（data-island）是同一种可复用节点：各自记下画出它时的 HTML（就是它的版本），按树键认。
   整页重画时，内容没变的节点换回原来那个 DOM 节点（身份、状态、动画都不变），只有变了的才换新的；嵌套的各自判断。
   流式输出用 streamPatch(mid)：只重画那一条消息，不走整页重画，所以输入框（节点、焦点、光标）完全不受影响。
   停在底部由组件库的 stick-end 负责（反向排列：贴底时跟着到底，用户往上翻了浏览器的滚动锚定停在原处，输入框变高也不用补差）。 */
const NODE_HTML = new WeakMap();
const REUSE_SEL = '[data-island], [data-stream] > [data-mid]';
/* 树键（组件库，唯一一份）：节点的身份 = 它自己和所有带身份的祖先的键串起来。键是 id / data-island / 消息（流 + mid）/ data-id / data-k。
   节点复用（消息、孤岛）、节拍的“同一个位置”都按它认，不按位置、不按签名 */
function nodeId(n) {
  const d = n.dataset || {};
  if (d.island) return 'i:' + d.island;
  if (d.mid && n.parentElement && n.parentElement.hasAttribute('data-stream')) return 'm:' + n.parentElement.dataset.stream + '|' + d.mid;   /* 对话主流和回放剧场里可以是同一条消息，各认各的 */
  return n.id || d.id || d.k || '';
}
function treeKey(el) { const ks = []; for (let n = el; n && n !== document.body; n = n.parentElement) { const k = nodeId(n); if (k) ks.unshift(k); } return ks.join('/'); }
/* 节点的“版本”就是它的 HTML：相位（节拍、轮换起点）从不写进 HTML，由动画诞生时按时间原点对齐 */
function streamVer(el) { return el.outerHTML.replace(/ data-aname="[^"]*"/g, ''); }   /* 锚点名（ui.js）是插进页面后按身份写上的，不算内容 */
/* 本地更新之后（只改了某个节点里的属性 / 一小块）：把所在消息节点、各层孤岛记下的版本更新成现在的样子，
   下次整页重画时它们照样被复用（前提：本地更新出来的 HTML 和重画出来的一样） */
/* 组件在页面上写的测量结果（CSS 变量、data-foldable、按测量改的提示文字）不算内容：记版本前由各组件把副本还原成“刚画出来”的样子 */
const LOCAL_NORM = [];
function localVer(n) { const c = n.cloneNode(true); LOCAL_NORM.forEach(function (f) { f(c); }); return streamVer(c); }
function localSync(el) {
  for (let n = el; n && n !== document.body; n = n.parentElement) {
    if (n.matches && n.matches(REUSE_SEL)) NODE_HTML.set(n, localVer(n));
  }
}
/* 本地开合（组件库通用）：开关只改开合目标的 data-open 和开关的 aria-expanded；内容一直画着，收起时由样式藏起来。
   需要在开合时做事的组件（滚到底、量高度）在这里登记一次：onOpenToggle(选择器, 函数(el, open))——不在各个开关里各写一遍。
   改完记版本（localSync），下次整页重画时这条消息 / 孤岛照样复用 */
const OPEN_HOOKS = [];
function onOpenToggle(sel, fn) { OPEN_HOOKS.push([sel, fn]); }
function localOpen(box, open, tg) {
  box.setAttribute('data-open', String(open));
  if (tg) tg.setAttribute('aria-expanded', String(open));
  OPEN_HOOKS.forEach(function (x) { if (box.matches(x[0])) x[1](box, open); });
  localSync(box);
}
/* FLIP 移动：改动 DOM 顺序前后各量一次位置，让留下来的兄弟节点从旧位置平滑移到新位置（拖动排序时让出空位用） */
function flipMove(container, mutate) {
  if (motionOff()) { mutate(); return; }
  const kids = Array.prototype.slice.call(container.children), before = kids.map(function (k) { return k.getBoundingClientRect(); });
  mutate();
  kids.forEach(function (k, i) {
    const r = k.getBoundingClientRect(), dx = before[i].left - r.left, dy = before[i].top - r.top;
    if (!dx && !dy) return;
    k.animate([{ transform: 'translate(' + dx + 'px,' + dy + 'px)' }, { transform: 'none' }], { duration: ms('--dur-fast'), easing: 'ease-out' });
  });
}
/* 原地过渡的节点：组件在节点上原地改了状态、过渡正在跑（开关的开 / 关），登记 reuseHold(el)；--dur-fast 之内的整页重画留住它：
   画之前把它原样挪到文档里的一边（moveBefore：节点不离开文档，过渡不断），原位置放一个副本；画之后副本还在（所在的孤岛整个被复用）就换回原位，
   否则按树键 + 签名 + 第几个找到新画的同一个节点：里面的内容一样就换回原节点、属性按新画的补齐（状态以重画为准：和原地改的一样，过渡接着跑；
   不一样，就从当前位置过渡回去），里面的内容变了就用新画的 */
const REUSE_HOLD = [];
function holdSig(el) { return treeKey(el) + '|' + el.tagName + '.' + el.classList[0]; }
function holdKey(el, skip) {
  const sig = holdSig(el), same = Array.prototype.filter.call(document.querySelectorAll(el.tagName + '.' + el.classList[0]), function (x) { return x !== skip && holdSig(x) === sig; });
  return sig + '#' + same.indexOf(el);
}
function reuseHold(el) { if (!document.body.moveBefore || !ms('--dur-fast')) return; REUSE_HOLD.push({ el: el, key: holdKey(el), until: performance.now() + ms('--dur-fast') }); }   /* 不能原样挪动节点或减少动态效果时，照旧由重画画出终态 */
const LIVE_SEL = 'iframe[data-island][src]';   /* 活的孤岛：离开文档就会重新加载的节点（按地址加载的框），每次整页重画都原样挪开再放回，不只在过渡期 */
function holdPark() {
  const now = performance.now();
  if (document.body.moveBefore) document.querySelectorAll(LIVE_SEL).forEach(function (el) { if (!el.closest('.layer-covered') && !REUSE_HOLD.some(function (o) { return o.el === el; })) REUSE_HOLD.push({ el: el, key: holdKey(el), until: Infinity, live: true }); });
  for (let i = REUSE_HOLD.length - 1; i >= 0; i--) {
    const o = REUSE_HOLD[i]; o.ph = null;
    if (now > o.until || !o.el.isConnected || o.el.closest('.layer-covered')) { REUSE_HOLD.splice(i, 1); continue; }
    o.ph = o.el.cloneNode(true); o.el.parentNode.insertBefore(o.ph, o.el); document.body.moveBefore(o.el, null);
  }
}
function holdPlace() {
  REUSE_HOLD.forEach(function (o) {
    if (!o.ph) return; const ph = o.ph; o.ph = null;
    if (ph.isConnected) { ph.parentNode.moveBefore(o.el, ph); ph.remove(); return; }
    const nu = Array.prototype.find.call(document.querySelectorAll(o.el.tagName + '.' + o.el.classList[0]), function (x) { return x !== o.el && holdKey(x, o.el) === o.key; });
    if (!nu || nu.innerHTML !== o.el.innerHTML) { o.el.remove(); return; }
    Array.prototype.slice.call(o.el.attributes).forEach(function (a) { if (!nu.hasAttribute(a.name)) o.el.removeAttribute(a.name); });
    Array.prototype.slice.call(nu.attributes).forEach(function (a) { if (o.el.getAttribute(a.name) !== a.value) o.el.setAttribute(a.name, a.value); });
    getComputedStyle(nu).display; nu.parentNode.moveBefore(o.el, nu); nu.remove();   /* 目标处先有样式再挪进去（挪进还没算过样式的新子树时浏览器会丢掉正在跑的过渡） */
  });
  for (let i = REUSE_HOLD.length - 1; i >= 0; i--) if (!REUSE_HOLD[i].el.isConnected || REUSE_HOLD[i].live) REUSE_HOLD.splice(i, 1);   /* 活的孤岛每次重画重新登记 */
}
/* 画之前记下现有的可复用节点（按树键）；带 data-flip 的顺便记下位置 */
/* 被盖住 / 切走的层（.layer-covered）不是这次画的东西：它们由投影原样放回（navPlace），不参加复用，也不改它们记下的版本 */
function reuseNodes() { holdPark(); const out = {}; document.querySelectorAll(REUSE_SEL).forEach(function (el) { if (el.closest('.layer-covered')) return; out[treeKey(el)] = { el: el, r: el.hasAttribute('data-flip') ? el.getBoundingClientRect() : null }; }); return out; }
/* 画之后：版本相同的换回原节点。带 data-flip 的节点重画前后位置变了，从旧位置平滑移到新位置；新插进页面的节点没有“旧位置”，从不做过渡。
   到达动效：一条流里新出现的消息（这条流画之前就有、至少一条消息还在）加 arrive，放在那条消息节点上；整条流是新的（刚打开、换了对话）就不动。
   正在回复的那条用的是占位 id（typing），不算“还在”；占位出现时到达一次，正式消息接替它时不再到达 */
function reuseApply(old) {
  const msgOf = function (k) { const m = /(?:^|\/)m:([^|/]*)\|([^/]*)$/.exec(k); return m ? { stream: m[1], mid: m[2] } : null; };
  const els = Array.prototype.slice.call(document.querySelectorAll(REUSE_SEL)), keys = els.map(treeKey), had = {}, kept = [];
  keys.forEach(function (k) { const m = msgOf(k); if (m && m.mid !== 'typing' && old[k]) had[m.stream] = 1; });
  els.forEach(function (el, i) {
    if (!el.isConnected || NODE_HTML.has(el)) return;   /* 外层换回了原节点，里面这个新节点已经不在页面上；已经有版本的是投影放回的原节点（被盖住的、重新露出来的层），不是这次画的 */
    const k = keys[i], o = old[k], v = streamVer(el);
    if (o && o.el === el) return;   /* 局部重画：这个容器整个没换，节点就是上一次的那个，不用（也不能）自己换自己 */
    if (o && NODE_HTML.get(o.el) === v) { o.el.classList.remove('arrive'); el.replaceWith(o.el); if (o.r) kept.push(o); return; }
    NODE_HTML.set(el, v);
    const m = msgOf(k); if (!o && m && had[m.stream] && (m.mid === 'typing' || !old[k.replace(/\|[^|/]*$/, '|typing')])) el.classList.add('arrive');   /* 占位出现时到达一次；正式消息接替占位不再到达 */
  });
  holdPlace();
  const dur = ms('--dur-med'); if (!dur) return;   /* 减少动态效果：不做位置过渡 */
  kept.forEach(function (o) {
    if (o.el.hidden) return;
    const r = o.el.getBoundingClientRect(), dx = o.r.left - r.left, dy = o.r.top - r.top;
    if ((dx || dy) && o.r.width && r.width) o.el.animate([{ translate: dx + 'px ' + dy + 'px' }, { translate: '0 0' }], { duration: dur, easing: 'ease-out' });
  });
}
/* 滚动区的锚点（唯一一份）：窗口是固定的，内容里有变化（一张卡片变长变短、插入、删除、流式输出、展开收起、图片读完）时，
   只有变了的那一块自己重画，其余的按窗口的锚点往能伸展的方向挪，不跳。锚点只由窗口的状态决定，和点了什么、动作同步还是异步无关：
   · 贴底的区（stick-end）停在底部：锚点是底，变化往上长（浏览器的反向排列本来就这样，不用补）；普通的区停在顶上：锚点是顶，变化往下长；
   · 否则：锚点是窗口里第一张完整可见的单位（带身份的最外层节点：消息、行……）的上沿，它不动，变化都往它下面长；
     它被删掉了，就由紧挨着它的下一张接到它原来的位置；
   · 窗口里没有完整可见的单位（一张卡比一屏还高）：没有卡片锚点，只有窗口——贴底的区照旧往上走，普通的区停在原处。
   用户（或 streamScrollTo / scrollToMessage）滚动后重新取锚点；尺寸变化和增删由一个观察器统一还原。滚动位置只有这一个写入者（浏览器的原生锚定关掉）。 */
const KEYED_SEL = '[id], [data-island], [data-mid], [data-id], [data-k]';
const ANCHOR = new WeakMap();
/* 节点身份所在的那个属性（找同身份的节点时只按它原生查找，再比身份和所在的树） */
function keySel(n) { const d = n.dataset; return d.island ? '[data-island="' + CSS.escape(d.island) + '"]' : nodeId(n).indexOf('m:') === 0 ? '[data-mid="' + CSS.escape(d.mid) + '"]' : n.id ? '#' + CSS.escape(n.id) : d.id ? '[data-id="' + CSS.escape(d.id) + '"]' : '[data-k="' + CSS.escape(d.k) + '"]'; }
function keyedIn(sc, ref) { return Array.prototype.filter.call(sc.querySelectorAll(ref.sel), function (x) { return nodeId(x) === ref.id && treeKey(x) === ref.key; }); }
/* 单位 = 带身份的最外层节点。按文档顺序从第一张完整可见的单位起取 max 张：从滚动区往下走，找到之前只进和窗口相交的分支，单位里面不再进 */
function anchorUnits(sc, r, max) {
  const out = [];
  (function walk(p) {
    for (let n = p.firstElementChild; n && out.length < max; n = n.nextElementSibling) {
      const q = n.getBoundingClientRect();
      if (n.matches(KEYED_SEL)) { if (nodeId(n) && q.height && (out.length || (q.top >= r.top - 0.5 && q.bottom <= r.bottom + 0.5))) out.push(n); continue; }
      if (out.length || !q.height || (q.bottom > r.top && q.top < r.bottom)) walk(n);
    }
  })(sc);
  return out;
}
function anchorRef(sc, n) { const ref = { el: n, id: nodeId(n), key: treeKey(n), sel: keySel(n) }; ref.i = keyedIn(sc, ref).indexOf(n); return ref; }
function anchorTake(sc) {
  const st = sc.scrollTop;
  if (sc.classList.contains('stick-end') && st >= -1) return { bottom: true, st: st };
  if (!sc.classList.contains('stick-end') && st <= 1) return { top: true, st: st };   /* 普通的区停在顶上：锚点是顶，变化往下长 */
  const r = sc.getBoundingClientRect(), units = anchorUnits(sc, r, 3);
  if (!units.length) return { window: true, st: st };
  return { st: st, y: units[0].getBoundingClientRect().top - r.top, refs: units.map(function (n) { return anchorRef(sc, n); }) };
}
/* 节点还在（只是挪了）就是它；被换成了新节点再按身份找 */
function anchorFind(sc, ref) { return ref.el.isConnected && sc.contains(ref.el) ? ref.el : keyedIn(sc, ref)[ref.i] || null; }
function anchorApply(sc, a) {
  if (!a || !a.refs || !sc.isConnected) return;
  for (let i = 0; i < a.refs.length; i++) {
    const n = anchorFind(sc, a.refs[i]); if (!n || !n.getBoundingClientRect().height) continue;
    const d = n.getBoundingClientRect().top - sc.getBoundingClientRect().top - a.y;
    if (Math.abs(d) >= 1) { const st = sc.scrollTop; sc.scrollTop += d; if (sc.scrollTop !== st) ANCHOR_SELF.set(sc, sc.scrollTop); }
    return;
  }
}
const ANCHOR_SELF = new WeakMap();
/* 内容变了（进树、尺寸变化：引擎唯一的进树通知 treeMatch 交过来）：按变化前取的锚点还原，再取新的锚点。
   取锚点之后滚动位置被别人改过（脚本滚动还没来得及取）：那是新的位置，不按旧锚点挪，重新取 */
function anchorKeep(sc) {
  if (!sc || !sc.isConnected) return;
  const a = ANCHOR.get(sc);
  if (a && Math.abs(sc.scrollTop - a.st) <= 1) anchorApply(sc, a);
  ANCHOR.set(sc, anchorTake(sc));
}
/* 滚动后立刻重新取锚点（滚动事件每帧一次，在尺寸观察之前到）；引擎自己为了还原而改的那一下不算 */
document.addEventListener('scroll', function (e) { const sc = e.target; if (!sc.classList || !sc.classList.contains('scroll')) return; const own = ANCHOR_SELF.get(sc); ANCHOR_SELF.delete(sc); if (own != null && Math.abs(sc.scrollTop - own) <= 1) return; ANCHOR.set(sc, anchorTake(sc)); }, true);
/* 把消息流放到某个位置（null = 到底）：到最新、从查找返回、返回原处都走这里，和 scrollToMessage 一起是唯一主动改 #stream 位置的地方；之后的锚点由上面的规则重新取。
   消息流是 stick-end：scrollTop ≤ 0，0 就是底 */
function streamTop() { const s = document.getElementById('stream'); return s ? s.scrollTop : 0; }   /* 消息流现在的位置（给“返回原处”记下；还原走 streamScrollTo） */
function streamScrollTo(top) {
  /* top：数字 = scrollTop；null = 到底；{ mid, off } = 让这条消息离视口顶 off（之后内容高度变了由浏览器的滚动锚定保持） */
  const s = document.getElementById('stream'); if (!s) return;
  const el = top && typeof top === 'object' ? s.querySelector('[data-stream] > [data-mid="' + top.mid + '"]') : null;
  if (el) s.scrollTop += el.getBoundingClientRect().top - s.getBoundingClientRect().top - top.off;
  else s.scrollTop = top == null ? 0 : typeof top === 'object' ? top.top : top;
}
/* 跳到某条消息（跳到原文、点引用、补充消息的跳到原文、跨对话落点、查找命中……都走这一个）：
   浏览器原生的平滑滚动（scrollIntoView，减少动态效果时直接到位），停下来之后（scrollend）才回调——强调从这时开始；
   目标还没加载（更早的消息）时先加载再滚。仍然是消息流唯一的滚动所有者：只有这里和 streamScrollTo 改 #stream 的位置 */
const STREAM_OLDER = { load: null };   /* 对话区登记“加载更早的消息”（返回 false 表示已经没有更早的了） */
/* 落点强调：跳转 / 定位停下来之后，目标闪一下（--dur-emph）。节点上直接加类；期间重画时组件按 landed(key) 照样画上，到时清掉 */
const LANDED = {};
function landed(key) { return !!LANDED[key]; }
function land(el, key, cls) {
  if (LANDED[key]) clearTimeout(LANDED[key].t);
  el.classList.add(cls);
  LANDED[key] = { cls: cls, t: setTimeout(function () { delete LANDED[key]; document.querySelectorAll('.' + cls).forEach(function (x) { x.classList.remove(cls); }); }, ms('--dur-emph')) };
}
/* 定位一个节点：滚进视口，落点强调（行用 emph-ring）。app 只给属性名和值（data-<attr>="<value>"），不碰页面；at = 'center'（默认）| 'start'，ring: false 只滚不闪 */
function locateNode(attr, value, o) {
  o = o || {};
  const el = document.querySelector('[data-' + attr + '="' + CSS.escape(String(value)) + '"]'); if (!el) return false;
  if (ENGINE_PARTS.reveal) ENGINE_PARTS.reveal(el);
  el.scrollIntoView({ block: o.at || 'center' });
  if (o.ring !== false) land(el, attr + ':' + value, 'emph-ring');
  return true;
}
let JUMP_WAIT = null;   /* 正在滚向的那次跳转：重画后看一眼流 / 目标还在不在 */
function scrollToMessage(mid, done, tries) {
  const s = document.getElementById('stream'); done = done || function () {};
  /* 只认消息节点（流的直接子项）：按钮、引用这类也带 data-mid，不能当成落点；正在输出的那条用 data-run 标它的消息号 */
  const el = s && s.querySelector('[data-stream] > [data-mid="' + mid + '"], [data-stream] > [data-run="' + mid + '"]');
  if (!el && ENGINE_PARTS.unitsAll && ENGINE_PARTS.unitsAll()) { scrollToMessage(mid, done, tries); return; }   /* 目标在数据里但还没画（长列表分批画）：先全画上 */
  if (!el) { if ((tries || 0) < 3 && STREAM_OLDER.load && STREAM_OLDER.load(function () { scrollToMessage(mid, done, (tries || 0) + 1); }) !== false) return; done(false); return; }
  let live = true;
  const fin = function () { if (!live) return; live = false; JUMP_WAIT = null; land(el, mid, 'emph'); done(true, el); };
  /* 滚动途中整页重画换掉了消息流（或目标节点）：旧节点上的 scrollend 不会再来，按 mid 重新找一次再滚 */
  const again = function () { if (!live) return; live = false; JUMP_WAIT = null; scrollToMessage(mid, done, tries); };
  /* 已经在位（或滚不动）时不会有 scrollend：读一下目标和当前的差（只读，不用来定位）。
     之前的滚动留下的 scrollend 可能晚一拍才到：到了还没在位、也还滚得动，就接着等下一个 */
  const away = function () { const sr = s.getBoundingClientRect(), r = el.getBoundingClientRect(), d = (r.top + r.height / 2) - (sr.top + sr.height / 2), room = d > 0 ? -s.scrollTop : s.scrollHeight - s.clientHeight + s.scrollTop;   /* stick-end：往下（朝底）还能滚 -scrollTop，往上还能滚到 -(sh - ch) */ return Math.abs(d) >= 2 && room >= 2; };
  if (!away() || motionOff()) { el.scrollIntoView({ block: 'center', behavior: 'instant' }); fin(); return; }
  if (JUMP_WAIT) JUMP_WAIT.drop();   /* 新的跳转接替旧的 */
  JUMP_WAIT = { check: function () { if (!s.isConnected || !el.isConnected) again(); }, drop: function () { live = false; } };
  /* 在文档上（捕获）等 scrollend：流被换掉时也收得到 */
  const wait = function () { document.addEventListener('scrollend', function (e) {
    if (!live) return;
    if (!s.isConnected || !el.isConnected) { again(); return; }
    if (e.target !== s) { wait(); return; }
    if (away()) { wait(); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } else fin(); }, { once: true, capture: true }); };
  wait();
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
}
function jumpCheck() { if (JUMP_WAIT) JUMP_WAIT.check(); }
onRender(jumpCheck);
/* 触发元素：点击分发（见下面的 click 分发）在执行动作时记在 ACT_FROM，动作结束就清掉——不另外监听点击。投影引擎（proj.js）从它推出容器链 */
let ACT_FROM = null;
/* 用户最后点的是哪一个（锚点名）：菜单里的一项算打开这个菜单的那个按钮。打开对话框的动作常常先读一份数据再开（中间 ACT_FROM 已经清掉），对话框按它认触发者 */
let ACT_TRIGGER = null;
function actTrigger(el) { const pop = el.closest('[data-pop]'), a = pop && ANCHORED[pop.dataset.pop]; return a ? a.name : anchorOf(el); }
/* 路由是不是空间的页面（入口打开的页、空间的主页 / 对话页 / 列出的路由）；不是的就是详情（入口声明的 also：成员详情、作品、插件详情……）。
   页面换的是页面容器（从外面切换，没有返回）；详情是“打开内容”，开到默认层级（身体），盖住了触发处就有返回 */
function navIsPage(r) {
  const also = pdlEntryIds().some(function (k) { return (pdlEntry(k).also || []).indexOf(r) >= 0; });
  if (pdlEntryIds().some(function (k) { return (pdlEntry(k).open || {}).page === r; })) return true;
  if (also) return false;
  return Object.keys(PDL_SPACES).some(function (k) { const s = PDL_SPACES[k]; return s.home === r || s.threadView === r || (s.routes || []).indexOf(r) >= 0 || (s.prefix && r.indexOf(s.prefix) === 0); });
}
/* 地址栏保存页面容器的底层路由及参数；临时叠加内容不覆盖可恢复的地址。盖在上面、自己声明了路由的帧（从地址打开的那一层）例外，地址是它 */
function navHash() { const fc = navCovers().find(function (c) { const l = navStack(c)[0]; return l && String(l.f).indexOf('node:') === 0 && navRouteOf(l); }), base = navStack(fc || ctPages())[0], r = navRouteOf(base), p = ENGINE_PARTS.addressParam(r, base.a); try { history.replaceState(null, '', '#' + (p != null ? r + '-' + p : r)); } catch (e) { /* 某些环境不允许改地址 */ } }
/* 去一个路由（页面或详情，见 navIsPage）：
   - 触发处在投影的某一层里、去的是详情 → 打开（proj.js 的 navOpen：默认层级，盖住了触发处就压栈、有返回）；分栏的列表里选一项 → 分栏声明的 data-into（并排时换掉详情，不压栈；收起时压栈）；
   - 程序里去一个详情（没有触发元素）→ 换掉焦点那一层；
   - 去一个页面 → 切换页面容器（盖着它的层都离开） */
function go(to, o) {
  let route = to, param = null;
  const m = !PAGES[to] && /^([a-zA-Z]+)-(.+)$/.exec(to);   /* 详情页：页名-参数 */
  if (m && PAGES[m[1]]) { route = m[1]; param = m[2]; }
  /* 帧的路由：地址写得出来（navRouteOf），也要读得回去——打开那个帧，地址里的参数交给它 */
  const fk = !PAGES[route] && Object.keys(PDL_VIEWS).find(function (k) { const r = PDL_VIEWS[k].route; return r && !PAGES[r] && (to === r || to.indexOf(r + '-') === 0); });
  if (fk) { const fr = PDL_VIEWS[fk], f = pdlNodeOpen(fk); navReset(); navReplace(f.target || ctPages(), 'node:' + fk, to === fr.route ? {} : { p: to.slice(fr.route.length + 1) }); navAfter(); return; }   /* 开到哪：打开它的入口（引用）说了算 */   /* 从地址进来就是这一层本身（换掉，不压栈） */
  const args = param != null ? { p: param } : {}, decl = pdlPageDecl(route);
  if (decl) { const d = pdlOpenOf(decl); if (d && d.target && d.target !== ctPages()) { pdlOpenNode(Object.assign({}, d, { args: Object.assign({}, d.args, args) }), ACT_FROM, decl); return; } }   /* 程序里的打开也是引用：真声明开在别处时照它开 */
  pagesOpen(route, args, ACT_FROM, o);
}
/* 开一个页面到页面容器（go、页面的打开声明、开到页面容器的入口都走这里）：已经在这儿就回到顶；从内容里打开另一个空间的页面时盖在原处（带 ✕ / Esc）；
   分栏的列表里打开的进分栏；o.exit：盖在原处、带这些关闭方式；o.address：按地址进来（换到页面所属的空间） */
function pagesOpen(route, a, t, o) {
  o = o || {}; let param = a.p != null ? a.p : null;
  if (!PAGES[route]) { route = startRoute(); param = null; a = {}; }
  const sp0 = PDL_SPACES[routeSpace(route)] || {};
  if (sp0.prefix && route.indexOf(sp0.prefix) === 0 && !plugOn(route.slice(sp0.prefix.length))) route = PDL_SPACES[Object.keys(PDL_SPACES).find(function (k) { return PDL_SPACES[k].fallback; })].home;   /* 插件页面：插件没开就回到兜底空间的主页 */
  /* 打开内容不改空间；声明了 own 的空间单独算 */
  const rs = routeSpace(route); if (PDL_SPACES[rs].own || (PDL_SPACES[S.space] || {}).own) S.space = rs;   /* 声明了 own 的空间：进出它的路由就换空间 */
  if (o.exit) { navOpen({ f: route, a: a, into: o.into, exit: o.exit }, t); return; }
  navReset();
  const tc0 = trigChain(t), cur = navRouteLayer(), to = param != null ? route + '-' + param : route;
  const after = function () {
    const anchor = ROUTE_ANCHOR[to] && document.getElementById(ROUTE_ANCHOR[to]);   /* 有些路由是一页里的某一节（比如 通知 → 系统配置的通知小节）：滚到那一节 */
    if (anchor) anchor.scrollIntoView({ block: 'start', behavior: 'instant' });
  };
  if (cur && navRouteOf(cur) === route && (cur.a.p == null ? null : String(cur.a.p)) === (param == null ? null : String(param))) {   /* 已经在这儿：重画，回到顶 */
    navHash(); render(false); document.querySelectorAll('.main, .main-col').forEach(function (el) { el.scrollTop = 0; }); after(); return;
  }
  const pane = t && t.closest && tc0.lc && t.closest('[data-ct="pane-l"]'), split = pane && pane.closest('[data-ct="split"]');
  if (split) { if (split.dataset.into === 'split') navOpen({ f: route, a: a, into: '.' }, t); else { navReplace(tc0.lc, route, a); navAfter(); } after(); return; }
  if (tc0.lc && !navIsPage(route)) { navOpen({ f: route, a: a }, t); after(); return; }
  if (!t && !navIsPage(route)) { navReplace(navFocusC(), route, a); navAfter(); after(); return; }
  /* 从内容里（主区、工作台里的链接和按钮）打开页面（对话里点“记忆”、点插件去它的设置页）：和打开内容一样开到触发处的默认覆盖层级（触发处的祖先，返回规则），
     压在原来的内容上，返回回去；从内容外面的入口（窄栏、设置菜单）切换照旧 */
  if (tc0.lc && navIsPage(route) && tc0.chain.indexOf(ctParent(ctPages())) >= 0) { navOpen({ f: route, a: a, push: true }, t); after(); return; }   /* 返回规则：从内容里开的页面压在原处，返回回到原来的内容（对话里开的带「‹ 对话标题」） */
  const sp = o.address && navIsPage(route) && rs !== space() ? rs : null;   /* 按地址进来：地址里的页面属于哪个空间就是哪个空间（离开的空间隐藏着留下）；入口打开页面只换主区，不换第二栏 */
  navSwitchC(ctPages(), route, a, after, !t && !o.ask, sp ? function () { S.space = sp; } : null);   /* 程序里的跳转不问；动作（导航）总要过离开检查 */
}
const ROUTE_ANCHOR = {};
/* 时长 token（毫秒）：组件和交互里用到的等待都从 CSS 的时长 token 读，不在脚本里写数字 */
const MS_CACHE = {};
function ms(name) { if (MS_CACHE[name] == null) { const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); if (!v) return 0;   /* 样式表在脚本之前加载（脚本等样式表），这里总能读到 */ MS_CACHE[name] = (parseFloat(v) || 0) * (/ms$/.test(v) ? 1 : 1000); } return MS_CACHE[name]; }
let toastTimer = null;
/* 提示条；act 可选：一个文字操作（比如转发后的“查看”） */
/* 复制：唯一的一处。真的写进剪贴板（不可用时静默），不弹提示：点的那个图标原地变成勾，--hold-copied 后变回（菜单里的复制项随菜单关掉，闪的是打开菜单的 ⋯） */
function copyText(text, el) {
  PLATFORM.clipboard(String(text == null ? '' : text));   /* 平台口（engine/platform.js）：剪贴板不可用时静默 */
  el = el && el.nodeType ? el : ACT_FROM;
  const host = el && el.closest && el.closest(POP_SEL), closes = host && popExits(host.dataset.pop, 'pick') && !el.closest('[data-stay]');   /* 只有选了就关的弹窗才闪它的触发元素 */
  const trig = closes && POP_TRIG[host.dataset.pop] ? anchorEl(POP_TRIG[host.dataset.pop]) : null;
  ENGINE_PARTS.copied(trig || el);
}
/* 弹过的提示条按顺序记下（检查用：代表性的操作之后这里不该有新的） */
const TOAST_LOG = [];
function toast(msg, act, tone) { TOAST_LOG.push(String(msg)); S.toast = msg; S.toastAct = act || null; S.toastTone = tone || null; render(true); clearTimeout(toastTimer); toastTimer = setTimeout(function () { S.toast = null; const t = document.querySelector('.toast'); if (t) t.remove(); }, ms('--hold-toast')); }
/* 边缘拖动：组件库里唯一的拖动机制。鼠标移到元素边缘 6px 显示移动光标，按住拖动；元素中间照常点击。
   谁能被拖由登记的提供者决定（EDGE_DRAG）：find(目标) → 可拖的元素（或 { el, whole } 整块都算边缘）；start(元素, 事件) → 会话 { move(e), end(e, moved) }。
   弹窗框架（下面）和编辑布局里可编辑的节点（pdl.js）都登记在这里，用户只学一个手势。拖过之后紧跟的那次点击会被吃掉，免得拖完误触发 */
const EDGE_DRAG = [];
(function () {
  const EDGE = 6; let sess = null, eat = false, cur = null;
  const onEdge = function (el, e) { const r = el.getBoundingClientRect(); return e.clientX - r.left < EDGE || r.right - e.clientX < EDGE || e.clientY - r.top < EDGE || r.bottom - e.clientY < EDGE; };
  /* 嵌套拖动按命中层级取最近的可抓元素；外层窗口不能先截走里面的入口。 */
  const hit = function (t, e) {
    let found = null;
    for (const pr of EDGE_DRAG) {
      const x = pr.find(t); if (!x) continue;
      const el = x.el || x; if (!x.whole && !onEdge(el, e)) continue;
      if (!found || found.el !== el && found.el.contains(el)) found = { pr: pr, el: el };
    }
    return found;
  };
  document.addEventListener('mousemove', function (e) {
    if (sess) { sess.moved = true; sess.s.move(e); return; }
    const x = hit(e.target, e), el = x && x.el;
    if (cur && cur !== el) cur.style.cursor = '';
    if (el) el.style.cursor = 'move';
    cur = el;
  });
  document.addEventListener('mousedown', function (e) {
    if (e.button !== 0) return;
    const x = hit(e.target, e); if (!x) return;
    const s = x.pr.start(x.el, e); if (!s) return;
    sess = { s: s, moved: false }; e.preventDefault();
  }, true);
  document.addEventListener('mouseup', function (e) { if (!sess) return; const s = sess; sess = null; if (s.moved) eat = true; s.s.end(e, s.moved); setTimeout(function () { eat = false; }, 0); });
  document.addEventListener('click', function (e) { if (eat) { e.stopImmediatePropagation(); e.preventDefault(); eat = false; } }, true);
})();
/* 弹窗拖动：弹窗框架（[data-pop] 的第一个子元素）能不能拖只看 PDL_POPUPS 的 drag 声明，不逐个开启。拖动是相对初始位置（at）的偏移，只在这次打开期间有效：关掉再打开回到初始位置 */
S.dragPos = {};
EDGE_DRAG.push({ find: function (t) { return popFrameOf(t); }, start: function (el, e0) {
  const k = el.parentElement.dataset.pop, q = S.dragPos[k] || { x: 0, y: 0 }, sx = e0.clientX, sy = e0.clientY;
  return { move: function (e) { const p = S.dragPos[k] = { x: q.x + e.clientX - sx, y: q.y + e.clientY - sy }; dragOffset(el, p); }, end: function () {} };
} });
/* 把偏移交给框架（组件库按弹窗的身决定怎么挪：一般用 translate；page 层的身用相对定位，因为带变换时按视口铺的底图会失效） */
function dragOffset(el, p) { el.setAttribute('data-dragged', ''); el.style.setProperty('--drag-x', p.x + 'px'); el.style.setProperty('--drag-y', p.y + 'px'); }
/* 鼠标下面的弹窗框架：[data-pop] 的第一个子元素；没声明 drag 的不拖 */
function popFrameOf(t) { const host = t && t.closest && t.closest(POP_SEL), pp = host && PDL_POPUPS[host.dataset.pop]; if (!pp || !pp.drag) return null; const f = host.firstElementChild; return f && f.contains(t) ? f : null; }
function restoreDragPos() {
  const seen = {};
  document.querySelectorAll(':is(' + POP_SEL + ') > :first-child').forEach(function (el) { const k = el.parentElement.dataset.pop, q = S.dragPos[k]; seen[k] = 1; if (q && !el.hasAttribute('data-dragged')) dragOffset(el, q); });
  Object.keys(S.dragPos).forEach(function (k) { if (!seen[k]) delete S.dragPos[k]; });
}
onRender(restoreDragPos);
function dialog(d) { S.dialog = dialogOf(d); S.dialog.from = ACT_TRIGGER; render(true); }   /* 焦点、Esc、×、和打开它的菜单的关系（pick 交给菜单的主人）由弹窗框架给（frame.js） */
function val(id, raw) { const el = document.getElementById(id); return el ? (raw ? el.value : el.value.trim()) : ''; }   /* raw：原样（不去两头空白） */
function fileOf(id) { const el = document.getElementById(id); return el && el.files && el.files[0] || null; }   /* 文件字段选中的文件 */
function caretOf(id) { const el = document.getElementById(id); return el && el.selectionStart != null ? el.selectionStart : null; }   /* 输入框的光标位置 */
function liveVar(name, value) { const app = document.querySelector('.app'); if (app) app.style.setProperty(name, value); }   /* 拖动中先把一个外壳变量直接写上（松手后的重画按状态再写一遍） */
function picked(name) { const el = document.querySelector('input[name="' + name + '"]:checked'); return el ? el.value : ''; }   /* 单选组选中的值 */
function chosenIndex(id) { const el = document.getElementById(id); return el ? el.selectedIndex : -1; }   /* 下拉选中的第几项 */
function ticked(id) { const el = document.getElementById(id); return !!(el && el.checked); }   /* 勾选框 */
function hm(ms) { const d = ms == null ? new Date() : new Date(ms); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }
function now() { return hm(); }
/* 时长的两种写法，各只有一处：clockText = 计时器（m:ss，满一小时 h:mm:ss），durText = 一段话里的时长（x 分 y 秒） */
function durText(sec) { return ENGINE_PARTS.duration(sec); }
function clockText(sec, hours) { sec = Math.max(0, Math.round(sec)); const p2 = function (n) { return String(n).padStart(2, '0'); }; return hours || sec >= 3600 ? Math.floor(sec / 3600) + ':' + p2(Math.floor(sec % 3600 / 60)) + ':' + p2(sec % 60) : Math.floor(sec / 60) + ':' + p2(sec % 60); }
/* 改没改过：不另存标记，从“草稿 vs 原值”推出来。有草稿的表单登记一次 formDraft(表单名, { dirty, drop })：
   dirty() 草稿和原值不同；drop() 离开时丢掉草稿。表单在不在某个容器里看页面上的 form[data-form]，离开检查（frame.js 的 leave）只认这个。
   输入时先把页面上的值收进草稿（DIRTY_PULL），再按推出来的结果显隐保存栏 */
const DIRTY = [], DIRTY_PULL = [];
function formDraft(form, o) { DIRTY.push({ form: form, dirty: o.dirty, drop: o.drop }); }
Object.defineProperty(S, 'dirty', { configurable: true, get: function () { return DIRTY.some(function (x) { return x.dirty() && !!document.querySelector('form[data-form="' + x.form + '"]'); }); } });
function markDirty() { DIRTY_PULL.forEach(function (f) { f(); }); const b = document.getElementById('savebar'); if (b) b.hidden = !S.dirty; }

/* ───────────── Actions ───────────── */
const A = {
  /* 提示条：只剩看不见结果的那几类（下载、导出到别处……） */
  toast: function (d) { toast(d.msg); },
  undo: function () { const u = UNDO.cur; undoDrop(); if (u) u.undo(); render(true); },   /* 撤销提示上的“撤销”：执行动作声明的撤回 */
  /* 所有 ⋯ / 下拉菜单都走这一个动作：菜单作用的对象（d.k）记在 S.menuTarget，菜单项的动作从这里读 */
  menu: function (d, el) {
    S.menuTarget = d.k;
    S.menu = { items: menuItems(d.menu, d), k: d.k }; menuAnchor(el);
    render(true);
  }
};
/* ───────── 通用动作（引擎）─────────
   界面上的动作只有一小组通用动词，参数是数据：要改哪个状态（路径）、哪个实体、哪个 id。引擎不认具体的路径和实体名，它们由功能模块登记：
     STATE_ROOTS[根] = function () → 对象          路径的第一段（'s.memberFilter' → S.memberFilter）；路径里的 {名} 换成参数里的同名值（'s.notify.{k}'）
     SET_AFTER[路径模板] = function (值, 参数)     改完之后的连带（换了视图回到第一页这类），按声明时的模板原样查
     ENT[实体] = { get(id), coll(), name, title, make(值), fields, confirm(x), undo, undoText(动作, x, 值), after(x, 字段, 新, 旧), remove(x), add(值) }
     RESETS[范围] = { get(), set(值), def() }        恢复默认：引擎记下原值，给撤销
     DIALOGS[种类] = function (参数) → 对话框描述    打开一种对话框
   动词：set toggle pick fold open menu dialog close back forward copy rename remove add listOp setStatus insert reset refresh tab rail（tab / rail 在 frame.js / pdl.js）。
   参数从 data-* 来，都是字；按目标现在的类型转（数字、真假），也可以写 cast: num | bool | null（空字 → null）。 */
/* 每个名字只能登记一次：两个模块登记同一个实体 / 种类时报错（后登记的会悄悄盖掉前一个） */
function actRegistry(what) { return new Proxy({}, { set: function (o, k, v) { if (k in o) console.error('duplicate ' + what + ' ' + String(k)); o[k] = v; return true; } }); }
const STATE_ROOTS = actRegistry('state root'), SET_AFTER = actRegistry('SET_AFTER'), ENT = actRegistry('entity'), RESETS = actRegistry('reset scope'), DIALOGS = actRegistry('dialog');
function pathRef(path, d, make) {
  const segs = String(path).split('.').map(function (s) { return s.replace(/\{(\w+)\}/g, function (_, k) { return d && d[k] != null ? d[k] : ''; }); });
  const root = STATE_ROOTS[segs[0]]; if (!root) throw new Error('state root ' + segs[0]);
  let o = root();
  for (let i = 1; i < segs.length - 1; i++) { if (o[segs[i]] == null) { if (!make) return { o: {}, k: segs[segs.length - 1], miss: true }; o[segs[i]] = {}; } o = o[segs[i]]; }
  return { o: o, k: segs[segs.length - 1] };
}
function pathGet(path, d) { const r = pathRef(path, d); return r.miss ? undefined : r.o[r.k]; }
function castTo(v, cur, how) {
  if (how === 'num' || (how == null && typeof cur === 'number')) return v === '' || v == null ? null : +v;
  if (how === 'bool' || (how == null && typeof cur === 'boolean')) return v === true || v === 'true' || v === '1';
  if (how === 'null') return v === '' || v == null ? null : v;
  return v;
}
function pathSet(path, v, d) { const r = pathRef(path, d, true), nv = castTo(v, r.o[r.k], d && d.cast); r.o[r.k] = nv; if (SET_AFTER[path]) SET_AFTER[path](nv, d || {}); return nv; }
function entOf(d) { const e = ENT[d.entity]; if (!e) throw new Error('entity ' + d.entity); return e; }
function entGet(e, id) { return e.get ? e.get(id) : (e.coll() || []).find(function (x) { return String(x.id) === String(id); }); }
/* 实体的一次改动：能撤回的（实体声明了 undo，或者 undo 列出了这个状态值）直接做、给撤销提示；不能撤回又声明了 confirm 的先确认 */
function entChange(e, op, x, v, doIt) {
  const undo = e.undo === true || (Array.isArray(e.undo) && e.undo.indexOf(op === 'remove' ? 'remove' : String(v)) >= 0);
  const cf = !undo && e.confirm && (op === 'remove' || (e.confirmOn || []).indexOf(String(v)) >= 0) ? e.confirm(x, op, v) : null;
  /* doIt 可以返回撤销函数，或者等后端的 promise（兑现成撤销函数）；确认框跟着这个 promise 进行中 / 失败留下 */
  const done = function (back) { if (e.after) e.after(x, op, v); if (undo && back) undoShow({ text: e.undoText ? e.undoText(op, x, v) : tc('common.done'), undo: back }); else render(true); };
  const run = function () { const back = doIt(); return back && typeof back.then === 'function' ? back.then(done) : done(back); };
  if (cf) dialog({ kind: cf.kind, args: cf.args, title: cf.title, text: cf.text, ok: cf.ok || tc('common.delete'), danger: cf.danger !== false, fields: cf.fields, on: function () { if (cf.check && !cf.check()) return; return run(); } }); else return run();   /* 确认的字可以在主题里声明（cf.kind → dlg.<kind>） */
}
/* 表单字段的值：实体声明 fields: [{ id, key, req, unique }]；必填 / 重复的错误写在字段上（fieldErr），不弹提示 */
function entFields(e, d) {
  const vals = {}, bad = [];
  (e.fields || []).forEach(function (f) {
    const v = d.vals && f.i != null ? d.vals[f.i] : f.id ? val(f.id) : d[f.key];
    vals[f.key] = v == null ? '' : String(v).trim();
    if (f.req && !vals[f.key]) bad.push([f.id, tc('common.required')]);
    else if (f.unique && (e.coll() || []).some(function (x) { return String(x[f.key]).toLowerCase() === vals[f.key].toLowerCase(); })) bad.push([f.id, tc('common.exists')]);
  });
  bad.forEach(function (b) { if (b[0]) fieldErr(b[0], b[1]); });
  return bad.length ? null : vals;
}
Object.assign(A, {
  set: function (d) {
    const ps = String(d.path).split('|'), vs = d.v == null ? [] : String(d.v).split('|');
    ps.forEach(function (p, i) { pathSet(p, d.add != null ? (+pathGet(p, d) || 0) + (+d.add) : (vs.length > 1 ? vs[i] : d.v), d); });
    render(true);
  },
  toggle: function (d) {
    const cur = pathGet(d.path, d);
    if (d.values) { const l = String(d.values).split('|'), i = l.indexOf(String(cur)); pathSet(d.path, l[(i + 1) % l.length], d); } else pathSet(d.path, !cur, Object.assign({}, d, { cast: 'bool' }));
    render(true);
  },
  /* 集合里加入 / 拿掉一个 id（数组按成员，对象按 id → true）；none 清空，all 是逗号分隔的 id */
  pick: function (d) {
    const r = pathRef(d.path, d, true); let c = r.o[r.k];
    if (d.none != null) c = Array.isArray(c) ? [] : {};
    else if (d.all != null) { c = Array.isArray(c) ? c : (c || {}); String(d.all).split(',').filter(Boolean).forEach(function (id) { if (Array.isArray(c)) { if (c.indexOf(id) < 0) c.push(id); } else c[id] = true; }); }
    else if (Array.isArray(c)) { const i = c.indexOf(d.id); if (i >= 0) c.splice(i, 1); else c.push(d.id); }
    else { c = c || {}; if (c[d.id]) delete c[d.id]; else c[d.id] = d.v != null ? d.v : true; }
    r.o[r.k] = c; if (SET_AFTER[d.path]) SET_AFTER[d.path](c, d);
    render(true);
  },
  /* 打开：节点上的打开声明就是这个动作的参数——ref 引用真声明的触发者（被打开的节点、as、位置跟着它），或者自己写 page / view / frame + anchor / depth / as；
     其余的键是交给被打开节点的参数（args）。path / v：打开前先定好一个状态（带着查询词去插件页这类） */
  open: function (d, el) {
    if (d.path) pathSet(d.path, d.v, d);
    pdlOpenSpec(d, el);
  },
  dialog: function (d) { const x = DIALOGS[d.kind] ? DIALOGS[d.kind](d) : { kind: d.kind, args: d }; if (x) dialog(x); },   /* 主题里声明了的对话框（dlg.<kind>）不用再登记 */
  /* 关掉一样东西：弹窗按名字（离开检查在弹窗框架里），状态路径回到“没开”（真假 → false，其余 → null） */
  close: function (d) {
    if (d.popup) return popClose(d.popup);
    if (d.beside) { Object.keys(NAV.on).forEach(function (c) { NAV.on[c] = NAV.on[c].filter(function (f) { return f !== d.beside && f !== 'node:' + d.beside; }); }); render(true); return; }   /* 并排打开的（beside）：它自己声明的关闭 */
    if (d.node) return nodeClose(d.node);
    const r = pathRef(d.path, d); if (r.miss || r.o[r.k] == null || r.o[r.k] === false) return;
    r.o[r.k] = typeof r.o[r.k] === 'boolean' ? false : null; if (SET_AFTER[d.path]) SET_AFTER[d.path](r.o[r.k], d);
    render(true);
  },
  back: function (d) { navBack(d.c); },
  forward: function (d) { navForward(d.c); },
  copy: function (d, el) { copyText(d.v, el); },
  download: function (d) { PLATFORM.download(d.name, d.text != null ? d.text : { url: d.source }); },   /* 下载 / 导出：唯一的一处。source 是视图模型给的真实地址，或 text 是要导出的内容；name 是保存的文件名；怎么存由平台层决定 */
  /* 改名：实体声明 name（字段名，默认 name）和 title（对话框标题）；inline 时在原处变成输入框（S.renaming），提交带 v */
  rename: function (d) {
    const e = entOf(d), x = entGet(e, d.id), k = e.name || 'name';
    if (d.v != null) { const v = String(d.v).trim(); S.renaming = null; if (v && x) { if (e.rename) e.rename(x, v); else x[k] = v; } render(true); return; }
    if (e.inline) { S.renaming = { entity: d.entity, id: String(d.id) }; render(true); focusField(e.inline, 'all'); return; }
    const t = e.title ? e.title(x) : null;   /* title 给字，或给 { kind, args }：对话框的字在主题 dlg.<kind> 里 */
    dialog(Object.assign(t && typeof t === 'object' ? t : { title: t || tc('common.rename') }, { fields: [{ id: 'dlg-in', label: tc('common.name'), value: x[k], max: '120' }], ok: tc('common.save'), on: function () { const v = val('dlg-in'); const r = v && e.rename ? e.rename(x, v) : (v && (x[k] = v), null); if (r && typeof r.then === 'function') return r.then(function () { render(true); }); render(true); } }));
  },
  remove: function (d) {
    const e = entOf(d);
    if (d.all != null) { const c = e.coll(); if (!c.length) return; return entChange(e, 'remove', null, null, function () { const was = c.splice(0, c.length); return function () { c.push.apply(c, was); }; }); }
    const x = entGet(e, d.id); if (!x) return;
    return entChange(e, 'remove', x, null, function () {
      if (e.remove) return e.remove(x);
      const c = e.coll(), i = c.indexOf(x); c.splice(i, 1);
      return function () { c.splice(Math.min(i, c.length), 0, x); };
    });
  },
  add: function (d, el) {
    const e = entOf(d), vals = e.fields ? entFields(e, d) : { v: (d.v || '').trim() };
    if (!vals) return false;
    if (!e.fields && !vals.v) { if (el && el.focus) el.focus(); return false; }
    const x = e.add ? e.add(vals, d) : (function () { const n = e.make ? e.make(vals, d) : vals; e.coll().push(n); return n; })();
    (e.fields || []).forEach(function (f) { if (f.id && f.keep !== true) { const i = document.getElementById(f.id); if (i) i.value = ''; } });
    if (x !== false) render(true);
    return x;
  },
  /* 草稿里的一列（键值对、行）：op add | del | move */
  listOp: function (d) {
    const r = pathRef(d.path, d, true), l = r.o[r.k] || (r.o[r.k] = []), i = +d.i;
    if (d.op === 'add') l.push(d.v != null ? d.v : (d.shape === 'pair' ? ['', ''] : d.shape === 'obj' ? {} : ''));
    else if (d.op === 'del') l.splice(i, 1);
    else if (d.op === 'move') { const x = l.splice(i, 1)[0]; l.splice(Math.max(0, Math.min(l.length, i + (+d.by || 0))), 0, x); }
    if (SET_AFTER[d.path]) SET_AFTER[d.path](l, d);
    render(true);
  },
  /* 实体的状态 / 开关：field 默认是实体声明的 status（再默认 st）；没给 v 就是开关（真假翻转） */
  setStatus: function (d) {
    const e = entOf(d), x = entGet(e, d.id); if (!x) return;
    const f = d.field || e.status || 'st', old = x[f], v = d.v == null ? !old : castTo(d.v, old, d.cast);
    /* 实体的 set 可以同步改，也可以等后端（返回 promise）；返回 / 兑现成 false 就是没改成，不给撤销 */
    entChange(e, 'status', x, v, function () { const r = e.set ? e.set(x, f, v, old) : void (x[f] = v); return Promise.resolve(r).then(function (ok) { return ok === false ? null : function () { if (e.set) e.set(x, f, old, v); else x[f] = old; }; }); });
  },
  /* 往输入框里写（引用、@、历史、补全）：into 是输入框 id，mode = append（默认）| replace；写完焦点放回去，输入事件照常发出（草稿由输入框自己的处理收下） */
  insert: function (d) {
    const i = document.getElementById(d.into); if (!i) return;
    i.value = d.mode === 'replace' ? d.text : i.value + (i.value && d.mode !== 'raw' && !/\s$/.test(i.value) ? ' ' : '') + d.text;
    i.dispatchEvent(new Event('input', { bubbles: true }));
    focusField(d.into, i.value.length);
  },
  reset: function (d) {
    const r = RESETS[d.scope], before = JSON.stringify(r.get());
    r.set(r.def()); const changed = JSON.stringify(r.get()) !== before;
    if (changed) undoShow({ text: r.text ? r.text() : tc('common.resetDone'), undo: function () { r.set(JSON.parse(before)); } }); else render(true);
  },
  /* 重新读一份数据：按钮自己转（aria-busy），读完停下；列表重画本身就是反馈，不弹提示（读取由接口层负责） */
  refresh: function (d) { BUSY[d.k] = true; busySync(); ioSend('refresh', { k: d.k }); }
});
/* 进行中的状态（引擎）：BUSY[键] = true 时，画出来的同一个按钮（data-act="refresh" data-k=键）带 aria-busy；接口推 refreshed 时停下。
   BUSY_AT[锚点名]：对话框确定后还在做的那件事，打开它的按钮带 aria-busy（dialogSubmit） */
const BUSY = {}, BUSY_AT = {};
function busySet(b, on) { if (on !== (b.getAttribute('aria-busy') === 'true')) { if (on) b.setAttribute('aria-busy', 'true'); else b.removeAttribute('aria-busy'); } }
function busySync() {
  document.querySelectorAll('[data-act="refresh"][data-k]').forEach(function (b) { busySet(b, !!BUSY[b.dataset.k]); });
  document.querySelectorAll('[data-busy-at]').forEach(function (b) { if (!BUSY_AT[b.dataset.aname]) { b.removeAttribute('data-busy-at'); busySet(b, false); } });   /* 只拿掉引擎自己加的 */
  Object.keys(BUSY_AT).forEach(function (name) { const b = anchorEl(name); if (b && !b.hasAttribute('data-busy-at')) { b.setAttribute('data-busy-at', ''); busySet(b, true); } });
}
onRender(busySync);
ioOn('refreshed', function (e) { delete BUSY[e.k]; render(true); });
/* 动作的查找：先查界面的动作表，再查应用接上的后备（经接口门面 api.act） */
function actFn(name) { return A[name] || (IO.port && IO.port.act && IO.port.act(name)) || null; }
/* ───────── 公共部分登记的数据（通用动作用）───────── */
STATE_ROOTS.s = function () { return S; };
A.anchorScroll = function (d) { const el = document.getElementById(d.id); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
document.addEventListener('click', function (e) {
  const el = e.target.closest('[data-act]');   /* 点外面关弹窗是弹窗框架的事（frame.js，按 PDL_POPUPS 的声明） */
  if (!el) return;
  if (el.dataset.act === 'closeDialog' && e.target.closest('[data-stop]') && !e.target.closest('button')) return;
  if (el.closest('[data-act]') !== el) return;
  const inner = e.target.closest('button, .switch, select, input, textarea, a');
  if (inner && inner !== el && el.contains(inner) && !inner.dataset.act) return;
  const fn = actFn(el.dataset.act);
  if (fn) { e.preventDefault(); e.stopPropagation(); ACT_FROM = el; ACT_TRIGGER = actTrigger(el); try { fn(actionArgs(el), el); } finally { ACT_FROM = null; } }
});
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape' && !e.isComposing && popEsc()) { e.preventDefault(); e.stopImmediatePropagation(); return; }   /* 弹窗框架：Esc 关最上面一个 */
  for (let i = 0; i < KEY_FNS.length; i++) if (KEY_FNS[i](e)) return;
  if (S.menu && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    const items = Array.prototype.slice.call(document.querySelectorAll('#menu button')), k = keyStep(e, items.indexOf(document.activeElement), items.length, { wrap: true });
    if (k != null) { e.preventDefault(); items[k].focus({ preventScroll: true }); keySelShow(items[k]); }
    return;
  }
  if (e.key === 'Escape') { keyDeclared(e); return; }   /* 弹窗的 Esc 在上面的 popEsc；控件自己声明的 esc（data-on-esc）在这里；别的（抽屉等）由各自登记在 KEY_FNS 里 */
  const el = e.target;
  if ((e.key === 'Enter' || e.key === ' ') && el.matches && el.matches('[role="button"][data-act], tr[data-act], .opt[data-act]')) { e.preventDefault(); el.click(); }
  keyDeclared(e);   /* 控件自己声明的按键（data-on-enter 等，见 ui.js） */
});
/* 把焦点放进一个（新出现的）输入框：唯一的一处。pos 是光标位置，'all' 全选。重绘时保住焦点和选区是 render() 自己的事，输入处理不用再补 */
/* 表单里第一个标了错的字段：聚焦并滚进视口（错误标在外框上时聚焦它里面的输入框） */
function focusInvalid(scope) {
  const s = document.getElementById(scope); if (!s) return false;
  const bad = s.querySelector('[aria-invalid="true"]'); if (!bad) return false;
  const el = bad.matches('input, textarea, select, button') ? bad : bad.querySelector('input, textarea, select, button') || bad;
  el.focus(); el.scrollIntoView({ block: 'center' }); return true;
}
function focusField(id, pos) { const i = document.getElementById(id); if (!i) return; i.focus(); if (pos === 'all') { if (i.select) i.select(); } else if (pos != null && i.setSelectionRange) i.setSelectionRange(pos, pos); }
function liveInput(key, idKey, stateKey) {
  return function (e) { S[stateKey] = e.target.value; render(true); };
}
const INPUTS = { dirty: markDirty };   /* 输入时的处理（data-input）：各模块登记 */
document.addEventListener('input', function (e) { const k = e.target.dataset && e.target.dataset.input; if (k && INPUTS[k]) INPUTS[k](e); });
document.addEventListener('change', function (e) {
  const ck = e.target.dataset && e.target.dataset.change; if (ck && CHANGES[ck]) CHANGES[ck](e);
});
document.addEventListener('submit', function (e) {
  e.preventDefault();
  const f = e.target, kind = f.dataset.form;
  if (FORMS[kind]) { FORMS[kind](f, e); return; }
  if (kind === 'dialog') return dialogSubmit();
});
/* 提交：同步的校验（返回 false、抛错）留在对话框里。确定之后要等的（安装、更新、保存……）：对话框马上关，
   打开它的那个按钮自己转（进行中，和刷新同一个状态）；没成功（false、{ error }、出错）就带着填过的内容和原因重新打开同一个对话框 */
function dialogSubmit() {
  const d = S.dialog;
  if (!d || !d.ok) return;
  dlgSync(); d.error = ''; S.dialog = null;
  let result;
  try { result = d.on && d.on(); }
  catch (error) { S.dialog = d; dlgError(error.message || String(error)); return; }
  if (result === false) { if (!S.dialog) S.dialog = d; render(true); return false; }   /* 校验没过：留在对话框里 */
  if (!result || typeof result.then !== 'function') { if (!d.on) render(true); return result; }
  const from = d.from, again = function (error) { if (!S.dialog) { d.error = error; S.dialog = d; } };   /* 这期间开了别的对话框：不抢它 */
  if (from) BUSY_AT[from] = (BUSY_AT[from] || 0) + 1;
  render(true);
  return settleHold(Promise.resolve(result).then(function (value) {
    if (value && value.error) again(value.error);
    else if (value === false) again('');
  }, function (error) { again(error.message || String(error)); }).finally(function () { if (from && !--BUSY_AT[from]) delete BUSY_AT[from]; render(true); }));
}
/* 节拍钟（每拍一次）：只跑登记在 RUN_TICK 里的局部更新（比如计时的字、状态跨过安静门槛时只改头像 / 圆点的状态属性），从不整页重画（局部变化只更新自己的节点）。
   会走的字是一种通用节点：画的时候标 data-tick="名字"，字由 TICK_TEXT[名字]() 给（应用登记）；tickSync() 只改这些节点的字。
   层的版本（frame.js layerVer）不算这些字——它们每拍都变，不是界面状态 */
const RUN_TICK = [], TICK_TEXT = {};
function tickSync() { document.querySelectorAll('[data-tick]').forEach(function (n) { const f = TICK_TEXT[n.dataset.tick]; if (f) n.textContent = f(); }); }
onStart('boot', function () { setInterval(function () { RUN_TICK.forEach(function (f) { f(); }); }, ms('--beat')); });


/* 重画后提示的目标不在了，提示跟着消失 */
function restoreTip() { if (TIP.at && !TIP.at.isConnected) tipHide(); }

onRender(restoreTip);
/* 参数值只写一次；属性用 HTML 的连字名，原键名和类型随同编码，分发时统一还原。控件自身的 data-* 仍是 DOM 元数据。 */
function argAttr(key) { return 'data-' + key.replace(/[A-Z]/g, function (c) { return '-' + c.toLowerCase(); }); }
function argAttrs(args) {
  const entries = Object.keys(args || {}).map(function (k) {
    const v = args[k], type = v === undefined ? 'undefined' : typeof v === 'string' && !/[\x00-\x1f]/.test(v) ? 'string' : 'json';
    return [k, type, type === 'string' ? v : type === 'undefined' ? '' : JSON.stringify(v)];
  });
  return entries.map(function (e) { return ' ' + argAttr(e[0]) + '="' + h(e[2]) + '"'; }).join('') +
    (entries.length ? ' data-arg-types="' + h(JSON.stringify(entries.map(function (e) { return e.slice(0, 2); }))) + '"' : '');
}
function actionArgs(el) {
  const data = Object.assign({}, el.dataset), types = JSON.parse(data.argTypes || '[]');
  delete data.argTypes;
  types.forEach(function (entry) {
    const key = entry[0], type = entry[1], attr = argAttr(key), value = el.getAttribute(attr);
    delete data[attr.slice(5).replace(/-([a-z])/g, function (_, c) { return c.toUpperCase(); })];
    data[key] = type === 'undefined' ? undefined : type === 'string' ? value : JSON.parse(value);
  });
  return data;
}
function actAttrs(act, args) { return (act ? ' data-act="' + h(act) + '"' : '') + argAttrs(args); }
/* ───────── 格子容器（编辑布局的格子） ─────────
   可编辑的容器是一排等大的格子（窄栏是一列，各种条是一行）。每项占整数个格子（span，按种类在 PDL 里写档位 s 1 / m 2 / l 4），
   位置 = { anchor: 'start' | 'end', cell }：从哪一端数、第几格。起始端的项从头往后排，结束端的项从尾往前排，中间一个弹性空位；
   用户留出的空格是可压缩的空位——窗口变小时先压空位，再压中间。贴着结束端放的（比如窄栏底部的待办、设置）窗口变高变矮都贴着底。
   items：[{ key, html, span, anchor（默认端）, locked }]；saved：{ key: { anchor, cell, t } } 用户放过的位置（t 越大越新，重叠时新的占位，旧的往后让）。 */
const CELL_SPAN = { s: 1, m: 2, l: 4 };
function cellsResolve(items, saved) {
  saved = saved || {};
  const out = { start: [], end: [] }, used = { start: [], end: [] };
  const free = function (a, c, n) { for (let i = c; i < c + n; i++) if (used[a][i]) return false; return true; };
  const take = function (a, c, n) { for (let i = c; i < c + n; i++) used[a][i] = true; };
  const put = function (it, a, c) { while (!free(a, c, it.span)) c += 1; take(a, c, it.span); out[a].push(Object.assign({}, it, { anchor: a, cell: c })); };
  const span = function (it) { return CELL_SPAN[it.span] || +it.span || 1; };
  const all = items.map(function (it) { return Object.assign({}, it, { span: span(it) }); });
  /* 先放固定的，再放用户放过的（新的优先），最后按默认顺序填进各自那一端最前面的空格 */
  all.filter(function (it) { return it.locked; }).forEach(function (it) { put(it, it.anchor || 'start', it.cell || 0); });
  all.filter(function (it) { return !it.locked && saved[it.key]; }).sort(function (a, b) { return (saved[b.key].t || 0) - (saved[a.key].t || 0); })
    .forEach(function (it) { const p = saved[it.key]; put(it, p.anchor === 'end' ? 'end' : 'start', Math.max(0, p.cell | 0)); });
  const rest = all.filter(function (it) { return !it.locked && !saved[it.key]; });
  rest.filter(function (it) { return (it.anchor || 'start') === 'start'; }).forEach(function (it) { put(it, 'start', 0); });
  rest.filter(function (it) { return it.anchor === 'end'; }).reverse().forEach(function (it) { put(it, 'end', 0); });   /* 结束端从尾往前数：列表里最后一项贴着尾巴，读起来的顺序不变 */
  out.start.sort(function (a, b) { return a.cell - b.cell; }); out.end.sort(function (a, b) { return b.cell - a.cell; });
  return out;
}
/* 调宽的行为：唯一的一处。每个把手在 RESIZERS 里登记 { width()（现在的宽）, preview(w)（拖动中只改变量）, commit(w)（松手写进状态）, reset(), min, max(), collapse?()（单击） }。
   拖动：往把手外侧拖变宽（data-side="end" 时反向）；方向键：一步 --sp-l；Home / 双击：恢复默认；单击：有 collapse 的才收起 */
const RESIZERS = {};
(function () {
  let dr = null, clickT = null;
  const R = function (el) { const d = el && el.closest && el.closest('[data-resize]'); return d && RESIZERS[d.dataset.resize] ? d : null; };
  const clamp = function (r, w) { return Math.round(Math.max(r.min, Math.min(r.max ? r.max() : 9999, w))); };
  const grow = function (d, dx) { return d.dataset.side === 'end' ? dx : -dx; };   /* 把手在区域的结束边：往外（右）拖变宽；在开始边：往左拖变宽 */
  document.addEventListener('pointerdown', function (e) { const d = R(e.target); if (!d) return; const r = RESIZERS[d.dataset.resize]; dr = { d: d, r: r, x: e.clientX, w: r.width(), cur: null, moved: false }; try { d.setPointerCapture(e.pointerId); } catch (err) { /* 有的浏览器不支持 */ } e.preventDefault(); });
  document.addEventListener('pointermove', function (e) {
    if (!dr) return; const dx = grow(dr.d, e.clientX - dr.x); if (Math.abs(dx) > 3) dr.moved = true; if (!dr.moved) return;
    dr.cur = clamp(dr.r, dr.w + dx); dr.r.preview(dr.cur); document.body.classList.add('resizing');
  });
  document.addEventListener('pointerup', function () {
    if (!dr) return; const x = dr; dr = null; document.body.classList.remove('resizing');
    if (x.moved) { x.r.commit(x.cur); return; }
    if (clickT) { clearTimeout(clickT); clickT = null; x.r.reset(); return; }
    clickT = setTimeout(function () { clickT = null; if (x.r.collapse) x.r.collapse(); }, ms('--dbl-click'));
  });
  KEY_FNS.push(function (e) {
    const d = R(e.target); if (!d) return false; const r = RESIZERS[d.dataset.resize], k = d.dataset.resize;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { const step = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sp-l')) || 16; r.commit(clamp(r, r.width() + grow(d, e.key === 'ArrowRight' ? step : -step))); const n = document.querySelector('[data-resize="' + k + '"]'); if (n) n.focus(); return true; }
    if (e.key === 'Home') { r.reset(); return true; }
    if ((e.key === 'Enter' || e.key === ' ') && r.collapse) { r.collapse(); return true; }
    return false;
  });
})();
/* 筛选里的“全部”是一个枚举值，不是一句显示文字 */
const ALL = 'all';
/* 字段上的错误（组件库）：必填、重复、格式不对写在字段下面（状态的 danger 档），不弹提示；改这个字段时消失。FIELD_ERR[字段 id] = 文字 */
const FIELD_ERR = {};
function fieldErr(id, msg) { FIELD_ERR[id] = msg; ENGINE_PARTS.fieldErr(); const el = document.getElementById(id); if (el && el.focus) el.focus(); return false; }
function fieldOf(el) { return el && el.closest ? el.closest('.ifield') : null; }
function fieldVals(f) { return Array.prototype.map.call(f.querySelectorAll('input.input'), function (x) { return x.value.trim(); }); }
Object.assign(A, {
  fieldGo: function (d, el) { const f = fieldOf(el), fn = f && actFn(f.dataset.go); if (!fn) return false; const vals = fieldVals(f), i = f.querySelector('input.input[id]'); if (i && !String(vals[0] || '').trim()) return fieldErr(i.id, tc('common.required'));   /* 空着提交：必填写在框下面，不是点了没反应 */
    return fn(Object.assign(actionArgs(f), { v: vals[0], vals: vals }), el); },
  fieldEsc: function (d, el) { const f = fieldOf(el); if (!f) return false; if (f.dataset.cancel && actFn(f.dataset.cancel)) return actFn(f.dataset.cancel)(actionArgs(f), el); f.querySelectorAll('input.input').forEach(function (x) { x.value = ''; }); },
  /* 失焦：焦点还在同一个框里（点了框里的提交图标、换到框里另一个输入）不算离开 */
  fieldBlur: function (d, el, e) { const f = fieldOf(el); if (!f || !f.dataset.cancel || (e && e.relatedTarget && f.contains(e.relatedTarget))) return false; setTimeout(function () { if (f.isConnected && !f.contains(document.activeElement) && actFn(f.dataset.cancel)) actFn(f.dataset.cancel)(actionArgs(f), el); }, 0); }
});
/* 进度条：0–100 */

/* ───────── Markdown（组件库：消息正文、文件预览、说明都用它） ───────── */
/* 行内：`代码`；成员的 @句柄 标成提及（代码里的不算） */
/* 行内 Markdown：`代码`、**粗体**、*斜体* / _斜体_、[文字](链接)（在外部打开）、@提及。代码和链接地址先换成占位，不参与其它格式 */
/* 引用胶囊（文件 / PR / 提交）：正文里的链接和行内代码先问一下解析钩子（MD_REF.resolve(引用, 组件库认出的链接种类)，视图模型那边登记，结果是数据），认得的画成 图标 + 名字；
   只有出问题时才带色调（文件不在了、检查没过、PR 关了），说明在悬停里。认不得的照常是链接 / 代码 */
const MD_REF = { resolve: null };
/* ───────── 控件自己声明按键和事件（组件库） ─────────
   输入控件写 data-on-<事件>="动作名"：enter（不带 Shift）、esc、tab（含光标在末尾按 →）、ctrl-r、blur、paste。
   全局只按声明把事件交给 A[动作](控件的 data, 控件, 事件)，动作返回 false 表示没处理；不按元素 id 认控件。 */
function keyEvName(e, el) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) return 'onEnter';
  if (e.key === 'Escape') return 'onEsc';
  if (e.key === 'Tab' || (e.key === 'ArrowRight' && el.selectionStart != null && el.selectionStart === (el.value || '').length)) return 'onTab';
  if (e.ctrlKey && (e.key || '').toLowerCase() === 'r') return 'onCtrlR';
  return null;
}
/* 限行数的列表最大高度直接声明成 (k + 1) × 行高，最后那一整行渐隐——不测量。scrollRows(k, 行高 token) 给列表；对话框正文按 --dlg-rows × 一档行高 */
function onDeclared(name, el, e) { const act = el && el.dataset && el.dataset[name]; if (!act || !actFn(act)) return false; return actFn(act)(actionArgs(el), el, e) !== false; }
function keyDeclared(e) { const el = e.target, k = el && el.dataset ? keyEvName(e, el) : null; if (k && onDeclared(k, el, e)) { e.preventDefault(); return true; } return false; }
document.addEventListener('focusout', function (e) { if (!RENDERING) onDeclared('onBlur', e.target, e); });
document.addEventListener('paste', function (e) { if (onDeclared('onPaste', e.target, e)) e.preventDefault(); });
/* PDL 控件的 on: { enter, esc, tab, ctrlR, blur, paste } → data-on-* */
function onAttrs(on) { return on ? Object.keys(on).map(function (k) { return ' data-on-' + k.replace(/[A-Z]/g, function (c) { return '-' + c.toLowerCase(); }) + '="' + h(on[k]) + '"'; }).join('') : ''; }
/* 颜色色板（单选） */
function dlgFieldById(id) { return S.dialog && S.dialog.fields ? S.dialog.fields.find(function (f) { return f.id === id; }) : null; }
/* 把弹窗里正在输入的内容写回字段（重画之前调用；输入时也随时写回）：每种字段怎么从页面上读回来是对话框组件的事（ENGINE_PARTS.dialogSync，组件库登记） */
function dlgSync() { if (S.dialog && (S.dialog.fields || S.dialog.doc) && ENGINE_PARTS.dialogSync) ENGINE_PARTS.dialogSync(S.dialog); }
/* 校验没过：留在弹窗里，显示一句错误，已填的内容保留 */
function dlgError(msg) { if (!S.dialog) return; dlgSync(); S.dialog.error = msg || ''; render(true); }
document.addEventListener('input', function (e) { if (e.target.closest && e.target.closest('.dialog')) dlgSync(); });
document.addEventListener('change', function (e) { if (e.target.closest && e.target.closest('.dialog')) dlgSync(); });
/* 弹窗里可增删的标签：kind 有自己的校验（CHIP_CHECK[kind](值, 现有值, 字段 id) 返回一句错误或空） */
const CHIP_CHECK = {};
/* 对话框里的字段按 id 当状态根（通用动作的路径 'dlgf.<字段 id>.…'：选项、环境变量的开合和增行）；分页换了，确认按钮的字跟着换 */
STATE_ROOTS.dlgf = function () { const o = {}; ((S.dialog || {}).fields || []).forEach(function (f) { if (f.id) o[f.id] = f; }); return o; };
SET_AFTER['s.dialog.panes.cur'] = function (v) { const p = S.dialog && S.dialog.panes; if (p && p.ok) S.dialog.ok = p.ok[v]; };

/* 打字时让位（组件库的通用行为）：typing-scope 里有输入时，标了 hideWhileTyping 的元素（data-htype）淡出；
   最后一次按键后约 1.5 秒（--typing-hold）淡回。只改一个属性，不触发重画；流式输出、头像、队列都不受影响 */
(function () {
  let tm = null;
  document.addEventListener('input', function (e) {
    const scope = e.target && e.target.closest && e.target.closest('.typing-scope'); if (!scope) return;
    scope.dataset.typing = '1'; clearTimeout(tm);
    tm = setTimeout(function () { delete scope.dataset.typing; }, ms('--typing-hold'));
  });
})();
function motionOff() { return document.documentElement.dataset.motion === 'reduce'; }
/* HTML → 纯文字（摘录、引用用）：块级元素和换行之间补一个空格，不把“@lang”和下一段“Decision”粘成一个词 */
function htmlText(html) { const d = document.createElement('div'); d.innerHTML = String(html || '').replace(/<br\s*\/?>/gi, ' ').replace(/<\/(p|div|li|h[1-6]|tr|td|th|pre|blockquote|ul|ol)>/gi, '$& '); return d.textContent.replace(/\s+/g, ' ').trim(); }
/* oneOf 表单（组件库唯一一个，插件配置的 configurationVariants 和成员的接入方式都用它）：分支的 when 是对几个字段一起的约束
   （{ properties: { 字段: { const } | { enum } } }，比如 客户端 = Google 且 接入方式 = ACP），当前的值恰好命中一个分支，它的字段就在；
   没被任何分支认领的字段一直在。几种组合可以共用一张表（enum）。oneOfKeys(全部字段键, { branches: [{ id, when, fields }] }, 当前值) → { 键: 1 } */
function oneOfWhen(when, values) {
  const props = (when && when.properties) || {};
  return Object.keys(props).every(function (k) {
    const c = props[k], v = values[k];
    if (v === undefined) return false;
    if ('const' in c) return String(v) === String(c.const);
    if (c.enum) return c.enum.map(String).indexOf(String(v)) >= 0;
    return true;
  });
}
function oneOfBranch(vp, values) { const hit = vp.branches.filter(function (b) { return oneOfWhen(b.when, values); }); return hit.length === 1 ? hit[0] : null; }
function oneOfKeys(keys, vp, values) {
  const claimed = {}; vp.branches.forEach(function (b) { b.fields.forEach(function (k) { claimed[k] = 1; }); });
  const branch = oneOfBranch(vp, values), out = {};
  keys.forEach(function (k) { if (!claimed[k]) out[k] = 1; });
  (branch ? branch.fields : []).forEach(function (k) { out[k] = 1; });
  return out;
}
/* 消息正文：真实模型存的是 Markdown；读消息时按需渲染一次（已有 html 的旧数据原样用） */
function msgMd(x) { if (x && x.md != null && x.html == null) x.html = ENGINE_PARTS.md(x.md); return x; }
/* 经组件库得到的两样文字和一个节点（ENGINE_PARTS 登记）：应用、视图模型只经这里取，不认识组件 */
function whoSync() { ENGINE_PARTS.whoSync(); }
function whoText(x, o) { return ENGINE_PARTS.whoText(x, o); }
/* 数据出错：当空数据画（由调用的一方给空），这里只给一条通用提示。
   来源（一份视图模型、宿主的一份数据……）的同一个错误只提示一次；dataOk 之后再出错会再提示。提示放到这一轮画完之后。 */
const DATA_ERR = {};
function dataError(source, e) {
  const m = String((e && e.message) || e);
  if (DATA_ERR[source] === m) return;   /* 同一个错误：不再提示，也不再往控制台打 */
  console.error(e);
  DATA_ERR[source] = m; setTimeout(function () { toast(tc('common.dataError'), null, 'danger'); }, 0);
}
function dataOk(source) { delete DATA_ERR[source]; }
/* 读一份视图模型：读出错就当空数据（null，各处按自己的空状态画） */
function vmRead(name, arg) {   /* arg：按渲染类型取到的模板，它的视图模型收到这一项的数据（见组件库的 typed 块） */
  if (!VM[name]) return null;
  try { const r = VM[name](arg); dataOk('vm:' + name); return r; }
  catch (e) { dataError('vm:' + name, e); return null; }
}
function framePost(key, data) { return ENGINE_PARTS.framePost(key, data); }   /* 往指定的框发一条命令，只发一次（组件按 key 找框，见 blocks.js） */   /* 身份的显示文字（名字，o.handle 时带句柄） */
function mdHtml(src) { return ENGINE_PARTS.md(src); }          /* Markdown → HTML */
function pdlNodeHtml(t, sc, root) { return PV_DRAW.node(t, sc, root); }   /* 按节点模板画一个节点（消息流的局部更新） */
function modalBox(o) { return ENGINE_PARTS.modal(o); }   /* 模态的框（应用登记的弹窗用它画框；正文是视图，底部是按钮的声明） */
