/* 边界：一个含义一个组件、不为接口定制、不按位置推导样式 */
/* 代码与日志：终端、差异、日志 */
'use strict';

/* ───────── 终端 ─────────
   { id, mine, off, owner, output: 原始输出快照, caret: 'live'|'idle'|null }
   同一 io 口：terminal:output {id,data} 追加输出；terminal:input {id,data} 发原始输入；terminal:resize {id,cols,rows}。
   终端仿真由平台的终端口（PLATFORM.terminal）做；连接、鉴权及输出留存归宿主。
   页面上只画一个空的屏幕节点，快照和光标状态不写进 HTML：整页重画时节点按版本原样复用，终端不重建。颜色、字体来自主题 token（换主题时同步）。 */
const TERMS = {};   /* 终端 id → { gen, snap, caret, el, term, text } */
function termTheme(el) {
  const probe = document.createElement('span'); el.appendChild(probe);
  const c = function (v) { probe.style.color = 'var(' + v + ')'; return getComputedStyle(probe).color; };
  const a = ['--term-bg', '--term-error', '--term-ok', '--warn', '--info', '--term-br', '--term-ps', '--term-fg'].map(c);
  const t = { background: a[0], foreground: a[7], cursor: a[7], cursorAccent: a[0], selectionBackground: c('--line-strong'),
    black: a[0], red: a[1], green: a[2], yellow: a[3], blue: a[4], magenta: a[5], cyan: a[6], white: a[7],
    brightBlack: c('--term-dim'), brightRed: a[1], brightGreen: a[2], brightYellow: a[3], brightBlue: a[4], brightMagenta: a[5], brightCyan: a[6], brightWhite: a[7] };
  probe.remove(); return t;
}
PDL_COMPONENTS.terminal = function (p) {
  const t = TERMS[p.id] || (TERMS[p.id] = { gen: 0, text: '' });
  if (p.output.indexOf(t.text) !== 0) { t.gen++; t.text = ''; }   /* 宿主换了一份快照（重连）：换一个代号，节点重建、重写 */
  t.snap = p.output; t.caret = p.mine ? p.status === 'connected' ? 'live' : null : p.status === 'running' ? 'idle' : null; if (t.term) termCaret(t);
  return '<div class="tm' + (p.mine ? '' : ' ro') + (p.mine && p.status !== 'connected' ? ' off' : '') + '"><div id="tm-screen" class="tm-screen" data-island="terminal:' + h(p.id) + ':' + t.gen + '" data-terminal="' + h(p.id) + '" role="' + (p.mine ? 'textbox' : 'log') + '"' +
    (p.mine ? ' aria-label="' + h(tc('terminal.labelLive', tc('wsTerminal.mine'))) + '"' : ' aria-label="' + h(tc('terminal.labelReadonly', tc('terminalData.owner', p.owner))) + '" aria-readonly="true"') + '></div></div>';
};
function termCaret(t) { t.term.set({ cursorBlink: t.caret === 'live', cursorInactiveStyle: t.caret ? 'outline' : 'none' }); }
/* 屏幕节点进了页面：同一节点只开一次终端，写入快照；尺寸变了重算行列 */
function terminalMount(el) {
  const id = el.dataset.terminal, t = TERMS[id]; if (!t) return;
  if (t.el === el) { if (t.term && el.getClientRects().length) t.term.fit(); return; }
  if (t.term) t.term.dispose();
  t.el = el; t.term = null; t.text = '';
  const css = getComputedStyle(el), ro = !!el.closest('.ro, .off');
  PLATFORM.terminal(el, { fontFamily: css.fontFamily, fontSize: parseFloat(css.fontSize), lineHeight: 1.2, theme: termTheme(el), disableStdin: ro, scrollback: 5000 }).then(function (term) {
    if (t.el !== el) { term.dispose(); return; }
    t.term = term; t.text = t.snap; term.write(t.snap); termCaret(t);
    term.onData(function (data) { if (!el.closest('.ro, .off')) ioSend('terminal:input', { id: id, data: data }); });
    term.onResize(function (d) { if (!el.closest('.ro, .off')) ioSend('terminal:resize', { id: id, cols: d.cols, rows: d.rows }); });
    if (el.getClientRects().length) term.fit();
  });
}
treeMatch('.tm-screen[data-terminal]', terminalMount, true);
ioOn('terminal:output', function (e) { const t = TERMS[e.id]; if (!t) return; t.snap += e.data; if (t.term) { t.text += e.data; t.term.write(e.data); } });
PDL_THEME_SYNC.push(function () { Object.keys(TERMS).forEach(function (id) { const t = TERMS[id]; if (t.term && t.el.isConnected) t.term.set({ theme: termTheme(t.el) }); }); });

/* ───────── 差异：合并 / 并排 ─────────
   { hunks: [[标题, [[' '|'+'|'-', 行]]]], mode: 'unified'|'split', empty: 没有差异时的一句 }；声明中的字段可以绑定。 */
PDL_COMPONENTS.diff = function (c, sc, root) {
  const bound = typeof c.hunks === 'string', hunks = pv(c.hunks, sc, root), mode = pv(c.mode, sc, root);
  if (!hunks || !hunks.length) return '<div class="wc-diff empty-diff">' + (bound ? pvText(c.empty || '', sc, root) : h(c.empty || '')) + '</div>';
  c = Object.assign({}, c, { hunks: hunks, mode: mode });
  if (c.mode === 'split') {
    return '<div class="wc-diff scroll-x split">' + c.hunks.map(function (hk) {
      const L = [], R = [];
      hk[1].forEach(function (l) { if (l[0] === ' ') { while (L.length < R.length) L.push(null); while (R.length < L.length) R.push(null); L.push(l); R.push(l); } else if (l[0] === '-') L.push(l); else R.push(l); });
      while (L.length < R.length) L.push(null); while (R.length < L.length) R.push(null);
      return '<div class="wc-hunk">' + h(hk[0]) + '</div>' + L.map(function (l, i) { const r = R[i]; return '<div class="wc-sl ' + (l ? (l[0] === '-' ? 'del' : '') : 'gap') + '">' + (l ? h(l[1]) : '') + '</div><div class="wc-sl ' + (r ? (r[0] === '+' ? 'add' : '') : 'gap') + '">' + (r ? h(r[1]) : '') + '</div>'; }).join('');
    }).join('') + '</div>';
  }
  return '<div class="wc-diff scroll-x">' + c.hunks.map(function (hk) { return (hk[0] ? '<div class="wc-hunk">' + h(hk[0]) + '</div>' : '') + hk[1].map(function (l) { return '<div class="wc-dl ' + (l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : '') + '"><span class="wc-sign">' + (l[0] === ' ' ? '' : l[0]) + '</span>' + h(l[1]) + '</div>'; }).join(''); }).join('') + '</div>';
};

/* ───────── 日志：一条一行（级别标记、等宽正文、时间） ─────────
   { entries: [{ level: 'log'|'info'|'warn'|'error', text, at }], total }；级别标记就是状态色点（.dot）
   不是终端：日志是结构化的条目（能按级别筛），终端是字符流 */
PDL_COMPONENTS.log = function (p) {
  return '<div class="wpv-log scroll">' + (p.entries.length ? p.entries.map(function (c) { const tone = { info: 'info', warn: 'warn', error: 'danger' }[c.level] || ''; return '<div class="wpv-ce"' + (tone ? ' data-tone="' + h(tone) + '"' : '') + '><span class="dot"' + (tone ? ' data-tone="' + h(tone) + '"' : '') + ' data-tip="' + h(tc('log.level', c.level)) + '"></span><span class="mono wpv-msg">' + h(c.text) + '</span><span class="num faint">' + h(FORMATS.hm(c.at)) + '</span></div>'; }).join('') : emptyState(tc('log.empty', !!p.total))) + '</div>';
};

/* ───────── 目录登记：部件的示例（view：借那个视图的真实视图模型；没写 view 就用目录的样例数据） ───────── */
PDL_COMPONENTS.terminal.catalog = { g: 'workbench', view: 'ws.terminal', props: '$.screen' };
PDL_COMPONENTS.log.catalog = { g: 'workbench', view: 'ws.preview', props: '$.log' };
PDL_COMPONENTS.diff.catalog = { g: 'workbench', props: '$.diff' };
