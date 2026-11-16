/* 边界：一个含义一个组件、不为接口定制、不按位置推导样式 */
/* 插件配置表单 */
'use strict';

/* ───────── 插件配置表单：插件清单 configuration 的投影（PluginManagerConfigField[]）画成一张表单 ─────────
   props（plugin-config.js 的 pcfModel 整理好）：{ p 表单实例, installed, steps: [{ text / code }], rows: [字段行], fieldCount, testable }
   字段行：{ key, id, kind, label, req, desc（清单的字段说明，原样画在字段下面）, err, value / items / operation }；组件按 kind 画对应的控件。
   操作 op.mode：seq（按钮 → 进行中 → 轮询〔二维码、剩余秒数〕→ 结果 / 已连接 + 断开）、live（限时授权：状态 + 一个按钮）、rows（列表按钮 + 行，每行自己的动作）。
   都是组件库的控件（field、sel、sw、kvEditor、btn、status、notice、lrow）；点了什么由 data-act（pcf*）+ 实例 / 字段 / 动作给出 */
/* 动作的结果：标签是一行状态；文本结果（网址、要粘贴的消息）是可复制的值 */
function pcfFb(fb) {   /* 文本结果是表单里的一个只读框（和输入框同一个样子，按内容长高）+ 框尾的复制 */
  if (!fb) return '';
  const copy = fb.copy ? '<span class="combo"><textarea class="input' + (/\s/.test(fb.copy) ? '' : ' mono') + '" readonly data-grow rows="1" aria-label="' + h(fb.label || tc('common.copy')) + '">' + h(fb.copy) + '</textarea>' +
    btn(tc('common.copy'), { iconOnly: true, sm: true, icon: 'copy', act: 'copy', data: argAttrs({ v: fb.copy, msg: tc('control.copied', fb.label || tc('common.copy')) }) }) + '</span>' : '';
  return (fb.label ? status('ok', fb.label) : '') + copy;
}
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
  if (r.kind === 'operation') return pcfOpHtml(r.operation);
  if (r.kind === 'select') {
    const options = r.options.map(function (x) { return { v: x.value, label: pv(x.label, x, x) }; });
    return sel(r.id, !r.record && r.value === '' ? [{ v: '', label: tc('pcf.choose') }].concat(options) : options, r.value, { change: r.record ? 'pcfRecSel' : 'pcfSel', data: d, invalid: !!r.err, label: label });
  }
  if (r.kind === 'member') return memberPick({ id: r.id, pool: r.options, value: r.value, multi: r.multiple, none: tc('pcf.choose'), change: 'pcfSel', data: d, label: label, act: 'pcfOp', args: { op: 'pick', p: p, k: r.key } });
  if (r.kind === 'thread') return sel(r.id, (r.multiple ? [] : [{ v: '', label: tc('pcf.choose') }]).concat(r.options.map(function (x) { return { v: x.value, label: x.label }; })), r.value, { change: 'pcfSel', data: d, label: label, multi: r.multiple, act: 'pcfOp', args: { op: 'pick', p: p, k: r.key }, key: 'id', none: tc('pcf.choose') });
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
PDL_COMPONENTS.pluginConfigForm.catalog = { g: 'structure', vm: 'pcfCatalog', props: ['$.kinds', '$.variants', '$.qr', '$.rows', '$.live'] };   /* 每种字段、分支切换、扫码流程、行结果、限时授权 */
