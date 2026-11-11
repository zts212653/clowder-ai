/* 边界：引擎只放机制与时机，不认任何具体名字、不为单个位置打补丁 */
// 结构检查 pdl-schema 的一部分：主题的 PDL 数据（theme/<主题>/pdl/*.yaml）里每个块 / 控件只用 PDL_SCHEMA 声明过的属性，枚举属性只取声明的值。
// 用法：node engine/pdl-check.js（lint.py 调用；输出 JSON：{ count, problems }）
const fs = require('fs'), vm = require('vm'), path = require('path'), ROOT = path.join(__dirname, '..');
/* 源文件按层目录找：契约（PDL_SCHEMA、PDL_ROLES、PDL_POPUPS、ICON_RESERVED）在哪个文件里按定义找，不按文件名 */
const LAYERS = ['engine', 'platform', 'library', 'theme', 'app', 'mock', 'proto'];
function jsUnder(d) { const out = []; if (!fs.existsSync(d)) return out; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) out.push(...jsUnder(f)); else if (e.name.endsWith('.js') && !e.name.includes('.local.') && e.name !== 'pdl-check.js') out.push(f); } return out.sort(); }
const ALL = [].concat(...LAYERS.map(l => jsUnder(path.join(ROOT, l)))), rel = f => path.relative(ROOT, f), read = f => fs.readFileSync(f, 'utf8');
const NOCOPY = ALL.filter(f => !/\/copy\//.test(rel(f)));
function defOf(re) { for (const f of NOCOPY) { const m = read(f).match(re); if (m) return m; } return null; }
const ctx = { PDL_VIEWS: {}, PDL_ROWS: {}, PDL_NODES: {}, PDL_COMPONENTS: {}, PDL_FRAGS: {}, console };
vm.createContext(ctx);
const m = defOf(/const PDL_SCHEMA = \{[\s\S]*?\n\};\n/), mr = defOf(/const PDL_ROLES = \{[\s\S]*?\n\};\nfunction R\(k\) \{[^\n]*\n/);
vm.runInContext(mr[0].replace('const PDL_ROLES', 'this.PDL_ROLES').replace('function R(k)', 'this.R = function (k)'), ctx);   /* 角色变体：契约的变体枚举从这里来 */
vm.runInContext(m[0].replace('const PDL_SCHEMA', 'this.PDL_SCHEMA'), ctx);
/* 文案：视图里用 tr() 取的字在这里换成 't:键' 记号，这样能看出哪些字是文案键、哪些还是写死的字面量 */
vm.runInContext("this.I18N = {}; this.defineI18nPack = function (ns, p) { this.I18N[ns] = p; return p; }; this.tc = function (k) { return 't:' + k; };", ctx);
/* 主题的页面定义：每个主题的数据（构建从 pdl/*.yaml 合成的 pdl.js）里的视图、行模板、节点模板；片段引用（$frag）照加载时一样换成片段 */
ctx.pdlThemeLoad = function (pdl) {
  const expand = x => Array.isArray(x) ? x.map(expand) : !x || typeof x !== 'object' ? x : x.$frag ? expand(pdl.frags[x.$frag]) : Object.fromEntries(Object.entries(x).map(([k, v]) => [k, expand(v)]));
  ctx.PDL_POPUPS = Object.assign(ctx.PDL_POPUPS || {}, expand(pdl.popups || {}));
  Object.assign(ctx.PDL_VIEWS, expand(pdl.views || {})); Object.assign(ctx.PDL_ROWS, expand(pdl.rows || {})); Object.assign(ctx.PDL_NODES, expand(pdl.nodes || {}));
};
for (const f of ALL.filter(f => /^theme\/[^/]+\/pdl\.js$/.test(rel(f)))) vm.runInContext(read(f), ctx, { filename: rel(f) });
const S = ctx.PDL_SCHEMA, problems = [];
const isBind = v => typeof v === 'string' && /^[$@!{]/.test(v);
/* 行模板：layout 必填且是组件库的一种行布局；只用 _row 声明过的字段；这种布局不接受的字段（_rowNo）算失败 */
function rowCheck(r, where) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return;
  if (S._row.layout.indexOf(r.layout) < 0) { problems.push(where + ': 行模板的 layout = ' + JSON.stringify(r.layout) + ' 不是组件库的行布局'); return; }
  for (const k of Object.keys(r)) {
    if (!(k in S._row)) problems.push(where + ': 行模板的字段 ' + k + ' 没有声明');
    else if (S._rowNo[r.layout].indexOf(k) >= 0) problems.push(where + ': ' + r.layout + ' 布局不接受 ' + k);
  }
}
function walk(o, where) {
  if (Array.isArray(o)) return o.forEach((x, i) => walk(x, where));
  if (!o || typeof o !== 'object') return;
  if (o.type === 'list' && o.row && typeof o.row === 'object') rowCheck(o.row, where + ' list.row');
  if (o.type === 'list' && typeof o.row === 'string' && !ctx.PDL_ROWS[o.row]) problems.push(where + ': 行模板 ' + o.row + ' 不存在');
  if (typeof o.type === 'string' && S[o.type]) {
    const decl = S[o.type];
    for (const k of Object.keys(o)) {
      if (k === 'type') continue;
      if (!(k in decl) && !(k in S._node)) { problems.push(where + ': ' + o.type + '.' + k + ' 没有声明'); continue; }
      const d = k in decl ? decl[k] : S._node[k];
      if (Array.isArray(d) && !isBind(o[k]) && d.indexOf(String(o[k])) < 0 && !(d.indexOf('$') >= 0 && typeof o[k] !== 'string')) problems.push(where + ': ' + o.type + '.' + k + ' = ' + JSON.stringify(o[k]) + ' 不在声明的取值里');
    }
  } else if (typeof o.type === 'string' && o.type.length < 20 && /^[a-z]\w*$/.test(o.type)) problems.push(where + ': 块 / 控件 ' + o.type + ' 没有声明属性');
  else if (!o.type && 'variant' in o && ctx.PDL_ROLES.part.indexOf(o.variant) < 0) problems.push(where + ': 片段的 variant = ' + JSON.stringify(o.variant) + ' 不是片段的角色（PDL_ROLES.part）');
  for (const k of Object.keys(o)) walk(o[k], where);
}
/* 弹窗的声明（PDL_POPUPS）：只用 _popup 声明过的属性，枚举取声明的值（exit 的每一项都要在枚举里），at / exit / drag 必填 */
const pp = Object.keys(ctx.PDL_POPUPS || {}).length;   /* 主题数据里的弹窗声明（登记表在引擎） */
if (!pp) problems.push('找不到 PDL_POPUPS 的声明');
else {
  const D = S._popup;
  for (const [k, d] of Object.entries(ctx.PDL_POPUPS)) {
    for (const need of ['at', 'exit', 'drag']) if (!(need in d)) problems.push('popup ' + k + ': 缺少 ' + need);
    for (const [a, v] of Object.entries(d)) {
      if (!(a in D)) { problems.push('popup ' + k + '.' + a + ' 没有声明'); continue; }
      if (Array.isArray(D[a])) [].concat(v).forEach(x => { if (D[a].indexOf(String(x)) < 0) problems.push('popup ' + k + '.' + a + ' = ' + JSON.stringify(x) + ' 不在声明的取值里'); });
    }
  }
}
/* 给人看的字只能是文案键（'t:包.键'）或数据绑定：文字类属性里出现写死的中文就报错 */
const TEXT = new Set(['label', 'text', 'title', 'tip', 'placeholder', 'empty', 'help', 'sub', 'desc', 'aria']);
function walkText(o, where) {
  if (Array.isArray(o)) return o.forEach(x => walkText(x, where));
  if (!o || typeof o !== 'object') return;
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (TEXT.has(k) && typeof v === 'string' && /[\u3400-\u9fff]/.test(v) && !/^t:/.test(v)) problems.push(where + ': ' + k + ' 是写死的文字 ' + JSON.stringify(v.slice(0, 20)) + '（改成文案键 t:…）');
    else walkText(v, where);
  }
}
for (const [n, v] of Object.entries(ctx.PDL_VIEWS)) walkText(v, 'view ' + n);
for (const [n, v] of Object.entries(ctx.PDL_NODES)) walkText(v, 'node ' + n);
for (const [n, v] of Object.entries(ctx.PDL_ROWS)) walkText(v, 'row ' + n);
/* 对话框视图（dlg.*）上的 fields / doc / panes / foot / ack / sync 是引擎对话框的描述（字段的 type 是输入框类型，比如 number），不是 PDL 节点，不按块 / 控件查 */
const DLG_DESC = new Set(['fields', 'doc', 'panes', 'foot', 'ack', 'sync']);
for (const [n, v] of Object.entries(ctx.PDL_VIEWS)) walk(n.indexOf('dlg.') === 0 ? Object.fromEntries(Object.entries(v).filter(([k]) => !DLG_DESC.has(k))) : v, 'view ' + n);
for (const [n, v] of Object.entries(ctx.PDL_NODES)) walk(v, 'node ' + n);
for (const [n, v] of Object.entries(ctx.PDL_ROWS)) { rowCheck(v, 'row ' + n); walk(v, 'row ' + n); }
/* 操作引用：PDL 和视图模型里写死的 act 名必须是登记过的动作（A.x / Object.assign(A, {…}) / CHANGES / INPUTS / 组件库内置），否则按钮是哑的 */
const ACTS = new Set();
const srcs = NOCOPY.map(read);
for (const t of srcs) {
  for (const m of t.matchAll(/\b(?:A|CHANGES|INPUTS|MOCK_ACTS)\.(\w+)\s*=/g)) ACTS.add(m[1]);
  for (const blk of t.matchAll(/const (?:A|CHANGES|INPUTS|MOCK_ACTS) = \{([^\n]*)\};/g)) for (const m of blk[1].matchAll(/(?:^|,)\s*(\w+):/g)) ACTS.add(m[1]);
  for (const m of t.matchAll(/(?:\bA\[|\bCHANGES\[|\bINPUTS\[|\bMOCK_ACTS\[)'(\w+)'\]\s*=/g)) ACTS.add(m[1]);
  for (const blk of t.matchAll(/(?:Object\.assign\(\s*(?:A|CHANGES|INPUTS|MOCK_ACTS)\s*,|const (?:A|CHANGES|INPUTS|MOCK_ACTS) =)\s*\{([\s\S]*?)\n\}\)?;/g)) for (const m of blk[1].matchAll(/(?:^|\n)\s{2}(\w+):\s*(?:function|\w+\()/g)) ACTS.add(m[1]);
}
for (const t of srcs) for (const m of t.matchAll(/\b(?:act|change|input)\s*:\s*'(\w+)'/g)) if (!ACTS.has(m[1])) problems.push('act ' + m[1] + ' 没有登记成动作（按钮会是哑的）');
/* 图标按含义引用：保留字形（同一个字形只能表达一个含义）只能通过含义名用（frame.js 的 ICON_MEANING / ICON_RESERVED） */
const RES = JSON.parse((defOf(/const ICON_RESERVED = (\[[^\]]*\]);/) || [, '[]'])[1].replace(/'/g, '"'));
for (const t of srcs) for (const m of t.matchAll(/\bicon(?:\(|\s*:\s*)'([\w-]+)'/g)) if (RES.indexOf(m[1]) >= 0) problems.push('图标 ' + m[1] + ' 是保留字形，要用含义名（send / close / delete / prev / next / collapse…）');
/* 角色变体只来自契约：视图模型和组件代码里写死的 variant 也必须是登记过的角色，不能在数据里挑样子 */
const ROLE_NAMES = new Set([].concat.apply([], Object.keys(ctx.PDL_ROLES).map(k => ctx.PDL_ROLES[k])));
for (const f of NOCOPY.filter(f => !/^mock\//.test(rel(f)))) for (const mm of read(f).matchAll(/\bvariant: '([^']*)'/g)) if (!ROLE_NAMES.has(mm[1])) problems.push(rel(f) + ': variant ' + JSON.stringify(mm[1]) + ' 不是登记过的角色（PDL_ROLES）');
console.log(JSON.stringify({ count: problems.length, problems: problems.slice(0, 40), acts: ACTS.size }));
