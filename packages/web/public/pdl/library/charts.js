/* 边界：一个含义一个组件、不为接口定制、不按位置推导样式 */
/* 图表：关系图、柱状图 */
'use strict';

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
PDL_COMPONENTS.graph.catalog = { g: 'workbench', props: '$.graph' };
PDL_COMPONENTS.bars.catalog = { g: 'workbench', view: 'cafe.ws.ops', props: '$.quota.bars' };
