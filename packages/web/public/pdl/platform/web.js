/* 平台适配 · 网页：平台的能力（剪贴板、下载、选文件、通知、窗口、主题包 YAML 的读写）由这一层接到引擎的平台口上（engine/platform.js 的 platformProvide）。
   安装包（桌面）只换这一层。网页里能力条件 app.desktop 决定是否出现桌面版的部分（系统配置里的“桌面更新”一节）。 */
'use strict';
WHEN['app.desktop'] = function () { return true; };
/* 用户素材独立保存，个人外观偏好只保存素材 id；完整图片不进入 CSS 变量或 localStorage。 */
let assetDb;
function webAssetDb() {
  if (!assetDb) assetDb = new Promise(function (resolve, reject) {
    const r = indexedDB.open('clowder-assets', 1);
    r.onupgradeneeded = function () { r.result.createObjectStore('assets'); };
    r.onsuccess = function () { resolve(r.result); };
    r.onerror = function () { reject(r.error); assetDb = null; };
  });
  return assetDb;
}
async function webAsset(id, value) {
  const db = await webAssetDb();
  return new Promise(function (resolve, reject) {
    const tx = db.transaction('assets', value === undefined ? 'readonly' : 'readwrite'), st = tx.objectStore('assets');
    const r = value === undefined ? st.get(id) : st.put(value, id);
    tx.oncomplete = function () { resolve(r.result); };
    tx.onabort = tx.onerror = function () { reject(tx.error); };
  });
}
const WEB_ASSETS = {};
async function webAssetGet(id) {
  if (WEB_ASSETS[id]) return WEB_ASSETS[id];
  const stored = await webAsset(id); if (!stored) return;
  const data = typeof stored.src === 'string' ? await fetch(stored.src).then(function (r) { return r.blob(); }) : stored.src;   /* 存 Blob；data URL 先转成 Blob——完整图片不能进 CSS 变量 */
  return WEB_ASSETS[id] = Object.assign({}, stored, { src: URL.createObjectURL(data) });
}
async function webAssetPut(id, value) {
  const data = await fetch(value.src).then(function (r) { return r.blob(); });
  await webAsset(id, Object.assign({}, value, { src: data }));   /* 直接存 Blob（不转 base64：小三分之一，读的时候也不用再解码） */
  if (WEB_ASSETS[id]) URL.revokeObjectURL(WEB_ASSETS[id].src);
  return WEB_ASSETS[id] = Object.assign({}, value, { src: URL.createObjectURL(data) });
}
async function webAssetRemove(id) {
  const db = await webAssetDb();
  await new Promise(function (resolve, reject) { const tx = db.transaction('assets', 'readwrite'); tx.objectStore('assets').delete(id); tx.oncomplete = resolve; tx.onabort = tx.onerror = function () { reject(tx.error); }; });
  if (WEB_ASSETS[id]) URL.revokeObjectURL(WEB_ASSETS[id].src);
  delete WEB_ASSETS[id];
}
/* 正文里的公式（KaTeX）和 Mermaid 图：第一次用到时加载 */
let webKatex = null, webMermaid = null, webMermaidN = 0;
function webRichRender(kind, src, inline) {
  if (kind === 'math') {
    webKatex = webKatex || import('https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.mjs').then(function (m) { return m.default; });
    return webKatex.then(function (k) { return k.renderToString(src, { displayMode: !inline, throwOnError: true, output: 'mathml' })   /* 只出 MathML：浏览器原生画公式，不用额外样式和字体 */; });
  }
  webMermaid = webMermaid || import('https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs').then(function (m) { m.default.initialize({ startOnLoad: false, theme: document.documentElement.dataset.mode === 'dark' ? 'dark' : 'neutral' }); return m.default; });
  return webMermaid.then(function (m) { return m.render('md-mermaid-' + (++webMermaidN), src); }).then(function (r) { return r.svg; });
}
/* 终端：xterm（第一次用到时加载，连同它自己的样式） */
let webXterm = null;
function webTerminal(el, o) {
  webXterm = webXterm || Promise.all([import('https://cdn.jsdelivr.net/npm/@xterm/xterm@6.0.0/lib/xterm.mjs'), import('https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.11.0/lib/addon-fit.mjs'), new Promise(function (resolve) { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = 'https://cdn.jsdelivr.net/npm/@xterm/xterm@6.0.0/css/xterm.css'; l.onload = l.onerror = resolve; document.head.appendChild(l); })]);
  return webXterm.then(function (m) {
    const term = new m[0].Terminal(o), fit = new m[1].FitAddon(); term.loadAddon(fit); term.open(el);
    return { write: function (d) { term.write(d); }, reset: function () { term.reset(); }, set: function (x) { Object.assign(term.options, x); }, fit: function () { fit.fit(); },
      onData: function (fn) { term.onData(fn); }, onResize: function (fn) { term.onResize(fn); }, dispose: function () { term.dispose(); } };
  });
}
/* 主题包的清单（theme.yaml）：YAML 只在这一层读写（第一次用到时加载 yaml），引擎只拿到对象 */
let webYaml = null;
function webYamlLib() { return webYaml = webYaml || import('https://cdn.jsdelivr.net/npm/yaml@2.8.2/browser/index.js'); }
/* 主题包是一个 zip：theme.yaml（身份、uses、pdl）+ components/<组件包>/*.js|css + i18n/<语言>/*.json + assets/<素材 id>.<扩展名>；
   解开后交给引擎的是一个对象（组件包、文案、素材挂在包上；自定义主题挂在它附带的 bundle 上），zip 只在平台层 */
let webZip = null;
function webZipLib() { return webZip = webZip || import('https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js'); }
const PACK_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml', woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf' };
function webPackRead(file) {
  return Promise.all([webYamlLib(), webZipLib(), file.arrayBuffer()]).then(function (r) {
    const Z = r[1], files = Z.unzipSync(new Uint8Array(r[2])), text = function (n) { return Z.strFromU8(files[n]); };
    const o = r[0].parse(text('theme.yaml')), comps = {}, i18n = {}, assets = {};
    Object.keys(files).sort().forEach(function (n) {
      let m = /^components\/([^/]+)\/[^/]+\.(js|css)$/.exec(n); if (m) { (comps[m[1]] = comps[m[1]] || { js: [], css: [] })[m[2]].push(text(n)); return; }
      m = /^i18n\/([^/]+)\/[^/]+\.json$/.exec(n); if (m) { i18n[m[1]] = Object.assign(i18n[m[1]] || {}, JSON.parse(text(n))); return; }
      m = /^assets\/(.+)\.(\w+)$/.exec(n); if (m && PACK_MIME[m[2]]) assets[m[1]] = { type: /^font/.test(PACK_MIME[m[2]]) ? 'font' : 'image', mime: PACK_MIME[m[2]], src: 'data:' + PACK_MIME[m[2]] + ';base64,' + btoa(Z.strFromU8(files[n], true)) };
    });
    const pack = o.pdl && o.pdl.doc ? o.bundle : o;   /* 自定义主题：组件、文案、素材属于它附带的主题包 */
    if (pack) Object.assign(pack, Object.keys(comps).length ? { components: comps } : {}, Object.keys(i18n).length ? { i18n: i18n } : {}, Object.keys(assets).length ? { assets: assets } : {});
    return o;
  });
}
function webPackSave(name, pack) {
  return Promise.all([webYamlLib(), webZipLib()]).then(function (r) {
    const Z = r[1], o = JSON.parse(JSON.stringify(pack)), p = o.pdl && o.pdl.doc ? o.bundle : o, files = {};
    if (p) {
      Object.keys(p.components || {}).forEach(function (u) { ['js', 'css'].forEach(function (x) { p.components[u][x].forEach(function (src, i) { files['components/' + u + '/' + String(i).padStart(2, '0') + '.' + x] = Z.strToU8(src); }); }); });
      Object.keys(p.i18n || {}).forEach(function (l) { files['i18n/' + l + '/text.json'] = Z.strToU8(JSON.stringify(p.i18n[l], null, 1)); });
      Object.keys(p.assets || {}).forEach(function (id) { const a = p.assets[id], ext = Object.keys(PACK_MIME).find(function (k) { return PACK_MIME[k] === a.mime; }); files['assets/' + id + '.' + ext] = Z.strToU8(atob(a.src.split(',')[1]), true); });
      delete p.components; delete p.i18n; delete p.assets;
    }
    files['theme.yaml'] = Z.strToU8(r[0].stringify(o));
    PLATFORM.download(name, { url: URL.createObjectURL(new Blob([Z.zipSync(files)], { type: 'application/zip' })) });
  });
}
platformProvide({
  richRender: webRichRender,
  packRead: webPackRead,
  packSave: webPackSave,
  terminal: webTerminal,
  assets: { get: webAssetGet, put: webAssetPut, remove: webAssetRemove },
  clipboard: function (text) { try { navigator.clipboard.writeText(text); } catch (e) { /* 剪贴板不可用时忽略 */ } },
  /* PNG 图片（base64）写进剪贴板：内容来自插件面板，这里校验一次（PNG、不超过 8 MB） */
  clipboardImage: function (base64) {
    const bytes = /^[A-Za-z0-9+/]*={0,2}$/.test(base64 || '') ? Uint8Array.from(atob(base64), function (c) { return c.charCodeAt(0); }) : new Uint8Array(0);
    if (bytes.length > 8000000 || ![137, 80, 78, 71, 13, 10, 26, 10].every(function (v, i) { return bytes[i] === v; })) return Promise.reject(new Error(tc('platform.clipboardImage.invalid')));
    return navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })]);
  },
  download: function (name, text, type) { try { const a = document.createElement('a'); a.href = typeof text === 'object' ? text.url : URL.createObjectURL(new Blob([text], { type: type || 'text/plain' })); a.download = name; document.body.appendChild(a); a.click(); a.remove(); } catch (e) { /* 下载不可用时忽略 */ } },
  pickFiles: function (accept, fn) { const i = document.createElement('input'); i.type = 'file'; i.multiple = true; if (accept) i.accept = accept; i.addEventListener('change', function () { if (i.files && i.files.length) fn(Array.from(i.files)); }); i.click(); },
  pickFile: function (accept, fn) { const i = document.createElement('input'); i.type = 'file'; if (accept) i.accept = accept; i.addEventListener('change', function () { if (i.files && i.files[0]) fn(i.files[0]); }); i.click(); },
  notify: function (title, body) { try { if (typeof Notification !== 'undefined' && Notification.permission === 'granted') new Notification(title, { body: body }); } catch (e) { /* 通知不可用时忽略 */ } },
  window: function () { /* 网页里没有窗口控制 */ }
});
