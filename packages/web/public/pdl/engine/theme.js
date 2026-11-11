/* 边界：引擎只放机制与时机，不认任何具体名字、不为单个位置打补丁 */
/* 主题的应用（引擎）：当前主题文档里的配色值、字体 / 字号 / 圆角 / 动态效果、背景图、素材，落到根元素上（token 变量、data-theme / data-skin）。
   主题自己的声明（系统主题、配色、素材）在 theme/<主题>/；主题插件带来的配色、自建配色由应用登记来源（THEME_SRC）。 */
'use strict';
/* ───────────── 外观与语言：主题 = 给 core.css 顶部那组语义变量一套值 ───────────── */
const TOKEN_GROUPS = [
  [tc('theme.tokens.surfaces'), [['bg-rail', tc('theme.tokens.rail')], ['bg-nav', tc('theme.tokens.sidebar')], ['bg-page', tc('theme.tokens.page')], ['bg-group', tc('theme.tokens.group')], ['bg-field', tc('theme.tokens.input')], ['bg-hover', tc('theme.tokens.hover')], ['bg-selected', tc('theme.tokens.selected')], ['bg-bubble', tc('theme.tokens.messageBubble')], ['bg-raised', tc('theme.tokens.popup')]]],
  [tc('theme.tokens.text'), [['fg-strong', tc('theme.tokens.emphasis')], ['fg', tc('wsSignals.body')], ['fg-muted', tc('theme.tokens.secondaryText')], ['fg-faint', tc('theme.tokens.faintText')], ['fg-on-accent', tc('theme.tokens.onAccentText')]]],
  [tc('theme.tokens.accent'), [['accent', tc('theme.tokens.accent')], ['accent-hover', tc('theme.tokens.accentHover')], ['accent-soft', tc('theme.tokens.accentBackground')], ['accent-fg', tc('theme.tokens.accentText')], ['focus', tc('theme.tokens.focusRing')], ['switch-on', tc('theme.tokens.switchOn')]]],
  [tc('theme.tokens.status'), [['ok', tc('theme.tokens.normal')], ['warn', tc('log.level.warn')], ['warn-soft', tc('theme.tokens.warningBackground')], ['danger', tc('theme.tokens.danger')], ['danger-soft', tc('theme.tokens.dangerBackground')], ['info', tc('theme.tokens.information')]]],
  [tc('theme.tokens.lines'), [['line', tc('theme.tokens.divider')], ['line-strong', tc('theme.tokens.emphasisLine')]]],
  [tc('theme.tokens.memberColor'), [1, 2, 3, 4, 5, 6].map(function (n) { return ['tint-' + n, tc('theme.tokens.tintN', n)]; })],
  [tc('common.threads'), [['bg-code', tc('theme.tokens.inlineCodeBackground')]].concat([1, 2, 3, 4, 5, 6].map(function (n) { return ['name-' + n, tc('theme.tokens.nameN', n)]; }))]
];
/* 悬停、选中、内嵌、行内代码、分隔线由层级推导（叠在所在层上的墨色），主题只给叠多深 d-*；主题包里如果还带着这些的绝对值，不让它们覆盖推导 */
const LAYER_DERIVED = ['bg-hover', 'bg-selected', 'bg-field', 'bg-code', 'line', 'line-strong'];
const TOKENS = [].concat.apply([], TOKEN_GROUPS.map(function (g) { return g[1].map(function (t) { return t[0]; }); })).concat(['font-display', 'd-hover', 'd-btn', 'd-selected', 'd-inset', 'd-code', 'd-line', 'd-line-strong']);
/* 内置配色（主题数据）：default 是没有 data-skin 的那一套（样式表的基础值），其余各自是一个 data-skin；accent 是它声明的强调色 */
const BUILTIN_THEMES = [];   /* 内置配色：主题声明（theme/<主题>/palettes.js 登记）；default 是没有 data-skin 的那一套（样式表的基础值），其余各自是一个 data-skin；accent 是它声明的强调色 */
/* 配色的来源（应用登记）：packs() 主题插件带来的配色 [{ id, values, … }]；own() 旧的自建配色 [{ id, values }]（改它自己）；saveOwn() 存旧的自建配色 */
const THEME_SRC = { packs: function () { return []; }, own: function () { return []; }, saveOwn: function () {} };
function themeDefault() { return BUILTIN_THEMES.find(function (x) { return x.default; }).id; }
/* 一套配色落到页面上的 data-skin：内置的非默认配色用自己的 id，其余（默认、插件带的、自定义的）没有 */
function skinAttr(id) { const b = BUILTIN_THEMES.find(function (x) { return x.id === id; }); return b && !b.default ? b.id : null; }
function stIsDark() { return S.tweaks.theme === 'dark' || (S.tweaks.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches); }
function stMode() { return stIsDark() ? 'dark' : 'light'; }
/* 一套配色的值：插件带的配色 = 插件的值 + 当前主题文档里的改动；旧的自建配色 = 它自己的值；内置配色 = 文档里的改动 */
function themeVals(id) {
  const ov = ((S.pdlDoc && S.pdlDoc.full.tokens) || {})[id] || {}, p = THEME_SRC.packs().find(function (t) { return t.id === id; });
  if (p) return { light: Object.assign({}, p.values.light || {}, ov.light || {}), dark: Object.assign({}, p.values.dark || {}, ov.dark || {}) };
  const c = THEME_SRC.own().find(function (t) { return t.id === id; }); if (c) return c.values;
  return pdlClone(Object.keys(ov).length ? ov : { light: {}, dark: {} });
}
/* 改某套配色的值：旧的自建配色直接改它自己；插件带的配色和内置配色（系统主题的一部分，不可改）的改动写进当前主题文档的 tokens——
   当前是系统主题时，pdlDocEdit 先复制出一个自定义主题（带撤销提示），改动落在副本上 */
function themeValsEdit(id, fn) {
  const own = THEME_SRC.own().find(function (t) { return t.id === id; });   /* 插件带的配色是只读的：改动和内置配色一样进当前主题文档（只读主题上先自动复制出自定义主题） */
  if (own) { own.values.light = own.values.light || {}; own.values.dark = own.values.dark || {}; fn(own.values); THEME_SRC.saveOwn(); return; }
  pdlDocEdit(function (full) { const all = full.tokens = full.tokens || {}, v = all[id] = all[id] || { light: {}, dark: {} }; fn(v); });
}
function snapTokens(skin, mode) {
  const de = document.documentElement, sv = { t: de.getAttribute('data-theme'), s: de.getAttribute('data-skin'), st: de.getAttribute('style') };
  de.removeAttribute('style'); de.setAttribute('data-theme', mode); if (skinAttr(skin)) de.setAttribute('data-skin', skinAttr(skin)); else de.removeAttribute('data-skin');
  const cs = getComputedStyle(de), out = {}; TOKENS.forEach(function (t) { out[t] = cs.getPropertyValue('--' + t).trim(); });
  if (sv.t == null) de.removeAttribute('data-theme'); else de.setAttribute('data-theme', sv.t);
  if (sv.s == null) de.removeAttribute('data-skin'); else de.setAttribute('data-skin', sv.s);
  if (sv.st == null) de.removeAttribute('style'); else de.setAttribute('style', sv.st);
  return out;
}
function applyThemeVals() {
  const de = document.documentElement; TOKENS.forEach(function (t) { de.style.removeProperty('--' + t); });
  const v = themeVals(S.tweaks.skin)[stMode()] || {}; Object.keys(v).forEach(function (k) { if (LAYER_DERIVED.indexOf(k) < 0) de.style.setProperty('--' + k, v[k]); });
  applyStyle();   /* 字体、圆角、缩放在主题值之上（主题值里可能带 font-display） */
  if (typeof applyAssets === 'function') applyAssets();   /* 换皮肤可能换素材 */
}
PDL_THEME_SYNC.push(applyThemeVals);
function toHex(c) { if (/^#[0-9a-f]{6}$/i.test(c)) return c; if (/^#[0-9a-f]{3}$/i.test(c)) return '#' + c.slice(1).split('').map(function (x) { return x + x; }).join(''); const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c); return m ? '#' + [m[1], m[2], m[3]].map(function (x) { return (+x).toString(16).padStart(2, '0'); }).join('') : '#000000'; }
/* ───────── 字体、字号、圆角、密度 ───────── */
/* 字体组：[名字, 正文, 标题, 等宽]；空 = 用系统那一组。bundled 用内置字体素材（font.inter / font.sc / font.mono，见 font-assets.js），是默认；
   字体栈最后都是系统字体：内置字体加载失败、或者某个字不在子集里，就落到系统字体 */
const SYS_MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';
const FONT_SETS = {
  bundled: [tc('theme.fontOptions.bundled'), '"Inter", "Noto Sans SC", -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif', null, '"JetBrains Mono", ' + SYS_MONO],
  system: [tc('theme.fontOptions.system'), '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif', null, SYS_MONO]
};
const RADIUS_SETS = { tight: [tc('theme.compact'), [4, 6, 8, 10]], normal: [tc('theme.radiusOptions.normal'), [6, 8, 12, 16]], round: [tc('theme.radiusOptions.round'), [8, 10, 16, 20]] };
const STYLE_DEFAULT = { font: 'bundled', readSize: '15', uiScale: '1', radius: 'normal', motion: 'system' };
/* 字体、字号、圆角、动态效果是主题的一部分：存在当前主题文档的 style 里（系统主题就是默认值）。
   读：S.style 由主题文档推出来；改：styleSet——在系统主题上会先复制出自定义主题（和编辑布局、配色同一套） */
Object.defineProperty(S, 'style', { configurable: true, get: function () { return Object.assign({}, STYLE_DEFAULT, (S.pdlDoc && S.pdlDoc.full.style) || {}); } });
function styleSet(patch) { pdlDocEdit(function (full) { full.style = patch ? Object.assign({}, full.style || {}, patch) : {}; }); applyStyle(); render(true); }
PDL_THEME_SYNC.push(function () { applyStyle(); });
/* 文字大小：用户层的 token 覆盖——正文字号直接给阅读那一档（--fs-read → --fs-xl），界面字号是其余各档和展示字号的倍数（--fs-scale）；控件高度、间距不跟着变 */
const READ_SIZES = ['14', '15', '16', '17', '18'], UI_SCALES = [['0.93', tc('theme.scale.text')], ['1', tc('theme.scale.standard')], ['1.07', tc('theme.scale.large')]];
function applyStyle() {
  const de = document.documentElement, st = S.style, f = FONT_SETS[st.font] || FONT_SETS[STYLE_DEFAULT.font], base = FONT_SETS.system[1];
  de.style.setProperty('--font-text', f[1] || base);
  de.style.setProperty('--font-display', f[2] || f[1] || base);
  de.style.setProperty('--font-mono', f[3] || FONT_SETS.system[3]);
  de.style.setProperty('--fs-read', (READ_SIZES.indexOf(st.readSize) >= 0 ? st.readSize : '15') + 'px');
  de.style.setProperty('--fs-scale', UI_SCALES.some(function (x) { return x[0] === st.uiScale; }) ? st.uiScale : '1');
  const r = (RADIUS_SETS[st.radius] || RADIUS_SETS.normal)[1];
  ['--r-s', '--r-m', '--r-l', '--r-xl'].forEach(function (k, i) { de.style.setProperty(k, r[i] + 'px'); });
  /* 动态效果：跟随系统（prefers-reduced-motion）/ 减少 / 正常。减少 = 时长 token 归零（见 core.css），状态信号不受影响 */
  const sys = matchMedia('(prefers-reduced-motion: reduce)').matches;
  de.dataset.motion = st.motion === 'reduce' || (st.motion !== 'normal' && sys) ? 'reduce' : 'normal';
  if (typeof MS_CACHE !== 'undefined') Object.keys(MS_CACHE).forEach(function (k) { delete MS_CACHE[k]; });
}
/* 背景是用户外观偏好：图片引用、个人素材目录、默认底面值独立保存；主题切换和导出不包含个人照片。 */
function bgDefault() { return { home: PDL_LAYOUT.background.image, homeTr: PDL_LAYOUT.background.veil, images: [] }; }   /* 缺省的全局素材和窗口底面不透明度由主题布局声明（PDL_LAYOUT.background）；自定义素材目录是个人偏好 */
let BG_LIVE = null;   /* 正在拖的底面参数；个人背景写偏好，容器参数写主题结构。 */
Object.defineProperty(S, 'bg', { configurable: true, enumerable: true, get: function () { return Object.assign(bgDefault(), store.get('background-v1', {}), BG_LIVE || {}); } });
function bgSet(patch) {
  store.set('background-v1', Object.assign({}, S.bg, patch));
}
function bgUrl(kind) {
  if (kind === 'none' || !kind) return '';
  return asset(kind);   /* 内置图和自定义图都是素材，不跟随浅深配色自动切换。 */
}
/* 容器按父子关系推导不透明度；绝对值截断父级影响，未声明为相对叠加 0%。 */
function bgState(key) {
  const shell = bgUrl(S.bg.home), planes = {}, defaults = {};
  pdlTreeWalk(PDL_LAYOUT.tree, function (n) { if (n.surface) defaults[n.key] = n.surface; });
  pdlTreeWalk(pdlTree(), function (n, p) {
    const surface = Object.assign({ mode: 'relative', opacity: 0, blur: 0 }, defaults[n.key] || {}, n.surface || {}, BG_LIVE && BG_LIVE.container && BG_LIVE.container.key === n.key ? BG_LIVE.container.surface : {});
    const parent = p ? planes[p.key].value : S.bg.homeTr;
    const value = !p ? S.bg.homeTr : surface.mode === 'absolute' ? surface.opacity : Math.round(100 - (100 - parent) * (100 - surface.opacity) / 100);
    planes[n.key] = { mode: surface.mode, opacity: surface.opacity, blur: surface.blur, value: value };
  });
  return { shell: shell, g: shell ? S.bg.homeTr : 100, veil: shell ? planes[key || ctPages()].value : 100, planes: planes };
}
function applyTheme() {
  const de = document.documentElement, t = S.tweaks;
  if (t.theme === 'system') de.removeAttribute('data-theme'); else de.setAttribute('data-theme', t.theme);
  const sk = skinAttr(t.skin); if (sk) de.setAttribute('data-skin', sk); else de.removeAttribute('data-skin');
}
const ASSETS = {};   /* 素材登记（id → { type, mime, src, … }）：主题登记自己的素材（theme/<主题>/assets.js），组件和 CSS 只按 id 取 */
const ASSET_LAYERS = { skins: {}, user: {} };   /* skins[皮肤] / user（当前自定义主题选的素材）：{ id: 素材 } */
function assetSkin() { return typeof S !== 'undefined' && S.pdlSkin ? S.pdlSkin : 'default'; }
function assetRaw(id) {
  const u = ASSET_LAYERS.user[id]; if (u) return u;
  const sk = ASSET_LAYERS.skins[assetSkin()]; if (sk && sk[id]) return sk[id];
  return ASSETS[id] || null;
}
/* 取一个素材的地址（没有就是空串） */
function asset(id) { const a = assetRaw(id); return a ? a.src : ''; }
/* 把素材交给 CSS：每个 id 一个变量 --asset-<id 里的点换成横线>，值是 url(…) */
/* 字体素材（type: 'font'）登记成文档字体：同一个家族名只注册一次；加载失败就不管它——字体栈后面是系统字体，自然落过去 */
const FONT_DONE = {};
function applyFonts() {
  if (typeof FontFace === 'undefined' || !document.fonts) return;
  Object.keys(ASSETS).forEach(function (id) {
    const a = assetRaw(id); if (!a || a.type !== 'font' || FONT_DONE[a.family + a.src.length]) return;
    FONT_DONE[a.family + a.src.length] = true;
    try { const f = new FontFace(a.family, 'url("' + a.src + '")', { weight: a.weight || 'normal', display: 'swap' }); document.fonts.add(f); f.load().catch(function () { /* 落到系统字体 */ }); } catch (e) { /* 落到系统字体 */ }
  });
}
function applyAssets() {
  const de = document.documentElement;
  applyFonts();
  Object.keys(ASSETS).forEach(function (id) { if (ASSETS[id].type === 'font') return; const v = asset(id); de.style.setProperty('--asset-' + id.replace(/\./g, '-'), v ? 'url("' + v + '")' : 'none'); });
  /* 浏览器标签页的图标也是品牌标志这一个素材 */
  let ic = document.querySelector('link[rel="icon"]'); if (!ic) { ic = document.createElement('link'); ic.rel = 'icon'; document.head.appendChild(ic); }
  ic.href = asset('brand.logo');
}
/* 颜色按层级推导（主题计算器算的就是这些）：
   表面是绝对的几层：窄栏 → 二级栏 → 页面 → 分组 → 浮层（主题计算器给出各层明度）。
   其它都是“叠在所在那层上的墨色”，只有一个透明度：
     悬停 --bg-hover、选中 --bg-selected、内嵌（输入框、选择框这类凹进去的）--bg-field、行内代码 --bg-code、分隔线 --line / --line-strong
   墨色 = 最强的文字色。浅色主题里叠上去就深一档，深色主题里就浅一档；叠在背景图的半透明层上也成立。
   所以一个元素放在哪一层，它的悬停 / 选中自动是那一层的深一档，不需要为某个位置单独配色。 */


/* ── OKLCH ⇄ sRGB ── */
function okToRgb(L, C, H) {
  const hr = H * Math.PI / 180, a = C * Math.cos(hr), b = C * Math.sin(hr);
  const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3), m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3), s = Math.pow(L - 0.0894841775 * a - 1.2914855480 * b, 3);
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s];
}
function lin2srgb(x) { x = Math.min(1, Math.max(0, x)); return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055; }
function srgb2lin(x) { return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }
function okHex(L, C, H) { return '#' + okToRgb(L, C, H).map(function (v) { return ('0' + Math.round(lin2srgb(v) * 255).toString(16)).slice(-2); }).join(''); }
function hexOk(hex) {
  hex = toHex(hex || '#000000'); const r = srgb2lin(parseInt(hex.slice(1, 3), 16) / 255), g = srgb2lin(parseInt(hex.slice(3, 5), 16) / 255), b = srgb2lin(parseInt(hex.slice(5, 7), 16) / 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b), m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b), s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s, A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s, B = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  let H = Math.atan2(B, A) * 180 / Math.PI; if (H < 0) H += 360;
  return { L: L, C: Math.sqrt(A * A + B * B), H: H };
}
function lum(hex) { hex = toHex(hex); return [1, 3, 5].map(function (i) { return srgb2lin(parseInt(hex.slice(i, i + 2), 16) / 255); }).reduce(function (a, v, i) { return a + v * [0.2126, 0.7152, 0.0722][i]; }, 0); }
function contrast(a, b) { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }

/* 主题的 token（主题包 pdl.json 的 tokens）写成样式：lengths 登记成长度（读出来是算好的像素）；base 是根上的值，queries 按窗口宽度覆盖；
   dark 在跟随系统的深色和手动深色下都生效；skins 是各个配色的浅色 / 深色值（data-skin） */
function themeTokens(t) {
  const block = function (sel, vars) { const ks = Object.keys(vars || {}); return ks.length ? sel + ' { ' + ks.map(function (k) { return k + ': ' + vars[k]; }).join('; ') + '; }\n' : ''; };
  const dark = function (sel, vars) { return Object.keys(vars || {}).length ? '@media (prefers-color-scheme: dark) { ' + block(sel + ':not([data-theme="light"])', vars) + '}\n' + block(sel + '[data-theme="dark"]', vars) : ''; };
  let css = (t.lengths || []).map(function (n) { return '@property ' + n + " { syntax: '<length>'; inherits: true; initial-value: 0px; }\n"; }).join('') + block(':root', t.base);
  (t.queries || []).forEach(function (q) { css += '@media ' + q.media + ' { ' + block(':root', q.vars) + '}\n'; });
  css += dark(':root', t.dark);
  Object.keys(t.skins || {}).forEach(function (s) { const sel = ':root[data-skin="' + s + '"]'; css += block(sel, t.skins[s].light) + dark(sel, t.skins[s].dark); });
  let el = document.querySelector('style[data-theme-tokens]'); if (!el) { el = document.createElement('style'); el.setAttribute('data-theme-tokens', ''); document.head.appendChild(el); }
  el.textContent = css;
}
