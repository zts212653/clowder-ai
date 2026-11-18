/* 边界：一个含义一个组件、不为接口定制、不按位置推导样式 */
/* 插件框：iframe 的消息、生命周期、尺寸 */
'use strict';
/* 插件框：谁提供的在框的提示里，不写成框里的一句话 */
function frame(plugin, what, tall) { const d = WHO_DATA.plugins()[plugin]; return '<div class="frame' + (tall ? ' tall' : '') + '" data-tip="' + h(tc('frame.embeddedBy', d.name)) + '">' + icon(d.icon, 28) + '<b>' + h(what) + ('</b><span class="mono faint">plugin://') + plugin + '/' + (tall ? 'app' : 'settings') + '</span></div>'; }

/* 一次性发送：应用经引擎的既有登记点找指定的框；不保存消息，不在进树、重画或加载后重放。 */
ENGINE_PARTS.framePost = function (key, data) {
  const el = Array.from(document.querySelectorAll('iframe[data-frame-key]')).find(function (frame) { return frame.dataset.frameKey === key && !frame.closest('[inert]'); });
  if (!el) return false;
  el.contentWindow.postMessage(data, '*'); return true;
};

/* 独立 HTML 内容的通用数据绑定：属性变化只发消息，不重载 iframe。
   消息含义由内容与应用约定，组件不认识页面或业务阶段。 */
function frameMessage(el) {
  const value = el.getAttribute('data-frame-message');
  if (el._frameMessage === value) return;
  el.contentWindow.postMessage(JSON.parse(value), '*'); el._frameMessage = value;
}
function frameMessages() { document.querySelectorAll('iframe[data-frame-message]').forEach(frameMessage); }
onRender(frameMessages);
/* 框看不看得见（clowder-frame-lifecycle）：画完、页面显隐变化、框说 ready 时告诉有名字的框；没变不重发 */
function frameLifecycles(force) {
  document.querySelectorAll('iframe[data-frame-key]').forEach(function (f) {
    const v = !document.hidden && f.isConnected && !f.closest('[inert]');   /* 被盖住的层是 inert */
    if (!force && f._frameVisible === v) return;
    f._frameVisible = v; if (f.contentWindow) f.contentWindow.postMessage({ type: 'clowder-frame-lifecycle', visible: v }, '*');
  });
}
function frameVisibility() { frameLifecycles(false); }
onRender(frameVisibility);
document.addEventListener('visibilitychange', frameVisibility);
window.addEventListener('message', function (e) { if (e.data && e.data.type === 'clowder-frame-ready') frameLifecycles(true); });
/* 只认消息来自哪个框；消息协议与可信 origin 均交给应用动作。 */
window.addEventListener('message', function (e) {
  const el = Array.from(document.querySelectorAll('iframe[data-frame-on-message]')).find(function (frame) { return frame.contentWindow === e.source; });
  if (!el) return;
  const fn = actFn(el.dataset.frameOnMessage); if (fn) fn(e.data, el, e);
});
document.addEventListener('load', function (e) {
  if (e.target.matches && e.target.matches('iframe[data-frame-message]')) { e.target._frameMessage = null; frameMessage(e.target); }
}, true);

/* 沙箱只回报内容尺寸；父页按 source 找到自己的 iframe，不接受其他窗口的尺寸。 */
function frameSizeScript() {
  const report = function () {
    const body = document.body; let bottom = 0, seen = false;
    const include = function (rect) { if (rect.width > 0 || rect.height > 0) { seen = true; bottom = Math.max(bottom, rect.bottom + window.scrollY); } };
    body.querySelectorAll('*').forEach(function (el) { Array.from(el.getClientRects()).forEach(include); });
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT); let node;
    while ((node = walker.nextNode())) { if (!node.textContent.trim()) continue; const range = document.createRange(); range.selectNodeContents(node); Array.from(range.getClientRects()).forEach(include); range.detach(); }
    if (!seen) return;   /* 内容还没排版（层刚露出来）：不报，免得先报一个只有边距的高度再长回去 */
    /* 内容的后缘 + body / html 自己的下内边距、边框、外边距；只量内容不量盒子，所以 height:100% 的视口底不算进来，量出的高度也不随框当前的高度变 */
    [body, document.documentElement].forEach(function (el) { const style = getComputedStyle(el); ['paddingBottom', 'borderBottomWidth', 'marginBottom'].forEach(function (key) { bottom += Math.max(0, parseFloat(style[key]) || 0); }); });
    parent.postMessage({ type: 'clowder-frame-size', height: Math.max(1, Math.ceil(bottom)) }, '*');
  };
  const start = function () { const observer = new ResizeObserver(report); observer.observe(document.body); document.body.querySelectorAll('*').forEach(function (el) { observer.observe(el); }); window.addEventListener('load', report); report(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else start();
}
const FRAME_SIZE_PENDING = new Set(), FRAME_SIZE_HEIGHTS = new Map();
function frameSizeHold(el) {
  const src = el.getAttribute('srcdoc');
  if (el._frameSrc !== src) {
    if (el._frameSizeDone) el._frameSizeDone();
    el._frameSrc = src; el._frameSized = false; el._frameHeight = FRAME_SIZE_HEIGHTS.has(src) ? FRAME_SIZE_HEIGHTS.get(src) + 'px' : el._frameHeight; el._frameSizeDone = null;
  }
  if (el._frameHeight && el.style.height !== el._frameHeight) el.style.height = el._frameHeight;   /* 量过的高度进树时直接设上，不写进画出来的标记：重画时标记不变，节点和高度都留着 */
  if (el._frameSized || el._frameSizeDone || !el.offsetWidth) return;   /* 藏着的框（被切走的层里）不等：它报来的高度不算数，露出来时再量 */
  FRAME_SIZE_PENDING.add(el);
  /* 静止前等它报一次高度；框在报之前被切走（报来时不占位）、被移除（onRender 里释放），或者等满两个慢动效的时长，也算等完，不会一直卡着 */
  settleHold(new Promise(function (resolve) {
    const done = function () { if (el._frameSizeDone !== done) return; el._frameSizeDone = null; FRAME_SIZE_PENDING.delete(el); resolve(); };
    el._frameSizeDone = done; setTimeout(done, 2 * ms('--dur-slow'));
  }));
}
treeMatch('iframe[data-frame-size]', frameSizeHold);
window.addEventListener('message', function (e) {
  if (!e.data || e.data.type !== 'clowder-frame-size' || !Number.isFinite(e.data.height) || e.data.height < 1) return;   /* 量到 0 = 框里还没排版（框被收起时发出的），不是内容的高度 */
  const el = Array.from(document.querySelectorAll('iframe[data-frame-size]')).find(function (frame) { return frame.contentWindow === e.source; });
  if (!el) return;
  if (!el.offsetWidth) { if (el._frameSizeDone) el._frameSizeDone(); return; }   /* 框此刻不在页面上占位：高度不算数，但这次等待算结束 */
  const measured = Math.max(1, e.data.height), height = measured + 'px';
  FRAME_SIZE_HEIGHTS.set(el.getAttribute('srcdoc'), measured);
  if (el.style.height !== height) { el.style.height = height; settleHold(Promise.resolve()); }
  el._frameHeight = height; el._frameSized = true;
  if (el._frameSizeDone) { el._frameSizeDone(); el._frameSizeDone = null; FRAME_SIZE_PENDING.delete(el); }
});
/* HTML 作品请求跳转（cat-cafe:html-widget-navigation，v 1）：请求本身不跳。只认三种去处——本站某条对话里的某条消息、
   OpenStreetMap 上的一个地点、本机 127.0.0.1 上的页面（避开宿主自己的端口）；认得的弹一条提示，用户亲手点“打开”才打开 */
const WIDGET_NAV_RESERVED = [3001, 3002, 3003, 3004, 6397, 6398, 6399, 18888, 19999, 9876, 9877, 9878, 9879, 9880, 9881];
function widgetNavTarget(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\]/.test(value)) return null;
  let url; try { url = new URL(value, location.origin); } catch (e) { return null; }
  if (url.username || url.password || url.hash) return null;
  const q = Array.from(url.searchParams), port = Number(url.port), thread = /^\/thread\/(thread_[A-Za-z0-9_-]{1,193})$/.exec(url.pathname);
  if (value.indexOf('/thread/') === 0 && url.origin === location.origin && thread && q.length === 1 && (q[0][0] === 'message' || q[0][0] === 'messageId') && /^[A-Za-z0-9_-]{1,200}$/.test(q[0][1]))
    return { href: url.href, act: 'msgJump', data: { t: thread[1], mid: q[0][1] } };
  if (url.origin === 'https://www.openstreetmap.org' && /^\/(way|node|relation)\/\d+$/.test(url.pathname) && !q.length) return { href: url.href, act: 'openUrl', data: { url: url.href } };
  if (url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.pathname === '/' && port >= 1024 && port <= 65535 && WIDGET_NAV_RESERVED.indexOf(port) < 0 &&
    (!q.length || (q.length === 1 && q[0][0] === 'asset' && /^[a-f0-9]{64}$/.test(q[0][1])))) return { href: url.href, act: 'openUrl', data: { url: url.href } };
  return null;
}
window.addEventListener('message', function (e) {
  if (!e.data || e.data.type !== 'cat-cafe:html-widget-navigation' || e.data.v !== 1 || e.origin !== 'null') return;
  const el = Array.from(document.querySelectorAll('iframe.vw-widget[srcdoc]')).find(function (frame) { return frame.contentWindow === e.source; });
  const to = el && widgetNavTarget(e.data.href); if (!to) return;
  toast(tc('frame.widgetNav', to.href), { label: tc('common.open'), act: to.act, data: to.data });
  e.source.postMessage({ type: 'cat-cafe:html-widget-navigation-ready', v: 1 }, '*');
});
function frameSizePrune() {
  document.querySelectorAll('iframe[data-frame-size]').forEach(function (el) { frameSizeHold(el); if (el._frameHeight) el.style.height = el._frameHeight; });
  FRAME_SIZE_PENDING.forEach(function (el) { if (!el.isConnected) { el._frameSizeDone(); el._frameSizeDone = null; FRAME_SIZE_PENDING.delete(el); } });
}
onRender(frameSizePrune);
LOCAL_NORM.push(function (root) {
  (root.matches('iframe[data-frame-size]') ? [root] : Array.from(root.querySelectorAll('iframe[data-frame-size]'))).forEach(function (el) { el.style.removeProperty('height'); if (!el.getAttribute('style')) el.removeAttribute('style'); });
});
