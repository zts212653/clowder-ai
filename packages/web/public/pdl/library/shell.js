/* 边界：一个含义一个组件、不为接口定制、不按位置推导样式 */
/* 外壳（组件库）：窄栏、二级栏的外壳和入口项、各个内置容器的画法（CT_DRAW）、工作台的外框（标签条、启动面板、菜单条、把手）、
   插槽里的入口、页面元素插槽、弹窗框架的盒子和按钮、编辑条。机制（投影、弹窗栈、返回槽、标签式容器的状态）在引擎（engine/frame.js），这里只画。 */
'use strict';
APP_CLASS.push(function () { return S.layout === 'two' ? 'layout-two' : ''; });
/* 区域是界面树里同级的节点：根元素带它的键（data-okey），放着设置入口的区域（受保护）固定（data-locked）。
   编辑布局时区域和其它可编辑的节点一样：边缘出现移动光标，按住拖到另一侧，区域里的东西跟着走（拖动机制见 core.js 的 EDGE_DRAG）。
   平时区域的边是调宽度的（↔ 光标），编辑布局时调宽度关掉——两种模式靠模式和光标区分，同一个手势不会有两种意思 */
function regionAttrs(key) { return ' data-okey="' + key + '"' + (S.editLayout ? ' data-edit="region"' : ''); }
function rail() {
  const sp = space();
  /* 窄栏是一列格子：品牌标志固定在起始端第 0 格；上方插槽的入口默认从起始端往下排，下方插槽的从结束端往上排；用户可以把入口放到任意一格 */
  const items = [], add = function (slot, anchor) { (pdlNodeHidden(slot) ? [] : pdlKids(slot)).forEach(function (id) { const html = pdlItem(id, slot); if (html) items.push({ key: id, html: html, span: 's', anchor: anchor, locked: slot === 'rail.mark' }); }); };   /* 品牌标志固定；设置入口和别的入口一样能移动 */
  add('rail.mark', 'start'); add('rail.top', 'start'); add('rail.bottom', 'end');
  return '<nav class="rail"' + regionAttrs('rail') + ' aria-label="' + h(tc('frame.rail')) + '">' + cellsHtml({ key: 'rail', axis: 'col', items: items, saved: pdlCells('rail'), edit: false, attrs: ' data-entries="rail.top rail.bottom"' }) + '</nav>';
}

/* 一行导航：当前项 = 路由就是它，或者它的入口声明的 also 里有当前路由（详情页、新建页），不按路由名写对照 */
function navItem(to, ic, label, trail, block) {
  const e = pdlEntry(to), cur = S.route === to || !!(e && (e.also || []).indexOf(S.route) >= 0);
  /* block：页面描述里的块（入口的稳定名字）。样子是导航行的默认，PDL 不挑表面 */
  return navRow({ label: label, icon: ic, attrs: (block ? ' data-block="' + block + '"' : '') + ' data-act="open" data-page="' + to + '"', current: cur, trail: trail ? '<span class="trail num">' + trail + '</span>' : '' });
}

/* o.title 标题（文字）+ o.acts 标题行右边的操作；o.foot 底部的入口（套 nav-foot） */
function navShell(o) {
  const cls = o.hidden ? 'cafe-hidden' : o.cls;
  const head = o.head != null ? o.head : '<span class="nav-title">' + h(o.title || '') + '</span>' + (o.acts || '');
  return '<aside class="nav' + (cls ? ' ' + cls : '') + '"' + regionAttrs('nav') + ' aria-label="' + o.label + '">' + '<div class="nav-head">' + head + '</div><div class="nav-scroll scroll"' + (o.scrollId ? ' id="' + o.scrollId + '"' : '') + '>' + o.body + '</div>' + (o.foot ? '<div class="nav-foot">' + o.foot + '</div>' : '') +
    resizeHandle({ which: 'nav', side: 'end', label: tc('frame.navResize'), tip: tc('frame.navResizeTip'), now: Math.round(RESIZERS.nav.width()), min: Math.round(RESIZERS.nav.min), max: Math.round(RESIZERS.nav.max()) }) + '</aside>';
}
/* 现有侧栏外壳的 PDL 入口：标题操作、页面插槽、格子工具条、列表与底部入口。
   结构仍由 navShell / listBar / listWrap / navItem 四个原件画，主题只声明内容和绑定。 */
PDL_COMPONENTS.navShell = function (p, sc, root) {
  const P = function (x) { return pv(x, sc, root); }, bar = p.bar;
  return navShell({ label: P(p.label), hidden: P(p.hidden), title: P(p.title), acts: pvControls(p.actions, sc, root), scrollId: P(p.scrollId),
    body: (p.slot ? pdlSlot(P(p.slot)) : '') + (bar ? listBar({ key: bar.key, note: P(bar.note), items: bar.items.filter(function (x) { return pvOk(x.when, sc, root); }).map(function (x) { return { key: x.key, html: pvControl(x.control, sc, root), span: x.span || 's', anchor: x.anchor || 'start' }; }) }) : '') + (p.body ? listWrap(pvBlocks(p.body, sc, root)) : ''),
    foot: p.foot ? navItem(P(p.foot.to), P(p.foot.icon), P(p.foot.label), P(p.foot.trail), p.foot.key) : '' });
};
PDL_COMPONENTS.navShell.catalog = { g: 'structure', props: { label: '$.label', title: '$.label', scrollId: { lit: 'cat-nav-scroll' }, body: [{ type: 'text', variant: 'para', text: '$.sub' }] } };   /* 静态示例：真的侧栏里的操作会作用到整页 */
/* 未保存确认：本身是一个声明了 focus + fixLayer 的弹窗 */
POPUPS.confirm = function () {
  if (!S.popConfirm) return '';
  return dialogHtml({ key: 'confirm', alert: true, title: tc('pop.dirtyTitle'), text: h(tc('pop.dirtyText')),   /* 同一个对话框组件（标题 + × + 正文 + 底部按钮），不另写一份 */
    acts: [[tc('pop.keepEditing'), { act: 'close', data: ' data-path="s.popConfirm" data-autofocus="1"' }], [tc('pop.discard'), { primary: true, danger: true, act: 'popDiscard' }]] });
};
/* 取消按钮：和 × 一样走 popClose（离开检查）；默认焦点在它上面（安全的那个），除非弹窗声明 focus: 'confirm' */
function popCancel(k, focus) { return btn(tc('common.cancel'), { act: 'close', data: ' data-popup="' + k + '"' + (focus === 'confirm' ? '' : ' data-autofocus="1"') }); }
/* × 按钮：弹窗唯一的 ×，只在弹窗声明了 exit: x 时画 */
function popX(k) { return popExits(k, 'x') ? btn(tc('common.close'), { iconOnly: true, icon: 'close', sm: true, act: 'close', data: ' data-popup="' + k + '"' }) : ''; }
/* 内置容器的画法（区域引擎）：窄栏、侧栏、身体（主区 + 工作台的分栏）、主区（页面容器的栈顶）、工作台（标签式容器） */
CT_DRAW.rail = function () { return { key: 'rail', html: rail(), col: 'var(--rail-w)' }; };
CT_DRAW.nav = function () { const sp = space(), html = NAV_OVERRIDE[sp] ? NAV_OVERRIDE[sp]() : ''; return html ? { key: 'nav', html: html, col: 'var(--nav-w, var(--nav-w0))', drawer: true } : null; };
CT_DRAW.main = function () {
  const c = ctPages(), s = navStack(c), top = s[s.length - 1], fr = navNodeOf(top), focus = !!(fr && fr.focus);
  if (CT_DRAW.main.hidden()) return { key: 'main', html: '<div class="main-col scroll" data-okey="main" data-c="' + c + '"' + ctGridAttr('main') + '>' + projSlots(s.concat(navKeptLayers(c))).map(projTag).join('') + '</div>', col: 'minmax(0, 1fr)' };   /* 铺开的工作台盖住主区：主区的层整个按盖住的层留着，不画也不读 */
  if (focus) PROJ_FOCUS = true;   /* 声明了 focus 的插件界面框：遮罩在它下面 */
  const html = '<div class="layer' + (focus ? ' occ' : '') + '" data-layer="' + top.id + '" data-lc="' + c + '">' + navWith(c, top, function () { const bk = navBackOf(c); return backIn(bk ? bk.role : 'page', bk, function () { return layerExit(c, top) + projFrame(top); }); }) + '</div>' + projSlots(s.slice(0, -1).concat(navKeptLayers(c))).map(projTag).join('');   /* 被盖住的层 + 切走的兄弟（别的页面、别的空间的页面）：隐藏着留在页面容器里 */
  if (space() !== panelSpace()) return { key: 'main', html: html, col: 'minmax(0, 1fr)', bare: true };
  return { key: 'main', html: '<div class="main-col scroll" data-okey="main" data-c="' + c + '"' + ctGridAttr('main') + '>' + html + '</div>', col: 'minmax(0, 1fr)' };
};
CT_DRAW.main.hidden = function () { return !!S.panelWide && CT_DRAW.panel.open(); };
/* 临时投影的关闭仍走原有出栈和离开检查；界面只画一个通用图标按钮。 */
function layerExit(c, l) { return (l.exit || []).indexOf('x') >= 0 ? '<div class="layer-exit">' + btn(tc('common.close'), { iconOnly: true, icon: 'close', act: 'back', data: ' data-c="' + h(c) + '" data-exit="x"' }) + '</div>' : ''; }
ENGINE_PARTS.layerExit = layerExit;
onStart('boot', function () { KEY_FNS.push(function (e) { const c = navFocusC(); if (e.key !== 'Escape' || (navTop(c).exit || []).indexOf('esc') < 0) return false; e.preventDefault(); navBack(c); return true; }); });
/* 身体：主区 + 工作台的分栏（主区自己是主窗口的面：不分栏时 .main 就是它，带主窗口的背景图）（工作台所在的空间里），被覆盖时画覆盖它的那一层；别的空间里主区直接放在里面 */
CT_DRAW.body = function (kids, base, covered) {
  const head = '<main class="main' + (covered || space() === panelSpace() ? ' split-host' : ' scroll') + '" id="main" data-c="body"' + ctGridAttr(covered || space() === panelSpace() ? 'body' : 'main') + regionAttrs('main') + (space() !== panelSpace() && !covered ? ' data-bg-owner="' + h(ctPages()) + '"' : '') + '>';
  if (covered) return { key: 'body', html: head + kids.map(ctKid).join('') + '</main>', col: 'minmax(0, 1fr)' };
  if (space() !== panelSpace()) return { key: 'body', html: head + '<div class="layer" data-layer="' + base + '">' + kids.map(ctKid).join('') + '</div></main>', col: 'minmax(0, 1fr)' };
  const L = pdlLayout(), panel = kids.find(function (x) { return x.key === 'panel'; });
  const order = (ctNode('body').kids || []).map(function (n) { return n.key; }), panelFirst = order.indexOf('panel') >= 0 && order.indexOf('panel') < order.indexOf('main');   /* 顺序来自容器树（工作台收起时也留着） */
  const extra = kids.filter(function (x) { return x.key !== 'main' && x.key !== 'panel'; }), cols = extra.length ? ' data-cols style="--split-cols:' + kids.map(function (x) { return x.key === 'panel' ? 'var(--ws-w, min(var(--span-7), 44%))' : x.col || 'auto'; }).join(' ') + '"' : '';
  void L;
  return { key: 'body', html: head + '<div data-ocontainer="main.split" data-layer="' + base + '" class="split' + (panel ? ' has-panel' : '') + (panelFirst ? ' panel-first' : '') + (panel && S.panelWide ? ' wide' : '') + '"' + cols + '>' + kids.map(ctKid).join('') + '</div></main>', col: 'minmax(0, 1fr)' };
};
CT_DRAW.panel = function () {
  if (!CT_DRAW.panel.open()) { if (S.panel && !REGION_TABS.panel.visible(S.panel)) S.panel = null; return null; }
  const html = panelHtml(); return html ? { key: 'panel', html: html, col: 'var(--ws-w, min(var(--span-7), 44%))' } : null;
};

CT_DRAW.panel.open = function () { return space() === panelSpace() && !!S.panel && REGION_TABS.panel.visible(S.panel); };   /* 工作台这一次画不画 */
CT_DRAW.panel.closed = function () { return space() === panelSpace() && !CT_DRAW.panel.open(); };   /* 在工作台所在的空间里、收着（这时才有菜单条和把手） */
/* 工作台区域的外框：专注头、启动面板（工具 + 文件搜索）、并排、每个工具的加载 / 失败 / 过期 / 空状态（状态由组件库统一给出，文案来自 WS_SIMS 数据） */
/* ───────────── 面板外壳 ───────────── */
function wsHeadHtml() { return rtFocusHead('panel') || rtChrome('panel'); }
/* 专注头（区域声明 chrome.focus：什么时候出现 when、名字后的后缀、头上的操作——操作自己也可以带 when）：当前项的图标 + 名字 + 后缀 · 空白 · 声明的操作。
   什么时候换成专注头、头上有哪些操作都是声明 */
function rtFocusHead(r) {
  const fc = rtCfg(r).focus; if (!rtWhen(fc, r)) return '';
  const b = REGION_TABS[r], cur = navTabCur(r), vm = rtVM(r);
  return '<div class="panel-head ws-head"' + rtToolsAttr(r) + (cur === rtHome(r) && fc.note ? ' data-note="' + fc.note + '"' : '') + '><span class="ws-focus-t">' + icon(b.icon(cur), 15) + h(b.title(cur)) + '<span class="faint">' + h(fc.suffix) + '</span></span><span class="grow"></span>' +
    (fc.actions || []).filter(function (a) { return pvOk(a.when, vm, vm); }).map(function (a) { return btn(a.label, { sm: true, act: a.act, data: argAttrs(a.args) }); }).join('') + '</div>';
}
/* 区域的工具插槽（布局声明 chrome.tools）：头和启动面板是它的落点（编辑布局时把页面入口拖进来，引擎按 data-tools 认） */
function rtToolsAttr(r) { const t = rtCfg(r).tools; return t ? ' data-tools="' + h(t) + '"' : ''; }
/* 已有内容绑定同时作为页面入口；菜单只保存入口的摆放，不再自带一份不可移动的工具清单。 */
/* 标签式容器的工具菜单的默认内容：每个登记了菜单分组的面板一个入口节点（others：主题别处已经有打开它的入口的，不再生成第二份） */
function pdlPanelEntries(r, others) {
  return Object.keys(PANEL_VIEWS).filter(function (k) { return !!PANEL_VIEWS[k][3]; }).map(function (k) {
    if (Object.keys(others || {}).some(function (id) { return (others[id].open || {}).node === k; })) return null;   /* 已有入口的内容不再生成第二份入口。 */
    const v = PANEL_VIEWS[k], id = 'ws.' + k;
    PAGES[id] = function () { return '<div class="page">' + rtBody(r, k, function () { return REGION_TABS[r].view(k); }, ctPages()) + '</div>'; };
    return { id: id, title: v[0], icon: v[1], open: { page: id, node: k } };
  }).filter(Boolean);
}
function rtToolAttrs(k) { return ' data-k="' + h(k) + '"' + (S.editLayout ? ' data-edit="tool"' : ''); }
/* 菜单里的一项：一行 lrow（小行），放在格子里；行尾一个图钉（固定这一项）。菜单和首页的“最近打开”画同一种行 */
function rtToolRow(r, k) { const d = PANEL_VIEWS[k]; return lrow({ layout: 'record', hook: 'ws-tool' + (rtHas(r, k) ? ' open' : ''), rootAttrs: rtToolAttrs(k), act: 'wsTool', data: ' data-k="' + k + '"', headAttrs: ' data-tip="' + h(d[4]) + (rtHas(r, k) ? tc('frame.alreadyOpen') : '') + '"', cur: rtHas(r, k), lead: icon(d[1], 15), title: h(d[0]), actsHtml: rtItemPinBtn(r, k) }); }
function wsLauncher() {
  const q = S.wsQ.trim().toLowerCase(), r = 'panel', menu = rtMenuItems(r), tool = function (k) { return rtToolRow(r, k); };   /* 菜单里的项和顺序（固定的在前，其余按分组、名字） */
  let body = '';
  if (q) {
    const tools = menu.filter(function (k) { const d = PANEL_VIEWS[k]; return (d[0] + d[4]).toLowerCase().indexOf(q) >= 0; });
    const byName = (REGION_TABS[r].files ? REGION_TABS[r].files() : []).filter(function (f) { return f.p.toLowerCase().split('/').pop().indexOf(q) >= 0; });
    const byBody = (REGION_TABS[r].files ? REGION_TABS[r].files() : []).filter(function (f) { return byName.indexOf(f) < 0 && f.body.toLowerCase().indexOf(q) >= 0; });
    const fileRow = function (f, snip) { return lrow({ layout: 'record', hook: 'ws-res', act: 'wsFile', data: ' data-p="' + h(f.p) + '"', lead: icon('file', 14), title: h(f.p.split('/').pop()), sub: '<span class="mono">' + h(snip ? wsSnippet(f.body, q) : f.p) + '</span>' }); };
    body = (tools.length ? lrSection(tc('frame.tools'), '', { v: 'float' }) + '<div class="ws-grid">' + tools.map(tool).join('') + '</div>' : '') +
      (byName.length ? lrSection(tc('frame.byName', byName.length), '', { v: 'float' }) + byName.slice(0, 5).map(function (f) { return fileRow(f); }).join('') : '') +
      (byBody.length ? lrSection(tc('frame.byBody', byBody.length), '', { v: 'float' }) + byBody.slice(0, 5).map(function (f) { return fileRow(f, true); }).join('') : '') +
      ((byName.length > 5 || byBody.length > 5) ? btn(tc('frame.viewAll', byName.length + byBody.length), { link: true, cls: 'ws-all', act: 'open', data: ' data-node="files" data-anchor="panel"' }) : '') +
      (!tools.length && !byName.length && !byBody.length ? '<div class="u-p-m empty">' + h(tc('frame.noResults', S.wsQ.trim())) + '</div>' : '');
  } else {
    const pins = menu.filter(function (k) { return rtItemPinned(r, k); });
    body = /* 菜单里固定的项单独一组在最前（菜单条也是这个顺序）；其余按分组，组里按名字（rtMenuItems 的顺序） */
      (pins.length ? lrSection(tc('frame.menuPinned'), '', { v: 'float' }) + '<div class="ws-grid">' + pins.map(tool).join('') + '</div>' : '') +
      rtGroups().map(function (g) {
        const ks = menu.filter(function (k) { return rtGroupOf(k) === g[0] && pins.indexOf(k) < 0; });
        return ks.length ? lrSection('', '', { v: 'float', html: g[1] }) + '<div class="ws-grid">' + ks.map(tool).join('') + '</div>' : '';   /* 空的分组不画（和所有空分区同一条规则） */
      }).join('');
  }
  return floatHtml({ cls: 'ws-pop ws-launcher', label: tc('frame.launcher'), attrs: rtToolsAttr(r) + (S.panel === rtHome('panel') ? ' data-note="3"' : ''), head: search('ws-q', tc('frame.launcherSearch'), S.wsQ, 'wsQ', 'ws-q') + rtMenuPinBtn(r) + popX('ws.launcher'), body: body });   /* 面（阴影）和滚动分两层；搜索头留在滚动外；头上的图钉固定整个菜单（右边缘的菜单条） */
}
POPUPS['ws.launcher'] = function () { return rtWhen(rtCfg('panel').launcher, 'panel') ? wsLauncher() : ''; };   /* 贴着打开它的按钮：工作台头上的 + */
/* 工作台首页：最近打开的几项（还没有打开过时按菜单的顺序），下面接绑定方给首页的内容（比如最近的作品）。全部工具在 + 的菜单里 */
const RT_HOME_RECENT = 6;
function rtHomeRecent(r) {
  const menu = rtMenuItems(r), seen = (rtMenuSt(r).recent || []).filter(function (k) { return menu.indexOf(k) >= 0; });   /* 旧的本地记录里没有 recent */
  const ks = (seen.length ? seen : menu).slice(0, RT_HOME_RECENT);
  return ks.length ? '<div class="ws-recent"' + rtToolsAttr(r) + '>' + section({ title: tc('frame.recentOpened'), body: '<div class="ws-grid">' + ks.map(function (k) { return rtToolRow(r, k); }).join('') + '</div>' }) + '</div>' : '';   /* 和下面的小节同一种标题 */
}
POPUPS['ws.pop'] = function () { return ctVisible('panel') && navTabs('panel').menu ? rtOverflow('panel') : ''; };   /* 全部标签：区域这一次画出来了才有（触发它的按钮在区域的头上） */
function wsSnippet(body, q) { const i = body.toLowerCase().indexOf(q); const s = Math.max(0, i - 18); return (s ? '…' : '') + body.slice(s, i + q.length + 30).replace(/\n/g, ' ') + '…'; }
function panelHtml() {
  const r = 'panel', b = REGION_TABS[r], ts = navTabs(r);
  if (!b.exists(navTabCur(r))) rtShow(r, rtHome(r));
  rtSplitSync(r);
  const cur = navTabCur(r); rtEnsure(r, cur);
  if (b.before) b.before();
  return '<aside class="panel ws" data-okey="panel" data-c="' + r + '"' + (S.editLayout ? ' data-edit="region"' : '') + ' aria-label="' + h(tc('frame.workbench')) + '">' + resizeHandle({ which: 'panel', side: pdlLayout().order.indexOf('panel') < pdlLayout().order.indexOf('main') ? 'end' : 'start', label: tc('frame.panelDivider'), tip: tc('frame.navResizeTip') }) +
    wsHeadHtml() + rtNotice(b.notice ? b.notice() : null) + rtPanes(r) + '</aside>';
}
/* 区域的框架提示（绑定方给 { tone, text, act }）：组件库的提示条，“知道了”执行 act */
function rtNotice(n) { return n ? '<div class="ws-fnotice">' + notice({ tone: n.tone, text: n.text, action: btn(tc('common.gotIt'), { sm: true, act: n.act, data: ' data-v=""' }) }) + '</div>' : '';
}

/* 摆放引擎的画法：被占用区域、插槽里的入口、页面元素插槽、工作台里的页面工具；区域运行时（标签条、放不下的标签、返回）。pdl.js 只留描述数据和摆放逻辑 */
/* 插槽里进来的每个入口都叠加插槽声明的操作（比如设置菜单的“固定到窄栏”） */
const ITEM_ACTIONS = {
  pin: function (id) {
    const on = pdlInRail(id), t = pdlEntry(id).title;
    return btn(tc(on ? 'frame.unpinRailNamed' : 'frame.pinRailNamed', t), { size: 'xs', iconOnly: true, cls: 'nav-pin', icon: 'pin', act: 'rail', data: argAttrs({ k: id }), pressed: on, tip: tc(on ? 'frame.unpinRail' : 'frame.pinRail') });
  }
};
function pdlItem(id, slot) {
  const e = pdlEntry(id), disp = PDL_SLOTS[slot].display;
  if (!e) return '';
  if (!pdlWhen(e.when) || pdlNodeHidden(id)) return '';
  /* 平时什么都不能拖；编辑布局时只有导航结构里的入口能拖（页面内容不在范围里） */
  const cur = pdlCur(id), data = ' data-act="open" data-ref="' + id + '" data-entry="' + id + '" data-from="' + slot + '"' + (S.editLayout && e.movable !== false ? ' data-edit="entry"' : '');
  const n = e.badge && BADGES[e.badge] ? BADGES[e.badge]() : null;   /* 入口的计数（数据给的）：窄栏是角上的点，行是行尾的数 */
  let html;
  if (disp === 'mark') html = '<button type="button" class="rail-mark"' + data + ' aria-label="' + h(e.title) + '" data-tip="' + h(e.title) + '"><img src="' + asset(e.asset) + '" alt=""></button>';
  else if (disp === 'icon') {
    const dot = e.badge && BADGES[e.badge] ? badge(n, { corner: true }) : '';
    html = '<button type="button" class="rail-btn' + (S.justAdded && S.justAdded === id ? ' arrive' : '') + '"' + data + ' aria-label="' + h(e.title) + '" data-tip="' + h(e.title) + '"' + (cur ? ' aria-current="page"' : '') + '>' + icon(e.icon, 20) + dot + '</button>';
  } else html = navRow({ label: e.title, icon: e.icon, attrs: data, current: cur, trail: n ? '<span class="trail num">' + n + '</span>' : '' });
  const acts = PDL_SLOTS[slot].itemActions || [];
  return acts.length ? '<div class="nav-row" data-entry="' + id + '" data-from="' + slot + '">' + html + acts.map(function (a) { return ITEM_ACTIONS[a] ? ITEM_ACTIONS[a](id) : ''; }).join('') + '</div>' : html;
}
function pdlSlot(slot, p) {
  const list = pdlNodeHidden(slot) ? [] : pdlKids(slot);
  /* 分组标题：编辑布局时可以拖动调整分组顺序（标题带着它下面的入口一起走）、可以改名 */
  const head = function (id) {
    const ed = S.editLayout;
    return lrSection(pdlHeadLabel(id), ed ? btn(tc('common.rename'), { sm: true, iconOnly: true, icon: 'pen', act: 'rename', cls: 'pdl-head-act', data: argAttrs({ entity: 'navHead', id: id }) }) : '', { v: 'nav', attrs: ' data-head="' + h(id) + '" data-from="' + slot + '"' + (ed ? ' data-edit="head"' : '') });
  };
  return '<div class="pdl-slot" data-slot="' + slot + '">' + list.map(function (id) { return id[0] === '#' ? head(id) : pdlItem(id, slot); }).join('') + '</div>';
}
/* 页面插槽里的元素（输入框工具、消息操作……）：一个图标按钮（组件库的 btn）。和状态的绑定都写在入口的声明里（不读应用的状态、不认动作名）：
   open.args 里的 @字段 取这一处的上下文（视图模型给的 ctx）；pressed = { when: '@字段', title, icon }：条件成立时按下（aria-pressed），名字 / 图标换成它的；
   arrive（'@字段'）成立时播一次到达；打开菜单的（open.action = menu）带上右键找菜单的标记 */
function pdlItemBtn(e, c) {
  const pr = e.pressed && pvOk(e.pressed.when, c, c) ? e.pressed : null, a = e.open.action || 'open';
  return btn(pr && pr.title || e.title, { iconOnly: PDL_SLOTS[c.slot].display === 'icon', sm: true, icon: pr && pr.icon || e.icon, act: a, pressed: pr ? true : null, cls: e.arrive && pvOk(e.arrive, c, c) ? 'arrive' : '',
    data: argAttrs(e.open.action ? pvArgsObj(e.open.args || {}, c, c) : { ref: c.id, entry: c.id, from: c.slot }) + (c.i != null ? ' data-i="' + c.i + '"' : '') + (a === 'menu' ? MENU_DECL : '') + (e.plugin ? ' data-plugin="' + e.plugin + '" data-entry="' + c.id + '"' : '') });
}
/* 页面插槽（输入框工具、消息操作）：用户可以调整顺序（order[插槽]），可以整组或单项隐藏；编辑布局时每项包一层可拖的壳 */
function pdlTools(slot, c, cells) {
  if (pdlNodeHidden(slot)) return '';
  const items = pdlKids(slot).map(function (id) {
    const e = pdlEntry(id); if (!e || !pdlWhen(e.when, c) || pdlNodeHidden(id)) return null;   /* when 里可以有对这一处上下文的条件（@字段，比如这条消息是不是成员发的） */
    return { key: id, span: e.span || 's', html: pdlItemBtn(e, Object.assign({ id: id, slot: slot }, c)) };
  }).filter(Boolean);
  /* 消息操作这类独立的操作条是一排格子（编辑布局时可以放到任意一格）；嵌在别的条里的一组工具就照顺序排 */
  return cells ? cellsHtml({ key: slot, axis: 'row', items: items, saved: pdlCells(slot), edit: S.editLayout }) : items.map(function (x) { return x.html; }).join('');
}
/* 标签页上的“固定 / 关闭”：组件库的 xs 图标按钮（不另写一种）；就地操作，在弹窗里点它弹窗不关（stay） */
function rtTabActs(r, c, t, ti) {
  return btn(tc(rtItemPinned(r, t.k) ? 'frame.unpin' : 'frame.pinTip'), { iconOnly: true, size: 'xs', icon: 'pin', act: 'tab', data: ' data-op="pin" data-r="' + r + '" data-k="' + h(t.k) + '" data-stay', pressed: rtItemPinned(r, t.k), aria: tc(rtItemPinned(r, t.k) ? 'frame.unpinNamed' : 'frame.pinNamed', ti) }) +
    btn(tc('common.close'), { iconOnly: true, size: 'xs', icon: 'close', act: 'tab', data: ' data-op="close" data-r="' + r + '" data-k="' + h(t.k) + '" data-stay', aria: tc('frame.closeNamed', ti) });   /* 就地操作（data-stay）：在全部标签里点它不关 */
}
function rtChip(r, t) {
  const b = REGION_TABS[r], ts = navTabs(r), on = t.k === navTabCur(r), side = !!ts.split && (ts.split.left === t.k || ts.split.right === t.k), ti = b.title(t.k);
  return '<span class="ws-chip' + (t.preview ? ' preview' : '') + (side ? ' side' : '') + '" role="tab" aria-selected="' + on + '" data-okey="' + h(t.k) + '" data-edit="order">' +
    '<button type="button" class="ws-chip-t" data-act="tab" data-op="show" data-r="' + r + '" data-k="' + h(t.k) + '" data-rt-tab="' + h(t.k) + '" data-tip="' + h(ti) + (t.preview ? tc('frame.previewTab') : '') + '">' +
    (rtItemPinned(r, t.k) && !on ? icon('pin', 12) : '') + '<span class="ws-chip-l">' + h(ti) + '</span>' + (b.badge(t.k) ? badge(true, { tip: tc('frame.newActivity') }) : '') + '</button>' +
    (on ? rtTabActs(r, rtCfg(r), t, ti) : '') + '</span>';
}
/* 控制条：标签条 + 区域动作（动作是布局数据里的控件） */
function rtChrome(r) {
  const b = REGION_TABS[r], ts = navTabs(r), c = rtCfg(r), home = c.home, atHome = home && navTabCur(r) === home.key, tabs = rtShownTabs(r), notes = c.notes || {};
  const homeChip = home ? '<span class="ws-chip" role="tab" aria-selected="' + atHome + '"><button type="button" class="ws-chip-t" data-act="tab" data-op="show" data-r="' + r + '" data-k="' + home.key + '" aria-label="' + h(home.label) + '" data-tip="' + h(home.label) + '">' + icon(home.icon, 14) + '</button></span>' : '';
  const vm = rtVM(r);
  /* 标签条是横向滚动的一行（组件库的 .scroll-x，两端渐隐），不估算放得下几个；当前标签由浏览器滚进视野（scroll-initial-target）。
     有标签时末尾一个“全部标签”菜单，列出所有标签（放不下的也能从这里找到） */
  return '<div class="panel-head ws-head"' + rtToolsAttr(r) + '><div class="ws-tabs" role="tablist" aria-label="' + h(tc('frame.openTabs')) + '"' + (atHome && notes.tabs ? ' data-note="' + notes.tabs + '"' : '') + '><div class="ws-strip scroll-x" data-ocontainer="tabs.' + r + '" data-order-act="tab" data-op="order" data-r="' + r + '">' + homeChip + tabs.map(function (t) { return rtChip(r, t); }).join('') + '</div>' +
    (tabs.length ? '<span class="ws-more">' + btn(tc('frame.overflowTabs'), { iconOnly: true, sm: true, icon: 'down', act: 'tab', data: ' data-op="menu" data-r="' + r + '" aria-expanded="' + !!ts.menu + '"' }) + (tabs.some(function (t) { return b.badge(t.k); }) ? badge(true, { corner: true }) : '') + '</span>' : '') + '</div>' +
    '<span class="ws-headacts"' + (atHome && notes.actions ? ' data-note="' + notes.actions + '"' : '') + '>' + pvControls(c.actions || [], vm, vm) + '</span></div>';
}
/* ───────── 标签式容器组件自己的状态和操作─────────
   引擎只有通用的标签栈（frame.js：打开、显示、关、固定、恢复、排序，每项自己的栈）；全部标签、并排、批量关闭、菜单 / 菜单条 / 把手是这个组件的事，
   登记进同一个动作 tab（TAB_OPS）。变化本身就是反馈，不弹提示；能撤回的给撤销提示 */
Object.assign(TAB_OPS, {
  menu: function (d, r) { const ts = navTabs(r); ts.menu = !ts.menu; render(true); },   /* 全部标签（弹窗 ws.pop）开 / 关：状态记在这个区域的标签状态上（NAV.tabs[r].menu） */
  closeOthers: function (d, r) { const keep = navTabCur(r); rtCloseMany(r, function (t) { return t.k !== keep && !rtItemPinned(r, t.k); }, tc('workbench.tabs.closeOthers.toast')); },
  closeUnpinned: function (d, r) { rtCloseMany(r, function (t) { return !rtItemPinned(r, t.k); }, tc('workbench.tabs.closeUnpinned.toast')); },
  /* 并排先留出选择区；用户明确选定第二项才组成一对。 */
  split: function (d, r) { const ts = navTabs(r); ts.split = ts.split ? null : { left: navTabCur(r), right: null }; render(true); },
  splitPick: function (d, r) { const ts = navTabs(r); if (!ts.split || d.k === ts.split.left) return; ts.split.right = d.k; render(true); },
  splitLeave: function (d, r) { navTabs(r).split = null; if (d.k) rtShow(r, d.k); render(true); },
  menuPin: function (d, r) { const st = rtMenuSt(r); st.off = !st.off; rtMenuSave(); render(true); },   /* 固定 / 取消固定整个菜单（菜单条跟着出现 / 消失） */
  itemPin: function (d, r) { rtPinToggle(r, d.k); rtNormalize(navTabs(r), r); render(true); }   /* 固定一项（菜单里或标签上都是这一份）：排到前面，开着的标签也是固定的 */
});
RT_CLOSED.push(function (r) { rtSplitSync(r); if (!rtTabs(r).length) navTabs(r).menu = false; });   /* 标签关光了：全部标签跟着收起 */
/* 菜单、菜单条、把手：
   一项的固定只有一份（标签上的图钉和菜单里的图钉是同一个数据）；菜单的固定（启动面板这个菜单本身可以固定，默认固定：
   固定着就在主窗口右边缘画成一条浮着的菜单条）；把手（右边缘的一个小标签，只负责打开区域，菜单不固定时也在）。
   菜单里有哪些项由绑定方给（b.menu）。顺序没有内置值：固定的在最前、按固定的先后（标签条上拖固定的标签也改这个先后）；
   其余按分组、组里按名字；分组按组名排，主题声明的最后一组是“其他”，永远在最后。菜单和菜单条是同一个顺序。
   菜单状态是用户的偏好（这台设备上记着）：{ 区域: { off: 菜单没固定, pins: [固定的项，按固定的先后], recent: [最近打开的项] } }；默认固不固定由布局声明（chrome.stripe.pinned） */
S.rtMenu = store.get('rtMenu', {});
function rtMenuSt(r) { return S.rtMenu[r] || (S.rtMenu[r] = { off: (rtCfg(r).stripe || {}).pinned === false, pins: [], recent: [] }); }   /* 固定哪几项是用户在这台设备上的偏好（本地记着），不是主题数据 */
function rtMenuPinned(r) { return !rtMenuSt(r).off; }
function rtItemPinned(r, k) { return rtMenuSt(r).pins.indexOf(k) >= 0; }
/* 记下最近打开的一项（组件自己的本地偏好，和固定放在一起）：画工作台时当前项换了就记 */
function rtSeen(r, k) { const st = rtMenuSt(r), rc = st.recent || []; if (k === rtHome(r) || rc[0] === k || rtMenuItems(r).indexOf(k) < 0) return; st.recent = [k].concat(rc.filter(function (x) { return x !== k; })).slice(0, RT_HOME_RECENT); rtMenuSave(); }
function rtPinToggle(r, k) { const st = rtMenuSt(r), i = st.pins.indexOf(k); if (i >= 0) st.pins.splice(i, 1); else st.pins.push(k); rtMenuSave(); }
/* 标签条上拖了固定的标签：固定的先后跟着变（keys = 拖完后固定标签的顺序；没开成标签的固定项留在原位） */
function rtPinOrder(r, keys) { const st = rtMenuSt(r), at = keys.map(function (k) { return st.pins.indexOf(k); }).sort(function (a, b) { return a - b; }); at.forEach(function (i, j) { st.pins[i] = keys[j]; }); rtMenuSave(); }
Object.assign(ENGINE_PARTS, { tabPinned: rtItemPinned, tabPin: rtPinToggle, tabPins: function (r) { return rtMenuSt(r).pins; }, tabPinOrder: rtPinOrder });   /* 引擎的标签栈问这一份固定（标签上的图钉、排序、批量关闭） */
/* 菜单的分组顺序：按组名；主题声明的最后一组（其他）永远在最后 */
function rtGroups() { const last = WS_GROUPS[WS_GROUPS.length - 1]; return WS_GROUPS.slice(0, -1).sort(function (a, b) { return String(a[1]).localeCompare(String(b[1]), 'zh'); }).concat([last]); }
function rtMenuItems(r) {
  const b = REGION_TABS[r]; if (!b || !b.menu) return [];
  const available = b.menu(), pins = rtMenuSt(r).pins, gs = rtGroups().map(function (g) { return g[0]; });
  const ks = pdlKids(rtCfg(r).tools).map(function (id) { return rtPageKey(r, id); }).filter(function (k) { return available.indexOf(k) >= 0; });
  return pins.filter(function (k) { return ks.indexOf(k) >= 0; }).concat(ks.filter(function (k) { return pins.indexOf(k) < 0; }).sort(function (x, y) { return gs.indexOf(rtGroupOf(x)) - gs.indexOf(rtGroupOf(y)) || String(b.title(x)).localeCompare(String(b.title(y)), 'zh'); }));
}
function rtMenuSave() { store.set('rtMenu', S.rtMenu); }
/* 页面放进标签式容器（工具插槽 chrome.tools 里的页面入口、开到这个区域的页面入口）：变成一项 pg.<入口>——标题、图标来自入口，分组是布局声明的 chrome.pageGroup，内容就是那一页。
   引擎经 ENGINE_PARTS 调这几个（rtPage 登记并给出键、rtPageKey 只给键、rtPagePrune 拿掉不在插槽里的、rtPageEntry 从一项认回入口），不认识这种键 */
const RT_PAGE = 'pg.';
function rtPageKey(r, id) { const o = pdlEntry(id).open; return o.node || RT_PAGE + id; }
/* 一项在菜单里的分组：它自己声明的分组（标签）；主题里没有这个组就放进最后一组（其他），不悄悄消失 */
function rtGroupOf(k) { const g = PANEL_VIEWS[k][3]; return WS_GROUPS.some(function (x) { return x[0] === g; }) ? g : WS_GROUPS[WS_GROUPS.length - 1][0]; }
function rtPageEntry(r, k) { return pdlKids(rtCfg(r).tools).find(function (id) { return rtPageKey(r, id) === k; }); }
function rtPage(r, id) {
  const e = pdlEntry(id), k = rtPageKey(r, id);
  if (e.open.node) return k;
  PANEL_VIEWS[k] = [e.title, e.icon, '', e.group || rtCfg(r).pageGroup, tc('frame.openInWorkbench', e.title)];   /* 入口自己声明分组（group）就用它，否则用布局的 pageGroup */
  PANELS[k] = function () { return '<div class="pdl-inpanel">' + PAGES[e.open.page]() + '</div>'; };
  return k;
}
function rtEntryOf(r, k) { return pdlEntryIds().find(function (id) { return rtPageKey(r, id) === k; }); }
function openTab(r, k, o) {
  const id = rtEntryOf(r, k), target = id && pdlOpenOf(id);
  if (!id) return rtReveal(r, k, o);
  if (REGION_TABS[target.target]) return rtReveal(target.target, k, Object.assign({ from: null }, o));
  pdlOpenSpec({ ref: id }, null);
  if (o && o.args) { const c = ctPages(); navReplace(c, null, Object.assign({}, navTop(c).a, o.args)); navAfter(); }
}
function rtPagePrune(r, ids) {
  rtTabs(r).slice().forEach(function (t) { const id = rtEntryOf(r, t.k); if (id && ids.indexOf(id) < 0) rtClose(r, t.k); });
  Object.keys(PANEL_VIEWS).forEach(function (k) { if (k.indexOf(RT_PAGE) === 0 && ids.indexOf(k.slice(RT_PAGE.length)) < 0) delete PANEL_VIEWS[k]; });
}
Object.assign(ENGINE_PARTS, { rtPage: rtPage, rtPageKey: rtPageKey, rtPageEntry: rtPageEntry, rtPagePrune: rtPagePrune, openTab: openTab, panelEntries: pdlPanelEntries });
function rtClosed(r) { return !!(CT_DRAW[r] && CT_DRAW[r].closed && CT_DRAW[r].closed()); }   /* 这个区域在、但收着（区域的画法回答） */
/* 菜单里一项的图钉（组件库的 xs 图标按钮，就地操作：在弹窗里点它弹窗不关） */
function rtItemPinBtn(r, k) { const on = rtItemPinned(r, k), t = REGION_TABS[r].title(k); return btn(tc(on ? 'frame.unpin' : 'frame.menuPinItem'), { iconOnly: true, size: 'xs', icon: 'pin', act: 'tab', data: ' data-op="itemPin" data-r="' + r + '" data-k="' + h(k) + '" data-stay', pressed: on, aria: tc(on ? 'frame.unpinNamed' : 'frame.menuPinItemNamed', t) }); }
/* 菜单本身的图钉（启动面板的头上）：固定着 = 右边缘有菜单条 */
function rtMenuPinBtn(r) { const on = rtMenuPinned(r); return btn(tc(on ? 'frame.menuUnpin' : 'frame.menuPin'), { iconOnly: true, sm: true, icon: 'pin', act: 'tab', data: ' data-op="menuPin" data-r="' + r + '" data-stay', pressed: on }); }
/* 区域控制条的视图模型：区域自己的状态（菜单固定没有、收着没有、窄屏、在不在它的空间里）+ 应用给的（chromeVM）。菜单条 / 把手 / 入口 / 启动面板 / 专注头什么时候出现由布局声明的 when 决定 */
function rtVM(r) { const b = REGION_TABS[r]; return Object.assign({ menuPinned: rtMenuPinned(r), closed: rtClosed(r), narrow: !!VIEWPORT.narrow, inSpace: space() === panelSpace() }, b && b.chromeVM ? b.chromeVM() : {}); }
function rtWhen(d, r) { if (!d) return false; const vm = rtVM(r); return pvOk(d.when, vm, vm); }
function rtStripe(r) {
  const b = REGION_TABS[r], sc = rtCfg(r).stripe; if (!rtWhen(sc, r)) return '';
  const ks = rtMenuItems(r); if (!ks.length) return '';
  return '<nav class="rt-stripe" aria-label="' + h(sc.label) + '"' + rtToolsAttr(r) + ' data-okey="stripe.' + r + '" style="--u-dy:' + ((S.stripeDy || {})[r] || 0) + 'px"><div class="scroll float-body">' + ks.map(function (k) {
    const t = b.title(k);
    return '<button type="button" class="rt-stripe-i" data-act="' + sc.itemAct + '"' + argAttrs(sc.itemArgs) + rtToolAttrs(k) + ' data-okey="' + h(k) + '" aria-label="' + h(t) + '" data-tip="' + h(t) + '">' + icon(b.icon(k), 15) + '<span class="rt-stripe-l scroll-x">' + h(t) + '</span>' + (b.badge(k) ? badge(true, { tip: tc('frame.newActivity'), corner: true }) : '') + '</button>';
  }).join('') + '</div></nav>';
}
/* 把手：通用的侧边抽屉标签——贴在对话主窗口右边缘、上下居中的一小块浮层的面（外侧圆角、贴边那侧齐平），里面是区域声明的小图标（缺省 ‹）。
   和菜单条是两个职责，各自按布局声明的 when 出现（缺省声明：工作台收着）。demo 只供组件目录展示。 */
function rtHandle(r, o) { const hd = rtCfg(r).handle; if (!hd || !(o && o.demo || rtWhen(hd, r))) return ''; return '<button type="button" class="rt-handle" data-act="' + hd.act + '"' + argAttrs(hd.args) + ' aria-label="' + h(hd.label) + '" data-tip="' + h(hd.label) + '">' + icon(hd.icon, 12) + '</button>'; }
const RT_CHROME = { stripe: function (r) { return rtStripe(r); }, handle: function (r, o) { return rtHandle(r, o); } };   /* PDL 的 app 控件（{ type: 'app', name, region }）：区域固定件的名字 → 画法 */
/* 拖菜单条：上下移动（组件库唯一的拖动机制 EDGE_DRAG，抓菜单条的边缘）；偏移是相对声明位置的增量，存在会话状态里（这次打开期间） */
S.stripeDy = {};
EDGE_DRAG.push({
  find: function (t) { const s = t && t.closest && t.closest('.rt-stripe'); return s && !t.closest('button') ? s : null; },
  start: function (el, e0) {
    const r = (el.dataset.okey || '').slice(7), q = { x: 0, y: S.stripeDy[r] || 0 }, sy = e0.clientY;
    return { move: function (e) { const o = { x: 0, y: q.y + e.clientY - sy }; S.stripeDy[r] = o.y; el.style.setProperty('--u-dy', o.y + 'px'); }, end: function () {} };
  }
});
/* 全部标签（标签条放不下时从这里找）：同一份数据的第三种画法 */
/* 画出来的标签：只画来源还在的（来源暂时不在时标签留在状态里，回来时照样显示） */
function rtShownTabs(r) { return rtTabs(r).filter(function (t) { return REGION_TABS[r].exists(t.k); }); }
function rtOverflow(r) {
  const b = REGION_TABS[r], c = rtCfg(r);
  return floatHtml({ cls: 'ws-pop ws-pop-sm', role: 'menu', label: tc('frame.overflowTabs'), attrs: rtToolsAttr(r), body: rtShownTabs(r).map(function (t) {
    return lrow({ layout: 'record', hook: 'ws-res', act: 'tab', data: ' data-op="show" data-r="' + r + '" data-k="' + h(t.k) + '"', lead: icon(b.icon(t.k), 14), title: h(b.title(t.k)), inline: b.badge(t.k) ? badge(true) : '', cols: [{ w: 'ctl', v: rtTabActs(r, c, t, b.title(t.k)) }] });
  }).join('') });
}
/* 并排的生命周期属于标签管理组件；关闭一侧仍走同一个通用关闭动作。 */
function rtSplitSync(r) {
  const ts = navTabs(r), pair = ts.split; if (!pair) return;
  const has = function (k) { return k && (k === rtHome(r) || !!rtTab(r, k)); };
  const left = has(pair.left), right = has(pair.right);
  if (!left || pair.right && !right) { ts.split = null; const keep = left ? pair.left : right ? pair.right : null; if (keep) rtShow(r, keep); return; }
  if (navTabCur(r) !== pair.left && navTabCur(r) !== pair.right) ts.split = null;
}
ENGINE_PARTS.tabVisible = function (r) { const p = navTabs(r).split; return p ? [p.left, p.right].filter(Boolean) : [navTabCur(r)]; };
/* 同一项在单栏和并排使用相同正文；只有并排容器增加边框和对称的标签头。 */
function rtPanes(r) {
  const b = REGION_TABS[r], ts = navTabs(r), cur = navTabCur(r), home = rtHome(r), pair = ts.split;
  const pane = function (k) { const sk = navTabKey(r, k), s = navStack(sk), top = s[s.length - 1]; return '<div class="panel-body scroll" data-layer="' + top.id + '" data-lc="' + h(sk) + '"' + ctGridAttr(r) + '>' + navWith(sk, top, function () { return rtBody(r, k, function () { return k === home ? rtHomeRecent(r) + b.view(k) : b.view(k); }); }) + '</div>'; };
  rtSeen(r, cur);
  const vis = ENGINE_PARTS.tabVisible(r), slots = [];
  rtKeys(r).forEach(function (k) { const s = NAV.st[navTabKey(r, k)]; if (s) s.forEach(function (l, i) { if (i < s.length - 1 || vis.indexOf(k) < 0) slots.push(l); }); });
  const rest = projSlots(slots).map(projTag).join('');
  if (!pair) return pane(cur) + rest;
  const framed = function (k, other) {
    const close = k === home ? { op: 'splitLeave', k: other || '' } : { op: 'close', k: k };
    return '<section class="ws-pane" data-pane="' + h(k) + '"><div class="panel-head">' + icon(b.icon(k), 14) + '<span class="grow">' + h(b.title(k)) + '</span>' + btn(tc('common.close'), { iconOnly: true, sm: true, icon: 'close', act: 'tab', data: argAttrs(Object.assign({ r: r }, close)) }) + '</div>' + pane(k) + '</section>';
  };
  const picker = '<section class="ws-pane"><div class="panel-head"><span class="grow">' + h(tc('frame.chooseSplit')) + '</span>' + btn(tc('common.cancel'), { iconOnly: true, sm: true, icon: 'close', act: 'tab', data: ' data-op="splitLeave" data-r="' + r + '"' }) + '</div><div class="panel-body scroll">' + rtKeys(r).filter(function (k) { return k !== pair.left; }).map(function (k) { return lrow({ layout: 'record', lead: icon(b.icon(k), 16), title: h(b.title(k)), act: 'tab', data: ' data-op="splitPick" data-r="' + r + '" data-k="' + h(k) + '"' }); }).join('') + '</div></section>';
  return '<div class="ws-split">' + framed(pair.left, pair.right) + (pair.right ? framed(pair.right, pair.left) : picker) + '</div>' + rest;
}
/* 拖动入口时出现的“移出”区 */
/* 编辑布局的编辑条：一个普通的非模态弹窗框架（PDL_POPUPS.editbar，Esc、×、拖动都来自框架）：只有标题和 ×，Esc 或 × 结束编辑；不写说明——晃动本身就说明“可以编辑” */
POPUPS.editbar = function () { return S.editLayout ? '<div class="edit-bar" role="dialog" aria-label="' + h(tc('pdlDoc.editing')) + '"><span class="edit-bar-t">' + h(tc('pdlDoc.editing')) + '</span>' + popX('editbar') + '</div>' : ''; };
/* 编辑布局里悬停的叶子：它的公开名字 + 复制定位（唯一 / 同名的都算；插槽里的入口只有一种） */
ENGINE_PARTS.editLeaf = function (l) {
  const copy = function (label, unique) { return btn(label, { iconOnly: true, icon: 'copy', sm: true, act: 'copy', data: ' data-v="' + h(JSON.stringify(pdlAnchorSpec(l, unique))) + '"' }); };
  return '<code>' + h(l.name) + '</code>' + copy(tc('pdlDoc.copyUnique'), true) + (l.entry ? '' : copy(tc('pdlDoc.copyPlain'), false));
};
function dragBin(text) { return '<div id="pdl-bin" class="pdl-bin">' + icon('delete', 14) + h(text) + '</div>'; }
/* 用户加的容器：一个盒子（方向、在父容器里的份额），里面是放进来的入口；空不空交给引擎（容器的“没有内容时隐藏”），编辑布局时空盒子是虚线的落点 */
function projBox(k, n, kids, base) {
  const slot = 'ct:' + k, ids = pdlKids(slot).filter(function (id) { return pdlEntry(id); });
  const inner = kids.map(ctKid).join('') + '<div class="pdl-slot ct-slot" data-slot="' + slot + '">' + ids.map(function (id) { return pdlItem(id, slot); }).join('') + '</div>';
  const empty = !kids.length && !ids.length;
  return { key: k, html: '<div class="ct-box" data-c="' + h(k) + '" data-okey="' + h(k) + '" data-dir="' + (n.dir || 'column') + '"' + (base ? ' data-layer="' + base + '"' : '') + (S.editLayout ? ' data-edit="region"' : '') + '>' + inner + '</div>', col: CT_SPAN[n.span || 'fit'], empty: empty };
}
const CT_SPAN = { fit: 'auto', 1: 'minmax(0, 1fr)', 2: 'minmax(0, 2fr)', 3: 'minmax(0, 3fr)' };
ENGINE_PARTS.ctBox = projBox;
ENGINE_PARTS.dragBin = dragBin;

/* 容器底面：同一份结构参数用于内置表面、投影页和用户容器。只输出样式，不替换内容节点。 */
ENGINE_PARTS.ctSurfaceCss = function () {
  const bg = bgState(), rules = [];
  pdlTreeWalk(pdlTree(), function (n) {
    const p = bg.planes[n.key], independent = p.mode === 'absolute';
    const paint = bg.shell && independent ? 'linear-gradient(var(--glass-surface), var(--glass-surface)), var(--shell-img, var(--page-img))' : 'none';
    rules.push('[data-c="' + CSS.escape(n.key) + '"], [data-bg-owner="' + CSS.escape(n.key) + '"] { --bg-veil:' + (bg.shell ? p.value : 100) + '%; --surface-paint:' + paint + '; --surface-content:' + (bg.shell && independent ? '""' : 'none') + '; --surface-blur:' + p.blur + 'px; --surface-filter:' + (independent ? 'blur(0px)' : p.blur ? 'blur(' + p.blur + 'px)' : 'none') + '; }');
  });
  return rules.join('\n');
};

