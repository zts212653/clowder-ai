/* 边界：一个含义一个组件、不为接口定制、不按位置推导样式 */
/* 外壳：窄栏、二级栏、内置容器的画法、侧栏抽屉、拖动与编辑条 */
/* 窄栏、二级栏的外壳和入口项、各个内置容器的画法（CT_DRAW）、弹窗框架的盒子和按钮、编辑条；工作台的外框（标签条、启动面板、菜单条、把手）在 tabs.js。
   机制（投影、弹窗栈、返回槽、标签式容器的状态）在引擎（engine/frame.js），这里只画。 */
'use strict';
/* 导航行：唯一的画法（侧栏导航、页面目录）。o = { label, icon, attrs（data-act 等属性串）, current, trail（已渲染的尾部）, cls } */
function navRow(o) { return '<button type="button" class="nav-item' + (o.cls ? ' ' + o.cls : '') + '"' + (o.attrs || '') + (o.current ? ' aria-current="' + (o.current === true ? 'page' : o.current) + '"' : '') + '>' + (o.icon ? icon(o.icon) : '') + '<span>' + h(o.label) + '</span>' + (o.trail || '') + '</button>'; }   /* 名字一行，放不下省略，悬停看全文；从不在词中间折行 */
/* 区域边界的调宽把手（组件库里只有这一个）：一种颜色、一套悬停 / 拖动中的状态、同样的宽度和命中区。
   which 说它调的是谁（nav 侧栏 / panel 工作台），side 说它贴在区域的哪条边（end 右边 / start 左边）。编辑布局时隐藏（那时区域的边用来移动区域） */
function resizeHandle(o) { return '<div class="resize-handle" data-resize="' + o.which + '" data-side="' + o.side + '" role="separator" aria-orientation="vertical" aria-label="' + h(o.label) + '" tabindex="0" data-tip="' + h(o.tip) + '"' + (o.now != null ? ' aria-valuenow="' + o.now + '" aria-valuemin="' + o.min + '" aria-valuemax="' + o.max + '"' : '') + '></div>'; }
/* 浮层宿主：对话区的模态窗、图片查看、撤销条挂在这里 */
function layerHost(html) { return '<div id="cafe-layer">' + html + '</div>'; }
/* 窄屏的侧栏抽屉（开关是主题声明的 drawer 按钮：toggle s.navOpen）：开着时根上带 nav-open；换地方（导航完成，引擎的 NAV_RESET）时收起；
   Esc 收起——排在各模块自己的 Esc 之后（启动时才登记，KEY_FNS 的最后一个），别的浮签先收 */
S.navOpen = false;
APP_CLASS.push(function () { return S.navOpen ? 'nav-open' : ''; });
NAV_RESET.push(function (o) { if (!o.popupsOnly) S.navOpen = false; });
onStart('boot', function () { KEY_FNS.push(function (e) { if (e.key !== 'Escape' || !S.navOpen) return false; S.navOpen = false; render(true); return true; }); });
APP_CLASS.push(function () { return S.layout === 'two' ? 'layout-two' : ''; });
/* 区域是界面树里同级的节点：根元素带它的键（data-okey），放着设置入口的区域（受保护）固定（data-locked）。
   编辑布局时区域和其它可编辑的节点一样：边缘出现移动光标，按住拖到另一侧，区域里的东西跟着走（拖动机制见 core.js 的 EDGE_DRAG）。
   平时区域的边是调宽度的（左右调整光标），编辑布局时调宽度关掉——两种模式靠模式和光标区分，同一个手势不会有两种意思 */
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
  const html = '<div class="layer' + (focus ? ' occ' : '') + '" data-layer="' + top.id + '" data-lc="' + c + '">' + navWith(c, top, function () { const bk = navBackOf(c); return backIn(bk ? bk.role : 'page', bk, function () { return layerExit(c, top) + projFrame(c, top); }); }) + '</div>' + projSlots(s.slice(0, -1).concat(navKeptLayers(c))).map(projTag).join('');   /* 被盖住的层 + 切走的兄弟（别的页面、别的空间的页面）：隐藏着留在页面容器里 */
  if (space() !== panelSpace()) return { key: 'main', html: html, col: 'minmax(0, 1fr)', bare: true };
  return { key: 'main', html: '<div class="main-col scroll" data-okey="main" data-c="' + c + '"' + ctGridAttr('main') + '>' + html + '</div>', col: 'minmax(0, 1fr)' };
};
CT_DRAW.main.hidden = function () { return !!S.panelWide && CT_DRAW.panel.open(); };
/* 区域的宽窄（分栏按它收起）：工作台没放大、或者里面两项并排时是窄的；主区跟着窗口（VIEWPORT.narrow） */
function regionNarrow(r) { return r === 'panel' && (!S.panelWide || !!navTabs(r).split); }
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
/* ───────── 目录登记：这个文件里的组件 ───────── */
Object.assign(LIB_CATALOG, {
  resizeHandle: { g: 'structure', inline: true, via: ['shell'], ex: function () { return '<div class="cat-rh">' + resizeHandle({ which: 'catalog', side: 'end', label: tc('catalog.ex.resize'), tip: tc('catalog.ex.resize') }) + '</div><span class="faint">' + h(tc('catalog.ex.resizeHint')) + '</span>'; } }
});
