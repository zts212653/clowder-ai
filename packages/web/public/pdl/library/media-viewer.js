/* 边界：一个含义一个组件、不为接口定制、不按位置推导样式 */
/* 媒体：图片 / 视频查看器、标绘、时间线播放器 */
'use strict';

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
PDL_COMPONENTS.player.catalog = { g: 'workbench', view: 'ws.replay', get props() { return pdlLoc(PDL_VIEWS['replay.body'].blocks[0].blocks.find(function (b) { return b.use === 'player'; }).props); } };
PDL_COMPONENTS.media.catalog = { g: 'workbench', props: ['$.lightbox', '$.compareSource', '$.compareReference'] };
