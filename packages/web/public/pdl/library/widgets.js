/* 边界：一个含义一个组件、不为接口定制、不按位置推导样式 */
/* 其他复合组件：日历、卡片网格、排队消息 */
/* 复合组件（这里和 code.js、media-viewer.js、charts.js、plugin-form.js）都登记在 PDL_COMPONENTS，只在组件库里登记（lint：pdl-comp）。
   契约：组件只吃数据（props），不读页面状态、不认识页面名和功能 ID；点了执行什么由 props 里的 { act, args } 给出，
   文字由组件的 i18n 或 PDL 绑定；状态和计数由数据给出。props 的字段见各组件的 catalog（组件目录）。 */
'use strict';
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
    const text = x.processing ? tc('queue.preparing') + ' · ' + x.text : x.text;
    return { key: x.key, orderable: !!order && !!x.orderable, layout: 'record', hook: 'qitem', title: '<span data-tip="' + h(x.text) + '">' + h(text) + '</span>', cols: [{ w: 'ctl', v: p.targets && x.delivery ? '<span class="qto">' + x.delivery.map(function (target) { return pvParts(p.targets, target, root); }).join('') + '</span>' : x.to.length ? '<span class="qto">' + x.to.map(function (id) { return whoAva(id, { size: 'sm', tip: tc('queue.to', who(id, 'text', { handle: true })) }); }).join('') + '</span>' : '' }],
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
PDL_COMPONENTS.calendar.catalog = { g: 'workbench', view: 'ws.schedule', props: '$.calendar' };
PDL_COMPONENTS.cards.catalog = { g: 'workbench', props: '$.cgrid' };
PDL_COMPONENTS.queue.catalog = { g: 'composer', props: '$.queue' };
