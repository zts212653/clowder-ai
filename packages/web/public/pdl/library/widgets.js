/* 边界：一个含义一个组件、不为接口定制、不按位置推导样式 */
/* 组件库 · 复合组件：终端、差异、日志、媒体查看器、时间线播放器、关系图、柱状图、卡片网格、队列。
   这里是 PDL_COMPONENTS 唯一的登记处（lint：pdl-comp 只许在组件库文件里登记）。
   契约：组件只吃数据（props），不读页面状态、不认识页面名和功能 ID；点了执行什么由 props 里的 { act, args } 给出，
   文字由组件的 i18n 或 PDL 绑定；状态和计数由数据给出。props 的字段见各组件的 catalog（组件目录）。 */
'use strict';

/* { act, args } → data-act + data-*（操作的统一写法） */
function wgAct(a) { return a ? actAttrs(a.act, a.args) : ''; }
/* 日期网格：只认识日期、计数和选择动作；事件的含义、筛选和详情由 VM / PDL 负责。
   { anchor, value, today, mode: 'month'|'week', marks: [{ at }], act, args } */
PDL_COMPONENTS.calendar = function (o, sc) {
  o = pvDeep(o, sc);
  const anchor = new Date(o.anchor), first = new Date(anchor.getFullYear(), anchor.getMonth(), o.mode === 'week' ? anchor.getDate() : 1, 12);
  first.setDate(first.getDate() - (first.getDay() + 6) % 7);
  const selected = new Date(o.value).toDateString(), today = new Date(o.today).toDateString(), counts = {};
  o.marks.forEach(function (m) { const key = new Date(m.at).toDateString(); counts[key] = (counts[key] || 0) + 1; });
  const days = Array.from({ length: o.mode === 'week' ? 7 : 42 }, function (_, i) {
    const d = new Date(first.getFullYear(), first.getMonth(), first.getDate() + i, 12), key = d.toDateString(), count = counts[key] || 0;
    const label = d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate() + (count ? ' · ' + tc('calendar.count', count) : '');
    return '<button type="button" class="calendar-day"' + wgAct({ act: o.act, args: Object.assign({}, o.args, { v: d.getTime() }) }) +
      ' aria-label="' + h(label) + '" aria-pressed="' + (key === selected) + '" data-outside="' + (d.getMonth() !== anchor.getMonth()) + '" data-today="' + (key === today) + '">' +
      '<span>' + d.getDate() + '</span><span class="calendar-count">' + (count || '') + '</span></button>';
  });
  return '<div class="calendar" data-period="' + h(o.mode) + '"><div class="calendar-weekdays">' + tc('calendar.weekdays').split(' ').map(function (d) { return '<span>' + h(d) + '</span>'; }).join('') + '</div><div class="calendar-days">' + days.join('') + '</div></div>';
};
/* 一个图标按钮：{ label, icon, act, args, pressed, tip, primary } */
function wgBtn(b, o) {
  o = o || {};
  return btn(b.label, { primary: !!b.primary, iconOnly: !b.text, icon: b.icon, sm: o.sm !== false, act: b.act, data: argAttrs(b.args) + (b.tip ? ' data-tip="' + h(b.tip) + '"' : ''), pressed: b.pressed != null ? !!b.pressed : null, disabled: !!b.disabled });
}

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

/* 媒体内容：图片 / 音频 / 视频共用一个组件；外壳、标题、批注表单由 PDL 组合。
   { id, kind, src, label, width, height, controls?, group?, points?, marks, pick?,
     markup:[{id,kind,color,strokeWidth,points?|from?|to?|at?|text?|fontSize?,time?,until?}], edit?:{act,args}, frameStep? }
   坐标是媒体像素，time / until 是播放秒数；版本和时间刻度属于应用。原生节点单独复用，编辑不重启播放。
   group：同一组的几个播放器各自独立播放，“一起播放 / 暂停、按节点对齐”是 mediaGroup / mediaGroupPoint 两个动作；points：[{ key, label, at }]，at 是它自己时间轴上的秒数 */
function mediaMarkupShape(mark) {
  const point = function (p) { return p.x + ',' + p.y; };
  let shape;
  if (mark.kind === 'stroke') shape = '<polyline points="' + mark.points.map(point).join(' ') + '"></polyline>';
  else if (mark.kind === 'arrow') {
    const a = mark.from, b = mark.to, angle = Math.atan2(b.y - a.y, b.x - a.x), size = mark.strokeWidth * 5;
    const wing = function (delta) { return point({ x: b.x - size * Math.cos(angle + delta), y: b.y - size * Math.sin(angle + delta) }); };
    shape = '<path d="M' + point(a) + ' L' + point(b) + ' M' + wing(.5) + ' L' + point(b) + ' L' + wing(-.5) + '"></path>';
  } else if (mark.kind === 'text') shape = '<text x="' + mark.at.x + '" y="' + mark.at.y + '" font-size="' + mark.fontSize + '" fill="' + h(mark.color) + '" stroke="none">' + h(mark.text) + '</text>';
  else if (mark.kind === 'rectangle') shape = '<rect x="' + mark.x + '" y="' + mark.y + '" width="' + mark.width + '" height="' + mark.height + '"></rect>';
  else if (mark.kind === 'ellipse') shape = '<ellipse cx="' + (mark.x + mark.width / 2) + '" cy="' + (mark.y + mark.height / 2) + '" rx="' + mark.width / 2 + '" ry="' + mark.height / 2 + '"></ellipse>';
  return '<g data-markup-id="' + h(mark.id) + '" stroke="' + h(mark.color) + '" stroke-width="' + mark.strokeWidth + '" stroke-linecap="round" stroke-linejoin="round"' + (mark.time == null ? '' : ' data-from="' + mark.time + '" data-to="' + mark.until + '"') + '>' + shape + '</g>';
}
function mediaMarkupToolbar(id, state) {
  const items = [['select', 'select', tc('common.select')], ['stroke', 'edit', tc('media.markup.stroke')], ['arrow', 'markupArrow', tc('media.markup.arrow')], ['text', 'markupText', tc('media.markup.text')]].map(function (tool) {
    return { type: 'button', label: tool[2], icon: tool[1], iconOnly: true, pressed: state.mode === tool[0], act: 'mediaMarkupMode', args: { mode: tool[0] } };
  });
  items.push({ type: 'button', label: tc('common.undo'), icon: 'undo', iconOnly: true, act: 'mediaMarkupUndo', disabled: !state.past.length });
  items.push({ type: 'button', label: tc('common.remove'), icon: 'delete', iconOnly: true, act: 'mediaMarkupRemove', disabled: !state.selected || state.marks.some(function (m) { return m.id === state.selected && m.readonly; }) });
  if (state.anchor) items.push({ type: 'input', id: 'media-text-' + id, value: state.anchor.text || '', input: 'mediaMarkupText', label: tc('media.markup.text'), placeholder: tc('media.markup.text'), go: 'mediaMarkupText', cancel: 'mediaMarkupCancel', goLabel: tc('common.add') });
  return PDL_BLOCKS.toolbar({ items: items }, {}, {});
}
PDL_COMPONENTS.media = function (p, sc, root) {
  if (p.data) {
    const d = pv(p.data, sc, root), action = function (list, item) { const a = (list || []).find(function (x) { return pvOk(x.when, item, d); }); return a ? Object.assign({ act: a.act }, a.args ? { args: pvArgsObj(a.args, item, d) } : {}) : null; };
    p = Object.assign({}, d, { open: action(p.open, d), pick: action(p.pick, d), edit: action(p.edit, d), marks: (d.marks || []).map(function (m) { return Object.assign({}, m, { open: action(p.mark, m) }); }) });
  }
  const attrs = ' data-island="media:' + h(p.id) + '" src="' + h(p.src) + '"';
  const content = p.kind === 'image' ? '<img' + attrs + ' alt="' + h(p.label) + '" draggable="false">' : '<' + p.kind + attrs + (p.controls === false ? ' muted' : ' controls') + ' preload="metadata" aria-label="' + h(p.label) + '"></' + p.kind + '>';
  const marks = (p.marks || []).map(function (m) { const time = m.from == null ? '' : ' data-from="' + m.from + '" data-to="' + m.to + '"'; return m.width ? '<rect' + time + ' x="' + m.x + '" y="' + m.y + '" width="' + m.width + '" height="' + m.height + '"></rect>' : '<circle' + time + ' cx="' + m.x + '" cy="' + m.y + '" r="6"></circle>'; }).join('');
  const bubbles = (p.marks || []).filter(function (m) { return m.label || m.located; }).map(function (m) { return btn(m.located ? tc('mediaMarks.located') : m.label, { iconOnly: true, icon: 'chat', cls: 'media-mark', data: wgAct(m.open) + ' style="--mark-x:' + m.x + ';--mark-y:' + m.y + '"' + (m.from == null ? '' : ' data-from="' + m.from + '" data-to="' + m.to + '"') }); }).join('');
  const stage = '<div class="media-content" data-media="' + h(p.id) + '"' + (p.open ? wgAct(p.open) : '') + ' data-markup="' + h(JSON.stringify(p.markup || [])) + '"' + (p.edit ? ' data-markup-edit="' + h(JSON.stringify(p.edit)) + '" data-frame-step="' + (p.frameStep || 0) + '"' : '') + (p.group ? ' data-media-group="' + h(p.group) + '" data-points="' + h(JSON.stringify(p.points || [])) + '"' : '') + (p.pick ? ' data-pick="' + h(JSON.stringify(p.pick)) + '"' : '') + '>' + content + (p.kind === 'audio' ? '' : '<svg class="media-marks" ' + (p.width ? 'viewBox="0 0 ' + p.width + ' ' + p.height + '"' : '') + ' aria-hidden="true">' + marks + '<g data-markup-layer>' + (p.markup || []).map(mediaMarkupShape).join('') + '</g></svg>' + bubbles)  + '</div>';
  return p.edit ? '<div data-media-editor><div data-media-tools>' + mediaMarkupToolbar(p.id, { mode: 'select', past: [] }) + '</div>' + stage + '</div>' : stage;
};
function mediaMarkupState(host) {
  const native = host.querySelector('img, video'), incoming = host.dataset.markup;
  if (!native._markup || native._markup.signature !== incoming) native._markup = { signature: incoming, marks: JSON.parse(incoming), mode: 'select', selected: '', past: [], anchor: null };
  return native._markup;
}
function mediaMarkupPaint(host) {
  const state = mediaMarkupState(host), editor = host.closest('[data-media-editor]');
  host.dataset.markupMode = state.mode;
  host.querySelector('[data-markup-layer]').innerHTML = state.marks.map(mediaMarkupShape).join('');
  host.querySelectorAll('[data-markup-id]').forEach(function (el) { el.dataset.selected = String(el.dataset.markupId === state.selected); });
  const active = document.activeElement, focus = active && active.id === 'media-text-' + host.dataset.media ? [active.selectionStart, active.selectionEnd] : null;
  editor.querySelector('[data-media-tools]').innerHTML = mediaMarkupToolbar(host.dataset.media, state);
  if (focus && state.anchor) { const input = document.getElementById(active.id); input.focus(); input.setSelectionRange(focus[0], focus[1]); }
  host.querySelector('img, video').ontimeupdate();
}
function mediaMarkupCommit(host, marks) {
  const state = mediaMarkupState(host), edit = JSON.parse(host.dataset.markupEdit);
  state.past.push(state.marks); state.marks = marks; state.mode = 'select'; state.selected = ''; state.anchor = null;
  state.signature = host.dataset.markup = JSON.stringify(marks);
  actFn(edit.act)(Object.assign({}, edit.args, { markup: marks }), host);
  mediaMarkupPaint(host);
}
function mediaMarkupHost(el) { return el.closest('[data-media-editor]').querySelector('.media-content'); }
A.mediaMarkupMode = function (d, el) { const host = mediaMarkupHost(el), state = mediaMarkupState(host); state.mode = d.mode; state.anchor = null; mediaMarkupPaint(host); };
A.mediaMarkupRemove = function (d, el) { const host = mediaMarkupHost(el), state = mediaMarkupState(host); mediaMarkupCommit(host, state.marks.filter(function (m) { return m.id !== state.selected || m.readonly; })); };
A.mediaMarkupUndo = function (d, el) {
  const host = mediaMarkupHost(el), state = mediaMarkupState(host); if (!state.past.length) return;
  const marks = state.past.pop(), edit = JSON.parse(host.dataset.markupEdit); state.marks = marks; state.mode = 'select'; state.selected = ''; state.anchor = null;
  state.signature = host.dataset.markup = JSON.stringify(marks); actFn(edit.act)(Object.assign({}, edit.args, { markup: marks }), host); mediaMarkupPaint(host);
};
A.mediaMarkupText = function (d, el) {
  const host = mediaMarkupHost(el), state = mediaMarkupState(host), mark = state.anchor;
  const text = d.v.trim(); if (text.length > 240) { fieldErr('media-text-' + host.dataset.media, tc('media.markup.tooLong', 240)); return false; }
  mediaMarkupCommit(host, state.marks.concat([Object.assign({}, mark, { text: text })]));
};
INPUTS.mediaMarkupText = function (e) { mediaMarkupState(mediaMarkupHost(e.target)).anchor.text = e.target.value; };
A.mediaMarkupCancel = function (d, el) { const host = mediaMarkupHost(el), state = mediaMarkupState(host); state.anchor = null; state.mode = 'select'; mediaMarkupPaint(host); };
function mediaMarkupNew(native, kind, shape) {
  const host = native.closest('.media-content'), scale = host.querySelector('svg').viewBox.baseVal.width / native.getBoundingClientRect().width;
  const mark = Object.assign({ id: crypto.randomUUID(), kind: kind, color: getComputedStyle(host).getPropertyValue('--media-mark-ink').trim(), strokeWidth: Math.min(1024, Math.max(1, Math.round(2 * scale))) }, shape);
  if (kind === 'text') mark.fontSize = Math.min(2048, Math.max(1, Math.round(16 * scale)));
  if (native.tagName === 'VIDEO') { mark.time = native.currentTime; mark.until = mark.time + +host.dataset.frameStep; }
  return mark;
}
/* 点/区域选择和标绘共用一次手势、同一个像素坐标换算；临时轮廓与撤销由 media 自己持有。 */
document.addEventListener('pointerdown', function (e) {
  const host = e.target.closest('.media-content');
  if (!host || !host.dataset.pick && !host.dataset.markupEdit || e.button !== 0) return;
  const state = host.dataset.markupEdit ? mediaMarkupState(host) : null, selected = e.target.closest('[data-markup-id]');
  const selectingMark = selected && state && state.mode === 'select';
  if (selectingMark) { state.selected = selected.dataset.markupId; if (!host.dataset.pick) { e.preventDefault(); mediaMarkupPaint(host); return; } }
  if (!e.target.matches('img, video') && !selectingMark) return;
  e.preventDefault(); const native = host.querySelector('img, video'), svg = host.querySelector('svg'), box = native.getBoundingClientRect(), view = svg.viewBox.baseVal;
  if (!view.width || !view.height) return;
  if (native.tagName === 'VIDEO') native.pause();
  const point = function (ev) { return { x: Math.round(Math.max(0, Math.min(1, (ev.clientX - box.left) / box.width)) * view.width), y: Math.round(Math.max(0, Math.min(1, (ev.clientY - box.top) / box.height)) * view.height) }; };
  const start = point(e), mode = state ? state.mode : 'select';
  if (mode === 'text') { state.anchor = mediaMarkupNew(native, 'text', { at: start }); mediaMarkupPaint(host); document.getElementById('media-text-' + host.dataset.media).focus(); return; }
  const shape = document.createElementNS('http://www.w3.org/2000/svg', 'g'); svg.appendChild(shape); native.setPointerCapture(e.pointerId);
  const area = function (end) { return { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) }; };
  const mark = mode === 'select' ? null : mediaMarkupNew(native, mode, mode === 'stroke' ? { points: [start] } : { from: start, to: start });
  const move = function (ev) {
    const end = point(ev);
    if (mark) { if (mode === 'stroke') { if (mark.points.length < 300) mark.points.push(end); else mark.points[299] = end; } else mark.to = end; shape.innerHTML = mediaMarkupShape(mark); }
    else { const a = area(end); shape.innerHTML = '<rect x="' + a.x + '" y="' + a.y + '" width="' + a.width + '" height="' + a.height + '"></rect>'; }
  };
  const finish = function (ev) {
    native.removeEventListener('pointermove', move); native.removeEventListener('pointerup', finish); native.removeEventListener('pointercancel', finish); shape.remove(); if (ev.type === 'pointercancel') { if (mark) { state.mode = 'select'; mediaMarkupPaint(host); } return; }
    if (mark) { move(ev); mediaMarkupCommit(host, state.marks.concat([mark])); return; }
    if (!host.dataset.pick) { if (state) { state.selected = ''; mediaMarkupPaint(host); } return; }
    const end = point(ev), a = Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) > 4 ? area(end) : { x: start.x, y: start.y }, pick = JSON.parse(host.dataset.pick);
    actFn(pick.act)(Object.assign({}, pick.args, a, { at: native.currentTime || 0 }), host);
  };
  native.addEventListener('pointermove', move); native.addEventListener('pointerup', finish); native.addEventListener('pointercancel', finish);
});
treeMatch('.media-content :is(img, video, audio)', function (media) {   /* 挂在媒体元素自己身上：外层留着、只换了图片 / 视频时也接得上 */
  const host = media.closest('.media-content'), svg = host.querySelector('svg'); if (!svg) return;
  const dimensions = function () { const w = media.naturalWidth || media.videoWidth, h = media.naturalHeight || media.videoHeight; if (w && h) { svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h); host.style.setProperty('--media-w', w); host.style.setProperty('--media-h', h); } };
  media.onload = dimensions; media.onloadedmetadata = dimensions; dimensions();
  media.ontimeupdate = function () { host.querySelectorAll('[data-from]').forEach(function (mark) { mark.style.visibility = media.currentTime >= +mark.dataset.from && media.currentTime < +mark.dataset.to ? 'visible' : 'hidden'; }); };
  media.ontimeupdate();
  if (host.dataset.markupEdit) mediaMarkupPaint(host);
});
function mediaMarkupEditors() { document.querySelectorAll('.media-content[data-markup-edit]').forEach(mediaMarkupPaint); }
onRender(mediaMarkupEditors);
A.mediaSeek = function (d) { const el = document.querySelector('[data-media="' + CSS.escape(d.id) + '"] video, [data-media="' + CSS.escape(d.id) + '"] audio'); if (el) { el.currentTime = +d.at; el.pause(); } };

/* 媒体组：组里的播放器各自独立（各有自己的控件），这两个动作只做“一起”——从各自当前的位置一起播放 / 暂停（mediaGroup { group, op }），
   按节点对齐（mediaGroupPoint，下拉带 group：每个播放器跳到自己时间轴上这个节点的位置，播放状态不变）。控制条由 PDL 用工具条组合 */
function mediaGroupEach(group, fn) {
  document.querySelectorAll('[data-media-group="' + CSS.escape(group) + '"]').forEach(function (host) { const media = host.querySelector('video, audio'); if (media) fn(media, host); });
}
A.mediaGroup = function (d) { mediaGroupEach(d.group, function (media) { if (d.op === 'play') media.play().catch(function () {}); else media.pause(); }); };
CHANGES.mediaGroupPoint = function (e) {
  const key = e.target.value; if (!key) return;
  mediaGroupEach(e.target.dataset.group, function (media, host) {
    const point = JSON.parse(host.dataset.points).find(function (x) { return x.key === key; }); if (point) media.currentTime = point.at;
  });
  e.target.value = '';
};

/* ───────── 时间线播放器（浮起的控制条） ─────────
   { data: 播放数据绑定, seek: 输入动作名, play, speed, toggles, more: PDL 控件声明 }
   数据：{ scrub: { segs: [{ from, to, speaker: { role, catId } }], idle, cur, max, count },
     note: { unit, amount }|null, time: { at, total, count, totalCount } }；at / total 为秒数，播放器用统一时钟写法。 */
function playerScrub(s, input) {
  const pos = function (i) { return (i / Math.max(1, s.max) * 100).toFixed(2); }, segs = [];
  s.segs.forEach(function (g) {
    const who = g.speaker, color = who.role === 'user' ? 'var(--accent)' : who.role === 'assistant' && who.catId ? 'var(--name-' + (whoInfo({ kind: 'agent', catId: who.catId }).step || 1) + ')' : 'var(--fg-faint)', prev = segs[segs.length - 1];
    if (prev && prev.color === color) prev.to = g.to;
    else segs.push({ from: g.from, to: g.to, color: color });
  });
  return '<div class="rp-scrub"><svg viewBox="0 0 100 16" preserveAspectRatio="none" aria-hidden="true"><line x1="0" x2="100" y1="8" y2="8" class="rp-track" stroke-width="2"/>' +
    segs.map(function (g) { return '<line x1="' + pos(g.from) + '" x2="' + pos(Math.max(g.from + 0.6, g.to + 0.6)) + '" y1="8" y2="8" stroke="' + g.color + '" stroke-width="3"/>'; }).join('') +
    s.idle.map(function (g) { return '<line x1="' + pos(g.from) + '" x2="' + pos(g.to) + '" y1="8" y2="8" stroke="var(--fg-faint)" stroke-width="2" stroke-dasharray="0.6 0.6"/>'; }).join('') +
    '<line x1="0" x2="' + pos(s.cur) + '" y1="13.5" y2="13.5" class="rp-done" stroke-width="1.5"/></svg>' +
    '<input type="range" id="rp-scrub-input" min="0" max="' + s.max + '" step="1" value="' + s.cur + '" aria-label="' + h(tc('timelinePlayer.scrub.label')) + '" aria-valuetext="' + h(tc('timelinePlayer.scrub.value', s.cur + 1, s.count)) + '" data-input="' + h(input) + '"></div>';
}
PDL_COMPONENTS.player = function (p, sc, root) {
  const d = pv(p.data, sc, root);
  return '<div class="rp"><div class="rp-dock">' + playerScrub(d.scrub, p.seek) + (d.note ? '<p class="rp-skip" role="status">' + icon('skipIdle', 12) + h(tc('timelinePlayer.note.text', tc('timelinePlayer.note.unit', d.note.unit, d.note.amount))) + '</p>' : '') +
    '<div class="rp-ctl">' + btn(pv(p.play.label, sc, root), { iconOnly: true, icon: pv(p.play.icon, sc, root), act: p.play.act, data: pvArgs(p.play.args, sc, root) }) +
    '<span class="rp-time num"><span>' + h(FORMATS.clockH(d.time.at)) + ' / ' + h(FORMATS.clockH(d.time.total)) + '</span><span class="faint">' + d.time.count + ' / ' + d.time.totalCount + '</span></span><span class="grow"></span>' +
    sel(pv(p.speed.id, sc, root), pvItems(p.speed.options, sc, root), pv(p.speed.value, sc, root), { change: p.speed.change, label: pv(p.speed.label, sc, root), cls: 'num' }) + p.toggles.map(function (t) { return btn(pv(t.label, sc, root), { sm: true, iconOnly: true, icon: pv(t.icon, sc, root), act: t.act, data: pvArgs(t.args, sc, root), pressed: !!pv(t.pressed, sc, root), tip: pv(t.tip, sc, root) }); }).join('') + pvControl(p.more, sc, root) + '</div></div></div>';
};

/* ───────── 关系图：节点 + 连线（SVG），可选图例和拖动平移 ─────────
   { label, view: [x, y, w, h], nodes: [{ id, x, y, text, tip, shape: 'card'|'bubble', tone, on, dim, hub, act, args }],
     edges: [{ from: [x, y], to: [x, y], dash }], legend: { items: [{ tone, label }], tail }, pan: { act } , empty }
   item：节点字段的模板（prefix / limit 是文字前缀 / 截断长度）；edge：连线字段的模板。
   没给节点坐标时按卡片网格摆放，zoom / offset 是用户的缩放和平移状态；给了 view / 坐标的照用。
   card：圆角块 + 状态点 + 名字（依赖图）；bubble：圆 + 名字在下（知识图谱）。拖动平移结束时执行 pan.act（带 x / y） */
function graphNode(n) {
  const cls = 'g-node ' + (n.shape || 'card') + (n.on ? ' on' : '') + (n.dim ? ' dim' : '') + (n.hub ? ' hub' : '');
  const open = '<g class="' + cls + '"' + wgAct(n) + ' role="button" tabindex="0" aria-label="' + h(n.tip || n.text) + '">';
  if (n.shape === 'bubble') return open + '<circle cx="' + n.x + '" cy="' + n.y + '" r="' + (n.hub ? 24 : 15) + '"/><text x="' + n.x + '" y="' + (n.y + 40) + '" text-anchor="middle">' + h(n.text) + '</text></g>';
  return open + '<title>' + h(n.tip || n.text) + '</title><rect x="' + (n.x - 70) + '" y="' + (n.y - 18) + '" width="146" height="36" rx="8"/><circle class="g-st ' + (n.tone || 'idle') + '" cx="' + (n.x - 56) + '" cy="' + n.y + '" r="4"/><text x="' + (n.x - 46) + '" y="' + (n.y + 4) + '">' + h(n.text) + '</text></g>';
}
PDL_COMPONENTS.graph = function (g, sc, root) {
  const nodes = pvList(g.nodes, sc, root).map(function (data, i) {
    const n = g.item ? Object.assign({}, data, pvArgsObj(g.item, data, root), { args: pvArgsObj(g.item.args, data, root) }) : Object.assign({}, data);
    if (g.item && g.item.limit) n.text = String(n.text).slice(0, g.item.limit);
    if (g.item && g.item.prefix) n.text = tc('graph.nodeText', pv(g.item.prefix, data, root), n.text);
    if (n.x == null) n.x = 75 + i % 3 * 155;
    if (n.y == null) n.y = 40 + Math.floor(i / 3) * 70;
    return n;
  }), pos = {}; nodes.forEach(function (n) { pos[n.id] = [n.x, n.y]; });
  const edges = pvList(g.edges, sc, root).map(function (data) { const e = g.edge ? pvArgsObj(g.edge, data, root) : data; return { from: typeof e.from === 'string' ? pos[e.from] : e.from, to: typeof e.to === 'string' ? pos[e.to] : e.to, dash: e.dash }; });
  const legend = g.legend ? '<p class="vw-label g-legend">' + (g.item ? pvItems(g.legend.items, sc, root) : g.legend.items).map(function (x) { return '<span>' + lrDot(x.tone) + h(x.label) + '</span>'; }).join('') + (g.legend.tail ? '<span>· ' + (g.item ? pvText(g.legend.tail, sc, root) : h(g.legend.tail)) + '</span>' : '') + '</p>' : '';
  if (!nodes.length) return legend + emptyState((g.item ? pv(g.empty, sc, root) : g.empty) || '');
  const zoom = pv(g.zoom, sc, root) || 1, offset = pv(g.offset, sc, root) || [0, 0], view = pv(g.view, sc, root) || [-offset[0], -offset[1], 460 / zoom, Math.max(160, 20 + Math.ceil(nodes.length / 3) * 70) / zoom];
  const svg = '<svg class="graph' + (g.pan ? ' pan' : '') + '" viewBox="' + view.join(' ') + '" role="img" aria-label="' + (g.item ? pvText(g.label, sc, root) : h(g.label)) + '"' + (g.pan ? ' data-pan="' + h(g.pan.act) + '"' : '') + '>' +
    edges.map(function (e) { return '<line x1="' + e.from[0] + '" y1="' + e.from[1] + '" x2="' + e.to[0] + '" y2="' + e.to[1] + '"' + (e.dash ? ' stroke-dasharray="' + e.dash + '"' : '') + '/>'; }).join('') +
    nodes.map(graphNode).join('') + '</svg>';
  return legend + '<div class="group g-wrap">' + svg + '</div>';
};
/* 拖动平移：只改 viewBox，不重画；松手时把位置交给 pan.act */
(function () {
  let drag = null;
  document.addEventListener('pointerdown', function (e) {
    const g = e.target.closest && e.target.closest('svg.graph.pan'); if (!g || e.target.closest('.g-node')) return;
    const vb = g.getAttribute('viewBox').split(' ').map(Number), scale = vb[2] / g.getBoundingClientRect().width;
    drag = { x: e.clientX, y: e.clientY, vb: vb, scale: scale, el: g };
  });
  document.addEventListener('pointermove', function (e) {
    if (!drag) return;
    const x = drag.vb[0] - (e.clientX - drag.x) * drag.scale, y = drag.vb[1] - (e.clientY - drag.y) * drag.scale;
    drag.el.setAttribute('viewBox', [x, y, drag.vb[2], drag.vb[3]].join(' ')); drag.at = [x, y];
  });
  document.addEventListener('pointerup', function () {
    if (!drag) return; const d = drag; drag = null;
    if (d.at && actFn(d.el.dataset.pan)) actFn(d.el.dataset.pan)({ x: d.at[0], y: d.at[1] });
  });
})();

/* ───────── 柱状图：一组按天 / 按项的柱，柱里可以叠一段 ─────────
   { label, max, items: [{ label, value, part, tip }] }；from / item 可声明 label / tip。part：叠在柱子底部的那一段（同一单位） */
PDL_COMPONENTS.bars = function (p, sc, root) {
  const xs = pvList(p.from || p.items, sc, root), max = pv(p.max, sc, root) || Math.max.apply(null, xs.map(function (d) { return d.value; }).concat([1]));
  return '<div class="group bars" role="img" aria-label="' + (p.item ? pvText(p.label, sc, root) : h(p.label)) + '">' + xs.map(function (d) {
    return '<div data-tip="' + (p.item ? pvText(p.item.tip, d, root) : h(d.tip || '')) + '"><span style="--u-height:' + Math.round(d.value / max * 100) + '%" class="u-v-height"><i style="--u-height:' + (d.value ? Math.round((d.part || 0) / d.value * 100) : 0) + '%" class="u-v-height"></i></span><em>' + (p.item ? pvText(p.item.label, d, root) : h(d.label)) + '</em></div>';
  }).join('') + '</div>';
};

/* ───────── 卡片网格：一排预览卡（图标预览 + 标题 + 一行说明） ─────────
   { items: [{ icon, title, sub, act, args, label, preview?:{kind,src}, actions?:[{label,icon,act,args}] }], empty, skel }；from / item 声明每项字段、预览和操作，when 按该项数据判断。 */
PDL_COMPONENTS.cards = function (p, sc, root) {
  if (p.skel) return skel(p.skel, 'card');
  const xs = pvList(p.from || p.items, sc, root), next = listNextHtml(p.next, sc, root);
  if (!xs.length) return emptyState({ text: (p.item ? pv(p.empty, sc, root) : p.empty) || tc('list.empty') }) + next;
  return '<div class="cgrid">' + xs.map(function (data) {
    const t = p.item, w = t ? Object.assign({}, data, pvArgsObj(t, data, root)) : data;
    if (t && t.preview) w.preview = pvOk(t.preview.when, data, root) ? pvArgsObj(t.preview, data, root) : null;
    const preview = w.preview ? w.preview.kind === 'video' ? '<video src="' + h(w.preview.src) + '" preload="metadata" muted playsinline></video>' : '<img src="' + h(w.preview.src) + '" alt="" draggable="false">' : icon(w.icon, 22);
    const actions = (w.actions || []).filter(function (a) { return !t || pvOk(a.when, data, root); }).map(function (a) { return btn(t ? pv(a.label, data, root) : a.label, { iconOnly: true, icon: t ? pv(a.icon, data, root) : a.icon, act: a.act, data: t ? pvArgs(a.args, data, root) : argAttrs(a.args) }); }).join('');
    const act = t ? actAttrs(w.act, pvArgsObj(t.args, data, root)) : wgAct(w);
    return '<div class="cgrid-card"><button type="button" class="cgrid-prev"' + act + ' aria-label="' + h(w.label || w.title) + '">' + preview + '</button>' +
      '<div class="cgrid-meta"><div class="cgrid-t" data-tip="' + h(w.title) + '">' + h(w.title) + '</div><div class="cgrid-foot"><div class="cgrid-s">' + h(w.sub) + '</div>' + actions + '</div></div></div>';
  }).join('') + '</div>' + next;
};

/* ───────── 队列：收起时只露右下角“排队中 · n”，展开时以右下角为基点向上、向左长成面板 ─────────
   { key, items: [{ key, orderable, text, to: [成员 id] }], actions: [{ label, icon, act, args, when, items }], label, visible, order }；字段可由 PDL 绑定。 */
PDL_COMPONENTS.queue = function (p, sc, root) {
  const q = pv(p.items, sc, root); if (!q.length) return '';
  const more = q.length - 1, key = 'queue:' + pv(p.key, sc, root), label = pv(p.label, sc, root), order = pv(p.order, sc, root), open = !!S.folds[key];
  const fold = more ? foldTg(open, 'fold', ' data-f="queue"', open ? '' : tc('fold.moreHtml', '<span class="num">' + more + '</span>'), null, 'up') : '';   /* 和折叠块共用开关，队列向上展开。 */
  /* 一条排队消息就是一行 lrow（小行）：正文 · 投给谁（头像叠放）· 悬停操作；行与行之间是分组的发丝线 */
  const rows = q.map(function (x) {
    return { key: x.key, orderable: !!order && !!x.orderable, layout: 'record', hook: 'qitem', title: '<span data-tip="' + h(x.text) + '">' + h(x.text) + '</span>', cols: [{ w: 'ctl', v: p.targets && x.delivery ? '<span class="qto">' + x.delivery.map(function (target) { return pvParts(p.targets, target, root); }).join('') + '</span>' : x.to.length ? '<span class="qto">' + x.to.map(function (id) { return whoAva(id, { size: 'sm', tip: tc('queue.to', who(id, 'text', { handle: true })) }); }).join('') + '</span>' : '' }],
      actsHtml: (p.actions || []).filter(function (a) { return pvOk(a.when, x, root); }).map(function (a) {
        if (a.type === 'more') return lrAct({ icon: 'more', label: pv(a.label, x, root), act: 'menu', data: argAttrs({ menu: menuLive(pvMenu(a.items, x, root)), k: x.key }) });
        return lrAct({ icon: a.icon, label: pv(a.label, x, root), act: a.act, data: pvArgs(a.args, x, root) });
      }).join('') };
  });
  return '<div class="qwrap" data-island="' + h(key) + '" data-fold-key="' + h(key) + '" data-open="' + open + '" data-count="' + q.length + '"><div class="qbox" role="dialog" aria-label="' + h(label) + '">' + fold +
    lrList(key, rows, { rows: pv(p.visible, sc, root) || 5, order: order, cls: 'qlist' }) +
    '<div class="qbox-foot"><span class="qchip">' + h(label) + ' · <span class="num">' + q.length + '</span></span></div></div></div>';
};

function foldQueue(d, el) {
  const box = el.closest('.qwrap');
  localOpen(box, box.dataset.open !== 'true', box.querySelector('.fold-tg'));
}
onOpenToggle('.qwrap', function (box, open) {
  S.folds[box.dataset.foldKey] = open;
  const tg = box.querySelector('.fold-tg'); if (!tg) return;
  const tmp = document.createElement('template');
  tmp.innerHTML = foldTg(open, 'fold', ' data-f="queue"', open ? '' : tc('fold.moreHtml', '<span class="num">' + (+box.dataset.count - 1) + '</span>'), null, 'up');
  const next = tmp.content.firstElementChild;
  tg.innerHTML = next.innerHTML;
  ['aria-label', 'data-tip'].forEach(function (name) { tg.setAttribute(name, next.getAttribute(name)); });
});

/* 队列自己的行为：
   - 展开着时点队列外面（对话框里除外：排队消息的“现在发出”会开对话框）就本地收起；
   - 收起时的裁剪大小 = 底下“排队中 · n”这一行的实际大小：胶囊进了文档 / 变宽时量一次（引擎的进树通知），--qmax 是输入框的宽 */
document.addEventListener('click', function (e) {
  const w = document.querySelector('.qwrap[data-open="true"]'), t = e.target; if (!w || !t.closest || t.closest('.qwrap, .dialog')) return;
  localOpen(w, false, w.querySelector('.fold-tg'));
}, true);
function measureQueueClip(chip) {
  const box = chip && chip.closest('.qbox'); if (!box) return;
  const first = !box.style.getPropertyValue('--qch');   /* 新生成的框：量的时候样式已经按默认值算过一次，第一次放值不能走过渡 */
  if (first) box.style.transition = 'none';
  box.style.setProperty('--qcw', chip.offsetWidth + 'px'); box.style.setProperty('--qch', chip.offsetHeight + 'px');
  if (first) { void box.offsetWidth; box.style.transition = ''; }
  const comp = box.closest('.composer'); if (comp) box.style.setProperty('--qmax', comp.offsetWidth + 'px');
}
treeMatch('.qbox .qchip', measureQueueClip, true);
/* 裁剪尺寸是组件量出来的值，不是内容版本。 */
LOCAL_NORM.push(function (root) {
  root.querySelectorAll('.qbox').forEach(function (box) { box.removeAttribute('style'); });
});

/* ───────── 插件配置表单：插件清单 configuration 的投影（PluginManagerConfigField[]）画成一张表单 ─────────
   props（plugin-config.js 的 pcfModel 整理好）：{ p 表单实例, installed, steps: [{ text / code }], rows: [字段行], fieldCount, testable }
   字段行：{ key, id, kind, label, req, desc（清单的字段说明，原样画在字段下面）, err, value / items / operation }；组件按 kind 画对应的控件。
   操作 op.mode：seq（按钮 → 进行中 → 轮询〔二维码、剩余秒数〕→ 结果 / 已连接 + 断开）、live（限时授权：状态 + 一个按钮）、rows（列表按钮 + 行，每行自己的动作）。
   都是组件库的控件（field、sel、sw、kvEditor、btn、status、notice、lrow）；点了什么由 data-act（pcf*）+ 实例 / 字段 / 动作给出 */
/* 动作的结果：标签是一行状态；文本结果（网址、要粘贴的消息）是可复制的值 */
function pcfFb(fb) { return fb ? (fb.label ? status('ok', fb.label) : '') + (fb.copy ? copyValue({ value: fb.copy, label: tc('common.copy'), mono: !/\s/.test(fb.copy) }) : '') : ''; }
function pcfData(p, k) { return argAttrs({ p: p, k: k }); }
function pcfOpHtml(o) {
  const A = function (a, extra) { return actAttrs('pcfOp', Object.assign({ p: o.p, f: o.f, a: a }, extra || {})); };
  const action = function (id) { return o.actions.find(function (a) { return a.id === id; }); };
  const err = o.err ? status('danger', o.err) : '';
  if (o.mode === 'rows') {
    const list = action(o.listId), buttons = o.actions.filter(function (a) { return a.render === 'button' && a.id !== o.listId; });
    /* 自动看的状态没有常驻的刷新：读失败或自动查看到点了才有“重新检查”（提示里说为什么停了） */
    const refresh = o.refresh ? btn(o.refreshAuto ? tc('pcf.recheck') : list.label, { sm: true, data: A(list.id) + (o.paused ? ' data-tip="' + h(tc('pcf.observePaused')) + '"' : ''), icon: 'refresh' }) : '';
    const bar = refresh || buttons.length ? '<div class="pcf-acts">' + refresh + buttons.map(function (b) { return btn(b.label, { sm: true, data: A(b.id) }); }).join('') + '</div>' : '';
    const rs = o.rows.map(function (r) {
      const actions = (r.actions || []).map(function (ra) { const d = o.rowActions.find(function (a) { return a.id === ra.action; }); return d ? { id: d.id, label: ra.label || d.label } : null; }).filter(Boolean);
      return { sm: !r.detail && !r.fb, title: h(r.label), sub: (r.detail ? h(r.detail) : '') + pcfFb(r.fb), meta: r.err ? status('danger', r.err) : '',
        cols: actions.length ? [{ w: 'ctl', v: actions.map(function (a) { return btn(a.label, { sm: true, data: A(a.id, { r: r.key }) }); }).join('') }] : [] };
    });
    const rows = rs.length ? '<div class="group lr-list lined"' + lrCols(rs) + '>' + rs.map(lrow).join('') + '</div>' : '';
    return '<div class="pcf-op">' + bar + err + pcfFb(o.fb) + (o.awaiting ? '<span class="muted">' + h(tc('pcf.awaiting', list.label)) + '</span>' : '') + (o.loaded && !o.rows.length ? '<span class="muted">' + h(o.emptyText || tc('pcf.noRows')) + '</span>' : '') + rows + '</div>';
  }
  if (o.mode === 'live') { const current = action(o.status && o.status.armed ? o.revokeId : o.armId); return '<div class="pcf-op">' + status(o.status && o.status.armed ? 'ok' : 'info', !o.status ? tc('pcf.checking') : o.status.armed ? tc('pcf.armedLeft', o.status.label, o.status.seconds) : o.status.label) + err + '<div class="pcf-acts">' + btn(current.label, { sm: true, data: A(current.id), disabled: o.busy || !o.status }) + '</div></div>'; }
  const off = action(o.offId);
  if (o.phase === 'connected' || o.phase === 'disconnecting') return '<div class="pcf-op"><div class="pcf-acts">' + status('ok', (o.last && o.last.label) || tc('common.status.connected')) + (off ? btn(off.label, { sm: true, data: A(off.id), disabled: o.phase === 'disconnecting' }) : '') + '</div></div>';
  const current = action(o.currentId) || action(o.firstId), last = o.last, image = last && last.render === 'img';
  return '<div class="pcf-op">' + err +
    (current && current.render === 'button' && ['idle', 'error', 'result'].indexOf(o.phase) >= 0 ? '<div class="pcf-acts">' + btn(current.label, { sm: true, data: A(current.id), icon: current.resultRender === 'img' ? 'grid' : '' }) + '</div>' : '') +
    (o.phase === 'loading' ? status('info', tc('pcf.ui.pending', current ? current.label : '')) : '') + (o.phase === 'result' && last && last.render === 'status' && last.label ? status('ok', last.label) : '') + (o.phase === 'result' && last && last.render === 'text' ? pcfFb({ label: last.label, copy: typeof last.data === 'string' ? last.data : '' }) : '') +
    (image ? '<img class="pcf-qr" src="' + h(last.data.url) + '" alt="' + h(last.label || '') + '">' : '') +
    (o.phase === 'polling' ? status('info', (last && (last.render === 'polling' || image) && last.label || tc('pcf.ui.pending', current ? current.label : '')) + (o.seconds ? ' · ' + tc('pcf.left', o.seconds) : '')) : '') + '</div>';
}
function pcfCtl(r, p) {
  const d = pcfData(p, r.key), label = r.label ? pv(r.label, r, r) : tc('pcf.fieldLabel', r.schemaKey || r.key);
  if (r.kind === 'operation') return pcfOpHtml(r.operation) + (r.operation.restartable ? btn(tc('placement.restart'), { sm: true, act: 'pcfReset', data: argAttrs({ p: p, f: r.key }) }) : '');
  if (r.kind === 'select') {
    const options = r.options.map(function (x) { return { v: x.value, label: pv(x.label, x, x) }; });
    return sel(r.id, !r.record && r.value === '' ? [{ v: '', label: tc('pcf.choose') }].concat(options) : options, r.value, { change: r.record ? 'pcfRecSel' : 'pcfSel', data: d, invalid: !!r.err, label: label });
  }
  if (r.kind === 'boolean') return sw(r.value, 'pcfOp', d + ' data-op="' + (r.record ? 'recBool' : 'bool') + '"', label);
  if (r.kind === 'list') return kvEditor({ key: p + '|' + r.key, rows: r.items.map(function (v) { return { v: v }; }), single: true, input: 'pcfListIn', del: 'pcfOp', add: tc('pcf.addItem') });
  if (r.kind === 'records') return pcfRecordsHtml(r, p);
  const type = { secret: 'password', number: 'number', url: 'url' }[r.kind] || 'text';
  const ph = r.record ? r.placeholder : r.kind === 'secret' ? (r.currentValue ? tc('pcf.secretSet') : tc('pcf.unset')) : r.currentValue || r.defaultValue || tc('pcf.unset');
  return '<input class="input" id="' + h(r.id) + '" type="' + type + '" value="' + h(r.value) + '" placeholder="' + h(ph) + '" data-input="' + (r.record ? 'pcfRecIn' : 'pcfIn') + '"' + d + (r.defaultClient && (r.schemaKey === 'id' || r.schemaKey === 'name') ? ' readonly' : '') + (r.err ? ' aria-invalid="true"' : '') + ' autocomplete="off">';
}
function pcfRecordsHtml(r, p) {
  const sub = function (x) { return field({ label: x.label ? pv(x.label, x, x) : tc('pcf.fieldLabel', x.schemaKey), id: x.kind === 'list' || x.kind === 'boolean' ? '' : x.id, req: x.req, control: pcfCtl(x, p), foot: (x.err ? status('danger', x.err) : '') + (x.desc ? '<span>' + h(x.desc) + '</span>' : '') }); };
  return '<div class="pcf-recs">' + r.items.map(function (it) {
    const check = it.checked;
    return '<div class="group pcf-rec"><div class="pcf-rec-h"><b>' + h(it.name || tc('pcf.recordN', it.i + 1)) + '</b>' + (check ? status(check.error ? 'danger' : check.ok ? 'ok' : 'warn', check.error || check.message) : '') + '<span class="grow"></span>' + (r.checkable ? btn(tc('pcf.checkRecord'), { sm: true, act: 'pcfOp', data: argAttrs({ op: 'recCheck', p: p, k: r.key, i: it.i }) }) : '') + (r.configurationMode === 'single' ? '' : btn(tc('kv.deleteRow'), { iconOnly: true, icon: 'delete', sm: true, act: 'pcfOp', data: argAttrs({ op: 'recDel', p: p, k: r.key, i: it.i }) })) + '</div>' + it.rows.map(sub).join('') + '</div>';
  }).join('') + (r.configurationMode === 'single' ? '' : '<div class="pcf-acts">' + btn(tc('common.add'), { sm: true, icon: 'plus', act: 'pcfOp', data: argAttrs({ op: 'recAdd', p: p, k: r.key }) }) +
    r.presets.map(function (pr) { return btn(pv(pr.label, pr, pr), { sm: true, act: 'pcfOp', data: argAttrs({ op: 'recAdd', p: p, k: r.key, preset: pr.id }) }); }).join('') + '</div>') + '</div>';
}
function pluginConfigForm(p) {
  if (!p) return '';
  if (!p.installed) return group([emptyState(tc('common.status.notInstalled'))]);
  const rows = p.steps.map(function (s, i) { return field({ label: tc('pcf.step', i + 1), control: '<div class="value">' + h(s.code ? tc('pcf.ui.step', s.code) : s.text) + '</div>' }); })
    .concat(p.rows.map(function (r) {
      const current = (r.options || []).find(function (o) { return o.value === r.value; }), hint = current && current.hint;
      const foot = (r.err ? status('danger', r.err) : '') + (r.desc ? '<span>' + h(r.desc) + '</span>' : '') + (hint ? '<span>' + h(hint) + '</span>' : '');
      return field({ label: r.label ? pv(r.label, r, r) : tc('pcf.fieldLabel', r.key), id: ['operation', 'list', 'boolean', 'records'].indexOf(r.kind) >= 0 ? '' : r.id, req: r.req, control: pcfCtl(r, p.p), foot: foot });
    }));
  if (!rows.length) return !p.fieldCount && !p.testable ? group([emptyState(tc('pcf.none'))]) : '';
  return '<div class="group pcf">' + rows.join('') + '</div>';
}
PDL_COMPONENTS.pluginConfigForm = pluginConfigForm;

/* ───────── 目录登记：部件的示例（view：借那个视图的真实视图模型；没写 view 就用目录的样例数据） ───────── */
PDL_COMPONENTS.terminal.catalog = { g: 'workbench', view: 'ws.terminal', props: '$.screen' };
PDL_COMPONENTS.calendar.catalog = { g: 'workbench', view: 'ws.schedule', props: '$.calendar' };
PDL_COMPONENTS.log.catalog = { g: 'workbench', view: 'ws.preview', props: '$.log' };
PDL_COMPONENTS.player.catalog = { g: 'workbench', view: 'ws.replay', get props() { return pdlLoc(PDL_VIEWS['replay.body'].blocks[0].blocks.find(function (b) { return b.use === 'player'; }).props); } };
PDL_COMPONENTS.graph.catalog = { g: 'workbench', props: '$.graph' };
PDL_COMPONENTS.bars.catalog = { g: 'workbench', view: 'cafe.ws.ops', props: '$.quota.bars' };
PDL_COMPONENTS.diff.catalog = { g: 'workbench', props: '$.diff' };
PDL_COMPONENTS.cards.catalog = { g: 'workbench', props: '$.cgrid' };
PDL_COMPONENTS.queue.catalog = { g: 'composer', props: '$.queue' };
PDL_COMPONENTS.media.catalog = { g: 'workbench', props: ['$.lightbox', '$.compareSource', '$.compareReference'] };
PDL_COMPONENTS.pluginConfigForm.catalog = { g: 'structure', vm: 'pcfCatalog', props: ['$.kinds', '$.variants', '$.qr', '$.rows', '$.live'] };   /* 每种字段、分支切换、扫码流程、行结果、限时授权 */

/* ───────── 多行输入：按内容长高（grow）、同行补全（complete）─────────
   grow：浏览器按内容定高度（CSS field-sizing: content，见 core.css），最少 --ta-rows-min 行、最多 --ta-rows-max 行，再多就在框里滚动；不量、不改 style。
   complete：候选里第一条以已输入内容开头的（至少输入了 2 个字、光标在末尾），剩下的部分淡色接在已输入的字后面（同一行）；
   Tab / → 采纳，接着打字就覆盖掉。都是组件自己的本地行为：打字不重画 */
const TA_COMPLETE = {};
function taGhost(ta) {
  const g = ta.parentElement && ta.parentElement.querySelector(':scope > .ta-ghost'); if (!g) return;
  const list = TA_COMPLETE[ta.id] || [], v = ta.value, end = ta.selectionStart === v.length && ta.selectionEnd === v.length;
  const hit = v.length >= 2 && end ? list.find(function (x) { return typeof x === 'string' && x.indexOf(v) === 0 && x.length > v.length; }) || '' : '';
  if (!g._styled) {   /* 覆盖层和输入框同一套排版（挂上时抄一次）：已输入的字透明占位，只露出后面的淡色部分 */
    const cs = getComputedStyle(ta); g._styled = true;
    ['font', 'lineHeight', 'letterSpacing', 'textIndent', 'whiteSpace', 'wordBreak', 'overflowWrap'].forEach(function (k) { g.style[k] = cs[k]; });
    ['Top', 'Right', 'Bottom', 'Left'].forEach(function (d) { g.style['padding' + d] = (parseFloat(cs['padding' + d]) + parseFloat(cs['border' + d + 'Width'])) + 'px'; });   /* 覆盖层没有边框：输入框的边框宽度算进内边距，对齐不变 */
  }
  g.children[0].textContent = v; g.children[1].textContent = hit ? hit.slice(v.length) : '';
  if (hit) ta.dataset.ghost = hit; else delete ta.dataset.ghost;   /* 滚动对齐交给下面的 scroll 监听：打字时不读 scrollTop（读它会让整页先排一次版） */
}
document.addEventListener('input', function (e) { const t = e.target; if (t && t.tagName === 'TEXTAREA' && TA_COMPLETE[t.id]) taGhost(t); }, true);
document.addEventListener('selectionchange', function () { const t = document.activeElement; if (t && t.tagName === 'TEXTAREA' && TA_COMPLETE[t.id]) taGhost(t); });
document.addEventListener('scroll', function (e) { const t = e.target; if (t && t.tagName === 'TEXTAREA') { const g = t.parentElement.querySelector(':scope > .ta-ghost'); if (g) g.scrollTop = t.scrollTop; } }, true);
KEY_FNS.push(function (e) {
  const t = e.target; if (!t || t.tagName !== 'TEXTAREA' || !t.dataset.ghost || e.isComposing || (e.key !== 'Tab' && e.key !== 'ArrowRight') || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return false;
  if (t.selectionStart !== t.value.length || t.selectionEnd !== t.value.length || document.querySelector('.pop-host')) return false;   /* 开着弹层时 Tab 是选候选（弹层自己的键） */
  e.preventDefault(); t.value = t.dataset.ghost; t.setSelectionRange(t.value.length, t.value.length); t.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
});
treeMatch('.ta-wrap > textarea', taGhost);
