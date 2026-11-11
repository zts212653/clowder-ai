/* 边界：一个含义一个组件、不为接口定制、不按位置推导样式 */
/* 主题计算器（组件库自带的主题编辑器：只用引擎的主题文档和组件库，不认识应用）：用少量 OKLCH 参数算出整套语义变量，并实时显示关键文字的对比度。
   它只改“当前主题”，不管理主题（列表、复制、切换都在主题页）：当前是系统主题时，第一次改动先自动复制出自定义主题（带撤销提示），之后的改动直接写进它；每次改动都已保存，没有单独的保存按钮。
   改动写进当前主题 × 当前浅/深色的值（themeVals），和主题页的逐项编辑共用保存与恢复。 */
'use strict';

/* ── 参数 ⇄ token ── */
const CALC_GROUPS = [
  ['accent', tc('themeCalc.group.text'), tc('themeCalc.group.accentHelp'), [['aH', tc('themeCalc.group.hue'), 0, 360, 1], ['aC', tc('themeCalc.group.chroma'), 0, 0.3, 0.005], ['aL', tc('control.colorLight'), 0.3, 0.9, 0.005]]],
  ['layers', tc('themeCalc.group.surfaces'), tc('themeCalc.group.surfacesHelp'), [['nH', tc('themeCalc.group.hue'), 0, 360, 1], ['nC', tc('themeCalc.group.chroma'), 0, 0.05, 0.001], ['rail', tc('theme.tokens.rail'), 0, 1, 0.005], ['nav', tc('theme.tokens.sidebar'), 0, 1, 0.005], ['page', tc('theme.tokens.page'), 0, 1, 0.005], ['group', tc('themeCalc.group.groupSurface'), 0, 1, 0.005], ['dHover', tc('themeCalc.group.hoverOverlay'), 0, 0.3, 0.005], ['dSelected', tc('themeCalc.group.selectedOverlay'), 0, 0.3, 0.005], ['dInset', tc('themeCalc.group.inputOverlay'), 0, 0.3, 0.005]]],
  ['bubble', tc('themeCalc.group.messageAndCode'), tc('themeCalc.group.messageAndCodeHelp'), [['uH', tc('themeCalc.group.bubbleHue'), 0, 360, 1], ['uC', tc('themeCalc.group.bubbleChroma'), 0, 0.1, 0.002], ['uL', tc('themeCalc.group.bubbleLightness'), 0, 1, 0.005], ['dCode', tc('themeCalc.group.inlineCodeOverlay'), 0, 0.3, 0.005]]],
  ['text', tc('themeCalc.group.typographyAndLines'), tc('themeCalc.group.typographyAndLinesHelp'), [['tC', tc('themeCalc.group.textChroma'), 0, 0.03, 0.001], ['strong', tc('themeCalc.group.primaryText'), 0, 1, 0.005], ['fg', tc('themeCalc.group.secondaryText'), 0, 1, 0.005], ['muted', tc('common.note'), 0, 1, 0.005], ['faint', tc('themeCalc.group.placeholderAndDisabled'), 0, 1, 0.005], ['dLine', tc('themeCalc.group.dividerOverlay'), 0, 0.4, 0.005], ['dLineS', tc('themeCalc.group.emphasisLineOverlay'), 0, 0.4, 0.005]]],
  ['names', tc('themeCalc.group.memberColors'), tc('themeCalc.group.memberColorsHelp'), [['mL', tc('themeCalc.group.identityLightness'), 0.3, 0.9, 0.005], ['mC', tc('themeCalc.group.identityChroma'), 0, 0.2, 0.005], ['tL', tc('themeCalc.group.avatarLightness'), 0, 1, 0.005], ['tTC', tc('themeCalc.group.avatarChroma'), 0, 0.1, 0.002]]],
  ['status', tc('theme.tokens.status'), tc('themeCalc.group.statusHelp'), [['sL', tc('control.colorLight'), 0.3, 0.9, 0.005], ['sC', tc('themeCalc.group.chroma'), 0, 0.25, 0.005], ['okH', tc('themeCalc.group.normalHue'), 0, 360, 1], ['warnH', tc('themeCalc.group.warningHue'), 0, 360, 1], ['dangerH', tc('themeCalc.group.dangerHue'), 0, 360, 1], ['dangerL', tc('themeCalc.group.dangerL'), 0.3, 0.9, 0.005], ['infoH', tc('themeCalc.group.informationHue'), 0, 360, 1], ['softL', tc('themeCalc.group.hintBackgroundLightness'), 0, 1, 0.005]]]
];
function calcRead() {
  const cs = getComputedStyle(document.documentElement), t = function (k) { return hexOk(cs.getPropertyValue('--' + k).trim()); };
  const page = t('bg-page'), acc = t('accent'), ub = t('bg-bubble'), w = t('warn'), n1 = t('name-1'), t1 = t('tint-1'), fs = t('fg-strong');
  return { aH: acc.H, aC: acc.C, aL: acc.L, nH: page.H, nC: page.C, rail: t('bg-rail').L, nav: t('bg-nav').L, page: page.L, group: t('bg-group').L,
    uH: ub.H, uC: ub.C, uL: ub.L,
    tC: fs.C, strong: fs.L, fg: t('fg').L, muted: t('fg-muted').L, faint: t('fg-faint').L,
    mL: n1.L, mC: n1.C, m1: n1.H, m2: t('name-2').H, m3: t('name-3').H, m4: t('name-4').H, m5: t('name-5').H, m6: t('name-6').H, tL: t1.L, tTC: t1.C,
    sL: w.L, sC: w.C, okH: t('ok').H, warnH: w.H, dangerH: t('danger').H, dangerL: t('danger').L, infoH: t('info').H, softL: t('warn-soft').L,
    dHover: layerPct('d-hover'), dBtn: layerPct('d-btn'), dSelected: layerPct('d-selected'), dInset: layerPct('d-inset'), dCode: layerPct('d-code'), dLine: layerPct('d-line'), dLineS: layerPct('d-line-strong') };
}
function layerPct(name) { const v = getComputedStyle(document.documentElement).getPropertyValue('--' + name).trim(); return (parseFloat(v) || 0) / 100; }
function calcTokens(P, dark) {
  const n = function (L, C) { return okHex(L, C == null ? P.nC : C, P.nH); }, tx = function (L) { return okHex(L, P.tC, P.nH); };
  const soft = function (H) { return okHex(P.softL, Math.min(0.06, P.sC * 0.35), H); };
  const T = {
    'accent': okHex(P.aL, P.aC, P.aH), 'accent-hover': okHex(P.aL + (dark ? 0.06 : -0.07), P.aC, P.aH), 'accent-fg': okHex(P.aL + (dark ? 0.08 : -0.08), P.aC, P.aH),
    'accent-soft': okHex(dark ? 0.3 : 0.93, P.aC * 0.25, P.aH), 'focus': okHex(P.aL, P.aC, P.aH),
    'bg-rail': n(P.rail), 'bg-nav': n(P.nav), 'bg-page': n(P.page), 'bg-group': n(P.group), 'bg-raised': n(P.group),
    'bg-bubble': okHex(P.uL, P.uC, P.uH),
    'fg-strong': tx(P.strong), 'fg': tx(P.fg), 'fg-muted': tx(P.muted), 'fg-faint': tx(P.faint), 'switch-on': okHex(P.aL, P.aC, P.aH),   /* 开关开着 = 强调色 */
    'ok': okHex(P.sL, P.sC, P.okH), 'warn': okHex(P.sL, P.sC, P.warnH), 'danger': okHex(P.dangerL != null ? P.dangerL : P.sL, P.sC, P.dangerH), 'info': okHex(P.sL, P.sC, P.infoH), 'warn-soft': soft(P.warnH), 'danger-soft': soft(P.dangerH)
  };
  for (let i = 1; i <= 6; i++) { T['name-' + i] = okHex(P.mL, P.mC, P['m' + i]); T['tint-' + i] = okHex(P.tL, P.tTC, P['m' + i]); }
  /* 悬停、选中、内嵌、行内代码、分隔线是叠在所在层上的墨色：只输出叠多深（见 core.css 的推导块） */
  const pc = function (x) { return Math.round(x * 1000) / 10 + '%'; };
  T['d-hover'] = pc(P.dHover); T['d-btn'] = pc(P.dBtn); T['d-selected'] = pc(P.dSelected); T['d-inset'] = pc(P.dInset); T['d-code'] = pc(P.dCode); T['d-line'] = pc(P.dLine); T['d-line-strong'] = pc(P.dLineS);
  return T;
}
const CALC_PAIRS = [
  [tc('themeCalc.contrastPairs.text'), 'fg-strong', 'bg-page', 4.5], [tc('themeCalc.contrastPairs.secondaryOnGroup'), 'fg', 'bg-group', 4.5], [tc('themeCalc.contrastPairs.descriptionOnGroup'), 'fg-muted', 'bg-group', 4.5], [tc('themeCalc.contrastPairs.placeholderOnInput'), 'fg-faint', 'bg-field', 3],
  [tc('themeCalc.contrastPairs.buttonOnAccent'), 'fg-on-accent', 'accent', 4.5], [tc('themeCalc.contrastPairs.linkOnPage'), 'accent-fg', 'bg-page', 4.5], [tc('themeCalc.contrastPairs.textOnBubble'), 'fg-strong', 'bg-bubble', 4.5],
  [tc('themeCalc.contrastPairs.memberOnPage'), 'NAMEMIN', 'bg-page', 3], [tc('themeCalc.contrastPairs.warningOnGroup'), 'warn', 'bg-group', 3], [tc('themeCalc.contrastPairs.dangerOnGroup'), 'danger', 'bg-group', 3],
  [tc('themeCalc.contrastPairs.groupOnPage'), 'bg-group', 'bg-page', 1.04]
];

/* ── 面板 ── */
S.calc = { open: false, P: null, mode: null, fold: {}, tab: 'colors', ct: null };   /* tab：配色 / 背景 / 结构；ct：结构页里选中的容器。拖动、×、Esc 都来自弹窗框架（PDL_POPUPS.calc） */
function calcMode() { return stMode(); }
function calcEnsure() { const m = calcMode(); if (!S.calc.P || S.calc.mode !== m) { S.calc.P = calcRead(); S.calc.mode = m; } }
function calcApply() {
  const T = calcTokens(S.calc.P, S.calc.mode === 'dark'), mode = S.calc.mode;
  themeValsEdit(S.tweaks.skin, function (v) { v[mode] = Object.assign(v[mode] || {}, T); });   /* 内置配色：改动进当前主题文档（系统主题上先自动复制出自定义主题） */
  const de = document.documentElement; Object.keys(T).forEach(function (k) { de.style.setProperty('--' + k, T[k]); });
  calcReadouts();
}
/* 对比度：叠加色先合成到它所在的层上再算 */
function layerOver(tok, base) {
  const probe = document.createElement('div'); probe.style.cssText = 'position:absolute;visibility:hidden;background:var(--' + tok + ')'; document.body.appendChild(probe);
  const c = getComputedStyle(probe).backgroundColor; probe.remove();
  const b = getComputedStyle(document.documentElement).getPropertyValue('--' + base).trim();
  const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/.exec(c) || /color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?/.exec(c);
  if (!m) return b;
  const scale = c.indexOf('color(') === 0 ? 255 : 1, a = m[4] == null ? 1 : +m[4];
  const bh = toHex(b), br = parseInt(bh.slice(1, 3), 16), bg = parseInt(bh.slice(3, 5), 16), bb = parseInt(bh.slice(5, 7), 16);
  const mix = function (x, y) { return Math.round(x * scale * a + y * (1 - a)); };
  return '#' + [mix(+m[1], br), mix(+m[2], bg), mix(+m[3], bb)].map(function (x) { return Math.max(0, Math.min(255, x)).toString(16).padStart(2, '0'); }).join('');
}
function calcReadouts() {
  /* 对比度表读的是变量的值；叠加类的变量先换成“合成到所在层后”的颜色，读完再还原 */
  const de = document.documentElement, solid = [['bg-field', 'bg-group'], ['bg-selected', 'bg-nav'], ['bg-hover', 'bg-page'], ['bg-code', 'bg-group']].map(function (x) { return [x[0], layerOver(x[0], x[1])]; });
  solid.forEach(function (x) { de.style.setProperty('--' + x[0], x[1]); });
  try { calcReadoutsRaw(); } finally { solid.forEach(function (x) { de.style.removeProperty('--' + x[0]); }); }
}
function calcReadoutsRaw() {
  const cs = getComputedStyle(document.documentElement), g = function (k) { return cs.getPropertyValue('--' + k).trim(); };
  const box = document.getElementById('calc-contrast'); if (!box) return;
  box.innerHTML = CALC_PAIRS.map(function (p) {
    let fgc = g(p[1]);
    if (p[1] === 'NAMEMIN') { fgc = [1, 2, 3, 4, 5, 6].map(function (i) { return g('name-' + i); }).sort(function (a, b) { return contrast(a, g(p[2])) - contrast(b, g(p[2])); })[0]; }
    const r = contrast(fgc, g(p[2])), layer = p[3] < 2, ok = r >= p[3];
    return '<div class="calc-pair"><span class="calc-sw" style="background:' + g(p[2]) + ';color:' + fgc + (tc('themeCalc.readouts.previewMarkup')) + h(p[0]) + '</span><span class="num ' + (ok ? '' : 'calc-bad') + '">' + r.toFixed(2) + '</span><span class="calc-mark">' + (layer ? (ok ? tc('themeCalc.readouts.noticeable') : tc('themeCalc.readouts.tooClose')) : (r >= 4.5 ? 'AA' : r >= 3 ? tc('themeCalc.readouts.largeText') : tc('themeCalc.readouts.insufficient'))) + '</span></div>';
  }).join('');
  CALC_GROUPS.forEach(function (gr) { const sw = document.getElementById('calc-sw-' + gr[0]); if (sw) sw.innerHTML = calcSwatches(gr[0]); });
}
function calcSwatches(k) {
  const cs = getComputedStyle(document.documentElement), list = { accent: ['accent', 'accent-hover', 'accent-soft', 'accent-fg'], layers: ['bg-rail', 'bg-nav', 'bg-page', 'bg-group', 'bg-field', 'bg-selected'], bubble: ['bg-bubble', 'bg-code'], text: ['fg-strong', 'fg', 'fg-muted', 'fg-faint', 'line', 'line-strong'], names: ['name-1', 'name-2', 'name-3', 'name-4', 'name-5', 'name-6'], status: ['ok', 'warn', 'danger', 'info', 'warn-soft', 'danger-soft'] }[k];
  return list.map(function (t) { return '<i data-tip="--' + t + '" style="background:' + cs.getPropertyValue('--' + t).trim() + '"></i>'; }).join('');
}
/* 计算器是一个普通的弹窗（PDL_POPUPS.calc：在角上，× + Esc 关，能拖，不是模态），用通用的对话框组件（dialogHtml）画：同一个面、同一个标题行、同一个正文滚动。
   标题行：切浅 / 深、编辑布局、⋯（恢复默认布局、查看页面描述）、×；两个标签页（配色 / 结构）同一个标题行。页面样式的入口都收在这里 */
function calcHtml() {
  calcEnsure();
  const tab = S.calc.tab || 'colors';
  const tabs = seg([['colors', 'structure.tabColors'], ['tree', 'structure.tab']].map(function (t) { return { v: t[0], label: tc(t[1]), active: tab === t[0] }; }), 'set', undefined, '', ' data-path="s.calc.tab"');
  const html = dialogHtml({ key: 'calc', modal: false, title: tc('theme.calculator'),
    actions: btn(S.calc.mode === 'dark' ? tc('themeCalc.controls.switchLight') : tc('themeCalc.controls.switchDark'), { sm: true, act: 'calcFlip' }) +
      btn(tc('pdlDoc.editing'), { sm: true, act: S.editLayout ? 'close' : 'set', data: ' data-path="s.editLayout"' + (S.editLayout ? '' : ' data-v="true" data-cast="bool"'), pressed: !!S.editLayout }) + moreBtn('calcMore'),
    body: tabs + (tab === 'tree' ? calcTreeHtml() : calcColorsHtml()),
    acts: tab === 'colors' ? [[tc('themeCalc.controls.copyParameters'), { icon: 'copy', act: 'copy', data: argAttrs({ v: calcCopyText() }) }], [tc('themeCalc.controls.reset'), { act: 'reset', data: ' data-scope="calc"' }]] : null });   /* 标题行不带主题名 / 浅深；背景归结构的根容器 */
  return html + '<div class="overlay-host" data-calc-rings></div>';
}
/* 配色页：背景（和主题页的“背景”一节是同一份数据、同一个视图，两个入口）、对比度、各组参数 */
function calcColorsHtml() {
  const P = S.calc.P;
  return '<div class="calc-sec"><div class="calc-sec-h">' + h(tc('themeCalc.contrast')) + '</div><div id="calc-contrast"></div></div>' +
    CALC_GROUPS.map(function (g) {
      const fold = S.calc.fold[g[0]];
      return '<div class="calc-sec"><button type="button" class="calc-sec-h" data-act="toggle" data-path="s.calc.fold.' + g[0] + '" aria-expanded="' + !fold + '">' + twisty(!(fold)) + h(g[1]) + '<span class="calc-sws" id="calc-sw-' + g[0] + '"></span></button>' +
        (fold ? '' : '<p class="calc-help">' + h(g[2]) + '</p>' + g[3].map(function (s) {
          const v = P[s[0]], dec = s[4] < 1 ? (s[4] < 0.01 ? 3 : 2) : 0;
          return '<label class="calc-row"><span>' + h(s[1]) + '</span><input type="range" min="' + s[2] + '" max="' + s[3] + '" step="' + s[4] + '" value="' + v + '" data-calc="' + s[0] + '" aria-label="' + h(g[1] + ' ' + s[1]) + '"><output class="num" id="calc-o-' + s[0] + '">' + Number(v).toFixed(dec) + '</output></label>';
        }).join('')) + '</div>';
    }).join('');
}
/* ⋯：布局的两个动作 */
MENU_FNS.calcMore = function () { return [{ label: tc('themeEntries.resetLayout'), act: 'reset', data: { scope: 'layout' }, why: S.pdlDoc ? '' : tc('themeEntries.resetOff') }, { label: tc('themeEntries.viewPdl'), act: 'dialog', data: { kind: 'pdl' } }]; };
/* 结构页：容器树（只有容器，没有元素）。每一行是一个容器：名字、方向；加子容器、删除（只有空的能删）用行上的图标，移动 / 换父容器是拖动这一行
   （放在另一行的上半 / 下半 = 前面 / 后面，中间 = 里面）。下面是选中的容器的属性：名字、方向、在父容器里的份额 */
function calcTreeHtml() {
  const t = pdlTree(), sel = pdlCtInfo(S.calc.ct) ? S.calc.ct : t.key;
  const dirLabel = function (d) { return tc(d === 'row' ? 'structure.dirRow' : 'structure.dirCol'); };
  const label = function (n) { return n.label || (pdlLayout().regions[n.key] || {}).label || n.key; };
  if (!S.folds[FOLD_TREE + 'calc-tree']) S.folds[FOLD_TREE + 'calc-tree'] = { [t.key]: true };
  const tree = ltree('calc-tree', function (path) {
    const kids = path ? pdlTreeFind(t, path).n.kids || [] : [t];
    return kids.map(function (n) {
      const info = pdlCtInfo(n.key);
      return { name: label(n), path: n.key, dir: !!(n.kids && n.kids.length),
        pick: { act: 'set', data: ' data-path="s.calc.ct" data-v="' + h(n.key) + '"' },
        row: { hook: 'calc-ct', rootAttrs: ' data-ct-row="' + h(n.key) + '"' + (info.whyMove || !info.parent ? ' data-locked="1"' : ' data-edit="ct"'), cur: sel === n.key,
          lead: icon(n.kids && n.kids.length ? 'layers' : 'panel', 14), inline: info.locked ? '<span class="faint" data-tip="' + h(tc('structure.whyLocked')) + '">' + icon('lock', 12) + '</span>' : '',
          sub: h(n.key) + ' · ' + h(dirLabel(n.dir)) + (info.empty ? ' · ' + h(tc('structure.empty')) : ''),   /* 容器 id（不可改）+ 方向 */
          acts: [{ label: tc('structure.add'), icon: 'plus', act: 'calcCtAdd', data: ' data-k="' + h(n.key) + '"', why: info.accepts ? '' : tc('structure.whyNoKids') }, { label: tc('common.delete'), icon: 'delete', act: 'calcCtDel', data: ' data-k="' + h(n.key) + '"', why: info.whyDel }] } };
    });
  }, { ready: true });
  const si = pdlCtInfo(sel), n = si.node, fixed = si.builtin ? tc('structure.whyBuiltinProps') : '';
  const props = '<div class="calc-sec"><div class="calc-sec-h">' + h(tc('structure.props')) + '</div>' +
    '<label class="calc-row"><span>' + h(tc('structure.name')) + helpTip(tc('structure.helpName')) + '</span><input class="input" id="calc-ct-name" data-change="calcCtName" value="' + h(label(n)) + '" data-calc-ct="' + h(sel) + '" aria-label="' + h(tc('structure.name')) + '"><span></span></label>' +   /* 名字只是显示：每个容器都能改（内置的、锁定的也一样） */
    '<div class="calc-row"><span>' + h(tc('structure.dir')) + helpTip(tc('structure.helpDir')) + '</span>' + seg(['column', 'row'].map(function (d) { return { v: d, g: sel, label: dirLabel(d), active: (n.dir || 'column') === d, why: fixed }; }), 'setStatus', undefined, '', ' data-entity="ct" data-id="' + h(sel) + '" data-field="dir"') + '<span></span></div>' +
    '<div class="calc-row"><span>' + h(tc('structure.span')) + helpTip(tc('structure.helpSpan')) + '</span>' + seg(['fit', '1', '2', '3'].map(function (x) { return { v: x, g: sel, label: tcOf('structure.spanOptions', x), active: String(n.span || 'fit') === x, why: fixed || (si.parent ? '' : tc('structure.whyLocked')) }; }), 'setStatus', undefined, '', ' data-entity="ct" data-id="' + h(sel) + '" data-field="span"') + '<span></span></div>' +
    '<div class="calc-row"><span>' + h(tc('structure.hideEmpty')) + helpTip(tc('structure.helpHideEmpty')) + '</span>' + sw(!!n.hideEmpty, 'calcCtHideEmpty', ' data-k="' + h(sel) + '"', tc('structure.hideEmpty'), !!(n.pages || n.space || n.tabs)) + '<span></span></div>' +
    (n.surface || !n.flat && !(n.kids || []).length ? calcSurfaceHtml(sel) : '') + '</div>';
  return '<div class="calc-sec calc-tree">' + tree + '</div>' + props + calcHostsHtml(si, t, label);
}
/* 选中的容器里会打开东西的按钮：每个按钮单独改开到哪（用户容器要删时先在这里迁移承载）；所在容器强制去处的按钮改不了 */
function calcHostsHtml(si, t, label) {
  if (!si.hosts.length) return '';
  const opts = []; pdlTreeWalk(t, function (n) { opts.push({ v: n.key, label: label(n) }); });
  return '<div class="calc-sec"><div class="calc-sec-h">' + h(tc('structure.opensHere')) + helpTip(tc('structure.helpOpensHere')) + '</div>' + si.hosts.map(function (id) {
    const e = pdlEntry(id), o = pdlOpenOf(id);
    return srow(e.title || id, o.forced ? muted(h(tc('structure.whyForced'))) : pick('calc-open-' + id, opts, si.node.key, tc('structure.openTo'), 'calcOpenTo', ' data-id="' + h(id) + '"'));
  }).join('') + '</div>';
}
/* 同一个容器属性编辑器；根容器使用全局背景视图，子容器只编辑声明。 */
function calcSurfaceHtml(key) {
  const surface = bgState().planes[key];
  const modes = [['relative', tc('structure.surface.relative')], ['absolute', tc('structure.surface.absolute')]].map(function (mode) { return { v: mode[0], label: mode[1], active: surface.mode === mode[0] }; });
  return '<div class="calc-row"><span>' + h(tc('structure.surface.label')) + helpTip(tc('structure.surface.help')) + '</span>' + seg(modes, 'calcCtSurface', undefined, '', ' data-k="' + h(key) + '"') + '<span></span></div>' +
    '<label class="calc-row"><span>' + h(tc('themeBackground.opacity')) + '</span><input type="range" id="calc-ct-opacity" min="0" max="100" step="1" value="' + (100 - surface.opacity) + '" data-input="ctBg" data-k="' + h(key) + '" aria-label="' + h(tc('themeBackground.opacity')) + '"><output id="calc-ct-opacity-o">' + (100 - surface.opacity) + '%</output></label>' +
    '<label class="calc-row"><span>' + h(tc('themeBackground.blur')) + '</span><input type="range" id="calc-ct-blur" min="0" max="30" step="1" value="' + surface.blur + '" data-input="ctBg" data-field="blur" data-k="' + h(key) + '" aria-label="' + h(tc('themeBackground.blur')) + '"><output id="calc-ct-blur-o">' + surface.blur + 'px</output></label>';
}
A.calcCtSurface = function (d) {
  const surface = bgState().planes[d.k];
  pdlCtSet(d.k, { surface: { mode: d.v, opacity: d.v === 'absolute' ? surface.value : surface.opacity, blur: surface.blur } });
  render(true); calcDraw();
};
INPUTS.ctBg = function (e) {
  const key = e.target.dataset.k, field = e.target.dataset.field || 'opacity', current = bgState().planes[key];
  const surface = { mode: current.mode, opacity: current.opacity, blur: current.blur };
  surface[field] = field === 'opacity' ? 100 - +e.target.value : +e.target.value;
  BG_LIVE = { container: { key: key, surface: surface } };
  document.getElementById(e.target.id + '-o').textContent = e.target.value + (field === 'opacity' ? '%' : 'px');
  ctGridSync();
};
document.addEventListener('change', function (e) {
  if (e.target.dataset.input !== 'ctBg') return;
  const live = BG_LIVE.container; BG_LIVE = null;
  pdlCtSet(live.key, { surface: live.surface });
});
/* 只重画计算器这个弹窗（不整页重画），之后补上读数和描边 */
POPUPS.calc = function () { return S.calc.open ? calcHtml() : ''; };
function calcDraw() { popRefresh('calc'); calcAfter(); }
function calcAfter() { if (S.calc.open) calcReadouts(); ctRingSync(); }
onRender(calcAfter);
/* 结构页选中的容器在页面上描边（通用：只按容器键找，不认哪个容器）。容器的根元素带 data-c="键"（frame.js 投影写的）；
   没有自己盒子的容器（flat，例如外壳）描它有盒子的子容器。描边是一个锚定在容器上的环（锚点名来自 ui.js 的锚定，环自己不量坐标）：
   画在容器外面一层，不受容器的滚动渐隐遮罩影响 */
function ctRingEls(key) {
  const root = document.getElementById('app'), out = [];
  const walk = function (n) { const el = root && root.querySelector('[data-c="' + CSS.escape(n.key) + '"]:not([data-act])'); if (el && el.getClientRects().length) out.push(el); else (n.kids || []).forEach(walk); };
  const f = pdlTreeFind(pdlTree(), key); if (f) walk(f.n);
  return out;
}
function ctRingSync() {
  document.querySelectorAll('.ct-ring').forEach(function (x) { x.remove(); });
  const host = document.querySelector('[data-calc-rings]'); if (!host || !S.calc.open || S.calc.tab !== 'tree') return;
  const key = pdlCtInfo(S.calc.ct) ? S.calc.ct : pdlTree().key;
  ctRingEls(key).forEach(function (el) { const r = document.createElement('div'); r.className = 'ct-ring'; r.dataset.ring = key; r.setAttribute('aria-hidden', 'true'); r.style.setProperty('--u-anchor', anchorOf(el)); host.appendChild(r); });
}
/* 重画时如果深浅模式变了，按新模式重读参数 */
function calcFollowMode() { if (S.calc.open && S.calc.mode !== calcMode()) { S.calc.P = null; calcDraw(); } }
onRender(calcFollowMode);

document.addEventListener('input', function (e) {
  const k = e.target.dataset && e.target.dataset.calc; if (!k) return;
  S.calc.P[k] = +e.target.value; const o = document.getElementById('calc-o-' + k); if (o) o.textContent = e.target.value;
  calcApply();
});
/* 结构页的名字：失焦或回车时写进主题文档 */
CHANGES.calcOpenTo = function (e) { if (pdlOpenRebind(e.target.dataset.id, e.target.value)) { render(true); calcDraw(); } };
CHANGES.calcCtName = function (e) { const k = e.target.dataset.calcCt, v = e.target.value.trim(); if (v) { pdlCtSet(k, { label: v }); render(true); calcDraw(); } };
/* 结构页里拖一行：移动 / 换父容器（组件库唯一的拖动机制 EDGE_DRAG，整行都是抓手）。放在另一行的上半 / 下半 = 前面 / 后面，中间 = 里面；不允许的落点不画标记 */
EDGE_DRAG.push({
  find: function (t) { const r = t && t.closest && t.closest('[data-pop="calc"] [data-ct-row][data-edit="ct"]'); return r ? { el: r, whole: true } : null; },
  start: function (el, e0) {
    const k = el.dataset.ctRow, sx = e0.clientX, sy = e0.clientY; let at = null;
    const mark = function (e) {
      document.querySelectorAll('[data-pop="calc"] :is(.drop-before, .drop-end, .pdl-over)').forEach(function (x) { x.classList.remove('drop-before', 'drop-end', 'pdl-over'); });
      el.style.pointerEvents = 'none'; const u = document.elementFromPoint(e.clientX, e.clientY); el.style.pointerEvents = '';
      const row = u && u.closest && u.closest('[data-pop="calc"] [data-ct-row]'); at = null; if (!row || row === el) return;
      const r = row.getBoundingClientRect(), y = (e.clientY - r.top) / r.height, zone = y < 0.3 ? 'before' : y > 0.7 ? 'after' : 'inside';
      if (pdlCtMoveWhy(k, row.dataset.ctRow, zone)) return;
      at = { target: row.dataset.ctRow, zone: zone }; row.classList.add(zone === 'before' ? 'drop-before' : zone === 'after' ? 'drop-end' : 'pdl-over');
    };
    return { move: function (e) { el.style.translate = (e.clientX - sx) + 'px ' + (e.clientY - sy) + 'px'; mark(e); },   /* 相对增量（跟着指针） */
      end: function (e, moved) { el.style.translate = ''; if (!moved) return; if (at && pdlCtMove(k, at.target, at.zone)) { render(true); } calcDraw(); } };   /* 没拖动 = 点击：不重画（重画会换掉按下的元素，点击就丢了，这一行选不中） */
  }
});
Object.assign(A, {
  calcCtHideEmpty: function (d) { pdlCtSet(d.k, { hideEmpty: !pdlCtInfo(d.k).node.hideEmpty }); render(true); calcDraw(); },
  calcCtAdd: function (d) { const k = pdlCtAdd(d.k); if (k) S.calc.ct = k; render(true); calcDraw(); },
  calcCtDel: function (d) { const p = (pdlCtInfo(d.k) || {}).parent; if (pdlCtDel(d.k)) { S.calc.ct = p ? p.key : null; render(true); calcDraw(); } },
  calcFlip: function () { A.themeFlip(); S.calc.P = null; calcDraw(); }
});
/* 通用动作用的数据：打开计算器时从当前主题重新读参数；容器的方向 / 份额写进主题文档的结构；复制的是当前参数和推出来的 token */
SET_AFTER['s.calc.open'] = function (v) { if (v) { S.protoOpen = false; S.calc.P = null; } };
ENT.ct = { get: function (k) { return { id: k }; }, set: function (x, f, v) { const o = {}; o[f] = v; pdlCtSet(x.id, o); } };
function calcCopyText() { return JSON.stringify({ theme: S.tweaks.skin, mode: S.calc.mode, params: S.calc.P, tokens: calcTokens(S.calc.P, S.calc.mode === 'dark') }, null, 2); }
/* 恢复默认值能撤回（改过的值记着）：系统主题本来就是默认值，恢复不需要复制，也没有要撤回的 */
RESETS.calc = {
  editable: function () { return !!(S.pdlDoc || THEME_SRC.own().some(function (t) { return t.id === S.tweaks.skin; })); },
  get: function () { return themeVals(S.tweaks.skin)[S.calc.mode] || {}; },
  set: function (v) { if (!RESETS.calc.editable()) return; const mode = S.calc.mode; themeValsEdit(S.tweaks.skin, function (x) { x[mode] = v; }); applyThemeVals(); S.calc.P = null; },
  def: function () { return {}; },
  text: function () { return tc('themeCalc.notifications.toast'); }
};
