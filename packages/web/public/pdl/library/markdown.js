/* 边界：一个含义一个组件、不为接口定制、不按位置推导样式 */
/* Markdown 正文：行内与块的渲染、链接、引用标记、批注 */
'use strict';
function mdUnesc(x) { return String(x).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&'); }
function mdRef(ref) { const u = mdUnesc(ref), r = MD_REF.resolve ? MD_REF.resolve(u, mdLinkTarget(u)) : null; return r ? refChip(r) : ''; }   /* 链接的种类由 Markdown 组件认（mdLinkTarget），解析钩子只拿结果 */
function refChip(r) {
  const t = PDL_FRAGS.refChip, act = pv(t.act, r, r);
  return '<button type="button" class="ref-chip"' + toneAttr(pv(t.tone, r, r)) + (act ? ' data-act="' + act + '"' + argAttrs(pvDeep(t.args, r, r)) : ' disabled') + ' data-tip="' + pvText(t.tip, r, r) + '">' + icon(pv(t.icon, r, r), 13) + '<span class="ref-n">' + pvParts(t.name, r, r) + '</span></button>';
}
function mdInline(t) {
  const keep = [], ph = function (x) { keep.push(x); return '\u0000' + (keep.length - 1) + '\u0000'; };
  let s = h(t).replace(/`([^`]+)`/g, function (m, c) { return ph(mdRef(c) || '<code>' + c + '</code>'); });
  s = s.replace(/(^|[^\w$])\$([^\s$](?:[^$]*?[^\s$])?)\$(?![\w$])/g, function (m, p, c) { return p + ph(mdRich('math', mdUnesc(c), true)); });   /* 行内公式 $…$（不跨行；$5 这类价格不是公式：结尾不能紧跟空格或字母） */
  s = mdLinks(s, ph);
  s = s.replace(/\*\*([^*]+?)\*\*/g, '<b>$1</b>').replace(/(^|[^\w])__([^_]+?)__(?!\w)/g, '$1<b>$2</b>')
    .replace(/(^|[^\w*])\*(?![\s*])([^*]+?)\*(?![\w*])/g, '$1<i>$2</i>').replace(/(^|[^\w])_(?![\s_])([^_]+?)_(?!\w)/g, '$1<i>$2</i>');
  s = s.replace(/(^|[^\w@])(@[\w\u4e00-\u9fff-]+)/g, function (m, p, hd) { return WHO_DATA.handleId(hd) ? p + '<span class="mention">' + hd + '</span>' : m; });
  return s.replace(/\u0000(\d+)\u0000/g, function (m, i) { return keep[+i]; });
}
/* 链接 [文字](地址)：地址按括号配对扫描（路径里可以有括号，可以带 :行号）。
   http(s) 在外部打开；thread:id 跳到对话；file:路径、绝对 / 相对路径（/ ./ ../ ~/ 或带扩展名）打开文件预览；其它保持原文 */
function mdLinkTarget(u) {
  const m = /^(file|thread):(.+)$/.exec(u);
  if (m) return { k: m[1], v: m[2] };
  if (/^https?:\/\//.test(u)) return { k: 'url', v: u };
  if (/^(\/|\.{1,2}\/|~\/)/.test(u) || /^[\w.@-]+(\/[\w.@()-]+)*\.\w+(:\d+(-\d+)?)?$/.test(u)) return { k: 'file', v: u };
  return null;
}

function mdLinks(s, ph) {
  let out = '', i = 0;
  while (i < s.length) {
    const a = s.indexOf('[', i); if (a < 0) break;
    const b = s.indexOf('](', a); if (b < 0) break;
    const tx = s.slice(a + 1, b);
    if (tx.indexOf('[') >= 0 || tx.indexOf('\n') >= 0 || !tx) { out += s.slice(i, a + 1); i = a + 1; continue; }
    let d = 1, j = b + 2;
    for (; j < s.length && d; j++) { const c = s[j]; if (c === '(') d++; else if (c === ')') d--; else if (c === ' ' || c === '\n') break; }
    const url = d ? null : s.slice(b + 2, j - 1), t = url && mdLinkTarget(url.replace(/&amp;/g, '&'));
    if (!t) { out += s.slice(i, a + 1); i = a + 1; continue; }
    out += s.slice(i, a);
    const chip = mdRef(url); if (chip) { out += ph(chip); i = j; continue; }
    out += t.k === 'url' ? ph('<a class="md-ext" href="' + url + '" target="_blank" rel="noopener noreferrer">') + tx + ph('</a>')
      : ph(t.k === 'file' ? '<button type="button" class="cafe-link" data-act="fileOpen" data-v="' + t.v + '" data-tip="' + t.v + '">' : '<button type="button" class="cafe-link mono" data-act="thread" data-id="' + t.v + '">') + tx + ph('</button>');
    i = j;
  }
  return out + s.slice(i);
}
/* 块级：front matter、标题、段落、列表（有序 / 无序，行内格式照常）、``` 代码块、表格、引用、分隔线 */
/* 正文里的批注：文字范围和气泡共用一份声明，不改变原来的段落结构。 */
function annotationHtml(html, annotations, markdown) {
  if (!annotations.length) return html;
  const root = document.createElement('div'); root.innerHTML = html;
  annotations.forEach(function (a) {
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: function (n) { return n.parentElement.closest('button') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; } }), nodes = [];
    let n, text = '';
    while ((n = walk.nextNode())) { nodes.push({ node: n, from: text.length, to: text.length + n.length }); text += n.data; }
    const positions = []; let compact = '';
    for (let i = 0; i < text.length; i++) if (!/\s/.test(text[i])) { positions.push(i); compact += text[i]; }
    const quote = document.createElement('div'); quote.innerHTML = markdown ? mdLite(a.quote) : h(a.quote);
    const needle = quote.textContent.replace(/\s/g, ''), at = compact.indexOf(needle);
    if (at < 0) return;
    const from = positions[at], to = positions[at + needle.length - 1] + 1; let last;
    nodes.forEach(function (s) {
      if (s.to <= from || s.from >= to) return;
      const r = document.createRange(), mark = document.createElement('mark'); mark.className = 'annotation-quote';
      r.setStart(s.node, Math.max(0, from - s.from)); r.setEnd(s.node, Math.min(s.node.length, to - s.from)); r.surroundContents(mark); last = mark;
    });
    last.insertAdjacentHTML('afterend', btn(a.speaking ? tc('frame.speak') : a.label, { iconOnly: true, icon: 'chat', sm: true, cls: 'annotation-mark', data: a.open ? actAttrs(a.open.act, a.open.args) : '' }));
  });
  return root.innerHTML;
}
function mdLite(src) {
  let fm = '', body = String(src == null ? '' : src);
  if (!body.trim()) return '';   /* 没有正文就什么都不画（调用方据此不画空的正文块） */
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(body);
  if (m) { fm = '<pre class="cap-fm mono">' + h(m[1]) + '</pre>'; body = body.slice(m[0].length); }
  const out = []; let list = null, ord = false, code = null, table = null, math = null;
  const flush = function () {
    if (list) { out.push((ord ? '<ol>' : '<ul>') + list.join('') + (ord ? '</ol>' : '</ul>')); list = null; }
    if (table) { const cells = function (r) { return r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(function (c) { return c.trim(); }); }, rows = table.filter(function (r) { return !/^\s*\|?\s*:?-{2,}/.test(r); });
      out.push('<table><thead><tr>' + cells(rows[0]).map(function (c) { return '<th>' + mdInline(c) + '</th>'; }).join('') + '</tr></thead><tbody>' + rows.slice(1).map(function (r) { return '<tr>' + cells(r).map(function (c) { return '<td>' + mdInline(c) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table>'); table = null; }
  };
  body.split('\n').forEach(function (line) {
    if (math) { if (/^\s*\$\$\s*$/.test(line)) { out.push(mdRich('math', math.join('\n'))); math = null; } else math.push(line); return; }
    if (/^\s*\$\$\s*$/.test(line)) { flush(); math = []; return; }   /* 块公式：$$ 单独成行开始、结束 */
    if (code) { if (/^\s*```/.test(line)) { out.push(code.lang === 'mermaid' ? mdRich('mermaid', code.join('\n')) : '<pre><code>' + mdCode(code.join('\n'), code.lang) + '</code></pre>'); code = null; } else code.push(line); return; }
    if (/^\s*```/.test(line)) { flush(); code = []; code.lang = line.replace(/^\s*```/, '').trim(); return; }
    if (/^\s*\|.*\|\s*$/.test(line)) { if (list) { const t = table; table = null; flush(); table = t; } table = table || []; table.push(line); return; }
    const li = /^\s*(-|\*|\d+\.) (.*)$/.exec(line);
    if (li) { if (table) flush(); const o = /\d/.test(li[1]); if (list && o !== ord) flush(); ord = o; list = list || []; list.push('<li>' + mdInline(li[2]) + '</li>'); return; }
    flush();
    if (/^#{1,6} /.test(line)) out.push('<h4>' + mdInline(line.replace(/^#+ /, '')) + '</h4>');
    else if (/^\s*> ?/.test(line)) out.push('<blockquote>' + mdInline(line.replace(/^\s*> ?/, '')) + '</blockquote>');
    else if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) out.push('<div class="divider" role="separator"></div>');
    else if (line.trim()) out.push('<p>' + mdInline(line) + '</p>');
  });
  if (code) out.push('<pre><code>' + h(code.join('\n')) + '</code></pre>');
  if (math) out.push(mdRich('math', math.join('\n')));
  flush();
  return fm + '<div class="md">' + out.join('') + '</div>';
}

/* 正文里的公式和 Mermaid 图（同一个正文组件）：组件只认语法；真正的绘制交给平台层 PLATFORM.richRender(kind, src, inline) → Promise<html>
   （网页版按需加载渲染库）。画好的结果按源文本缓存：重画时直接放进去，不闪；还没画好或画不了时显示源文本 */
const MD_RICH = {};
function mdRich(kind, src, inline) {
  const k = kind + (inline ? ':i:' : ':b:') + src, done = MD_RICH[k], tag = inline ? 'span' : 'div';
  return '<' + tag + ' class="md-rich" data-rich="' + kind + '"' + (inline ? ' data-inline' : '') + ' data-src="' + h(src) + '"' + (done ? ' data-done' : '') + '>' + (done || (inline ? '<code>' + h(src) + '</code>' : '<pre><code>' + h(src) + '</code></pre>')) + '</' + tag + '>';
}
treeIn(function (ns) {   /* 进树就画（整页重画、只重画一条消息、弹窗局部更新都一样） */
  ns.forEach(function (n) { (n.matches('.md-rich') ? [n] : Array.prototype.slice.call(n.querySelectorAll('.md-rich'))).filter(function (el) { return !el.hasAttribute('data-done') && !el.hasAttribute('data-busy'); }).forEach(function (el) {
    const kind = el.dataset.rich, src = el.dataset.src, inline = el.hasAttribute('data-inline'), k = kind + (inline ? ':i:' : ':b:') + src;
    el.setAttribute('data-busy', '');
    settleHold(PLATFORM.richRender(kind, src, inline)).then(function (html) { MD_RICH[k] = html; document.querySelectorAll('.md-rich[data-busy]').forEach(function (x) { if (x.dataset.src === src && x.dataset.rich === kind) { x.innerHTML = html; x.removeAttribute('data-busy'); x.setAttribute('data-done', ''); } }); },
      function () { el.removeAttribute('data-busy'); el.setAttribute('data-done', ''); });   /* 画不了：留源文本 */
  }); });
});
/* 代码块的轻量高亮（只认注释、字符串、关键字；CSS 认属性名），只在写了语言的代码块里用 */
const MD_KW = /\b(export|function|const|let|var|return|import|from|if|else|for|while|class|new|async|await|type|interface)\b/g;
function mdCode(src, lang) {
  if (!lang) return h(src);
  const keep = [], ph = function (cls, x) { keep.push('<span class="' + cls + '">' + x + '</span>'); return '\u0000' + (keep.length - 1) + '\u0000'; };
  let s = h(src).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, function (m) { return ph('c', m); }).replace(/&#39;[^\n]*?&#39;|&quot;[^\n]*?&quot;|'[^'\n]*'/g, function (m) { return ph('s', m); });
  s = lang === 'css' ? s.replace(/(^|\n)(\s+)([\w-]+)(?=:)/g, function (m, a, b, c) { return a + b + ph('k', c); }) : s.replace(MD_KW, function (m) { return ph('k', m); });
  return s.replace(/\u0000(\d+)\u0000/g, function (m, i) { return keep[+i]; });
}
