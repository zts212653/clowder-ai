/* 边界：引擎只放机制与时机，不认任何具体名字、不为单个位置打补丁 */
/* 文案：界面上所有给人看的字都在主题的 i18n 文件里（theme/<主题>/i18n/<语言>/<区域>.json，构建时合成加载脚本 i18n.js，全量加载）。
   每个文件的形状：{ 包: { 键: 文字 } }（包名在所有文件里唯一），可以分组嵌套；带数字、名字的句子写占位 {0}、{1}…（按参数的顺序）；枚举的显示文字以枚举值作下一级键（取用 tcOf）。
   中文是形状，en 同键、同占位；某个键缺了当前语言就退回 zh。
   取用：tc('包.键', 参数…)；PDL 里写 't:包.键'（或 { t: '包.键', args: ['$.n'] }），引擎在取值时换成当前语言的文字。
   运行时登记的文案（插件带来的）用 defineI18nPack(包, { zh, en })，和文件里的包合在一起。
   不进文案的：人和猫写的内容、文件内容、真实 id、模型和工具名（这些是数据）。 */
'use strict';
const I18N = {};
function defineI18nPack(ns, packs) {   /* 同一个包可以分几处定义（视图文案、视图模型文案），按语言合并 */
  const cur = I18N[ns] || (I18N[ns] = {});
  Object.keys(packs).forEach(function (l) { cur[l] = i18nMerge(cur[l] || {}, packs[l]); });
  return cur;
}
/* 主题的 i18n 文件：一种语言一棵树，按包合进 I18N */
function defineI18n(lang, tree) { Object.keys(tree).forEach(function (ns) { const cur = I18N[ns] || (I18N[ns] = {}); cur[lang] = i18nMerge(cur[lang] || {}, tree[ns]); }); }
/* 同一个包分几处定义时逐层合并（同名分组里的键合在一起，不互相覆盖） */
function i18nMerge(a, b) { Object.keys(b).forEach(function (k) { const x = a[k], y = b[k]; a[k] = x && y && typeof x === 'object' && typeof y === 'object' ? i18nMerge(x, y) : y; }); return a; }
function i18nLang() { try { return (S && S.lang) || 'zh'; } catch (e) { return 'zh'; } }   /* 加载早期（S 还没建好）就用 zh */
function i18nLeaf(pack, path) { return path.split('.').reduce(function (o, k) { return o == null ? o : o[k]; }, pack); }
function tc(key) {
  const i = key.indexOf('.'), pack = I18N[key.slice(0, i)], path = key.slice(i + 1);
  if (!pack) return key;
  let leaf = i18nLeaf(pack[i18nLang()] || {}, path);
  if (leaf == null) leaf = i18nLeaf(pack.zh || {}, path);
  if (typeof leaf === 'function') return leaf.apply(null, Array.prototype.slice.call(arguments, 1));
  if (leaf == null) return key;
  let args = Array.prototype.slice.call(arguments, 1);
  if (leaf && typeof leaf === 'object' && args.length) { const v = leaf[String(args[0])]; if (v == null) return String(args[0]); leaf = v; args = args.slice(1); }   /* 枚举：第一个参数按值取下一级，其余参数填占位；没有这个值就显示值本身 */
  return typeof leaf === 'string' && args.length ? leaf.replace(/\{(\d+)\}/g, function (m, i) { const v = args[+i]; return v == null ? '' : String(v); }) : leaf;
}
/* 枚举的显示文字：tcOf('包.分组', 枚举值)——分组键是静态的（可检查），枚举值来自数据 */
function tcOf(key, code) { return tc(key + '.' + code); }
/* 状态这类按数据取键的字：键不存在时用兜底键 */
function tcOr(key, fallback) { const v = tc(key); return v === key ? tc(fallback) : v; }
