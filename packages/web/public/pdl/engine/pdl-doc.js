/* 边界：引擎只放机制与时机，不认任何具体名字、不为单个位置打补丁 */
/* ═════════════ 自定义主题的文档：一棵树（引擎，纯函数） ═════════════
   full = { layout: { tree（整棵容器树）, open }, slots: { 内容容器 id: 改过的那份 }, views: { 视图 id: 改过的那份 }, tokens, style }：
   没改过的内容容器、视图直接用主题声明的（tree.js pdlEffectiveSync）。旁边存着基线快照 base = { v, tree, slots, views }——
   只记被改过的那几个根原来的样子。升级（主题的基线版本变了）：每个改过的根算一遍差异（按节点 id：拿掉 / 加上 / 挪动 / 改属性），
   套到新版本的同一个根上；找不到目标的改动作废（记进 dropped），套不上就把文档存档、直接用新基线。
   之前那种按插槽存键列表的文档（有 place）不再读：作废（都是测试数据）。 */
'use strict';

const PDL_BASE_VERSION = 4;
/* 一个根当前在主题里的样子（升级、新建快照都从这里取；插件插进来的不算） */
function pdlRootNow(kind, rid) { if (kind === 'tree') return PDL_LAYOUT.tree; const r = (PDL_BASE[kind] || {})[rid]; return r ? JSON.parse(JSON.stringify(r, function (k, v) { return Array.isArray(v) ? v.filter(function (x) { return !(x && x.ins); }) : v; })) : null; }   /* 只有主题自己的：插件插进去的节点不算（它们落在生效的那份上） */
/* 文档里改过的根都在快照里有一份原样（第一次改它时记下） */
function pdlBaseFill(full, base) {
  base.slots = base.slots || {}; base.views = base.views || {};
  if (full.layout && full.layout.tree && !base.tree) base.tree = pdlClone(PDL_LAYOUT.tree);
  ['slots', 'views'].forEach(function (kind) { Object.keys(full[kind] || {}).forEach(function (rid) { if (!(rid in base[kind])) { const r = pdlRootNow(kind, rid); base[kind][rid] = r ? pdlClone(r) : null; } }); });
}
/* ── 一个根里的节点：id → { node, parent（所在容器的 id）, prev（前一个兄弟的 id） } ── */
function pdlTreeFlat(root) {
  const out = {};
  const walk = function (x, parent) {
    if (!x || typeof x !== 'object') return;
    PDL_INS_LISTS.forEach(function (k) {
      if (!Array.isArray(x[k])) return;
      let prev = null;
      x[k].forEach(function (y) { if (!y || typeof y !== 'object') return; const id = pdlNodeId(y); if (id) { out[id] = { node: y, parent: parent, list: k, prev: prev }; prev = id; } walk(y, id || parent); });
    });
    Object.keys(x).forEach(function (k) { const v = x[k]; if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, parent); });
  };
  walk(root, '#root');
  return out;
}
function pdlOwnProps(n) { const o = {}; Object.keys(n).forEach(function (k) { if (!Array.isArray(n[k]) && !(n[k] && typeof n[k] === 'object' && pdlTreeFlatHas(n[k]))) o[k] = n[k]; }); return o; }
function pdlTreeFlatHas(x) { return Object.keys(pdlTreeFlat(x)).length > 0; }
/* ── 差异：user 相对 base 的改动（一个根）── */
function pdlTreeDiff(user, base) {
  const u = pdlTreeFlat(user), b = pdlTreeFlat(base), ops = [];
  Object.keys(b).forEach(function (id) { if (!u[id]) ops.push({ op: 'remove', id: id }); });
  Object.keys(u).forEach(function (id) {
    const x = u[id], y = b[id];
    if (!y) { ops.push({ op: 'add', id: id, node: pdlClone(x.node), parent: x.parent, list: x.list, after: x.prev }); return; }
    if (x.parent !== y.parent || x.prev !== y.prev) ops.push({ op: 'move', id: id, parent: x.parent, list: x.list, after: x.prev });
    const pu = pdlOwnProps(x.node), pb = pdlOwnProps(y.node), set = {};
    Object.keys(pu).concat(Object.keys(pb)).forEach(function (k) { if (JSON.stringify(pu[k]) !== JSON.stringify(pb[k])) set[k] = k in pu ? pu[k] : null; });
    if (Object.keys(set).length) ops.push({ op: 'set', id: id, props: set });
  });
  return ops;
}
/* ── 套用：把改动逐条套到一个根的拷贝上；目标已不存在的作废（记进 dropped） ── */
function pdlTreeApply(ops, root) {
  const r = pdlClone(root), dropped = [];
  const listOf = function (parent, k) { if (parent === '#root') return r[k] || (r[k] = []); const f = pdlTreeFlat(r)[parent]; return f ? f.node[k] || (f.node[k] = []) : null; };
  const take = function (id) { const f = pdlTreeFlat(r)[id]; if (!f) return null; const list = f.parent === '#root' ? r[f.list] : pdlTreeFlat(r)[f.parent].node[f.list]; return list.splice(list.indexOf(f.node), 1)[0]; };
  const put = function (op, n) { const list = listOf(op.parent, op.list); if (!list) return false; pdlKidsPlace(list, n, op.after === null ? null : op.after); return true; };
  ops.forEach(function (op) {
    if (op.op === 'remove') { if (!take(op.id)) dropped.push(op); return; }
    if (op.op === 'add') { if (pdlTreeFlat(r)[op.id] || !put(op, pdlClone(op.node))) dropped.push(op); return; }
    if (op.op === 'move') { const n = take(op.id); if (!n || !put(op, n)) dropped.push(op); return; }
    if (op.op === 'set') { const f = pdlTreeFlat(r)[op.id]; if (!f) { dropped.push(op); return; } Object.keys(op.props).forEach(function (k) { if (op.props[k] == null) delete f.node[k]; else f.node[k] = op.props[k]; }); }
  });
  return { root: r, dropped: dropped };
}
/* ── 升级：每个改过的根按差异套到新版本上 ── */
/* 一份基线快照里有、现在的主题里哪都没有的节点：主题删掉了它，用户对它的改动（包括跨容器挪过去的那份）一起作废 */
function pdlGoneIds(base) {
  const ids = function (roots) { const out = {}; roots.forEach(function (r) { if (r) Object.assign(out, pdlTreeFlat(r)); }); return out; };
  const kinds = ['slots', 'views'], was = ids([base.tree].concat([].concat.apply([], kinds.map(function (k) { return Object.values(base[k] || {}); }))));
  const now = ids([PDL_LAYOUT.tree].concat([].concat.apply([], kinds.map(function (k) { return Object.keys(PDL_BASE[k] || {}).map(function (rid) { return pdlRootNow(k, rid); }); }))));
  return Object.keys(was).filter(function (id) { return !now[id]; });
}
/* 快照和现在的主题一样（同一版、内容没变）：不用升级 */
function pdlBaseSame(base) {
  const same = function (a, b) { return JSON.stringify(a) === JSON.stringify(b); };
  return base.v === PDL_BASE_VERSION && (!base.tree || same(base.tree, PDL_LAYOUT.tree)) && ['slots', 'views'].every(function (k) { return Object.keys(base[k] || {}).every(function (rid) { return base[k][rid] === null || same(base[k][rid], pdlRootNow(k, rid)); }); });
}
function pdlUpgrade(user) {
  const full = pdlClone(user.full), base = user.base, nb = { v: PDL_BASE_VERSION, slots: {}, views: {} }, dropped = [], gone = pdlGoneIds(base);
  const diff = function (u, b) { return pdlTreeDiff(u, b).filter(function (op) { if (op.op === 'add' && gone.indexOf(op.id) >= 0) { dropped.push(op); return false; } return true; }); };
  if (full.layout && full.layout.tree) { const r = pdlTreeApply(diff(full.layout.tree, base.tree || PDL_LAYOUT.tree), PDL_LAYOUT.tree); full.layout.tree = r.root; nb.tree = pdlClone(PDL_LAYOUT.tree); dropped.push.apply(dropped, r.dropped); }
  ['slots', 'views'].forEach(function (kind) {
    Object.keys(full[kind] || {}).forEach(function (rid) {
      const now = pdlRootNow(kind, rid), was = (base[kind] || {})[rid];
      if (!was) { nb[kind][rid] = null; return; }   /* 用户自己加的根（自己的容器）：原样留着 */
      if (!now) { delete full[kind][rid]; return; }   /* 这一版主题里没有了 */
      const r = pdlTreeApply(diff(full[kind][rid], was), now); full[kind][rid] = r.root; nb[kind][rid] = pdlClone(now); dropped.push.apply(dropped, r.dropped);
    });
  });
  return { full: full, base: nb, dropped: dropped };
}
/* 上限（spec 主题文档）：只在导入主题、登记插件片段时校验一次 */
const PDL_LIMIT = { depth: 256, nodes: 65536 };
function pdlLimitWhy(x) {
  let nodes = 0, deep = 0;
  const walk = function (v, d) { if (!v || typeof v !== 'object') return; if (d > deep) deep = d; if (Array.isArray(v)) { v.forEach(function (y) { walk(y, d); }); return; } nodes += 1; if (v.type === 'frame') return; Object.keys(v).forEach(function (k) { walk(v[k], d + 1); }); };
  walk(x, 0);
  return deep > PDL_LIMIT.depth ? 'depth' : nodes > PDL_LIMIT.nodes ? 'nodes' : '';
}

/* ═════════════ 主题：系统主题 + 自定义主题 ═════════════
   系统主题（系统主题 1 / 2）不可改：就是基线（加各自的皮肤），随基线一起更新。
   自定义主题 = 一份完整文档 + 它派生自的基线快照。在系统主题上做任何调整（编辑布局、显示 / 隐藏、主题计算器）
   都会自动复制出一份“自定义主题 N”，改动落在它上面（不打断，给一条可撤销的提示）；在自定义主题上就直接改它。
   恢复 = 切回某个系统主题；自定义主题一直留在列表里，什么都不会丢。 */
/* 每套主题只有一套配色（palette：浅色、深色两个变体由它推出）和一个强调色（在配色的值里，主题计算器改它）。
   外观（自动 / 浅色 / 深色）是用户偏好，不属于主题。系统主题 1 = 奶油配色，系统主题 2 = 石墨配色；主题插件带来的主题也是只读主题（id 'pack:…'，配色是插件给的值） */
const PDL_SYS_THEMES = [];   /* 系统主题描述由当前主题的数据登记。 */
function pdlPackThemes() { return THEME_SRC.packs().map(function (t) { return { id: 'pack:' + t.id, name: t.name, src: t.src, skin: 'default', palette: t.id }; }); }
/* 主题文档放在哪：应用登记 THEME_DOCS = { read() → Promise<主题|null>, write(主题) }（宿主保存，清缓存也还在）；没登记时存在浏览器里。启动时先读回来（early 阶段：同一阶段的函数一起开始，主题文档在下一阶段） */
let THEME_DOCS = null, THEMES_HELD = null;
function pdlThemes() { return (THEME_DOCS ? THEMES_HELD && pdlClone(THEMES_HELD) : store.get('pdl-themes-v1', null)) || { active: PDL_SYS_THEMES[0].id, customs: [] }; }   /* 每次给一份副本（和读存储一样）：改了要 pdlThemesSave 才算数 */
function pdlThemesSave(t) { if (THEME_DOCS) { const j = JSON.stringify(t); if (j === JSON.stringify(pdlThemes())) return; THEMES_HELD = JSON.parse(j); THEME_DOCS.write(t); }   /* 没变就不写宿主（启动时的整理多半什么都没改） */ else store.set('pdl-themes-v1', t); }
onStart('early', function () { if (THEME_DOCS) return THEME_DOCS.read().then(function (t) { THEMES_HELD = t; }); });
function pdlThemeActive() { const t = pdlThemes(); return t.customs.find(function (c) { return c.id === t.active; }) || null; }
function pdlSysTheme(id) { return PDL_SYS_THEMES.concat(pdlPackThemes()).find(function (x) { return x.id === id; }) || null; }   /* 只读主题：系统主题 + 主题插件带来的主题 */
/* 当前主题的名字（主题页、主题计算器标题都用它） */
function pdlRoName(d) { return d.name || tc('pdlDoc.sysName', d.n); }
function pdlThemeName() { const t = pdlThemes(), c = pdlThemeActive(); return c ? c.name : pdlRoName(pdlSysTheme(t.active) || PDL_SYS_THEMES[0]); }
function pdlCustomName(t) { let n = 1; while (t.customs.some(function (c) { return c.name === tc('pdlDoc.customName', n); })) n += 1; return tc('pdlDoc.customName', n); }
function pdlDocSave(doc) {   /* 写回当前的自定义主题（系统主题不可写，见 pdlDocEdit） */
  const t = pdlThemes(), c = t.customs.find(function (x) { return x.id === t.active; }); if (!c) return;
  c.full = doc.full; c.base = doc.base; pdlThemesSave(t);
}
function pdlArchive() { return store.get('pdl-archive-v1', []) || []; }
/* 启动：每个自定义主题的基线版本落后就升级；失败 → 那份文档存档（出现在 主题 › 入口布局 里，选中就重试），它原来是当前主题就退回系统主题 1。
   系统主题不用升级：它就是基线 */
function pdlDocBoot() {
  const t = pdlThemes(), keep = [];
  t.customs.forEach(function (c) {
    if (!c.base || !c.full || c.full.place) { if (c.id === t.active) t.active = PDL_SYS_THEMES[0].id; return; }   /* 旧格式（按插槽存键列表）：作废 */
    if (pdlBaseSame(c.base)) { keep.push(c); return; }   /* 主题变了（换了版本，或者同一版里删了内置节点）才升级 */
    try {
      const up = pdlUpgrade(c);
      keep.push(Object.assign({}, c, { full: up.full, base: up.base }));
      if (c.id === t.active) S.pdlUpgrade = { from: c.base.v, dropped: up.dropped.length };
    } catch (e) {
      const arch = pdlArchive(); arch.push({ key: 'a' + Date.now() + c.id, name: c.name, full: c.full, base: c.base, error: String(e && e.message || e) });
      store.set('pdl-archive-v1', arch);
      if (c.id === t.active) { t.active = PDL_SYS_THEMES[0].id; S.pdlUpgradeFailed = { from: c.base.v }; }
    }
  });
  t.customs = keep; pdlThemesSave(t);
  pdlThemeSync();
}
/* 生效：当前主题是自定义主题时，它的文档按 id 覆盖主题声明的那几个根（tree.js pdlEffectiveSync）；系统主题就是基线 */
function pdlThemeSync() {
  const t = pdlThemes(), c = pdlThemeActive();
  S.pdlDoc = c ? { full: c.full, base: c.base } : null;
  const ro = pdlSysTheme(t.active) || PDL_SYS_THEMES[0];
  S.pdlSkin = c ? (c.skin || 'default') : ro.skin;
  const pal = c ? (c.palette || themeDefault()) : ro.palette;   /* 配色跟着主题走（不再单独选） */
  if (S.tweaks.skin !== pal) { S.tweaks.skin = pal; store.set('tweaks', S.tweaks); }
  PDL_THEME_SYNC.forEach(function (f) { f(); });
  /* 主题文档改了（背景、字号、布局……）：投影里留着的层跟着作废——露出来的时候按新的一版重画，
     不然被盖住的对话主窗口还留着旧背景 */
  if (typeof navStale === 'function') navStale();
}
function pdlBaseNew() { return { v: PDL_BASE_VERSION, slots: {}, views: {} }; }
/* 编辑：界面上的每次调整都改当前自定义主题的文档（fn(full)），第一次改到的根在基线快照里记下原样。
   当前是系统主题：先复制出一个自定义主题，改动落在它上面，并给一条可撤销的提示 */
function pdlDocEdit(fn) {
  const t = pdlThemes();
  let c = t.customs.find(function (x) { return x.id === t.active; });
  /* 一份自定义主题一直被改下去；只有当前主题是只读主题（系统主题）时改它才复制出新的一份，或者用户明确“复制为新主题” */
  if (!c) {
    const from = t.active, ro = pdlSysTheme(from) || PDL_SYS_THEMES[0];
    c = { id: 'c' + Date.now(), name: pdlCustomName(t), skin: ro.skin, palette: ro.palette, full: {}, base: pdlBaseNew(), from: from };
    t.customs.push(c); t.active = c.id;
    S.pdlCopied = { id: c.id, from: from, name: c.name };
  }
  const full = pdlClone(c.full);
  fn(full);
  pdlBaseFill(full, c.base);
  c.full = full; pdlThemesSave(t); pdlThemeSync();
  if (S.pdlCopied && S.pdlCopied.id === c.id && !S.pdlCopied.told) { S.pdlCopied.told = true; const cid = c.id; undoShow({ text: tc('pdlDoc.copiedTheme', c.name), undo: function () { pdlThemeUndoCopy(cid); } }); }   /* 第一次修改系统主题时自动复制：能撤回 */
}
/* 撤销自动复制：删掉这份副本，回到原来的系统主题 */
function pdlThemeUndoCopy(id) {
  const t = pdlThemes(), c = t.customs.find(function (x) { return x.id === id; }); if (!c) return;
  t.customs = t.customs.filter(function (x) { return x.id !== id; }); t.active = c.from || PDL_SYS_THEMES[0].id; pdlThemesSave(t); S.pdlCopied = null; pdlThemeSync(); render(true);
}
A.pdlThemeUse = function (d) { const t = pdlThemes(); t.active = d.id; pdlThemesSave(t); S.pdlCopied = null; pdlThemeSync(); render(true); };
A.pdlThemeDup = function (d) {   /* 复制为新主题（系统主题也能复制） */
  const t = pdlThemes(), src = t.customs.find(function (x) { return x.id === d.id; }), sys = pdlSysTheme(d.id);
  const c = { id: 'c' + Date.now(), name: pdlCustomName(t), skin: src ? src.skin : sys ? sys.skin : 'default', palette: src ? src.palette : sys ? sys.palette : themeDefault(), full: src ? pdlClone(src.full) : {}, base: src ? pdlClone(src.base) : pdlBaseNew() };
  t.customs.push(c); t.active = c.id; pdlThemesSave(t); pdlThemeSync(); render(true);
};
/* 自定义主题：改名（只有自定义主题能改名）、删除（能撤回：回到列表里原来的位置，正在用的话再用回它） */
ENT.theme = {
  coll: function () { return pdlThemes().customs; }, title: function () { return tc('common.rename'); },
  rename: function (c, v) { const t = pdlThemes(), x = t.customs.find(function (y) { return y.id === c.id; }); if (x) { x.name = v; pdlThemesSave(t); } },
  undo: true, undoText: function (op, c) { return tc('pdlDoc.themeDropped', c.name); },
  remove: function (c) {
    const t = pdlThemes(), i = t.customs.findIndex(function (x) { return x.id === c.id; }), was = t.active;
    t.customs.splice(i, 1); if (t.active === c.id) t.active = PDL_SYS_THEMES[0].id; pdlThemesSave(t); pdlThemeSync();
    return function () { const t2 = pdlThemes(); t2.customs.splice(Math.min(i, t2.customs.length), 0, c); t2.active = was; pdlThemesSave(t2); pdlThemeSync(); };
  }
};
/* ───────── 导入 / 导出─────────
   主题包 = theme.yaml：身份字段（id、name、version、contractVersion，和插件的 plugin.yaml 一样；extends 是它派生自的主题）+ pdl 段
   （palette、skin、doc（完整的主题文档：页面描述的摆放 / 结构、配色的值、背景、样式）、base（基线快照，升级用））。
   YAML 由宿主读写（平台口 packRead / packSave），引擎只拿到对象。用户背景和个人照片不属于主题。导入校验不过：对话框留着，显示错误 */
/* 用户对插件节点的调整（摆放、顺序、隐藏）按 plugin:<插件>/<节点> 记，读的时候插件在才生效；导出的主题包不带它们 */
function pdlDropPluginRefs(doc) {
  const strip = function (x) {
    if (!x || typeof x !== 'object') return;
    if (Array.isArray(x)) { for (let i = x.length - 1; i >= 0; i--) { if (x[i] && /^plugin:/.test(x[i].ref || '')) x.splice(i, 1); else strip(x[i]); } return; }
    Object.keys(x).forEach(function (k) { strip(x[k]); });
  };
  strip(doc);
}
function pdlThemePack(id) {
  const t = pdlThemes(), c = t.customs.find(function (x) { return x.id === id; }), ro = c ? null : pdlSysTheme(id) || PDL_SYS_THEMES[0];
  const doc = c ? pdlClone(c.full) : {};
  pdlDropPluginRefs(doc);
  return { id: c ? c.id : ro.id, name: c ? c.name : pdlRoName(ro), version: '1', contractVersion: PDL_THEME.contractVersion, extends: PDL_THEME.id,
    pdl: { palette: c ? c.palette : ro.palette, skin: c ? c.skin : ro.skin, doc: doc, base: c ? pdlClone(c.base) : pdlBaseNew() } };
}
A.pdlThemeExport = function (d) {   /* 文件落到下载文件夹，界面上看不到：保留提示（最近一次记在 S.lastExport） */
  const pack = pdlThemePack(d.id), name = pack.name.replace(/\s+/g, '-') + '.theme.yaml';
  S.lastExport = { name: name, pack: pack };
  return Promise.resolve(PLATFORM.packSave(name, pack)).then(function () { toast(tc('pdlDoc.exported', name)); });
};
/* 校验一个主题包：返回错误文案，或者 '' */
function pdlThemePackWhy(o) {
  const x = o && typeof o === 'object' && o.pdl;
  if (!x || typeof x !== 'object') return tc('pdlDoc.importBad');
  if (!x.doc || typeof x.doc !== 'object' || x.doc.place || !x.base || typeof x.base !== 'object' || !x.palette) return tc('pdlDoc.importIncomplete');
  const big = pdlLimitWhy(x.doc); if (big) return tc('pdlDoc.importTooLarge.' + big);   /* 上限只在这里校验一次 */
  return '';
}
function pdlThemeAdd(o) {
  const t = pdlThemes(), taken = t.customs.some(function (c) { return c.name === o.name; }) || PDL_SYS_THEMES.some(function (x) { return pdlRoName(x) === o.name; });
  const c = { id: 'c' + Date.now(), name: o.name && !taken ? String(o.name) : pdlCustomName(t), skin: o.pdl.skin || 'default', palette: o.pdl.palette, full: pdlClone(o.pdl.doc), base: pdlClone(o.pdl.base) };
  t.customs.push(c); pdlThemesSave(t); return c;
}
A.pdlThemeImport = function () {
  dialog({ title: tc('pdlDoc.importTitle'), fields: [{ id: 'theme-file', label: tc('pdlDoc.importFile'), file: { accept: '.yaml,.yml' } }], ok: tc('common.import'), on: function () {
    const el = document.getElementById('theme-file'), f = el && el.files && el.files[0];
    if (!f) return Promise.resolve({ error: tc('pdlDoc.importNoFile') });
    return PLATFORM.packRead(f).then(function (o) { const why = pdlThemePackWhy(o); if (why) return { error: why }; pdlThemeAdd(o); }, function () { return { error: tc('pdlDoc.importBad') }; });
  } });
};
/* 恢复默认 = 切回系统主题 1（自定义主题留在列表里） */
function pdlDocReset() { const t = pdlThemes(); t.active = PDL_SYS_THEMES[0].id; pdlThemesSave(t); pdlThemeSync(); }
onStart('doc', pdlDocBoot);

/* 存档的布局：选中就用当前基线重新合并一次；成功就成为当前布局，仍失败就留在列表里并标出原因 */
A.pdlArchiveApply = function (d) {
  const arch = pdlArchive(), i = arch.findIndex(function (a) { return a.key === d.k; }); if (i < 0) return;
  try {
    const up = pdlUpgrade(arch[i]);
    const t = pdlThemes(), c = { id: 'c' + Date.now(), name: arch[i].name || pdlCustomName(t), skin: 'default', full: up.full, base: up.base };
    t.customs.push(c); t.active = c.id; pdlThemesSave(t); pdlThemeSync();
    arch.splice(i, 1); store.set('pdl-archive-v1', arch); S.pdlUpgradeFailed = null;
  } catch (e) { arch[i].error = String(e && e.message || e); arch[i].tried = true; store.set('pdl-archive-v1', arch); }   /* 合并成功：这一行消失、布局已变；仍失败：原因写在这一行上 */
  render(true);
};
ENT.archive = { coll: function () { return pdlArchive(); }, get: function (k) { return pdlArchive().find(function (a) { return a.key === k; }); }, remove: function (x) { store.set('pdl-archive-v1', pdlArchive().filter(function (a) { return a.key !== x.key; })); } };
/* 升级结果的提示（不打断操作）：所有脚本加载完、第一屏画好之后说一次 */
window.addEventListener('load', function () {
  if (S.pdlUpgradeFailed) toast(tc('pdlDoc.upgradeFailed'), { label: tc('pdlDoc.upgradeFailedGo'), act: 'open', data: argAttrs({ page: 'appearance' }) });
  else if (S.pdlUpgrade && S.pdlUpgrade.dropped) toast(tc('pdlDoc.upgraded', S.pdlUpgrade.dropped));
});
