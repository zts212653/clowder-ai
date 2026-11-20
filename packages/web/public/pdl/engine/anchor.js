/* 边界：引擎只放机制与时机，不认任何具体名字、不为单个位置打补丁 */
/* 锚点（引擎，唯一的锚定机制）：锚点名、浮层锚在哪、看不见的锚点（点击处 / 选区 / 光标）、右键找菜单的主人、重画后的检查。
   它是跨组件的机制，组件只引用锚点名。 */
'use strict';
/* ───────── 锚定（组件库，唯一的锚定机制）─────────
   浮层（菜单、输入框和对话页的弹出层、提示、待办、全部标签）贴着触发它的元素，由浏览器的 CSS 锚点定位排版：
   每个可能当触发元素的节点（ANCHOR_SEL：带动作、提示、入口、身份的元素）有且只有一个锚点名，从它在树里的身份推出——
   最近的带身份祖先（树键的那一段，nodeId）的锚点名 + 自己的签名（anchorSig：标签 + 稳定的 data-*）+ 同一作用域里同签名的第几个（从第 2 个起才写）——
   一路串上去就是树键，树键相同的两个节点也靠序号分开。
   名字写在 data-aname 上，一条通用规则（core.css [data-aname]）把它变成 anchor-name。节点进了树之后由唯一的观察者写上（字符串渲染器不知道祖先，
   身份要等节点进了树才算得出）：同一个节点重画出来名字不变，浮层不用事后接回；名字不属于哪个浮层，任意多个浮层可以同时锚在同一个元素上。
   浮层只引用触发元素的名字：position-anchor: var(--u-anchor)（弹窗写在外壳上，提示写在自己身上），放不下时 position-try-fallbacks 翻到另一边。
   不存坐标、不在滚动 / 改尺寸 / 重画时用 JS 重算位置。重画后这个名字一个元素都找不到了就调 gone（浮层收起），不会摆在旧坐标上。
   浮层一律 position-visibility: always：触发元素常常是悬停才露出的按钮（visibility: hidden），默认的 anchors-visible 会把浮层一起藏掉。 */
const ANCHOR_KEYS = ['data-spot', 'id', 'data-c', 'data-entry', 'data-act', 'data-hover', 'data-who', 'data-menu', 'data-k', 'data-for', 'data-pop', 'data-v', 'data-id', 'data-i', 'data-page', 'data-mid', 'data-tid'];
const ANCHOR_SEL = '[data-act], [data-hover], [data-tip], [data-spot], [data-entry], [data-okey], [data-view], [data-island], [data-k], [data-id], [data-mid], [id], [data-c]';
function anchorSig(el) {   /* 没有 data-* 身份时用第一个类名 */
  const ks = ANCHOR_KEYS.filter(function (k) { return el.hasAttribute(k); });
  return el.tagName.toLowerCase() + (ks.length ? ks.map(function (k) { return '[' + k + '=' + el.getAttribute(k) + ']'; }).join('') : el.classList[0] ? '.' + el.classList[0] : '');
}
/* 作用域：最近的带身份（nodeId，树键的一段）的祖先或容器（data-c：主窗口、工作台……）；没有就是整页。
   容器也是作用域：两个容器里签名相同的元素（主窗口页头的工作台入口、工作台头上的 +）名字不同，一个没了，另一个不会顶上它的名字（锚在前一个上的浮层关掉） */
function anchorIdent(n) { return nodeId(n) || (n.dataset && n.dataset.c && !n.dataset.act ? 'c:' + n.dataset.c : ''); }
function anchorScope(el) { for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) if (anchorIdent(n)) return n; return document.body; }
/* 身份的一段 → 名字里合法的字符（字母、数字、- 和非 ASCII 原样，其余写成 _十六进制_） */
function anchorEsc(key) { return key.replace(/[^a-zA-Z0-9\u0080-\uffff-]/g, function (c) { return '_' + c.charCodeAt(0).toString(16) + '_'; }); }
/* 作用域的名字：整页是 --a；带身份的祖先用它自己的锚点名（它在自己的作用域里已经排过第几个，树键相同的两个节点也分得开） */
function anchorBase(s) { return s === document.body ? '--a' : s.getAttribute('data-aname') || anchorOf(s); }
/* 给一批刚画出来的节点所在的作用域写名字：名字 = 作用域的名字 / 自己的签名，作用域里同签名的按文档顺序从第 2 个起加 ~序号；同样的结构总是同样的名字。
   作用域自己的名字变了（它前面多了一个同签名的），里面的成员跟着重写 */
function anchorStamp(nodes) {
  const scopes = new Set();
  nodes.forEach(function (n) {
    if (n.nodeType !== 1 || !n.isConnected) return;
    if (n.matches(ANCHOR_SEL)) scopes.add(anchorScope(n));
    n.querySelectorAll(ANCHOR_SEL).forEach(function (el) { scopes.add(anchorScope(el)); });
  });
  scopes.forEach(function (s) {
    if (!s.isConnected) return;
    const base = anchorBase(s), seen = {};
    s.querySelectorAll(ANCHOR_SEL).forEach(function (el) {
      if (anchorScope(el) !== s) return;
      const sig = anchorSig(el), i = seen[sig] = (seen[sig] || 0) + 1, name = base + '_2f_' + anchorEsc(sig + (i > 1 ? '~' + i : ''));
      if (el.getAttribute('data-aname') === name) return;
      el.setAttribute('data-aname', name);
      if (anchorIdent(el)) scopes.add(el);
    });
  });
}
/* 写名字只有一个钩子：挂在引擎的进树通知上（frame.js treeIn）——收到“加进来的子树”就给它们所在的作用域写名字（整页重画、弹窗局部更新、只重画一条消息、输入框孤岛、
   本地换掉的开关、终端屏幕、看不见的锚点……都一样，画的地方不用管）。同一轮里要按名字找元素的（anchorEl / anchorOf）先 treeFlush。只处理加进来的那块所在的作用域，不扫整页 */
treeIn(anchorStamp);
/* 元素的锚点名（没有就现在写上——不在 ANCHOR_SEL 里的元素重画后不会再有名字，锚在它上面的浮层会按 gone 收起） */
function anchorOf(el) {
  if (!el) return null;
  treeFlush();
  if (!el.hasAttribute('data-aname')) { if (el.matches(ANCHOR_SEL)) anchorStamp([el]); else el.setAttribute('data-aname', anchorBase(anchorScope(el)) + '_2f_' + anchorEsc(anchorSig(el))); }
  return el.getAttribute('data-aname');
}
function anchorEl(name) { treeFlush(); return name ? document.querySelector('[data-aname="' + CSS.escape(name) + '"]') : null; }
/* 哪个浮层锚在哪个名字上（不是给浮层起名字：名字是触发元素的）：浮层 → { name, gone } */
const ANCHORED = {};
/* 锚在一个没有身份的元素上（比如输入框的外框）：它重画后认不出来，就在它身上放一个同样大小的看不见的锚点，跟着这个浮层走 */
function anchorTo(k, el, gone) {
  if (!el) { delete ANCHORED[k]; return null; }
  if (!el.matches(ANCHOR_SEL)) { const r = el.getBoundingClientRect(); el = spotAt(k, el, r) || el; if (SPOTS[k]) SPOTS[k].pop = k; }
  ANCHORED[k] = { name: anchorOf(el), gone: gone };
  return ANCHORED[k].name;
}
/* ───────── 看不见的锚点（唯一的一处） ─────────
   触发浮层的不是元素时——点击处（右键）、选中的文字、光标——在它所在的容器里放一个看不见的元素（.anchor-spot），
   打开浮层的动作把它当触发元素用（锚定、弹窗的主人和触发元素都是它），和锚在元素上没有区别。
   位置是相对所在容器的偏移（spotAt 量一次：那一处的矩形 − 容器的矩形），不是页面坐标；容器滚动时跟着走。
   重画把它冲掉了，anchorCheck 先按记下的偏移放回去；打开它的弹窗关了（或者一直没有弹窗用它），就拿掉 */
const SPOTS = {};   /* 名字（point / selection / caret）→ { host: 容器的位置, dx, dy, w, h, pop: 用它的弹窗, idle } */
/* 容器的位置 = 最近的有锚点名的祖先（含自己）的名字 + 从它往下的子元素序号：重画出同样的结构就找回同一个容器 */
function spotHostKey(host) {
  const path = []; let n = host;
  for (; n && n !== document.body && !n.matches(ANCHOR_SEL); n = n.parentElement) path.unshift(Array.prototype.indexOf.call(n.parentElement.children, n));
  return { base: n && n !== document.body ? anchorOf(n) : null, path: path };
}
function spotHost(k) { let n = k.base ? anchorEl(k.base) : document.body; for (let i = 0; n && i < k.path.length; i++) n = n.children[k.path[i]]; return n || null; }
function spotAt(name, host, r) {
  const hr = host.getBoundingClientRect(), old = SPOTS[name];
  SPOTS[name] = { host: spotHostKey(host), dx: r.left - hr.left, dy: r.top - hr.top, w: Math.max(1, r.width || 0), h: Math.max(1, r.height || 0), pop: old && old.pop, idle: 0 };
  return spotPut(name);
}
function spotPut(name) {
  const s = SPOTS[name], host = s && spotHost(s.host); if (!host) return null;
  document.querySelectorAll('[data-spot="' + name + '"]').forEach(function (x) { if (x.parentElement !== host) x.remove(); });
  let el = host.querySelector(':scope > [data-spot="' + name + '"]');
  if (!el) { el = document.createElement('span'); el.className = 'anchor-spot'; el.dataset.spot = name; el.setAttribute('aria-hidden', 'true'); host.appendChild(el); }
  el.style.setProperty('--u-sw', s.w + 'px'); el.style.setProperty('--u-sh', s.h + 'px');
  el.style.setProperty('--u-dx', '0px'); el.style.setProperty('--u-dy', '0px');
  const at = el.getBoundingClientRect(), hr = host.getBoundingClientRect();   /* 先放在定位容器的原点，读出差值：偏移只相对容器 */
  el.style.setProperty('--u-dx', (hr.left + s.dx - at.left) + 'px'); el.style.setProperty('--u-dy', (hr.top + s.dy - at.top) + 'px');
  return el;
}
/* 用看不见的锚点打开一个浮层：open(锚点) 里执行打开的动作；这次动作的触发元素就是锚点 */
function spotOpen(name, host, r, open) {
  const el = spotAt(name, host, r); if (!el) return;
  const prev = ACT_FROM; ACT_FROM = el;
  try { open(el); } finally { ACT_FROM = prev; }
  const s = SPOTS[name]; if (s && !s.pop && S.popOrder.length) s.pop = S.popOrder[S.popOrder.length - 1];   /* 已经开着的弹窗换了内容：用它的就是最上面那个 */
}
/* 重画后：放回被冲掉的锚点；没有打开着的弹窗用它就拿掉 */
function spotSync() {
  Object.keys(SPOTS).forEach(function (name) {
    const s = SPOTS[name];
    if (s.pop ? S.popOrder.indexOf(s.pop) < 0 : s.idle++ > 1) { delete SPOTS[name]; document.querySelectorAll('[data-spot="' + name + '"]').forEach(function (x) { x.remove(); }); return; }
    if (!document.querySelector('[data-spot="' + name + '"]')) spotPut(name);
  });
}
/* 光标的矩形（输入框里打字时的候选）：用一个同样排版的影子量出光标相对输入框的位置 */
function caretRect(ta) {
  const cs = getComputedStyle(ta), m = document.createElement('div'), mark = document.createElement('span');
  ['boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderStyle', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight', 'textTransform', 'wordSpacing', 'tabSize'].forEach(function (k) { m.style[k] = cs[k]; });
  m.style.position = 'fixed'; m.style.visibility = 'hidden'; m.style.whiteSpace = 'pre-wrap'; m.style.overflowWrap = 'break-word';
  m.textContent = ta.value.slice(0, ta.selectionStart || 0); mark.textContent = '\u200b'; m.appendChild(mark); document.body.appendChild(m);
  const mr = m.getBoundingClientRect(), kr = mark.getBoundingClientRect(), tr = ta.getBoundingClientRect(); m.remove();
  return { left: tr.left + kr.left - mr.left - ta.scrollLeft, top: tr.top + kr.top - mr.top - ta.scrollTop, width: 1, height: kr.height };
}
/* 右键：PDL 里声明了 ⋯ 菜单的节点（type: more / prop: menu，见 PDL_POPUPS.menu.via）画出来的元素带 data-menu-decl（渲染器写，MENU_DECL）。
   从点到的地方往上找，第一个装着 ⋯ 的祖先就是菜单的主人：只装着一个时，在点击处（看不见的锚点）打开同一个菜单；装着好几个（分不清是谁的）、
   或者点在可编辑的地方，就不管，交给浏览器。覆盖浏览器的右键菜单是有意的（应用也作为安装的客户端发布） */
document.addEventListener('contextmenu', function (e) {
  const t = e.target; if (!t.closest || t.closest('input, textarea, [contenteditable]')) return;
  for (let n = t; n && n !== document.documentElement; n = n.parentElement) {
    const ds = n.matches('[data-menu-decl]') ? [n] : n.querySelectorAll('[data-menu-decl]');
    if (!ds.length) continue;
    if (ds.length > 1) return;
    const more = ds[0]; e.preventDefault();
    spotOpen('point', n, { left: e.clientX, top: e.clientY, width: 1, height: 1 }, function (spot) { A.menu(actionArgs(more), spot); });
    return;
  }
});
/* 重画后：先放回被冲掉的看不见的锚点；浮层锚着的名字找不到元素了 → 收起浮层 */
function anchorCheck() {
  spotSync();
  Object.keys(ANCHORED).forEach(function (k) {
    const a = ANCHORED[k]; if (!a || anchorEl(a.name)) return;
    delete ANCHORED[k]; if (a.gone) a.gone();
  });
}
onRender(anchorCheck);   /* 整页重画后；只重画一条消息（streamPatch）时它自己调 */
