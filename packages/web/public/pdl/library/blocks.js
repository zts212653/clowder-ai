/* 边界：一个含义一个组件、不为接口定制、不按位置推导样式 */
/* 视图块的画法（组件库）：片段、控件、行、设置行、头、列表、全部块（PDL_BLOCKS 的内容）、节点模板、读取状态、提示、小节目录。
   视图引擎（取值、本地化、按块派发、视图的读取状态、下钻的返回、契约 PDL_SCHEMA）在 engine/pdl-view.js；这里只画，块只在这里登记（lint：pdl-block）。 */
'use strict';
const RESULT_TONE = { approved: 'ok', rejected: 'danger' };
/* 按钮的两个外壳角色（PDL_ROLES.button）：drawer = 打开侧栏抽屉（只在侧栏收成抽屉时出现）；reveal = 把收起的侧栏放回来（侧栏是抽屉时没有它）。出不出现由组件库的样式按容器决定 */
const BTN_ROLE_CLS = { drawer: 'nav-toggle', reveal: 'cafe-expand' };   /* 决定结果的状态 → 色调（组件自己的表） */
/* 组件目录的登记（和契约放在一起，只有这一份）：每个块 / 控件属于哪一组（g），示例是 PDL（ex，和页面写法一样，数据来自目录的样例视图模型 /api/catalog/sample）。
   tones：带严重度的组件按四档（info / ok / warn / danger）各画一次，示例里的 %tone 换成那一档。目录（catalog.js）从这里和 PDL_SCHEMA 枚举，不另写一份清单 */
const PDL_CATALOG = {
  app: { g: 'structure', ex: [{ type: 'chatpage', key: 'catalog.handle', body: [{ type: 'text', text: '$.title' }], side: [{ type: 'app', name: 'handle', region: 'panel', demo: true }] }] },   /* 固定件放在所属容器里展示；demo 不看区域当前开关。 */
  back: { g: 'basics', ex: [{ type: 'back', label: 't:common.cancel', act: 'noop' }] },
  dialog: { g: 'popups', ex: [{ type: 'button', label: 't:common.open', act: 'catalogDialog' }] },
  box: { g: 'structure', ex: [{ type: 'box', variant: 'card', blocks: [{ type: 'text', variant: 'title', text: '$.title' }, { type: 'text', variant: 'para', text: '$.sub' }] }],
    tones: [{ type: 'box', variant: 'card', tone: '%tone', blocks: [{ type: 'text', variant: 'title', text: '$.toneText.%tone' }] }] },
  jump: { g: 'composer', ex: [{ type: 'jump', icon: 'latest', label: 't:composer.jump', tip: 't:composer.jump', act: 'noop' }] },
  notices: { g: 'alerts', ex: [{ type: 'notices', items: '$.notices' }], tones: [{ type: 'notices', items: '$.noticeTones.%tone' }] },
  stack: { g: 'composer', ex: [{ type: 'stack', items: [{ type: 'chip', label: '$.chips.0' }, { type: 'chip', label: '$.chips.1' }] }] },
  button: { g: 'basics', ex: [{ type: 'button', variant: 'meta', act: 'noop', parts: [{ icon: 'trace', size: 's' }, { text: '$.label' }] }, { type: 'button', primary: true, label: '$.save', act: 'noop' }, { type: 'button', label: '$.cancel', act: 'noop' }, { type: 'button', danger: true, label: 't:common.delete', act: 'noop' }, { type: 'button', primary: true, danger: true, label: 't:common.delete', act: 'noop' }, { type: 'button', link: true, label: '$.more', act: 'noop' }, { type: 'button', iconOnly: true, icon: 'copy', label: 't:common.copy', act: 'noop' }] },
  capsules: { g: 'identity', ex: [{ type: 'capsules', from: '$.runners', label: '$.title' }] },
  check: { g: 'basics', ex: [{ type: 'check', value: '$.on', label: '$.label', act: 'noop' }, { type: 'check', value: '$.off', label: '$.label2', act: 'noop' }] },
  each: { g: 'structure', ex: [{ type: 'each', from: '$.eachRows', blocks: [{ type: 'notice', text: '@title' }] }, { type: 'toolbar', items: [{ type: 'each', from: '$.kv', control: { type: 'chip', kind: '@k', label: '@v', act: 'noop' } }] }] },
  chip: { g: 'basics', ex: [{ type: 'chip', label: '$.chips.0' }, { type: 'chip', label: '$.chips.1', act: 'noop', pressed: true, check: true }, { type: 'chip', icon: 'file', label: '$.chips.2', x: { act: 'noop', label: 't:common.remove' } }, { type: 'chip', thumb: '$.lightbox.src', label: '$.chips.0', act: 'noop', x: { act: 'noop', label: 't:common.remove' } }] },
  choices: { g: 'basics', ex: [{ type: 'choices', variant: 'multi', from: '$.checks', act: 'noop' }, { type: 'choices', group: 'cat-ch', from: '$.opts', value: 'a' }] },
  component: { g: 'structure', ex: [{ type: 'component', use: 'diff', props: '$.diff' }] },
  content: { g: 'message', ex: [{ type: 'content', html: '$.long' }] },
  tints: { g: 'basics', ex: [{ type: 'tints', value: '$.tint', act: 'noop', label: '$.label' }] },
  toc: { g: 'structure', ex: [{ type: 'box', variant: 'columns', blocks: [{ type: 'toc' }, { type: 'box', blocks: [{ type: 'section', id: 'cat-toc-a', title: '$.title', keep: true, blocks: [{ type: 'text', variant: 'para', text: '$.sub' }] }, { type: 'section', id: 'cat-toc-b', title: '$.label2', keep: true, blocks: [{ type: 'text', variant: 'para', text: '$.sub' }] }] }] }] },
  disclosure: { g: 'structure', ex: [{ type: 'disclosure', key: 'a', act: 'noop', open: '$.on', title: '$.title', sub: '$.sub', blocks: [{ type: 'text', variant: 'para', text: '$.long' }] }, { type: 'disclosure', key: 'catalog-disc', title: '$.title', blocks: [{ type: 'settings', from: '$.setRows' }] }, { type: 'disclosure', title: '$.label2', blocks: [{ type: 'text', variant: 'para', text: '$.sub' }] }] },
  empty: { g: 'structure', ex: [{ type: 'empty', text: '$.empty', help: '$.emptyHelp' }, { type: 'empty', icon: 'puzzle', text: '$.empty' }] },
  fold: { g: 'structure', ex: [{ type: 'fold', key: 'catalog-fold', height: 's', blocks: [{ type: 'text', variant: 'para', text: '$.long' }] }] },
  form: { g: 'structure', ex: [{ type: 'form', id: 'catalog', blocks: [{ type: 'settings', from: '$.setRows' }] }] },
  frame: { g: 'structure', ex: [{ type: 'frame', plugin: 'companion', what: '$.title' }, { type: 'frame', icon: '$.preview.icon', title: '$.preview.title', note: '$.preview.note' }, { type: 'frame', html: '<p>HTML</p>', title: '$.title' } ] },
  grow: { g: 'structure', ex: [{ type: 'toolbar', items: [{ type: 'button', label: '$.cancel', act: 'noop' }, { type: 'grow' }, { type: 'button', primary: true, label: '$.save', act: 'noop' }] }] },
  head: { g: 'structure', ex: [{ type: 'head', lead: [{ glyph: '$.packageIcon' }], title: '$.title', actions: [{ type: 'button', label: '$.more', act: 'noop' }] }] },
  input: { g: 'basics', ex: [{ type: 'input', id: 'cat-in', placeholder: '$.placeholder' }, { type: 'input', id: 'cat-ta', rows: 3, placeholder: '$.placeholder', value: '' }, { type: 'input', id: 'cat-in2', value: '$.value', label: '$.label', mono: true }, { type: 'input', id: 'cat-ta-grow', rows: true, grow: true, complete: '$.history', placeholder: '$.placeholder', value: '' }] },
  kv: { g: 'rows', ex: [{ type: 'kv', from: '$.kvPeople' }, { type: 'kv', from: '$.kvLong' }] },
  label: { g: 'rows', ex: [{ type: 'label', text: '$.title', count: '$.n' }, { type: 'label', text: '$.label', help: '$.sub' }] },
  lanes: { g: 'composer', ex: [{ type: 'lanes', lanes: [{ share: 1, name: 'run', scroll: true, items: [{ type: 'capsules', from: '$.runners', label: '$.title' }] }, { share: 3, name: 'notice', align: 'center', items: [{ type: 'notices', items: '$.notices' }] }, { share: 1, name: 'queue', align: 'end', items: [{ type: 'chip', label: '$.chips.0' }] }] }] },
  list: { g: 'rows', ex: [{ type: 'list', from: '$.rows', row: { layout: 'two', title: '@title', sub: '@sub' } }] },
  markdown: { g: 'message', ex: [{ type: 'markdown', text: '$.md' }] },
  more: { g: 'basics', ex: [{ type: 'more', menu: 'work', label: '$.more' }] },
  notice: { g: 'alerts', ex: [{ type: 'notice', text: '$.sub' }, { type: 'notice', tone: 'warn', text: '$.toneText.warn' }],
    tones: [{ type: 'notice', tone: '%tone', text: '$.toneText.%tone' }],
    banner: [{ type: 'notice', tone: '%tone', strong: '$.bannerStrong.%tone', text: '$.toneText.%tone', action: [{ type: 'button', sm: true, label: '$.more', act: 'noop' }, { type: 'button', sm: true, label: '$.save', act: 'noop' }] }] },
  ordered: { g: 'structure', ex: [{ type: 'ordered', order: '$.order', blocks: { a: { type: 'notice', text: '$.label' }, b: { type: 'notice', text: '$.label2' } } }] },
  picker: { g: 'composer', ex: [{ type: 'picker', label: '$.chips.0', prefix: 't:composer.afterCreate', act: 'noop', icon: 'box' }, { type: 'picker', label: '$.label2', check: '$.on', act: 'noop' }] },
  pre: { g: 'basics', ex: [{ type: 'pre', text: '$.code' }] },
  color: { g: 'basics', ex: [{ type: 'color', id: 'cat-col-b', value: '$.color.value', label: '$.color.label', preview: '$.color.label', slots: 'name' }] },
  pop: { g: 'popups', ex: [{ type: 'pop', pos: '$.popPos', blocks: [{ type: 'opts', from: '$.pop' }] }] },
  opts: { g: 'popups', ex: [{ type: 'opts', from: '$.pop' }] },
  chatpage: { g: 'message', ex: [{ type: 'chatpage', key: 'catalog.chat', head: [{ type: 'head', title: '$.title' }], body: [{ type: 'stream', id: 'catalog', from: '$.stream' }], dock: [{ type: 'notice', text: '$.placeholder' }] }] },
  ticks: { g: 'message', ex: [{ type: 'ticks', from: '$.ticks' }] },
  typed: { g: 'structure', ex: [{ type: 'typed', slot: 'chat.rich', of: 'card', data: '$', blocks: [{ type: 'notice', text: '$.label' }] }] },
  threads: { g: 'rows', ex: [{ type: 'threads', from: '$.threads' }] },
  range: { g: 'basics', ex: [{ type: 'range', id: 'cat-range', min: 0, max: 100, step: 5, value: '$.range', unit: '%', input: 'noop', label: '$.label' }] },
  reply: { g: 'message', ex: [{ type: 'reply', ref: '$.reply' }] },
  search: { g: 'basics', ex: [{ type: 'search', id: 'cat-q', placeholder: '$.search', value: '' }] },
  section: { g: 'structure', ex: [{ type: 'section', title: '$.title', help: '$.sub', actions: [{ type: 'button', label: '$.more', act: 'noop' }], blocks: [{ type: 'settings', from: '$.setRows' }] }] },
  seg: { g: 'basics', ex: [{ type: 'seg', from: '$.seg', act: 'noop' }, { type: 'seg', variant: 'tabs', from: '$.seg', act: 'noop' }] },
  select: { g: 'basics', ex: [{ type: 'select', id: 'cat-sel', options: '$.opts', value: 'a', label: '$.label' }, { type: 'select', id: 'cat-sel2', options: '$.opts', value: 'b' }, { type: 'select', variant: 'member', id: 'cat-mp', options: '$.memberOpts', value: '$.memberOne', label: '$.label' }, { type: 'select', variant: 'member', multi: true, id: 'cat-mp2', options: '$.memberOpts', value: '$.memberSome', act: 'noop', label: '$.label' }] },
  send: { g: 'composer', ex: [{ type: 'send', tip: '$.save' }, { type: 'send', stop: '$.on', tip: '$.cancel' }] },
  settings: { g: 'structure', ex: [{ type: 'settings', from: '$.setRows' }, { type: 'settings', rows: [{ label: '$.label', ctls: [{ type: 'switch', value: '$.on', act: 'noop', label: '$.label' }] }] }] },
  slot: { g: 'message', ex: [{ type: 'slot', slot: 'chat.message.actions', ctx: '$.slotCtx' }] },
  split: { g: 'structure', ex: [{ type: 'split', variant: 'aside', left: [{ type: 'settings', from: '$.setRows' }], right: [{ type: 'kv', from: '$.kv' }] }, { type: 'split', variant: 'aside', scroll: 'panes', left: [{ type: 'markdown', text: '$.md' }], right: [{ type: 'settings', from: '$.setRows' }] }] },
  stats: { g: 'rows', ex: [{ type: 'stats', from: '$.stats' }] },
  result: { g: 'message', ex: [{ type: 'result', status: 'approved', label: '$.statusText.ok', key: 'cat-result', blocks: [{ type: 'text', variant: 'para', text: '$.sub' }] }, { type: 'result', status: 'expired', label: '$.statusText.info', key: 'cat-result2' }] },
  status: { g: 'alerts', ex: [{ type: 'status', text: '$.statusText.info' }, { type: 'status', tone: 'ok', text: '$.statusText.ok' }], tones: [{ type: 'status', tone: '%tone', text: '$.statusText.%tone' }] },
  steps: { g: 'rows', ex: [{ type: 'steps', from: '$.steps' }, { type: 'steps', variant: 'checks', from: '$.stepChecks' }, { type: 'steps', variant: 'progress', from: '$.stepChecks' }] },
  stream: { g: 'message', ex: [{ type: 'stream', id: 'catalog', from: '$.stream' }] },
  switch: { g: 'basics', ex: [{ type: 'switch', value: '$.on', act: 'noop', label: '$.label' }, { type: 'switch', value: '$.off', act: 'noop', label: '$.label2' }] },
  tabs: { g: 'structure', ex: [{ type: 'tabs', label: '$.title', from: '$.tabs', act: 'noop', args: { k: '@k' }, selected: '@on', tip: '@label', parts: [{ text: '@label' }] }] },
  text: { g: 'basics', ex: [{ type: 'text', variant: 'para', text: '$.sub' }, { type: 'text', variant: 'meta', text: '$.value' }], tones: [{ type: 'text', variant: 'meta', tone: '%tone', text: '$.statusText.%tone' }] },
  tiles: { g: 'basics', ex: [{ type: 'tiles', from: '$.tiles', act: 'noop' }] },
  tags: { g: 'rows', ex: [{ type: 'tags', id: 'cat-chipbox', values: '$.chipVals', k: 'tags', placeholder: '$.placeholder', label: '$.label' }, { type: 'tags', from: '$.tagItems', pick: { act: 'noop' }, remove: { act: 'noop', label: 't:classify.deleteTag' }, add: { id: 'cat-tag', act: 'noop', tint: { id: 'cat-tag-tint', value: '#94b2cc', label: 't:control.color' } } }] },
  toolbar: { g: 'structure', ex: [{ type: 'toolbar', left: [{ type: 'text', variant: 'meta', text: '$.title' }], right: [{ type: 'button', label: '$.more', act: 'noop' }, { type: 'button', primary: true, label: '$.save', act: 'noop' }] }] },
  tree: { g: 'rows', ex: [{ type: 'tree', id: 'catalog-tree', nodes: '$.tree', row: { lead: [{ icon: 'folder', size: 's', when: '@dir' }, { icon: 'file', size: 's', when: '!@dir' }], title: { text: '@name', mono: true } } }] },
  upload: { g: 'basics', ex: [{ type: 'upload', icon: 'upload', label: '$.upload', accept: 'image/*', msg: '$.value' }] },
  copy: { g: 'basics', ex: [{ type: 'copy', value: '$.path', label: 't:composerPop.copyPath', tip: 't:composerPop.pathReadonly', mono: true }] },   /* 可复制的值：值 + 复制图标 */
  view: { g: 'structure', ex: [{ type: 'view', id: 'chat.welcome' }] },
  kvlist: { g: 'basics', ex: [{ type: 'kvlist', key: 'catalog', rows: '$.kvRows', input: 'noop', add: 'noop', del: 'noop' }] },
  avatar: { g: 'identity', ex: [{ type: 'avatar', lead: '$.lead', size: 'l' }] }
};

/* ───────── 片段 ───────── */
/* 图标档位（PDL 只写档位）：xs 12 · s 14 · m 16 · l 20 */
const ICON_STEP = { xs: 12, s: 14, m: 16, l: 20 };
/* 片段的角色（PDL_ROLES.part）：meta 次要信息、badge 短代码徽标（颜色来自 tone）、twisty 跟着展开状态转的箭头 */
const PART_ROLE = { meta: 'vw-meta', badge: 'vw-badge', twisty: 'vw-ic vw-turn' };
function pvPart(p, sc, root) {
  if (p == null) return '';
  if (typeof p === 'string') return pvText(p, sc, root);
  if (!pvOk(p.when, sc, root)) return '';
  if (p.lit != null) return h(String(p.lit));
  if ('of' in p) { const x = pv(p, sc, root); return x == null ? '' : typeof x === 'object' ? pvPart(x, sc, root) : h(String(x)); }   /* 值的写法 / 值映射当片段：取到字就转义，取到片段就照片段画 */
  if (p.use) { const f = PDL_COMPONENTS[p.use]; if (!f) console.error(tc('engine.part.error', p.use)); return f ? f(pv(p.props, sc, root), sc, root) : ''; }
  if (p.control) return typeof p.control === 'string' ? pvControls(p.control, sc, root) : pvControl(p.control, sc, root);   /* 写成路径：控件来自数据（行自己的勾选这类） */
  if (p.roll) {   /* 轮换的一行：先显示 a（当前动作），停 --roll-hold 后向上滚成 b（累计数）；a 变了节点就重画，动画从头开始。at = 这个动作开始的时刻（生成 HTML 时才算过去了多久，视图模型被缓存也照样接着走；旧的 t = 秒数仍认） */
    const r = pv(p.roll, sc, root); if (!r) return '';
    /* after：跟在每一行文字后面的尾巴（比如展开的箭头）——两行宽度不同，尾巴放进行里才能永远紧跟当前那行的文字 */
    const tail = p.after ? pvPart(p.after, sc, root) : '';
    return '<span class="roll"' + (r.at ? ' data-at="' + r.at + '"' : '') + '><span class="roll-in"><span class="roll-a">' + pvLit(p.a == null ? r.a : pv(p.a, sc, root), sc, root) + tail + '</span><span class="roll-b">' + pvLit(p.b == null ? r.b : pv(p.b, sc, root), sc, root) + tail + '</span></span></span>';
  }
  if (typeof p.t === 'string') {   /* 一句带片段参数的话：{ t: 键, args: [值或片段] }——值照常填进字里，片段参数（{ parts, mono } 这类）画好再放进去，其余的字都转义 */
    const rich = [], args = (p.args || []).map(function (a) { if (a && typeof a === 'object' && !a.t && !('of' in a)) { rich.push(pvPart(a, sc, root)); return '\u0001' + (rich.length - 1) + '\u0001'; } return pv(a, sc, root); });
    return h(tc.apply(null, [p.t].concat(args))).replace(/\u0001(\d+)\u0001/g, function (m, i) { return rich[+i]; });
  }
  if (p.hint !== undefined) return helpTip(pv(p.hint, sc, root));   /* hint：就是 help */
  if (p.br) return '<br>';
  if (p.swatch) return '<span class="u-v-background theme-dot" style="--u-background:' + h(pv(p.swatch, sc, root)) + '"></span>';   /* 色块：颜色来自数据（主题强调色） */
  if (p.tile) return letterTile(pvText(p.tile, sc, root));
  if (p.bar != null) return progBar(pv(p.bar, sc, root), pv(p.tone, sc, root));
  if (p.parts) {   /* 一组片段包在一层里（variant 给样式；form 时是一张小表单） */
    const tone = pv(p.tone, sc, root), cls = ((p.variant ? PART_ROLE[p.variant] || '' : '') + (tone ? ' vw-t-' + tone : '')).trim(), tip = pv(p.tip, sc, root), tag = p.form ? 'form' : 'span';   /* tone：整组一个色调（一层） */
    const inner = typeof p.parts === 'string' ? (p.each ? pvGlue(pvList(p.parts, sc, root).map(function (x) { return pvPart(p.each, x, root); }), p.sep != null ? p.sep : '') : p.sep != null ? pvGlue((pv(p.parts, sc, root) || []).map(function (x) { return typeof x === 'string' ? h(x) : pvPart(x, sc, root); }), p.sep) : pvLit(pv(p.parts, sc, root), sc, root)) : pvJoin(p.parts, sc, root, p.sep != null ? p.sep : '');   /* sep：片段之间的分隔（数据里的字原样当文字，'@…' 也不当绑定）；each：一组数据每项怎么画（@ 是那一项） */
    if (pv(p.mono, sc, root)) return '<span class="mono">' + inner + '</span>';   /* mono：这一组片段整个用等宽字（工具名、路径这类） */
    if (!p.variant && !tone && !tip && !p.form && !p.note) return inner;
    return '<' + tag + (cls ? ' class="' + cls + '"' : '') + pvNote(p.note) + (p.form ? ' data-form="' + p.form + '"' : '') + (tip ? ' data-tip="' + h(tip) + '"' : '') + '>' + inner + '</' + tag + '>';
  }
  if (p.who) { const w = pv(p.who, sc, root); if (Array.isArray(w)) return '<span class="hb-av">' + w.map(function (x) { return avatar(WHO_DATA.member(x), 'sm'); }).join('') + '</span>'; const x = who(w, p.form || 'avatar', { size: p.size || PV.leadSize || 's', health: !!pv(p.health, sc, root) }); return x; }
  if (p.tint != null) return tintDot(pv(p.tint, sc, root));   /* 色调点（标签颜色） */
  if (p.icon) {   /* 图标；可带文字（variant 给样式，如计数 n、类型 kind） */
    const ic = icon(pv(p.icon, sc, root), ICON_STEP[pv(p.size, sc, root)] || 15), tone = pv(p.tone, sc, root), tip = pv(p.tip, sc, root), t = p.text != null ? pvText(p.text, sc, root) : '';
    const cls = ((p.variant ? PART_ROLE[p.variant] : 'vw-ic') + (tone ? ' vw-t-' + tone : '')).trim();
    return p.variant || tone || tip || t ? '<span class="' + cls + '"' + (tip ? ' data-tip="' + h(tip) + '"' : '') + '>' + ic + t + '</span>' : ic;
  }
  if (p.glyph) return glyph(pv(p.glyph, sc, root), p.size === 'xl' ? 'glyph-xl' : '');   /* xl：页头里的大图标，和成员头像 xl 一样大 */
  if (p.dot != null) return lrDot(pv(p.dot, sc, root), pv(p.tip, sc, root));
  if (p.status) { const st = pv(p.status, sc, root); return st ? status(st.tone, st.text, st.strong) : ''; }
  if (p.chip != null) { const t = pv(p.mono, sc, root) ? '<span class="mono">' + pvText(p.chip, sc, root) + '</span>' : pvText(p.chip, sc, root), act = pv(p.act, sc, root); return chipItem(t, act, act ? pvArgs(p.args, sc, root) : ''); }   /* act 可以是绑定（每项模板里 '@act'） */
  if (p.chips) { const xs = pvList(p.chips, sc, root); return chipList(xs.length ? xs.map(function (x) { return pvPart(p.each || x, x, root); }) : p.empty ? ['<span class="faint">' + pvText(p.empty, sc, root) + '</span>'] : []); }   /* each：每一项怎么画（片段，@ 是这一项的数据）；没写时每一项本身就是片段 */
  /* 文字 */
  const t0 = pvText(p.text, sc, root);
  if (p.mark) return t0 ? '<mark>' + t0 + '</mark>' : '';
  if (p.strong) return '<b class="vw-strong">' + t0 + '</b>';
  const tone = pv(p.tone, sc, root), tip = pv(p.tip, sc, root), cls = (p.variant ? PART_ROLE[p.variant] || '' : '') + (tone ? ' vw-t-' + tone : '');
  const t = cls.trim() || tip ? '<span' + (cls.trim() ? ' class="' + cls.trim() + '"' : '') + (tip ? ' data-tip="' + h(tip) + '"' : '') + '>' + t0 + '</span>' : t0;
  return pv(p.mono, sc, root) ? '<span class="mono">' + t + '</span>'  : p.num ? '<span class="num">' + t + '</span>' : t;
}
/* 片段列表：数组或 { parts, sep }；默认用空格连接 */
function pvParts(ps, sc, root) {
  if (ps == null) return '';
  ps = pdlLoc(ps);
  if (!Array.isArray(ps) && typeof ps === 'object' && ps.parts) return pvJoin(ps.parts, sc, root, ps.sep == null ? ' ' : ps.sep);
  return pvJoin(ps, sc, root, ' ');
}
/* 片段之间用 sep 连接；排版规则：全角标点（：，。、；）前面不加分隔，紧贴前一段 */
const PV_GLUE = /^[：，。、；）」』]/;
function pvJoin(ps, sc, root, sep) { return pvGlue((Array.isArray(ps) ? ps : [ps]).map(function (p) { return pvPart(p, sc, root); }), sep); }
function pvGlue(xs, sep) { return xs.filter(Boolean).reduce(function (acc, x, k) { return k && !PV_GLUE.test(x) ? acc + sep + x : acc + x; }, ''); }
/* 一处内容：写成路径时取视图模型的值（字符串原样当文字、数组 / 对象按片段画）；写成片段时按片段画 */
function pvAny(x, sc, root) { return x == null ? '' : typeof x === 'string' ? pvLit(pv(x, sc, root), sc, root) : pvParts(x, sc, root); }
/* 来自视图模型的内容：字符串原样当文字；数组 / 对象按片段画 */
function pvLit(x, sc, root) { if (x == null) return ''; if (typeof x === 'string') return h(x); return (Array.isArray(x) ? x : [x]).map(function (p) { return typeof p === 'string' ? h(p) : pvPart(p, sc, root); }).filter(Boolean).reduce(function (acc, x, k) { const el = /^</.test(x) !== />$/.test(acc); return k && el && !/\s$/.test(acc) && !/^\s/.test(x) && !PV_GLUE.test(x) ? acc + ' ' + x : acc + x; }, ''); }   /* 文字和组件（状态、标签……）相邻时隔一个空格；视图模型自己带了空白或分隔的照旧 */

/* ───────── 控件 ───────── */
function pvSegItems(c, sc, root) {
  const cur = pv(c.value, sc, root), xs = c.item ? pvList(c.options || c.from, sc, root) : pvItems(c.options || c.from, sc, root);
  return xs.map(function (o) { return { v: o.v, label: o.label, count: o.count, warn: o.warn, g: o.g, why: o.why, active: o.active != null ? o.active : o.v === cur }; });
}
/* 只读上下文：视图声明 readonly（比如回放剧场）时，里面的消息和卡片不带操作——消息的工具条不画，卡片里能触发动作的控件不画。
   这是消息 / 卡片组件自己的能力：PV_RO 由视图开关，PV_INERT 在画消息节点时打开 */
const PV_TOC = '\u0000toc\u0000';   /* 目录的占位（见 toc 块） */
/* 画一段 PDL，里面的小节目录（toc）换成这段里带 id 的小节标题（锚点）：视图和组件目录的示例都走这里 */
function pvWithToc(fn) {
  const prev = PV.anchors; PV.anchors = [];
  try { const s = fn(); return s.indexOf(PV_TOC) < 0 ? s : s.split(PV_TOC).join(PV.anchors.map(function (a) { return navRow({ label: a.label, attrs: ' data-act="anchorScroll"' + argAttrs({ id: a.id }) }); }).join('')); }
  finally { PV.anchors = prev; }
}
function pvControl(c, sc, root) {
  c = pvItemize(pdlLoc(c), sc, root);
  if (!c || !pvOk(c.when, sc, root)) return '';
  if (c.stay) return pvStay(pvControl(Object.assign({}, c, { stay: false }), sc, root));
  if (c.key && pdlNodeHidden(c.key)) return '';   /* 用户在 界面元素 里关掉的节点：连同里面的东西一起不画 */
  if (c.plugin) pdlPluginNeed(c.plugin);   /* 插件插进来的控件画出来了：取回它的子树（延迟加载） */
  /* hideWhileTyping：所在的输入区域（typing-scope）里正在打字时淡出，停下约 1.5 秒后淡回（组件库的通用行为，不重画）；支持它的组件自己在外层元素上写 data-htype */
  const htype = c.hideWhileTyping ? ' data-htype' : '';
  if (PV.inert && (c.act || c.change || c.input || c.menu || c.type === 'more' || c.type === 'switch')) return '';
  const P = function (x) { return pv(x, sc, root); };
  let data = pvArgs(c.args, sc, root);
  /* items：按钮 / 选择器点开的菜单在这里声明（和 more 的 items 同一种写法）；样子不变，动作是打开这个菜单 */
  if (c.items && (c.type === 'button' || c.type === 'picker')) { data += ' data-menu="' + menuLive(pvMenu(c.items, sc, root)) + '"' + MENU_DECL; c = Object.assign({}, c, { act: 'menu', items: null }); }
  switch (c.type) {
    case 'button':
      if (c.variant === 'nav') return navRow({ label: pvText(c.label, sc, root), attrs: ' data-act="' + c.act + '"' + data, current: P(c.current) ? 'true' : '' });   /* 页面目录：和侧栏导航同一种行 */
      if (c.variant === 'meta') {   /* 次要信息那一行里的文字按钮（消息的过程记录行）：墨色小字，悬停变强调色 */
        const ex = c.expanded != null ? ' aria-expanded="' + !!P(c.expanded) + '"' : '';
        return '<button type="button" class="meta-btn" data-act="' + c.act + '"' + data + ex + '>' + (c.parts ? pvJoin(c.parts, sc, root, '') : pvText(c.label, sc, root)) + '</button>';
      }
      if (c.variant === 'cycle')   /* 点一下换到下一个状态：圆形状态标记（任务） */
        return '<button type="button" class="tk-st" data-act="' + c.act + '"' + data + ' data-tip="' + pvText(c.tip, sc, root) + '" aria-label="' + pvText(c.label, sc, root) + '"><span class="tk-g ' + pvText(c.state, sc, root) + '" aria-hidden="true"></span></button>';
      if (c.variant === 'title')   /* 页面标题本身是按钮（点了改名） */
        return '<button type="button" class="chat-title cafe-title" data-title data-act="' + c.act + '"' + data + ' data-tip="' + pvText(c.tip, sc, root) + '"' + pvNote(c.note) + '>' + pvText(c.label, sc, root) + '</button>';
      if (c.who) {   /* 带成员的按钮：头像叠放（最多 3 个）+ 可选文字 + 下箭头（打开成员列表） */
        const ids = pvList(c.who, sc, root), lab = pvText(c.label, sc, root);
        return '<button type="button" class="cafe-people" data-act="' + c.act + '"' + data + ' aria-label="' + pvText(c.aria, sc, root) + '" data-tip="' + pvText(c.tip, sc, root) + '"' + pvNote(c.note) + '><span class="stack">' + ids.slice(0, 3).map(function (id) { return whoAva(id, { size: 'sm', tip: false }); }).join('') + '</span>' + (lab ? '<span class="cafe-ellip vw-w80">' + lab + '</span>' : '') + icon('down', 12) + '</button>';
      }
      if (c.menu) return '<button type="button" class="target" data-act="menu" data-menu="' + c.menu + '"' + MENU_DECL + ' data-tip="' + pvText(c.tip, sc, root) + '">' + (c.icon ? icon(c.icon, 14) : '') + '<span class="cafe-ellip">' + pvText(c.label, sc, root) + '</span>' + icon('down', 12) + '</button>';   /* 打开菜单选一项：图标 + 当前值 + 下箭头（和输入框里的“项目 / 发给”同一种触发） */
      if (c.open != null) return btn(pv(c.label, sc, root), { sm: true, act: c.act, icon: c.icon, data: data + ' aria-expanded="' + !!P(c.open) + '"' + (c.tip ? ' data-tip="' + pvText(c.tip, sc, root) + '"' : ''), html: pvText(c.label, sc, root) + twisty(P(c.open)) });
      if (c.parts) return btn('', { sm: c.sm !== false, primary: P(c.primary), act: c.act, data: data, html: pvJoin(c.parts, sc, root, '') });
      return btn(P(c.label), { cls: BTN_ROLE_CLS[c.variant] || '', primary: !!P(c.primary), link: !!c.link, danger: !!P(c.danger), sm: true, size: c.size, icon: P(c.icon), act: P(c.act), data: data + (c.tip && !P(c.disabled) ? ' data-tip="' + pvText(c.tip, sc, root) + '"' : ''), iconOnly: !!c.iconOnly, disabled: !!P(c.disabled), why: P(c.disabled) && c.tip ? pvText(c.tip, sc, root) : '',   /* 停用 + 提示 = 停用的原因（悬停看、点了也说） */ pressed: c.pressed != null ? !!P(c.pressed) : null, busy: !!P(c.busy), note: c.note, submit: !!c.submit });   /* 四种样子只由按钮自己的声明决定：默认浅底，primary 实底，danger 危险（见 btn）；不看所在的位置 */
    case 'picker': {   /* 输入框里的“项目 / 发给”：图标或头像 + 当前值 + 下箭头，可带“自动”标记 */
      const lead = c.who ? whoAva(P(c.who), { size: 'sm', tip: false }) : icon(c.icon, 14), dis = c.disabled != null && !!P(c.disabled);
      if (c.check != null) { const on = !!P(c.check); return '<button type="button" class="target" role="checkbox" aria-checked="' + on + '" data-act="' + c.act + '"' + data + (dis ? ' disabled' : '') + '>' + checkInd(on) + (c.prefix ? '<span class="hide-sm">' + h(c.prefix) + '</span>' : '') + pvText(c.label, sc, root) + '</button>'; }
      return '<button type="button" class="target" data-act="' + c.act + '"' + data + ' data-tip="' + pvText(c.tip, sc, root) + '"' + (dis ? ' disabled' : '') + '>' + (c.prefix ? '<span class="hide-sm">' + h(c.prefix) + '</span> ' : '') + lead + '<span class="' + (c.who ? 'hide-sm' : 'cafe-ellip') + '">' + pvJoin(c.parts || [{ text: c.label }], sc, root, ' ') + '</span>' + icon('down', c.who ? 14 : 12) + (P(c.auto) ? '<span class="c auto-tag" data-tip="' + h(c.autoTip || '') + '">' + h(tc('modeThumb.label.system')) + '</span>' : '') + '</button>';
    }
    case 'send': {   /* 发送 / 停止 */
      if (P(c.stop)) return P(c.stopping) ? ('<button type="button" class="send stop" disabled aria-label="' + h(tc('composer.stopping')) + '" data-tip="' + h(tc('composer.stopping')) + '">') + icon('stop', 14) + '</button>' : ('<button type="button" class="send stop" data-act="stop" aria-label="' + h(tc('composer.stop')) + '" data-tip="' + h(tc('composer.stop')) + '">') + icon('stop', 14) + '</button>';
      return '<button type="button" class="send" data-act="send"' + data + ' aria-label="' + h(tc('common.send')) + '" data-tip="' + pvText(c.tip, sc, root) + '"' + (P(c.disabled) ? ' disabled' : '') + '>' + icon('reply', 16) + '</button>';   /* 在对话里发出去就是回复：reply 字形；纸飞机 send 只给排队的“现在发出” */
    }
    case 'capsules': {   /* 身份胶囊：数据与 from/item 模板；状态片段、打开动作、悬停操作由声明绑定。 */
      const xs = [], draw = function (x, t) {
        const state = t ? pvParts(t.state, x, root) : x.state, showClock = t ? pv(t.clockWhen, x, root) : !!x.clock;
        const ticking = t ? pv(t.ticking, x, root) : !!x.tick, time = t ? clockText(pv(t.seconds, x, root)) : x.clock;
        const st = state + (showClock ? ' · <span class="num"' + (ticking ? ' data-tick="run"' : '') + '>' + h(time) + '</span>' : ''), id = t ? pv(t.who, x, root) : x.who;
        const cap = capWho({ who: id }, st, (t ? pv(t.cur, x, root) : x.cur) ? 'cur' : '', true, 'm');
        const opens = t ? t.open : x.open ? [x.open] : [], open = opens.find(function (o) { return pvOk(o.when, x, root); }) || {};
        return Object.assign(cap, { act: open.act || c.act, data: argAttrs(Object.assign({ id: id }, pvArgsObj(open.args, x, root))), tip: t ? pv(t.tip, x, root) : x.tip,
          body: cap.body + (t ? t.actions : x.actions || []).filter(function (a) { return pvOk(a.when, x, root); }).map(function (a) { return btn(pv(a.label, x, root), { iconOnly: true, icon: a.icon, sm: true, act: a.act, data: pvArgs(a.args, x, root) }); }).join('') });
      };
      if (Array.isArray(c.from)) c.from.forEach(function (entry) { if (entry.from) pvList(entry.from, sc, root).forEach(function (x) { xs.push(draw(x, entry.item)); }); else xs.push(draw(entry)); });
      else pvList(c.from, sc, root).forEach(function (x) { xs.push(draw(x)); });
      return xs.length ? capStack(xs, { label: c.label, size: 'm' }) : '';
    }
    case 'stack': return '<div class="vstack">' + pvControls(c.items || [], sc, root) + '</div>';   /* 竖着叠的一列（底对齐）；子项位置变了时组件自己做过渡 */
    case 'jump': return '<button type="button" class="cafe-latest" data-island="jump" data-flip' + htype + ' data-act="' + c.act + '"' + data + ' data-jump="1" data-tip="' + pvText(c.tip, sc, root) + '">' + icon(c.icon || 'latest', 14) + pvText(c.label, sc, root) + '</button>';   /* 跳到底部：离底部远时才显示——纯 CSS，按消息流的滚动时间线 */
    case 'notices': return noticeList(c.items.slot ? pdlSlotItems(c.items.slot).concat(pvList(c.items.from, sc, root)) : pvList(c.items, sc, root), c.key || 'notices', htype);   /* 提示：slot 与 owner 使用同一轮换队列；多条时轮换，悬停暂停 */
    case 'slot': {   /* 页面插槽：list 按摆放画工具按钮；single 只画胜出的那一项 */
      const d = PDL_SLOTS[c.slot] || {};
      if (d.cardinality === 'single') { const x = pdlSingle(c.slot); return x ? pvSingleItem(x) : ''; }
      return pdlTools(c.slot, P(c.ctx) || {});
    }
    case 'switch': return sw(!!P(c.value), c.act, data + (c.tip ? ' data-tip="' + pvText(c.tip, sc, root) + '"' : ''), pvText(c.label, sc, root), !!P(c.disabled));
    case 'seg': return seg(pvSegItems(c, sc, root), c.act, c.variant === 'tabs' ? 'ctabs' : undefined, '', data);
    case 'select': {
      const id = P(c.id), o = c.options ? pvItems(c.options, sc, root) : pvList(c.from, sc, root), v = P(c.value);
      if (c.variant === 'member') return memberPick({ id: id, pool: o, value: v, none: c.none ? pvText(c.none, sc, root) : null, multi: !!c.multi, act: c.act, args: c.args ? pvArgsObj(c.args, sc, root) : null, change: c.change, data: data, label: c.label ? pvText(c.label, sc, root) : '' });   /* 选成员：组件库唯一的成员选择器 */
      return sel(id, o, v, { span: P(c.span), change: c.change, data: data, invalid: !!P(c.invalid), label: c.label ? pvText(c.label, sc, root) : '', prefix: c.prefix ? pvText(c.prefix, sc, root) : '' });   /* 下拉只有一个样子（不按所在的设置行 / 表单 / 筛选换样子） */
    }
    case 'search': {
      if (!c.form && !c.wide && !c.note && !c.label && !c.on) return search(c.id, c.placeholder, P(c.value), c.input);
      const inp = searchGo() + '<input class="input" id="' + c.id + '" placeholder="' + h(c.placeholder) + '"' + (c.label ? ' aria-label="' + h(c.label) + '"' : '') + ' value="' + h(P(c.value) || '') + '" data-input="' + c.input + '"' + onAttrs(c.on) + '>';
      return c.form ? '<form class="search" data-form="' + c.form + '"' + pvNote(c.note) + '>' + inp + '</form>' : '<div class="search' + (c.wide ? ' vw-search' : '') + '">' + inp + '</div>';
    }
    case 'input': {
      if (c.go) {   /* 表单里的一个输入（组件库的 goField）：回车提交、Esc / 失焦取消，提交是框里唯一的图标 */
        const one = function (x) { return { id: P(x.id), value: P(x.value), placeholder: pvText(x.placeholder, sc, root), label: pvText(x.label || x.placeholder, sc, root), mono: !!P(x.mono) }; };
        return goField(Object.assign(one(c), { go: c.go, add: !!P(c.add), data: data, icon: c.icon, goLabel: pvText(c.goLabel, sc, root), cancel: c.cancel, list: c.list ? P(c.list) : '', listFrom: pvList(c.listFrom, sc, root), input: c.input,
          more: (c.more || []).map(one), extra: c.tint ? colorCtl({ id: P(c.tint.id), value: P(c.tint.value), default: P(c.tint.default), input: c.tint.input, label: pvText(c.tint.label, sc, root) }) : '' }));   /* 框里的选色：组件库统一的取色器，值是固定的颜色 */
      }
      /* rows：多行输入（rows: true = 行数由所在的容器定，比如输入区的正文）；多行和单行是同一个输入框组件 */
      /* grow：按内容长高到上限再滚动；complete：同行补全的候选（组件自己按已输入的内容挑，见 widgets.js 的 taGhost） */
      if (c.rows && c.complete) { TA_COMPLETE[P(c.id)] = pvList(c.complete, sc, root); return '<div class="ta-wrap"><div class="ta-ghost" aria-hidden="true"><span class="ta-typed"></span><span class="ta-rest"></span></div>' + pvControl(Object.assign({}, c, { complete: null }), sc, root) + '</div>'; }
      if (c.rows) return '<textarea class="input' + (P(c.mono) ? ' mono' : '') + '" id="' + h(P(c.id)) + '"' + data + (c.grow ? ' data-grow rows="1"' : c.rows !== true ? ' rows="' + P(c.rows) + '"' : '') + (c.input ? ' data-input="' + c.input + '"' : '') + (P(c.invalid) ? ' aria-invalid="true"' : '') + (c.label ? ' aria-label="' + pvText(c.label, sc, root) + '"' : '') + (c.code ? ' spellcheck="false"' : '') + onAttrs(P(c.on)) + (P(c.disabled) ? ' disabled' : '') + ' placeholder="' + pvText(c.placeholder, sc, root) + '">' + pvText(c.value, sc, root) + '</textarea>';
      /* 输入框只有一个样子：值、占位、等宽、候选、只读、校验失败、密文都是声明；title 是就地改名的标题 */
      const id = P(c.id), combo = c.listFrom ? pvItems(c.listFrom, sc, root).map(function (x) { return typeof x === 'object' ? { v: x.v, label: x.label, sub: x.sub } : { v: x, label: x }; }) : null, val = c.value != null ? P(c.value) : null;
      if (c.variant === 'title') return '<label class="sr" for="' + h(id) + '">' + pvText(c.label, sc, root) + '</label><input class="input input-title" id="' + h(id) + '" maxlength="200" value="' + h(val == null ? '' : val) + '"' + (c.placeholder ? ' placeholder="' + pvText(c.placeholder, sc, root) + '"' : '') + (c.input ? ' data-input="' + c.input + '"' : '') + data + onAttrs(c.on) + (P(c.disabled) ? ' disabled' : '') + '>';
      if (val == null && !c.input && !c.lead) return cafeFld(id, null, pvText(c.placeholder, sc, root), { mono: !!P(c.mono), max: c.max, type: P(c.secret) ? 'password' : '' });   /* 没有绑定值：草稿留在本地（提问卡、新建表单） */
      const inp = '<input class="input' + (P(c.mono) ? ' mono' : '') + '" id="' + h(id) + '" value="' + h(val == null ? '' : val) + '" placeholder="' + pvText(c.placeholder, sc, root) + '"' + (c.input ? ' data-input="' + c.input + '"' : '') + (c.change ? ' data-change="' + c.change + '"' : '') + data + (P(c.num) ? ' inputmode="numeric"' : '') + (P(c.ro) ? ' readonly' : '') + (P(c.invalid) ? ' aria-invalid="true"' : '') + (P(c.secret) ? ' type="password"' : '') + (c.max ? ' maxlength="' + c.max + '"' : '') + (c.label || c.placeholder ? ' aria-label="' + pvText(c.label || c.placeholder, sc, root) + '"' : '') + (P(c.disabled) ? ' disabled' : '') + onAttrs(c.on) + '>' +
        (c.post ? ' <span class="vw-meta">' + pvText(c.post, sc, root) + '</span>' : '');   /* post：框后的单位 */
      /* listFrom：候选（字符串，或 { v, label, sub }）——框尾一个下拉按钮，点开组件库的菜单，选中的写回框里（ui.js 的 comboOpen） */
      /* reload：候选是读来的，可以重读——框尾一直有一个刷新（{ act, args, busy, tip, why }，读的时候它自己转；why 有值 = 这次不能读，置灰、悬停说原因） */
      if (combo) { COMBO[id] = combo; return '<span class="combo">' + inp + btn(pvText(c.label || c.placeholder, sc, root), { iconOnly: true, sm: true, icon: 'updown', act: 'comboOpen', data: ' data-for="' + h(id) + '" aria-haspopup="menu"' }) + (c.reload ? btn(tc('common.refresh'), { iconOnly: true, sm: true, icon: 'refresh', act: c.reload.act, busy: !!P(c.reload.busy), tip: P(c.reload.tip), why: P(c.reload.why), data: argAttrs(pvArgsObj(c.reload.args || {}, sc, root)) }) : '') + '</span>'; }
      return c.lead ? '<label class="input-lead">' + pvParts(c.lead, sc, root) + inp + '</label>' : inp;   /* lead：框里最前面的状态（地址栏的连接点） */
    }
    case 'check': return c.variant === 'row' ? checkMark(!!P(c.value), c.act, data, pvText(c.label, sc, root)) : checkBox(!!P(c.value), (c.tint ? tintDot(P(c.tint)) : '') + pvText(c.label, sc, root), c.act, data);
    case 'tints': return colorCtl({ kind: 'slot', value: +P(c.value), act: c.act, label: pvText(c.label, sc, root), data: data });   /* 取色的槽位变体：6 个成员色调里单选 */
    case 'text': {   /* 一段文字：默认是正文墨色；meta 是次要信息；value 是一项设置的值；for 时是某个控件的名字（label 元素）。什么都不加时就是片段本身（不包一层） */
      const t = c.parts ? (typeof c.parts === 'string' ? pvLit(P(c.parts), sc, root) : pvJoin(c.parts, sc, root, '')) : pvText(c.text, sc, root), tone = P(c.tone), tip = P(c.tip);
      if (!t && !c.id) return '';
      const cls = (c.variant === 'meta' ? 'vw-meta' : c.variant === 'value' ? 'sys-v' + (P(c.mono) ? ' mono' : '') + (P(c.faint) ? ' faint' : '') + (P(c.num) ? ' num' : '') : '') + (tone ? ' vw-t-' + tone : ''), tag = c.for ? 'label' : 'span';
      if (!cls.trim() && !c.for && !c.id && !tip) return t;
      return '<' + tag + (cls.trim() ? ' class="' + cls.trim() + '"' : '') + (c.for ? ' for="' + h(P(c.for)) + '"' : '') + (c.id ? ' id="' + c.id + '"' : '') + (tip ? ' data-tip="' + h(tip) + '"' : '') + '>' + t + '</' + tag + '>';
    }
    case 'copy': return copyValue({ value: P(c.value), v: P(c.v), label: pvText(c.label, sc, root), tip: c.tip ? pvText(c.tip, sc, root) : '', mono: !!c.mono, tail: !!c.tail });
    case 'status': return status(P(c.tone), P(c.text));
    case 'more': { const key = c.items ? menuLive(pvMenu(c.items, sc, root)) : P(c.menu); return c.variant === 'row' ? rowMore(key, P(c.k), c.label) : moreBtn(key, data + (c.k != null ? ' data-k="' + h(String(P(c.k))) + '"' : ''), c.label, c.size); }   /* k：菜单作用的对象（菜单项的动作从 S.menuTarget 读），两种样子都带 */
    case 'back': {   /* 返回放在这里（引擎的返回）：比如表单自己的取消就是返回——容器的标题行不再画返回。没有返回可回时用声明的动作 */
      const k = BACK.page ? 'page' : BACK.detail ? 'detail' : null, d = k ? BACK[k] : null; if (k) BACK[k] = null;
      return btn(pvText(c.label, sc, root), { sm: true, act: d ? d.act : c.act, data: (d ? d.data || '' : data) + (d ? ' data-tip="' + h(tc('frame.backTo', d.label || '')) + '"' : '') });
    }
    case 'app': { const f = RT_CHROME[c.name]; return f ? f(c.region, { demo: !!c.demo }) : ''; }   /* 标签式容器（区域）的固定件：菜单条 stripe、把手 handle——放在哪个容器里、属于哪个区域（region）由页面 PDL 声明，长什么样、什么时候出现由区域的 chrome 声明 */
    case 'range': {   /* 滑块 + 数值；input 时边拖边更新（数值节点 id = 滑块 id + '-o'），change 时松手才提交 */
      const v = P(c.value), id = P(c.id);
      return '<span class="cafe-inline"><input type="range" class="ws-range"' + (id ? ' id="' + h(id) + '"' : '') + ' min="' + c.min + '" max="' + c.max + '" step="' + (c.step || 1) + '" value="' + h(v) + '"' + (c.change ? ' data-change="' + c.change + '"' : '') + (c.input ? ' data-input="' + c.input + '"' : '') + data + ' data-unit="' + h(pvText(c.unit, sc, root)) + '" aria-label="' + pvText(c.label, sc, root) + '"><span class="num"' + (id ? ' id="' + h(id) + '-o"' : '') + '>' + h(v) + pvText(c.unit, sc, root) + '</span></span>';
    }
    case 'tiles': {   /* 选一项：card = 一格一张小卡（头像 / 图标 + 名字 + 一行说明）；swatch = 一排色块头像。选中 aria-pressed，点了执行 act（带每项 args） */
      const xs = pvList(c.from, sc, root), A = function (x) { return actAttrs(x.act || c.act, x.args) + (x.pressed != null ? ' aria-pressed="' + !!x.pressed + '"' : ''); };   /* 每一项可以带自己的动作（开始方式） */
      if (xs.length && xs.every(function (x) { return !x.title; })) return '<div class="chips tiles-av">' + xs.map(function (x) { return '<button type="button" class="tile-av"' + A(x) + ' aria-label="' + h(x.label || x.tip || '') + '"' + (x.tip ? ' data-tip="' + h(x.tip) + '"' : '') + '>' + avatar({ name: x.text, tint: x.tint }, 'l') + '</button>'; }).join('') + '</div>';   /* 选一个头像：一排头像（共用头像组件） */
      return '<div class="tpl-grid">' + xs.map(function (x) { return '<button type="button" class="tpl"' + A(x) + '>' + (x.lead ? avatar(x.lead) : '<span class="avatar" aria-hidden="true">' + icon(x.icon || 'plus', 14) + '</span>') + '<span class="tpl-t"><b>' + h(x.title) + '</b>' + (x.tail ? ' <span class="muted">' + h(x.tail) + '</span>' : '') + '<span class="faint">' + h(x.sub || '') + '</span></span></button>'; }).join('') + '</div>';
    }
    case 'upload': if (c.hidden) return '<input type="file" id="' + h(P(c.id)) + '" accept="' + h(c.accept || '') + '"' + (c.multiple ? ' multiple' : '') + ' hidden' + data + '>';   /* hidden：只有选文件的输入，由别处的按钮触发 */
      return '<label class="btn btn-sm' + (c.iconOnly ? ' btn-icon" aria-label="' + pvText(c.label, sc, root) + '" data-tip="' + pvText(c.label, sc, root) : '') + '">' + (c.icon ? icon(c.icon, 14) : '') + (c.iconOnly ? '' : pvText(c.label, sc, root)) + '<input type="file" accept="' + h(c.accept || '') + '"' + (c.multiple ? ' multiple' : '') + ' class="sr" data-filemsg="' + pvText(c.msg, sc, root) + '"' + data + '></label>';   /* 上传：按钮样子的文件选择 */
    case 'chip': {   /* 一个小标签（组件库 chipHtml）：图标、类型（等宽小字）、名字、淡色补充；x 是移除按钮；有 act 时整个标签可点 */
      const xo = typeof c.x === 'string' ? P(c.x) : c.x, ca = P(c.act);   /* 动作可以来自数据（每一项自己的去处；没有就是不可点的标签） */
      return chipHtml({ tint: c.tint ? P(c.tint) : undefined, check: c.check, pressed: c.pressed != null ? P(c.pressed) : null, thumb: P(c.thumb), icon: c.icon ? P(c.icon) : '', kind: c.kind ? pvText(c.kind, sc, root) : '', label: pvText(c.label, sc, root), ellip: c.ellip, faint: c.faint ? pvText(c.faint, sc, root) : '',
        tip: c.tip ? pvText(c.tip, sc, root) : '', tone: P(c.tone), act: ca, data: data, x: xo ? chipX(xo.act, pvArgs(xo.args, sc, root), pv(xo.label, sc, root), pv(xo.icon, sc, root)) : '' });   /* 色调只写 data-tone（颜色通道），和提示一起放在标签的根上 */
    }
    case 'each': return pvList(c.from, sc, root).map(function (x) { return pvControl(c.control, x, root); }).join('');   /* 按数据重复一个控件 */
    case 'kvlist': return kvEditor({ key: P(c.key), path: c.path, rows: pvItems(c.rows, sc, root), single: !!c.single, ro: !!P(c.ro), input: c.input, add: P(c.add), eye: c.eye, del: c.del, keyPh: pvText(c.keyPh, sc, root), empty: pvText(c.empty, sc, root) });   /* 键值对 / 一列值的编辑器 */
    case 'avatar': {   /* 一个头像（还不是成员时，用名字 + 代表色）；upload：点头像本身就是上传（悬停出现上传提示） */
      const up = P(c.upload); return up ? avatarUp(P(c.lead), c.size || '', up, data) : avatar(P(c.lead), c.size || '');
    }
    case 'color': return colorCtl({ id: P(c.id), value: P(c.value), label: pvText(c.label, sc, root), input: c.input, slots: c.slots, preview: P(c.preview) });   /* 取色（组件库 colorCtl）：色块 + 调色盘；preview：名字用这个颜色的预览 */
    case 'reply': return replyRef(P(c.ref));   /* 回复引用（组件库的 replyRef） */
    case 'grow': return '<span class="grow"></span>';
    case 'tags': return PDL_BLOCKS.tags(c, sc, root);   /* 标签编辑器也可以是表单字段的控件 */
    case 'notice': return PDL_BLOCKS.notice(c, sc, root);   /* 提示在组合控件里仍由同一个提示组件画。 */
    case 'component': { const f = PDL_COMPONENTS[c.use]; if (!f) console.error(tc('engine.part.error', c.use)); return f ? f(P(c.props), sc, root) : ''; }
  }
  console.error(tc('engine.control.missingControl', c.type));
  return '';
}
function pvControls(cs, sc, root) { if (typeof cs === 'string') cs = pv(cs, sc, root); cs = pdlLoc(cs); return (Array.isArray(cs) ? cs : cs ? [cs] : []).map(function (c) { return pvControl(c, sc, root); }).join(''); }

/* ───────── 行 ─────────
   key lead title inline sub meta cols acts tone color bar sm act args note expand（一层，列表管理）more/moreWhen/moreAfter（调用方管理） */
function pvRow(t, sc, root, listId) {
  if (typeof t === 'string') { if (!PDL_ROWS[t]) console.error(tc('engine.row.error', t)); t = PDL_ROWS[t]; }
  t = pdlLoc(t);
  const cols = (t.cols || []).map(function (c) {
    const w = pv(c.w, sc, root);
    if (!pvOk(c.when, sc, root)) return { v: '', w: w || (c.control ? 'ctl' : 'num') };   /* 这一行没有这一列：留一个空格子（列表的列上下对齐） */
    if (c.control) { const v = pvControls(c.control, sc, root); return { v: v, w: w || 'ctl' }; }
    return { v: c.v != null ? pvParts(c.v, sc, root) : '', w: w || 'num', tip: pv(c.tip, sc, root), tone: pv(c.tone, sc, root), act: c.act, data: pvArgs(c.args, sc, root) };
  });
  let acts = null;
  if (t.acts && t.acts.slot) { const sl = pv(t.acts.slot, sc, root); acts = sl ? pdlActs(sl, pv(t.acts.ctx, sc, root) || {}) : null; }   /* 插槽可以来自数据（同一种行用在几段里，每段一个行插槽） */
  if (!acts && t.acts && t.acts.items) acts = pvList(t.acts.items, sc, root).filter(function (a) { return !t.acts.item || pvOk(t.acts.item.when, a, root); }).map(function (a) { return t.acts.item ? pvDeep(t.acts.item, root, a) : a; }).map(function (a) { return { label: a.label, icon: a.icon, act: a.act, data: argAttrs(a.args) }; });   /* 数据项也可以带声明在主题里的逐项模板 */
  else if (Array.isArray(t.acts)) acts = t.acts.filter(function (a) { return pvOk(a.when, sc, root); }).map(function (a) { const menu = a.items ? menuLive(pvMenu(a.items, sc, root)) : ''; return { label: pvText(a.label, sc, root), icon: pv(a.icon, sc, root), act: menu ? 'menu' : pv(a.act, sc, root), data: pvArgs(a.args, sc, root) + (menu ? ' data-menu="' + menu + '"' + MENU_DECL : ''), why: pv(a.why, sc, root) }; });
  const bar = t.bar && pv(t.bar.pct, sc, root) != null ? { pct: pv(t.bar.pct, sc, root), tone: pv(t.bar.tone, sc, root) } : null;
  const color = t.color ? (t.color.who ? whoInfo(pv(t.color.who, sc, root)).color : pv(t.color, sc, root)) : null;   /* 颜色是数据：身份自带的颜色，或视图模型给的 token */
  const sub = t.sub && !(t.sub.when && !pvOk(t.sub.when, sc, root)) ? pvParts(t.sub.parts && !Array.isArray(t.sub) && t.sub.sep == null ? t.sub.parts : t.sub, sc, root) : '';
  const prevL = PV.leadSize; PV.leadSize = t.layout === 'record' ? 's' : 'm';   /* 前导头像的档位跟着行布局（记录行是小档），不跟着所在的列表 */
  const lead = t.lead ? pvJoin(t.lead, sc, root, '') : ''; PV.leadSize = prevL;
  const act = pv(t.act && t.act.map ? pv(t.act, sc, root) : t.act, sc, root), args = t.args && t.args.map && 'of' in t.args ? pv(t.args, sc, root) : t.args,
    expand = typeof t.expand === 'string' ? pv(t.expand, sc, root) : t.expand, o = {
    key: pv(t.key, sc, root), layout: t.layout, list: listId,
    lead: lead, leadSlot: !!t.lead, title: pvParts(t.title, sc, root) + annotLabel(pvAnnot(t.label, sc, root), 'after') + helpTip(pv(t.help, sc, root)),
    inline: (t.inline ? pvJoin(t.inline, sc, root, '') : '') + annotLabel(pvAnnot(t.label, sc, root), 'corner'),
    sub: sub || (pvAnnot(t.label, sc, root) && pvAnnot(t.label, sc, root).pos === 'below' ? h(pvAnnot(t.label, sc, root).text) : ''), meta: t.meta ? pvParts(t.meta, sc, root) : '',
    cols: cols, acts: acts, tone: Array.isArray(t.tone) ? pv((t.tone.find(function (c) { return pvOk(c.when, sc, root); }) || {}).value, sc, root) : pv(t.tone, sc, root), color: color, bar: bar,
    act: act, data: act ? pvArgs(args, sc, root) : '',
    expand: expand == null ? null : pvBlocks(expand, sc, root), cur: !!pv(t.cur, sc, root)   /* 显式空数组只展开标题；绑定没有值时保留行自己的动作。 */
  };
  if (t.note) o.note = pv(t.note, sc, root);
  if (t.aside) { const as = t.aside.map(function (x) { return x ? pvJoin(x, sc, root, '') : ''; }); if (as[0] || as[1]) o.aside = as; }   /* 行尾上下两格：上面一格、下面一格，各自右对齐 */
  if (t.subLines) o.subLines = t.subLines;   /* 副行最多几行（超出省略） */
  if (t.more && pvOk(t.moreWhen, sc, root) && !t.moreAfter) o.more = pvRowMore(t, sc, root);   /* 模板在行的作用域里画，内部 each 保留自己的作用域 */
  return o;
}
function pvRowMore(t, sc, root) { const blocks = pv(t.more, sc, root); return pvBlocks(typeof blocks === 'string' ? pvList(blocks, sc, root) : blocks, sc, root); }
function pvRowHtml(t, it, root, listId) {
  const tpl = pdlLoc(typeof t === 'string' ? PDL_ROWS[t] : t);
  return lrow(pvRow(tpl, it, root, listId)) + (tpl.more && tpl.moreAfter && pvOk(tpl.moreWhen, it, root) ? pvRowMore(tpl, it, root) : '');
}

/* ───────── 设置行 ─────────
   一行：{ label, help, value | control | ctls, mono, faint, tip, acts, use/props（整行是组件）, link（可点的行）, kind（field / empty / row，来自数据的行） } */
function pvSetting(r, sc, root, lit, plain) {
  const T = function (x) { return lit ? (x == null ? '' : h(String(x))) : pvText(x, sc, root); };
  if (r.blocks) return pvBlocks(r.blocks, lit ? r : sc, root);   /* 组里的一行换成几个块（行内表单、说明） */
  if (r.link) return lrow({ layout: 'line', title: T(r.label), act: r.act, data: pvArgs(r.args, sc, root) });
  if (r.kind === 'field') { const fs = lit ? r : sc; return field({ label: lit ? r.label : pvText(r.label, sc, root), id: pv(r.id, fs, root), req: !!pv(r.req, fs, root), note: r.note, control: pvControls(r.control, fs, root), help: r.help ? (lit ? h(r.help) : pvParts(r.help, sc, root)) : '', foot: r.foot ? pvParts(r.foot, fs, root) : '' }); }   /* 表单字段：标签（必填 *、?）、控件（一个或几个）、字段下方一行 foot（状态、校验错误、字段操作） */
  let right;
  if (r.ctls) right = pvControls(r.ctls, lit ? r : sc, root);
  else if (r.control) right = pvControl(r.control, lit ? r : r.scope ? pv(r.scope, sc, root) : sc, root);
  else if (lit && r.parts != null) right = pvLit(r.parts, r, root);
  else if (plain) right = T(r.value);
  else if (lit && (r.value == null || r.value === '')) right = '';
  else right = '<span class="sys-v' + (r.mono ? ' mono' : '') + (r.faint ? ' faint' : '') + '"' + (r.tip ? ' data-tip="' + h(lit ? r.tip : pv(r.tip, sc, root) || '') + '"' : '') + '>' + T(r.value) + '</span>';
  if (r.acts) right += r.acts.map(function (a) { return lrAct({ label: a.label, icon: a.icon, act: a.act, data: pvArgs(a.args, sc, root) }); }).join('');
  const help = r.help ? (lit ? pvLit(r.help, r, root) : pvParts(r.help, sc, root)) : '';
  return srow(lit ? r.label : (r.label && typeof r.label === 'object' && r.label.lit != null ? h(r.label.lit) : pvText(r.label, sc, root)), right, { help: help });
}
function pvSettings(b, sc, root) {
  let out = [];
  if (b.from && b.row) out = pvList(b.from, sc, root).filter(function (it) { return pvOk(b.row.when, it, root); }).map(function (it) {
    if (b.row.swap && pvOk(b.row.swap.when, it, root)) return pvBlocks(b.row.swap.blocks, it, root);   /* 这一行换成别的块（比如行内编辑） */
    return pvSetting(b.row, it, root, false);
  });
  else if (b.from) out = pvList(b.from, sc, root).map(function (r) { return pvSetting(r, r, root, true, b.plain) + (r.after ? pvBlocks(r.after, r, root) : ''); });
  if (b.from && !out.length && b.empty) out = [emptyState(pvText(b.empty, sc, root))];   /* 来自数据的行一条都没有：组件库的空状态（后面的固定行照常） */
  if (b.rows) out = out.concat(b.rows.filter(function (r) { return pvOk(r.when, sc, root); }).map(function (r) { return pvSetting(r, sc, root, false); }));
  return out;
}

/* ───────── 块 ───────── */
/* 容器（box）和一排控件（toolbar）的角色 → 组件库的类（角色的含义见 PDL_ROLES）。没写角色 = 组件的默认 */
const BOX = { '': 'vw-box', card: 'vw-card', group: 'group', composer: 'composer typing-scope', log: 'vw-log scroll', scroll: 'vw-scrollbox scroll', expand: 'vw-expand', inline: 'cafe-inline', columns: 'vw-cols', viewport: 'wpv', hero: 'vw-hero', dock: 'vw-dock' };
const BAR = { '': 'toolbar', head: 'chat-head', savebar: 'savebar', selection: 'toolbar vw-selection', embed: 'vw-embed', marker: 'vw-marker', float: 'vw-float' };
/* 标题行在容器里的角色：默认是容器本身的头（取容器的返回），detail 是下钻出来的详情的头（先取下钻的返回） */
const HEAD_ROLE = { page: 'page', hero: 'page', detail: 'detail' };
/* 头的统一排法：标题 → 行内状态（带色调点的小字，紧跟标题、垂直居中）→ 空白 → 所有操作控件（文字按钮、图标按钮、更多、开关）在最后。
   声明里写在 actions 里的状态（type: 'status'）由这里分出来放到标题后面；视图不用各自安排 */
function pvHeadSplit(cs, sc, root) {
  if (typeof cs === 'string') cs = pv(cs, sc, root); cs = pdlLoc(cs); cs = Array.isArray(cs) ? cs : cs ? [cs] : [];
  const st = cs.filter(function (c) { return c && c.type === 'status'; }), rest = cs.filter(function (c) { return !(c && c.type === 'status'); });
  const sh = pvControls(st, sc, root);
  return { status: sh ? '<span class="head-status">' + sh + '</span>' : '', acts: pvControls(rest, sc, root) };
}
function pvHead(b, sc, root) {
  /* close：这个标题所在弹窗的名字，× 由弹窗框架给（popX：声明了 x 的弹窗才有） */
  const v = b.variant || 'page', xk = b.close ? pv(b.close, sc, root) : '', x = xk ? popX(xk) : '', hs = pvHeadSplit(b.actions, sc, root), actions = hs.acts + x;
  const bk = backTake(HEAD_ROLE[v]);   /* 返回画在容器自己的头里（引擎的返回槽，frame.js 的 BACK） */
  if (v === 'hero') return '<div class="cafe-greet">' + bk + '<h1 class="greet"' + pvNote(b.note) + '>' + pvText(b.title, sc, root) + '</h1>' + (b.sub ? '<p class="cafe-sub">' + pvText(b.sub, sc, root) + '</p>' : '') + '</div>';
  /* 详情 / 子层的头：眉题、标题（可带 ?）、副标题或一行数据（desc，里面可以有控件），都可以是视图模型给的片段 */
  if (v === 'detail') {
    const eyebrow = pvAny(b.eyebrow, sc, root), title = b.title ? pvAny(b.title, sc, root) + helpTip(pv(b.help, sc, root)) : '', sub = (b.sub ? pvAny(b.sub, sc, root) : b.desc ? (b.desc.t ? pvText(b.desc, sc, root) : pvAny(b.desc, sc, root)) : '') + annotLabel(pvAnnot(b.label, sc, root), 'after');
    return bk || eyebrow || title || hs.status || sub || actions ? detailHead({ back: bk, eyebrow: eyebrow, title: title, status: hs.status, sub: sub, note: b.note, actions: actions }) : '';
  }
  /* 说明进 help；状态（meta）和状态里的操作（descAction）是 label，标题下方直接显示 */
  const sub = (b.meta ? pvParts(b.meta, sc, root) : '') + (b.descAction ? pvControl(b.descAction, sc, root) : '');
  return pageHead({ back: bk, lead: b.lead ? pvJoin(b.lead, sc, root, '') : '', title: pvText(b.title, sc, root), status: hs.status, titleNote: b.note, help: pv(b.help, sc, root) || (b.desc ? pvText(b.desc, sc, root) : ''), sub: sub, label: pvAnnot(b.label, sc, root), actions: (b.tools ? pvControls(b.tools, sc, root) : '') + actions, actNote: b.actNote });
}
/* list / cards 共用续读尾标（唯一一个）：服务端的下一页（声明的 next）和本地的下一页（渐进显示）都是它。
   还有下一批时末尾是一个 ⋯（悬停“读取更多”），点它就读下一批；服务端的下一页滚到附近也会自动读（节点重画不续读，离开附近再进入或向下滚轮才触发下一批），
   本地的下一页只在点 ⋯ 时多画（行已经读到了，不让页面自己往下长） */
const LIST_NEXT = {};
function listNextHtml(decl, sc, root) {
  const d = pv(decl, sc, root); if (!d) return '';
  return listNextTail(pv(d.key, sc, root), { act: pv(d.act, sc, root), args: pvArgsObj(d.args, sc, root), enabled: pvOk(d.when, sc, root), busy: !!pv(d.busy, sc, root) });
}
function listNextTail(k, x) {
  LIST_NEXT[k] = x;
  return '<div class="list-next" data-list-next="' + h(k) + '" data-island="list-next:' + h(k) + '">' + (x.enabled && !x.busy ? btn(tc('list.loadMore'), { iconOnly: true, sm: true, icon: 'more', act: 'listNextGo', data: ' data-k="' + h(k) + '"' }) : '') + '</div>';
}
A.listNextGo = function (d) { const x = LIST_NEXT[d.k]; if (x && x.enabled && !x.busy) actFn(x.act)(x.args); };
function listNextRead(el, near) {
  const d = LIST_NEXT[el.dataset.listNext];
  if (!near) { el._nextRead = false; return; }
  if (!d.enabled || d.busy || d.click || el._nextRead || !el.checkVisibility()) return;
  el._nextRead = true; actFn(d.act)(d.args, el);
}
nearView('[data-list-next]', listNextRead);
document.addEventListener('wheel', function (e) {
  if (e.deltaY <= 0) return;
  const sc = e.target.closest('.scroll'); if (!sc) return;
  sc.querySelectorAll('[data-list-next]').forEach(function (el) { if (el.closest('.scroll') === sc && el.__near && !LIST_NEXT[el.dataset.listNext].busy) { el._nextRead = false; listNextRead(el, true); } });
}, { passive: true });
function pvListBody(b, sc, root) {
  const tpl = typeof b.row === 'string' ? PDL_ROWS[b.row] : b.row;
  if (b.groups) {   /* 分组：组标题和行在同一个列表底里 */
    const gs = pvList(b.groups, sc, root).filter(function (g) { return g.items.length || g.keep; });   /* keep：没有行的组也画组标题（比如一段还没有运行的会话） */
    const cls = 'group lr-list' + (b.scroll ? ' vw-scroll scroll' : ''), gid = pv(b.id, sc, root);
    if (!gs.length) return '<div class="' + cls + '">' + emptyState({ html: pvText(b.empty, sc, root) }) + '</div>';
    /* 组标题可以不写（不带标题的一组，如执行记录里的“思考”一行）；行可以展开，整个列表默认一次只展开一行（expand: many 各自开合） */
    const rows = gs.map(function (g) { return g.items.map(function (it) { const r = pvRow(b.row, it, root, gid); r.open = rowOpen(gid, r.key); r.many = b.expand === 'many'; return r; }); });   /* 各组的行在同一个列表的列上对齐（lrCols） */
    /* group：组标题怎么画（@ 是这一组的数据）：title / count / act + args / more { label, act, args, when }；没写时组的数据本身带这些 */
    const gh = function (g) { const t = b.group; if (!t) return g; const m = t.more && pvOk(t.more.when, g, root) ? { label: pv(t.more.label, g, root), act: t.more.act, args: pvArgsObj(t.more.args, g, root) } : null; return { title: pv(t.title, g, root), count: t.count != null ? pv(t.count, g, root) : null, act: pv(t.act, g, root), args: pvArgsObj(t.args, g, root), more: m, items: g.items }; };
    return '<div class="' + cls + '"' + lrCols([].concat.apply([], rows)) + '>' + gs.map(gh).map(function (g, gi) { return (g.title ? lrSection(g.title, g.more ? btn(g.more.label, { sm: true, act: g.more.act, data: argAttrs(g.more.args) }) : '', { html: g.act ? btn(g.title, { link: true, act: g.act, data: argAttrs(g.args) }) : null, count: g.count != null ? g.count : g.items.length }) : '') + rows[gi].map(lrow).join(''); }).join('') + '</div>';
  }
  const id = pv(b.id, sc, root), found = listFind(pvList(b.from, sc, root), b.searchable ? LIST_Q[id] : '');
  /* 渐进显示（列表自己的行为）：已经读到的行超过一页时先画一页，末尾“读取更多”每次多画一页。
     服务端分页的列表（next：滚到底读下一页）、限行滚动的（rows）、可拖动排序的、嵌在别处的紧凑列表不再本地分页 */
  const pageKey = id || PV.viewId + ':' + (typeof b.from === 'string' ? b.from : ''), items = b.order || b.inline || b.next || b.rows ? found : found.slice(0, LIST_PAGE[pageKey] || LIST_PAGE_N);
  const more = items.length < found.length ? listNextTail('page:' + pageKey, { act: 'listMore', args: { list: pageKey }, enabled: true, busy: false, click: true }) : '';
  if (tpl && tpl.moreAfter) {   /* 行模板把展开的块画在行后面（moreAfter）：展开由各行的数据管，可以同时展开多行 */
    const rows = items.map(function (it) { return pvRowHtml(b.row, it, root, null); }).join('');
    return b.inline ? (rows ? '<div class="lr-inline"' + lrCols(items.map(function (it) { return pvRow(b.row, it, root, null); })) + '>' + rows + '</div>' : emptyState({ text: pvText(b.empty, sc, root) || tc('list.empty') })) : '<div class="group lr-list"' + lrCols(items.map(function (it) { return pvRow(b.row, it, root, null); })) + '>' + (rows || emptyState({ html: pvText(b.empty, sc, root) || h(tc('list.empty')) })) + '</div>' + more;
  }
  if (b.inline) { const rs = items.map(function (it) { return pvRow(b.row, it, root, null); }); return rs.length ? '<div class="lr-inline"' + lrCols(rs) + '>' + rs.map(lrow).join('') + '</div>' : emptyState({ text: pvText(b.empty, sc, root) || tc('list.empty') }); }   /* 嵌在别处的紧凑列表：小行、不带框；各行的数据列和操作照样上下对齐（列轨，data-cols）；没有项也是空状态 */
  return lrList(id, items.map(function (it) { return pvRow(b.row, it, root, id); }), { empty: pvText(b.empty, sc, root), emptyActs: b.emptyAction ? pvControl(b.emptyAction, sc, root) : '', rows: b.rows || 0, many: b.expand === 'many', order: b.order ? pv(b.order, sc, root) : null, cls: (b.scroll ? 'vw-scroll scroll' : '') }) + more;   /* rows：最多显示几行，更多在列表里滚动；order：拖动排序交给哪个动作 */
}
Object.assign(PDL_BLOCKS, {
  head: pvHead,
  /* 一排控件：items；或 left / right；foot 还可以带片段 parts */
  /* 分道的一行（组件库）：几条道按 share 分宽度（比如 1:3:1），每条道是横向滚动原件（scroll-x，溢出那边渐隐 = 还有内容）；
     空的道不占位，把份额让给别的道。道里悬停展开的层会升到浮层层（escape），不被道的滚动裁掉 */
  lanes: function (b, sc, root) {
    /* scroll: true 的道才是横向滚动容器（可能溢出，溢出那边渐隐）；不滚动的道按内容定宽，永远不渐隐 */
    const ls = b.lanes.map(function (l) { return { share: l.share || 0, scroll: !!l.scroll, html: pvControls(l.items, sc, root), name: l.name || '', align: ['center', 'end'].indexOf(l.align) >= 0 ? l.align : 'start', attach: l.attach === 'straddle' ? 'straddle' : 'above' }; });
    if (!ls.some(function (l) { return l.html; })) return '';   /* 没内容的道也占着它的列：别的道有没有内容，居中的那条都不挪 */
    if (b.key) { const want = pdlOrderOf(b.key, ls.map(function (l) { return l.name; })); ls.sort(function (x, y) { return want.indexOf(x.name) - want.indexOf(y.name); }); }   /* 有 key 的道组是容器：道在组内按用户的顺序排 */
    return '<div class="lanes" data-island="lanes:' + (b.key || '') + '"' + (b.key ? ' data-ocontainer="' + h(b.key) + '"' : '') + ' style="--lanes:' + ls.map(function (l) { return l.share ? 'minmax(' + (l.scroll ? '0' : 'max-content') + ', ' + l.share + 'fr)' : 'auto'; }).join(' ')   /* 不滚动的道从不比内容窄 */ + '">' +
      ls.map(function (l) { return '<div class="lane' + (l.scroll ? ' scroll-x' : '') + '" data-attach="' + l.attach + '" data-align="' + l.align + '"' + (l.name ? ' data-lane="' + l.name + '"' + (b.key ? ' data-okey="' + l.name + '"' + (S.editLayout ? ' data-edit="order"' : '') : '') : '') + '><div class="lane-in">' + l.html + '</div></div>'; }).join('') + '</div>';
  },
  /* 一排控件：items；或 left / right（右边的推到末尾），可以带片段 parts。角色见 PDL_ROLES.toolbar；什么都没有就不画 */
  toolbar: function (b, sc, root) {
    const v = b.variant || '';
    let inner;
    if ((b.ordered || b.kind === 'actions') && b.key) {   /* 操作组（kind: 'actions'）默认就是一排格子，用户可以在组内编排（不用逐个开启）。grow 之前的项默认从起始端排，之后的从结束端排；每项按种类占 span 个格子；固定的（locked，比如发送）不动 */
      let anchor = 'start';
      const bk = v === 'head' ? backTake('page') : '';   /* 作为容器头的工具条：返回是它最前面固定的一格 */
      const items = (bk ? [{ key: 'back', html: bk, span: 's', anchor: 'start', locked: true }] : []).concat((b.items || []).map(function (c) {
        if (c.type === 'grow') { anchor = 'end'; return null; }
        const html = pvControl(c, sc, root); if (!html) return null;
        return { key: c.key || c.variant || c.act || c.type, html: html, span: c.span || 's', anchor: anchor, locked: !!c.locked };   /* 没写 key 的项按它的动作认 */
      })).filter(Boolean);
      return cellsHtml({ key: b.key, axis: 'row', items: items, saved: pdlCells(b.key), edit: S.editLayout, cls: BAR[v] });
    }
    if (b.left || b.right) { const right = pvControls(b.right, sc, root); inner = pvControls(b.left, sc, root) + pvParts(b.parts, sc, root) + (right ? '<span class="grow"></span>' + right : ''); }
    else inner = (v === 'head' && !b.key ? backTake('page') : '') + pvControls(b.items, sc, root) + pvParts(b.parts, sc, root);
    if (!inner.replace(/<span class="grow"><\/span>/g, '') && b.id == null) return '';   /* 里面只剩撑开的空白（按钮都按条件藏了）：整条不画 */
    const tone = pv(b.tone, sc, root), tag = b.form ? 'form' : 'div', cls = BAR[v] + (tone ? ' vw-t-' + tone : '');
    /* id / hidden：保存栏这类由别处按 id 显示、隐藏的条 */
    return '<' + tag + ' class="' + cls + '"' + (b.id ? ' id="' + b.id + '"' : '') + (b.hidden != null && pvOk(b.hidden, sc, root) ? ' hidden' : '') + (b.form ? ' data-form="' + b.form + '"' + pvArgs(b.args, sc, root) : '') + pvNote(pv(b.note, sc, root)) + '>' + inner + '</' + tag + '>';
  },
  section: function (b, sc, root) {
    /* 小节里直接是设置行（rows / from / row）：设置行组就是它的正文（系统配置这类按数据结构走的小节） */
    if (b.rows || b.from) b = Object.assign({}, b, { blocks: [{ type: 'settings', rows: b.rows, from: b.from, row: b.row }].concat(b.blocks || []), rows: null, from: null, row: null });
    let body = pvBlocks(b.blocks, sc, root);
    if (!body && !b.keep) return '';
    const hs = pvHeadSplit(b.actions, sc, root);
    if (b.id && PV.anchors) PV.anchors.push({ id: pv(b.id, sc, root), label: pvText(b.title, sc, root) });   /* 小节标题是锚点：同一视图里的目录（toc）从这里取条目 */
    return section({ id: b.id ? pv(b.id, sc, root) : null, title: pvText(b.title, sc, root), note: b.note, help: pv(b.help, sc, root) || (b.desc ? pvText(b.desc, sc, root) : ''), label: pvAnnot(b.label, sc, root), status: hs.status, actions: hs.acts, body: body });
  },
  /* 列表：空 / 加载 / 出错之外还有“部分可用”（partial：有的来源读不到）——列表顶上一行 warn 色调，文字是视图声明的 */
  /* 列表：没有数据时也画列表，里面是组件库的空状态（声明的 empty 文字，没声明就是通用的“无”）——有没有数据，这一块看起来一样。
     唯一的例外是声明了 optional 的子组（只在有成员时才存在，如已封存的会话、过去参与的猫）：没有项时整个不画，连它的组标签（label）一起 */
  list: function (b, sc, root) {
    const n = b.groups ? pvList(b.groups, sc, root).filter(function (g) { return g.items.length || g.keep; }).length : pvList(b.from, sc, root).length;
    if (b.optional && !n) return '';
    const pt = pv(b.partial, sc, root), q = b.searchable && n ? listQField(pv(b.id, sc, root)) : '';
    const lab = b.label ? lrSection(pvText(b.label, sc, root), q, { count: b.count != null ? pv(b.count, sc, root) : null }) : q ? '<div class="lr-section-label">' + q + '</div>' : '';   /* 筛选框在列表自己的头里：有组标签时在它的行尾，没有时单独一行头 */
    return lab + (pt ? '<div class="lr-partial" data-tone="warn" role="status">' + icon('alert', 14) + h(pt) + '</div>' : '') + pvListBody(b, sc, root) + listNextHtml(b.next, sc, root);
  },
  tree: function (b, sc, root) {
    const nodes = pv(b.nodes, sc, root) || {};
    const sel = b.select;
    return ltree(pv(b.id, sc, root), function (path) { return (nodes[path] || []).map(function (data) { const n = b.item ? Object.assign({}, data, pvDeep(b.item, root, data)) : data, r = pvRow(b.row, n, root, null); return { name: n.name, path: n.path, dir: n.dir, row: { lead: r.lead, title: r.title, sub: r.sub, inline: r.inline, cols: r.cols, acts: r.acts, cur: r.cur }, pick: sel ? { act: pv(sel.act, n, root), data: pvArgs(sel.args, n, root) } : null }; }); },
      { fileAct: b.fileAct, fileData: function (n) { return pvArgs(b.fileArgs, n, root); }, flat: !!b.flat, divider: !!b.divider, ready: !!pv(b.ready, sc, root) });
  },
  /* 设置行组：rows（模板）、from（数据）、from + row（每项按行模板）；行都在同一个分组底里 */
  settings: function (b, sc, root) {
    const rows = pvSettings(b, sc, root).filter(Boolean);
    return rows.length ? group(rows) : '';
  },
  /* 表单：提交时交给 FORMS[id]；里面是任意块（字段行用 settings 的 field 行） */
  form: function (b, sc, root) {
    return '<form data-form="' + b.id + '"' + (b.htmlId ? ' id="' + b.htmlId + '"' : '') + pvArgs(b.args, sc, root) + ' class="form-sections"' + pvNote(b.note) + '>' + pvBlocks(b.blocks, sc, root) + '</form>';
  },
  /* 键值：都是组件库的 kvGrid（一列标签对齐、按最宽标签取档）。一行是 { k, v } 或 { label, value }。值：人 → 身份（可带一句补充）、act → 文字按钮、warn → 留意色、片段 → 片段 */
  kv: function (b, sc, root) {
    const xs = b.item ? pvList(b.from, sc, root) : pvItems(b.from, sc, root);
    const rows = xs.map(function (r) {
      const v = r.v != null ? r.v : r.value, act = pv(r.act, r, root);
      const template = b.item && (b.item.v || b.item.value), rich = template && (Array.isArray(template) || template.parts), value = pvLit(rich ? template : v, r, root);
      const val = r.who ? who(r.who, 'line') + (v ? ' <span class="faint">' + value + '</span>' : '') : act ? btn(v, { link: true, sm: true, act: act, data: argAttrs(!b.item && Array.isArray(b.from) ? pvArgsObj(r.args, sc, root) : r.args), html: rich ? value : undefined }) : r.warn ? '<span class="vw-t-warn">' + value + '</span>' : value;
      return [r.k != null ? r.k : r.label, val];
    }).filter(function (x) { const v = String(x[1] == null ? '' : x[1]); return /<(img|svg|button|input)/.test(v) || v.replace(/<[^>]*>/g, '').trim(); });   /* 没有值的行不画（只剩一个键是噪音） */
    return rows.length ? kvGrid(rows) : '';
  },
  stats: function (b, sc, root) {
    const v = b.variant || 'grid';
    if (v === 'counters') return '<div class="vw-counters">' + b.items.map(function (i) { const tone = pv(i.tone, sc, root); return '<span class="vw-counter' + (tone ? ' vw-t-' + tone : '') + '"><b class="num">' + pvText(i.value, sc, root) + '</b>' + h(i.label) + '</span>'; }).join('') + '<span class="grow"></span>' + pvControls(b.actions, sc, root) + '</div>';
    return '<div class="kv">' + (b.item ? pvList(b.from, sc, root) : pvItems(b.from, sc, root)).map(function (x) { const value = x.format === 'number' ? Number(x.v).toLocaleString() : x.format === 'uptime' ? tc('stats.uptime', Math.floor(x.v / 3600), Math.floor(x.v % 3600 / 60)) : String(x.v); return '<div' + (x.tip ? ' data-tip="' + h(x.tip) + '"' : '') + '>' + (x.warn ? '<span class="vw-warn-t vw-13">' + h(x.warn) + '</span>' + (x.action ? pvControl(x.action, x, root) : '') : '<b' + (x.tone ? ' class="ws-' + x.tone + '"' : '') + '>' + h(value) + '</b><span>' + h(x.l) + '</span>') + '</div>'; }).join('') + '</div>';
  },
  /* 文字：一行（片段 + ? + 控件，默认）、一段正文（para）、次要信息（meta）、卡片标题（title）、一列要点（list）。
     from + parts：按数据重复片段（一行里，sep 连接）；from 单独：视图模型给的文字或片段 */
  text: function (b, sc, root) {
    const v = b.variant || '', tone = pv(b.tone, sc, root), help = helpTip(pv(b.help || b.hint, sc, root));
    if (v === 'list') { const xs = pvList(b.from, sc, root); return xs.length ? '<ul class="card-ul">' + xs.map(function (x) { return '<li>' + h(x) + '</li>'; }).join('') + '</ul>' : ''; }
    if (b.from && b.parts) {
      const xs = pvList(b.from, sc, root); if (!xs.length) return '';
      return lrText(xs.map(function (x) { return '<span' + (b.tip ? ' data-tip="' + pvText(b.tip, x, root) + '"' : '') + '>' + pvParts(b.parts, x, root) + '</span>'; }).join(b.sep == null ? ' · ' : b.sep), tone);
    }
    const t = b.from ? pvLit(pv(b.from, sc, root), sc, root) : b.parts ? (v ? (!Array.isArray(b.parts) && b.parts.parts ? pvParts(b.parts, sc, root) : pvJoin(b.parts, sc, root, '')) : pvParts(b.parts, sc, root)) : pvText(b.text, sc, root);   /* parts 可以是 { sep, parts }：片段之间用 sep 连 */
    if (v === 'para') return t ? '<p class="vw-para' + (tone ? ' vw-t-' + tone : '') + '">' + t + help + '</p>' : '';
    if (v === 'meta') return t ? '<div class="vw-label below' + (tone ? ' vw-t-' + tone : '') + '">' + t + help + '</div>' : '';
    if (v === 'title') return t ? '<div class="vw-card-t">' + t + annotLabel(pvAnnot(b.label, sc, root), 'after') + help + annotLabel(pvAnnot(b.label, sc, root), 'corner') + '</div>' : '';
    const acts = pvControls(b.actions, sc, root);
    return t || acts ? lrText(t + help + (t && acts ? ' ' : '') + acts, tone) : '';
  },
  label: function (b, sc, root) {   /* 组标签：只有一种（lrSection） */
    return lrSection(pv(b.text, sc, root) || '', b.action ? pvControl(b.action, sc, root) : '', { count: b.count != null ? pv(b.count, sc, root) : null, help: pv(b.help, sc, root), tip: pv(b.tip, sc, root) });
  },

  /* 提示：粗体开头 + 正文 + 操作；from 时一项一条（撤销不在这里：可撤回的动作给撤销提示，core.js undoShow） */
  notice: function (b, sc, root) {
    const one = function (x) { const st = pv(b.strong, x, root); if (pvSaidInHead(st, pv(b.text, x, root))) return ''; return notice({ tone: pv(b.tone, x, root), note: b.note, text: (st ? '<b>' + h(st) + '</b>' : '') + (b.parts ? pvParts(b.parts, x, root) : pvText(b.text, x, root)) + (b.num ? ' <span class="num">' + pvText(b.num, x, root) + '</span>' : '') + (function () { const it = pvList(b.items, x, root); return it.length ? '<ul class="cafe-ul">' + it.map(function (t) { return '<li>' + (b.each ? pvParts(b.each, t, root) : h(t)) + '</li>'; }).join('') + '</ul>' : '';   /* each：每一项怎么画（@ 是这一项） */ })(), action: pvControls(b.action, x, root) }); };
    return b.from ? pvList(b.from, sc, root).map(one).join('') : one(sc);
  },

  tabs: function (b, sc, root) {
    const xs = pvList(b.from, sc, root);   /* 一排标签页只有一个样子；声明了 close 的每个标签带 × */
    return '<div class="scroll-x wpv-tabs" role="tablist"' + (b.label ? ' aria-label="' + h(b.label) + '"' : '') + '>' + xs.map(function (x) {
      const on = !!pv(b.selected, x, root);
      const tab = '<button type="button" role="tab" aria-selected="' + on + '" data-act="' + b.act + '"' + pvArgs(b.args, x, root) + ' data-tip="' + pvText(b.tip, x, root) + '">' + pvParts(b.parts, x, root) + '</button>';
      return '<span class="wpv-tab' + (on ? ' on' : '') + '">' + tab + (b.close ? pvControl(b.close, x, root) : '') + '</span>';
    }).join('') + pvControls(b.after, sc, root) + '</div>';
  },
  /* 左右两栏：默认 = 列表 + 详情（窄屏收成下钻）；aside = 主栏 + 侧栏 */
  split: function (b, sc, root) {
    if (b.variant === 'compare') return '<div class="vw-split-compare"><section>' + pvBlocks(b.left, sc, root) + '</section><section>' + pvBlocks(b.right, sc, root) + '</section></div>';
    if (b.variant === 'aside') {
      const pane = function (side, cls) { const follow = b.scroll && (b.follow === side || b.follow === 'both'), body = pvBlocks(b[side], sc, root); return '<div class="' + cls + (b.scroll ? ' scroll' : '') + (follow ? ' stick-end' : '') + '">' + (follow ? '<div>' + body + '</div>' : body) + '</div>'; };
      return '<div class="cafe-two"' + (b.scroll ? ' data-scroll="panes"' : '') + '>' + pane('left', 'cafe-two-main') + pane('right', 'cafe-two-side') + '</div>';
    }
    /* 容器树：分栏（split）下面两栏（pane-l 列表 / pane-r 详情）。并排时选中的详情打开在 pane-r（列表的兄弟）；收起时（窄屏，布局状态 VIEWPORT.narrow）
       分栏变成“列表 → 详情”，详情打开在两栏共同的父容器 split 里。打开到哪个容器写在 data-into 上，返回的判断只看容器树，在画之前从触发点定（见 core.js 的 go、proj.js 的 navOpen） */
    const col = VIEWPORT.narrow, picked = !!pv(b.picked, sc, root);
    /* 收起时选了一项：详情盖住了列表，详情的头先画（引擎的返回落在看得见的那一栏的头里） */
    let L, Rr; if (col && picked) { Rr = pvBlocks(b.right, sc, root); L = pvBlocks(b.left, sc, root); } else { L = pvBlocks(b.left, sc, root); Rr = pvBlocks(b.right, sc, root); }
    /* 并排时两栏各自滚动（详情栏是自己的滚动容器，列表栏里的列表自己滚），滚详情不带着整页；收起时只有一栏，照常随页面滚 */
    return '<div class="vw-split" data-ct="split" data-into="' + (col ? 'split' : 'pane-r') + '" data-mode="' + (col ? 'collapsed' : 'side') + '"' + (picked ? ' data-picked' : '') + '><aside class="vw-split-l" data-ct="pane-l">' + L + '</aside><section class="vw-split-r' + (col ? '' : ' scroll') + '" data-ct="pane-r">' + Rr + '</section></div>';
  },
  /* 决定后的一行结果：所有卡片模板共用。状态到色调的对应在这里（同意 ok、拒绝 danger，其余不着色）；
     详情收在下面，展开状态在数据里（S.folds[key]）；行尾是调用方给的操作 */
  result: function (b, sc, root) {
    const st = pv(b.status, sc, root); if (!st) return '';
    const k = pv(b.key, sc, root), det = pvBlocks(b.blocks, sc, root), open = !!(det && S.folds[k]);
    return '<div class="vw-result" data-status="' + h(st) + '"><div class="vw-result-row">' + status(RESULT_TONE[st] || '', pv(b.label, sc, root)) +
      (det ? btn(tc(open ? 'common.collapse' : 'common.details'), { link: true, sm: true, act: 'fold', data: ' data-f="result" data-k="' + h(k) + '" aria-expanded="' + open + '"', html: h(tc(open ? 'common.collapse' : 'common.details')) + twisty(open) }) : '') +
      '<span class="grow"></span>' + pvControls(b.actions, sc, root) + '</div>' + (open ? '<div class="vw-result-d">' + det + '</div>' : '') + '</div>';
  },
  each: function (b, sc, root) { return pvList(b.from, sc, root).map(function (it) { return pvBlocks(b.blocks, it, root); }).join(''); },
  /* 按视图模型给的顺序画一组有名字的块（可拖动排序的小节） */
  ordered: function (b, sc, root) { return pvList(b.order, sc, root).map(function (id) { const x = b.blocks[id]; return x ? pvBlocks([x], sc, root) : ''; }).join(''); },
  steps: function (b, sc, root) {
    const xs = pvList(b.from, sc, root);
    if (b.variant === 'progress') return '<div class="ws-steps" role="list">' + xs.map(function (s, k) { const i = s.i != null ? s.i : k; return chipHtml({ cls: 'ws-step' + (s.done ? ' done' : ''), pressed: !!s.on, lead: s.done ? icon('check', 12) : '<span class="num">' + (i + 1) + '</span>', label: h(s.label), act: b.act, data: b.act ? pvArgs(b.args, sc, root) + ' data-i="' + i + '"' : '', attrs: b.act ? '' : ' role="listitem"' }); }).join('') + '</div>';   /* 阶段进度：有动作时每一步可点 */
    if (b.variant === 'flow') {   /* 流程图：区域（循环）里一排排节点，区域可以套区域；节点点了执行 act（带 i），on 选中、aff 受影响 */
      const node = function (n) { return chipHtml({ cls: 'lnode' + (n.state === 'aff' ? ' aff' : ''), pressed: n.state === 'on', act: b.act, data: pvArgs(b.args, sc, root) + ' data-i="' + n.i + '"', tip: h(n.tip || ''), icon: n.icon, label: h(n.label), tail: n.count ? '<span class="lnum num">' + n.count + '</span>' : '' }); };
      const arr = '<span class="larr" aria-hidden="true">' + icon('right', 12) + '</span>';
      const loop = function (l) { return '<div class="lloop' + (l.tone ? ' ' + l.tone : '') + '"><div class="lloop-h">' + icon(l.icon, 12) + h(l.title) + '</div>' + l.items.map(function (it) { return it.loop ? loop(it.loop) : '<div class="lrow">' + it.nodes.map(node).join(arr) + (it.back ? '<span class="lback" data-tip="' + h(it.back) + '">' + icon('refresh', 12) + '</span>' : '') + '</div>'; }).join('') + '</div>'; };
      return '<div class="lflow">' + xs.map(loop).join('') + '</div>';
    }
    if (b.variant === 'checks') return '<ul class="cafe-checks">' + xs.map(function (x) { return '<li' + (x.done ? ' class="done"' : '') + '>' + checkInd(x.done) + h(x.label) + '</li>'; }).join('') + '</ul>';   /* 清单：做完的打勾 */
    return xs.length ? '<ol class="vw-steps">' + xs.map(function (x) { return '<li>' + h(x) + '</li>'; }).join('') + '</ol>' : '';
  },
  /* 小节目录：先占位，整个视图画完后由 pdlView 换成锚点列表（目录在前、小节在后，条目要等小节画出来才知道） */
  toc: function (b, sc, root) { return '<nav class="mtoc scroll"' + pvNote(b.note) + '>' + PV_TOC + '</nav>'; },
  disclosure: function (b, sc, root) {
    const body = pvBlocks(b.blocks, sc, root);
    /* 展开 / 收起一块：一个样子（组件库的 foldSection）；里面什么都没有（optional 的列表没有项）就整个不画 */
    return body ? foldSection(pv(b.key, sc, root) || pvText(b.title, sc, root), pvAny(b.title, sc, root), body, { open: !!pv(b.open, sc, root), state: b.act ? !!pv(b.open, sc, root) : null, act: b.act, data: b.args ? pvArgs(b.args, sc, root) : '', sub: b.sub ? pvText(b.sub, sc, root) : '', note: b.note, count: pv(b.count, sc, root), trail: pvAny(b.trail, sc, root) }) : '';   /* 里面什么都没有（optional 的列表没有项）就整个不画 */
  },
  frame: function (b, sc, root) {
    const html = pv(b.html, sc, root), src = pv(b.src, sc, root);
    if (html != null || src != null) {
      const message = pv(b.message, sc, root), receive = b.on && pv(b.on.message, sc, root), key = pv(b.key, sc, root);
      const content = src != null ? ' data-island="frame:' + h(key != null ? key : src) + '" src="' + h(src) + '" sandbox="allow-scripts allow-forms allow-same-origin"' : ' data-frame-size sandbox="allow-scripts" srcdoc="' + h(html + '<script>(' + frameSizeScript.toString() + ')();<\/script>') + '"';
      return '<iframe class="vw-widget' + (b.tall ? ' tall' : '') + '"' + content + ' aria-label="' + pvText(b.title, sc, root) + '"' + (key != null ? ' data-frame-key="' + h(key) + '"' : '') + (receive ? ' data-frame-on-message="' + h(receive) + '"' : '') + (message != null ? ' data-frame-message="' + h(JSON.stringify(message)) + '"' : '') + '></iframe>';
    }
    if (b.plugin) return frame(pv(b.plugin, sc, root), pvText(b.what, sc, root), !!b.tall);
    const n = pvText(b.note, sc, root); return '<div class="frame">' + icon(pv(b.icon, sc, root), 28) + '<b>' + pvText(b.title, sc, root) + '</b>' + (n ? '<span>' + n + '</span>' : '') + '</div>';
  },
  empty: function (b, sc, root) {   /* 空状态（组件库的 emptyState，只有一种）：一句话 + ? + 一个操作；icon 是“选一项”的占位。加载中不是空状态（节点的 load，见 pvLoad） */
    const t = pvText(b.text, sc, root); if (!t) return '';
    return emptyState({ html: t, help: helpTip(pv(b.help || b.hint, sc, root)), acts: b.action ? pvControl(b.action, sc, root) : '', icon: b.icon });
  },
  /* 弹出层（组件库）：贴着触发元素（锚定 --pop，见 ui.js）；pos 只有方向 up、宽度 span（窗口网格占几列，按内容需要声明：候选这类少几列）、按内容定宽 fit，
     at = 相对锚点的偏移（选中文字：锚在消息上，偏到选区处）。不写坐标，放不下由浏览器翻到另一边 */
  pop: function (b, sc, root) {
    const v = Array.isArray(b.pos) ? b.pos.find(function (x) { return pvOk(x.when, sc, root); }) || {} : pv(b.pos, sc, root) || {}, p = { up: pv(v.up, sc, root), span: pv(v.span, sc, root), fit: pv(v.fit, sc, root) }, up = !!p.up, card = b.variant === 'card';   /* pos：位置的几种情况（第一个 when 成立的），每种写 up / span / fit */
    const vars = p.fit || !p.span ? '' : '--u-w:var(--span-' + (+p.span) + ')', page = pv(b.page, sc, root);   /* page：弹窗现在是哪一页（换了一页 = 留在弹窗里，pick 不关） */
    return floatHtml({ cls: card ? 'member-card' : 'pop' + (up ? ' up' : '') + (p.fit ? ' fit' : ''), label: b.label != null ? pv(b.label, sc, root) : undefined,
      attrs: (card ? ' aria-modal="true"' : '') + (page ? ' data-page="' + h(page) + '"' : '') + (vars ? ' style="' + vars + '"' : ''), body: b.view ? pdlView(pv(b.view, sc, root)) : pvBlocks(b.blocks, sc, root), bare: card });   /* 两种角色都用同一个面；摘要卡不套滚动层，保留原有内容结构。 */
  },
  /* 对话页的外壳（组件库）：顶部 → 浮在上面的条 → 消息流（唯一的滚动容器 #stream：流顶部的几行 + 消息）→ 右侧消息导航 → 底部（“到最新”、提示条、输入框）→ 浮层。
     #stream 的结构固定在这里：停在底部是组件库的 stick-end（反向排列，浏览器负责）；“到最新”是一个普通控件（jump），放在哪由 PDL 决定，离底部远时才显示 */
  chatpage: function (b, sc, root) {
    /* 对话页的两个子容器：消息流（内容，不动）和输入框（容器，可以在对话页里上下换位置；它附属的上沿三栏、工具栏是它的子节点，跟着走） */
    const key = b.key || 'main.chat';
    const parts = { stream: '<div class="stream scroll stick-end" id="stream" data-okey="stream"><div class="stream-inner">' + pvBlocks(b.top, sc, root) + pvBlocks(b.body, sc, root) + '</div></div>' + pvBlocks(b.side, sc, root),
      composer: '<div class="composer-wrap" data-okey="composer"' + (S.editLayout ? ' data-edit="order"' : '') + '>' + pvBlocks(b.dock, sc, root) + '</div>' };
    return '<div class="chat" data-ocontainer="' + key + '" data-order="' + pdlOrderOf(key, ['stream', 'composer']).join(' ') + '">' + pvBlocks(b.head, sc, root) + pvBlocks(b.bar, sc, root) + pdlOrderOf(key, ['stream', 'composer']).map(function (k) { return parts[k]; }).join('') + '</div>';
  },
  /* 消息导航（右侧细刻度）：一条消息一格；tone u 你 / c 成员 / s 其它，err 有出错、wait 等你回应；older：更早的还没加载 */
  ticks: function (b, sc, root) {
    return ('<nav class="cafe-mini hide-sm" data-note="14" data-tip-group="inline" data-own="ticks" aria-label="' + h(tc('chatNav.label')) + '">') + (pv(b.older, sc, root) ? '<span class="cafe-tick older" data-tip="' + h(tc('chatNav.older')) + '"></span>' : '') +
      unitsHtml('ticks', pvList(b.from, sc, root), function (x) { return x.mid; }, function (raw, r) { const x = unitsItem(b, raw, r), w = whoInfo(x.from, x.source), tip = x.tip && typeof x.tip === 'object' ? x.tip.prefix + htmlText(mdHtml(x.tip.markdown.filter(Boolean).join('\n'))).slice(0, x.tip.max) : x.tip; return '<button type="button" class="cafe-tick ' + x.tone + (x.err ? ' err' : '') + (x.wait ? ' wait' : '') + '" style="--c:' + h(w.color || 'var(--identity-fallback)') + '" data-act="msgJump" data-mid="' + h(x.mid) + '" data-tip="' + h(tip) + '" aria-label="' + h(x.label) + '"></button>'; }, root) + '</nav>';
  },
  /* 开始的几种方式（空对话）：图标 · 标题 · 一句话，点了做对应的事 */
  /* 标签编辑器：管理标签、整理未分类、对话设置、信号的标签都是它。项 { id, name, tint, n, on }；
     pick { act, args }：标签可勾选（on 是选中）；remove { act, label }：每个标签带 ×；add { id, act, args, tint, label, placeholder }：新建标签的输入（回车 / 框里的 + 提交） */
  tags: function (b, sc, root) {
    if (b.values) return chipBox(pv(b.id, sc, root), pvList(b.values, sc, root), { kind: pv(b.kind, sc, root), k: pv(b.k, sc, root), ph: pvText(b.placeholder, sc, root), label: pvText(b.label, sc, root), empty: pvText(b.empty, sc, root), lock: pv(b.lock, sc, root) });
    const xs = pvList(b.from, sc, root), pk = b.pick, rm = b.remove, ad = b.add;
    const chips = xs.map(function (x) {
      return pvControl({ type: 'chip', tint: x.tint != null ? '@tint' : null, label: '@name', faint: x.n != null ? '@n' : null, check: !!pk, pressed: pk ? '@on' : null,
        act: pk ? pk.act : null, args: pk ? Object.assign({ id: '@id' }, pk.args) : null, x: rm ? { act: rm.act, args: Object.assign({ id: '@id' }, rm.args), label: rm.label, icon: 'delete' } : null }, x, root);
    });
    const field = ad ? pvControl({ type: 'input', add: true, id: ad.id, placeholder: ad.placeholder || 't:tagManager.tagName', label: ad.label || 't:tagManager.newTag', go: ad.act, args: ad.args, goLabel: 't:common.create', tint: ad.tint }, sc, root) : '';
    return tagEditor({ chips: chips, empty: b.empty ? pvText(b.empty, sc, root) : '', field: field });
  },
  /* 对话列表：分组段 + 一个对话一行（数据形状见 lrow.js threadRow / threadSections） */
  threads: function (b, sc, root) { const html = threadSections(pvList(b.from, sc, root), b, root), n = pv(b.note, sc, root); return n ? '<div data-note="' + h(n) + '">' + html + '</div>' : html; },
  /* 弹出层里的一列选项（数据见 lrow.js 的 popEntry）；空的时候一行说明 */
  opts: function (b, sc, root) {
    const list = Array.isArray(b.from) ? b.from : pvList(b.from, sc, root), out = [];
    const one = function (it, data) {
      if (Array.isArray(it)) { it.forEach(function (part) { one(part, data); }); return; }
      if (!pvOk(it.when, data, root)) return;
      const x = pvArgsObj(it, data, root);
      if (x.lead) x.lead = pvArgsObj(Array.isArray(x.lead) ? x.lead.find(function (part) { return pvOk(part.when, data, root); }) : x.lead, data, root);
      if (x.args) x.args = pvArgsObj(x.args, data, root);
      if (x.disabled) x.act = '';
      out.push(popEntry(x));
    };
    list.forEach(function (it) { if (it.from && it.item) pvList(it.from, sc, root).forEach(function (x) { one(it.item, x); }); else one(it, sc); });
    const e = pv(b.empty, sc, root);
    return '<div class="pop-list">' + (out.length ? out.join('') : e ? popEntry({ note: e }) : '') + '</div>';
  },
  view: function (b, sc, root) { const id = pv(b.id, sc, root); return 'data' in b ? pdlViewOf(id, pv(b.data, sc, root)) : ctLeaf('view:' + id + '@' + (PV.tabKey || ''), S.route + '|' + S.thread, function () { return pdlView(id); }); },   /* 显式数据只在子视图里成为根；未声明时沿用子视图自己的 VM——它读到的来源记在它名下，数据推送没碰到这些来源时交回上一次的结果（ctLeaf） */
  /* 按渲染类型画（类型 = 容器.子类型，见 pdlTyped）：插槽里取最长的已登记、可用的前缀的模板；模板可以带自己的视图模型（收到这一项的数据，返回它要画的）；
     一个都没有就画块自己的 blocks（宿主的默认画法）——插件不在时，内容照样按宿主的容器画出来 */
  typed: function (b, sc, root) {
    const it = pv(b.data, sc, root), node = pdlTyped(b.slot, pv(b.of, sc, root));
    if (!node) return pvBlocks(b.blocks, sc, root);
    const r = node.vm ? vmRead(node.vm, it) : it;
    return r ? pvBlocks(node.blocks, r, r) : '';
  },
  component: function (b, sc, root) { const f = PDL_COMPONENTS[b.use]; return f ? f(pv(b.props, sc, root), sc, root) : ''; },
  /* 容器：给一组块套组件库里的一种角色（见 PDL_ROLES.box）；里面什么都没有就不画。tone：带状态色调的容器（告警卡片）；faint：被新的取代了（旧提议） */
  dialog: function (b, sc, root) { return dialogHtml({ key: pv(b.pop, sc, root), title: pv(b.title, sc, root), help: pv(b.help, sc, root), wide: pv(b.wide, sc, root), layout: pv(b.layout, sc, root), span: pv(b.span, sc, root), form: pv(b.form, sc, root), error: pv(b.error, sc, root), actions: pvControls(b.actions, sc, root), body: pvBlocks(b.blocks, sc, root), acts: pvBlocks(b.footer, sc, root) }); },
  box: function (b, sc, root) { const body = pvBlocks(b.blocks, sc, root), cls = BOX[b.variant || ''] + (pv(b.follow, sc, root) ? ' scroll stick-end' : ''); if (!body) return ''; const tone = pv(b.tone, sc, root); return '<div class="' + cls + '"' + (b.key ? ' data-key="' + h(pv(b.key, sc, root)) + '"' : '') + (tone ? ' data-tone="' + h(tone) + '"' : '') + (pv(b.faint, sc, root) ? ' data-faint' : '') + (b.open != null ? ' data-open="' + !!pv(b.open, sc, root) + '"' : '') + (pv(b.fill, sc, root) ? ' data-fill' : '') + pvNote(pv(b.note, sc, root)) + '>' + (/\bstick-end\b/.test(cls) ? '<div>' + body + '</div>' : body) + '</div>'; },   /* 停在底部的容器（stick-end）里只放一个子元素 */
  pre: function (b, sc, root) { const t = pv(b.text, sc, root); return t ? '<pre class="vw-code mono">' + annotationHtml(h(t), pvList(b.annotations, sc, root)) + '</pre>' : ''; },   /* 原样的文字（代码、日志、原始记录）：一个样子；不在里面限高滚动——它在的页面 / 详情铺满容器，由页面滚动 */
  /* 正文（Markdown）：一个样子。text 是 Markdown 文字；from 是一组段落；more 是接在后面的段落；clamp 收成几行 */
  markdown: function (b, sc, root) {
    const t = pv(b.text, sc, root), paras = pvList(b.from, sc, root).concat(pvList(b.more, sc, root));
    if (!t && !paras.length) return '';
    return '<div class="prose vw-md' + (pv(b.clamp, sc, root) ? ' clamp' : '') + '">' + annotationHtml((t ? mdLite(String(t)) : '') + paras.map(function (x) { return '<p>' + h(x) + '</p>'; }).join(''), pvList(b.annotations, sc, root), true) + '</div>';
  },

  /* 消息流：from 是消息列表，每一项按 kind 分派到 keyed 插槽（默认 chat.node）的节点模板 */
  /* 折叠（同一个组件，两种样式）：bottom 只留开头、底部渐隐、开关是居中的单个 V / ^；middle 留开头和结尾、中间收起、两侧渐隐、开关是右侧的双箭头。
     开关由测量步骤按真实高度决定要不要出现；展开状态写进 HTML（data-open），所以消息节点缓存会跟着重画 */
  fold: function (b, sc, root) {
    const one = (b.blocks || []).length === 1 ? b.blocks[0] : null, list = one && (one.type === 'list' || one.type === 'each') ? one : null;   /* 包着一个列表（list / each）：单位是项，项数来自数据 */
    const body = one && one.type === 'each' ? pvList(one.from, sc, root).map(function (it) { return '<div class="fold-item">' + pvBlocks(one.blocks, it, root) + '</div>'; }).join('') : pvBlocks(b.blocks, sc, root);   /* each 的一项可以是几个块：包成一个单位，折叠按项数 */
    if (!body) return '';
    return foldBox(pv(b.shape, sc, root) || 'bottom', pv(b.key, sc, root), body, { height: b.height, items: list ? pvList(list.from, sc, root).length : null });
  },
  stream: function (b, sc, root) { const id = b.id || 'chat', slot = b.slot || 'chat.node'; return '<div class="stream-list" data-stream="' + h(id) + '" data-own="stream">' + unitsHtml('stream:' + id, pvList(b.from, sc, root), streamUnitKey, function (it, r) { const t = pdlTyped(slot, it.kind); return t ? pvNode(t, it, r) : ''; }, root) + '</div>'; },
  /* 消息正文：内容本身（来自消息的富文本），不是界面标记；clamp 时收成几行 */
  content: function (b, sc, root) {
    const value = pv(b.html, sc, root); if (value == null) return ''; const html = annotationHtml(value, pvList(b.annotations, sc, root)); if (b.raw) return html;
    const f = pvDeep(b.fold, root, sc);   /* 折叠是组件库的 foldBox：长回复用 middle，转来的消息用 bottom */
    if (f && f.shape === 'middle') return '<div' + pvNote(pv(b.note, sc, root)) + '>' + foldBox('middle', f.key, html) + '</div>';
    if (f) return foldBox('bottom', f.key, html, { cls: 'msg-body' });
    return '<div class="msg-body' + (pv(b.clamp, sc, root) ? ' clamp' : '') + '"' + pvNote(pv(b.note, sc, root)) + '>' + html + '</div>';
  },
  search: function (b, sc, root) { return search(b.id, pv(b.placeholder, sc, root), pv(b.value, sc, root), b.input, 'vw-search'); },
  /* 一组选项：radio = 单选（对话区）；opt = 单选（选一个再提交）；check = 勾选 */
  /* 一组选项：默认单选（声明了 value 时选中项来自数据，否则记在本地草稿）；multi = 多选（一项一个勾选）；选项带缩略图（thumb）时画成缩略图单选（外观） */
  choices: function (b, sc, root) {
    const xs = pvList(b.from, sc, root);
    if (xs.length && xs.every(function (x) { return x && x.thumb; })) return '<div class="thumbs" role="radiogroup">' + xs.map(function (x) { return modeThumb(x, b.act, b.args ? pvArgsObj(b.args, sc, root) : null); }).join('') + '</div>';
    if (b.variant === 'multi') return '<div class="group vw-pad8">' + xs.map(function (x) { return cafeCheck(!!x.on, h(x.label) + (x.sub ? ' <span class="faint">' + h(x.sub) + '</span>' : ''), b.act, ' data-v="' + h(x.v) + '"' + pvArgs(b.args, sc, root)); }).join('') + '</div>';
    const g = pv(b.group, sc, root), cur = b.value != null ? pv(b.value, sc, root) : null;
    return '<div class="ws-opts" role="radiogroup">' + xs.map(function (o) { const v = o && typeof o === 'object' ? o.v : o, l = o && typeof o === 'object' ? o.label : o, s = o && typeof o === 'object' ? o.sub : ''; return b.value != null ? opt(g, v, cur, l, s, { plain: true, act: b.act, data: b.act ? pvArgs(b.args, sc, root) : '' }) : cafeRadio(g, v, l, s);   /* act：选一项执行它（带 args 和 data-v），没写时是本地的单选 */ }).join('') + '</div>';

  }
});
/* 一个节点（视图或块）在某个读取状态下的样子：文字是节点声明的，重试默认是数据层的重新读取（viewRetry，带上视图和工作台标签），也可以声明自己的 */
const LOAD_SHAPE = { cards: 'card', component: 'card' };
function pvLoad(b, st, sc, root) {
  const r = b.retry ? { act: pv(b.retry.act, sc, root), data: pvArgs(b.retry.args, sc, root) } : { act: 'viewRetry', data: argAttrs({ v: PV.viewId, k: PV.tabKey }) };
  return viewState(st, { text: pvText(b[st] || (st === 'empty' ? b.empty : ''), sc, root), retry: r, shape: LOAD_SHAPE[b.type] });
}
/* 节点：按模板把字段绑到消息卡片组件（msgFrame）上；正文和卡片下方是块 */
function pvNode(t, sc, root) {
  if (PV.ro) { PV.inert++; try { return pvNodeIn(Object.assign({}, t, { acts: null }), sc, root); } finally { PV.inert--; } }
  return pvNodeIn(t, sc, root);
}
function pvNodeIn(t, sc, root) {
  const P = function (x) { return pv(x, sc, root); };
  const meta = t.meta && pvOk(t.meta.when, sc, root) ? '<div class="msg-meta"' + pvNote(P(t.meta.note)) + '>' + '<span class="msg-meta-start">' + pvJoin(t.meta.parts, sc, root, '<span class="sep">·</span>') + '</span>' + (t.meta.end ? '<span class="grow"></span><span class="msg-meta-end">' + pvJoin(t.meta.end, sc, root, '') + '</span>' : '') + '</div>' : '';
  const side = t.frame === 'msg' && whoInfo(P(t.from) || P(t.who) || 'system').side || 'left';   /* 左右只由发送者推出：你在右，其余在左；表面跟着左右（卡片例外，由模板的 card 决定） */
  const markdown = t.markdown && pvOk(t.markdownWhen, sc, root) ? pvDeep(t.markdown, root, sc).join('\n') : null;
  const actsCtx = t.acts ? Object.assign({}, P(t.acts.ctx)) : {}; if (t.acts && t.acts.items) actsCtx.menu = menuLive(pvMenu(t.acts.items, actsCtx, root));
  return msgFrame({ frame: t.frame, side: side, surface: t.card ? 'none' : side === 'right' ? 'bubble' : 'bar', running: !!t.running, mid: sc.mid, text: P(t.text), who: P(t.who), time: P(t.time), receivedAt: P(t.receivedAt), badges: P(t.badges), quote: t.quote && pvOk(t.quote.when, sc, root) ? pvDeep(t.quote, root, sc) : null,
    icon: P(t.icon), title: P(t.title), tags: Array.isArray(t.tags) ? t.tags.filter(function (tag) { return pvOk(tag.when, sc, root); }).map(function (tag) { return { icon: P(tag.icon), text: P(tag.text), parts: tag.parts ? pvPart(tag.parts, sc, root) : null }; }) : P(t.tags), chips: (P(t.chips) || []).map(function (xs) { return t.chip ? xs.map(function (x) { return pvArgsObj(t.chip, x, root); }) : xs; }), delivery: pvDeep(t.delivery, root, sc), recv: P(t.recv), from: P(t.from), source: P(t.source), jump: P(t.jump), label: pvAnnot(t.label, sc, root), emph: sc.emph, picking: sc.picking, picked: sc.picked, notes: sc.notes,
    body: (markdown != null ? mdHtml(markdown) : '') + pvBlocks(t.body, sc, root), below: pvBlocks(t.pre, sc, root) + meta + pvBlocks(t.below, sc, root),
    acts: t.acts ? '<div class="cafe-acts ' + (side === 'right' ? 'mine' : 'theirs') + '" role="toolbar" aria-label="' + h(tc('message.actions')) + '" data-slot-page="' + t.acts.slot + '"' + pvNote(sc.notes && sc.notes.acts) + '>' + pdlTools(t.acts.slot, actsCtx, true) + '</div>' : '' });
}
/* 提示胶囊（tone / text / tip / 可关掉）；n > 1 时带一个“第几条 / 共几条”的小标记 */
function pvSingleItem(x, i, n) {
  return '<div class="cnote" data-i="' + (i || 0) + '" data-tip="' + h((x.text || '') + (x.tip ? ' · ' + x.tip : '')) + '">' + status(x.tone || '', x.text || '') + (n > 1 ? qty((i + 1) + '/' + n) : '') + (x.dismiss ? btn(tc('notice.dismiss'), { iconOnly: true, icon: 'close', size: 'xs', act: x.dismiss, data: argAttrs(x.dismissArgs) }) : '') + '</div>';   /* × 只关这一条。 */
}
/* 一组提示：同一时刻只露一条；多条时按节拍轮换（通用轮换 rotHtml），悬停暂停；关掉一条后下一条接上 */
function noticeList(items, key, attrs) {
  if (!items.length) return '';
  return rotHtml('div', 'cnotes', items.map(function (x, i) { return pvSingleItem(x, i, items.length); }), ' data-island="cnotes" data-flip' + (attrs || ''));
}
/* chain 插槽认领后的卡片：数据描述 { icon, title, chips, line }，字段用 {name} 引用 extract 出来的值 */
function pvClaim(x, ctx) {
  const v = {}; Object.keys(x.extract || {}).forEach(function (k) {
    const e = x.extract[k]; let val = null;
    if (e.from === 'tool') { const m = new RegExp(e.re).exec(ctx.tool || ''); val = m ? m[1] : null; }
    else { try { const j = JSON.parse(ctx.result); val = j[e.key]; } catch (err) { val = null; } }
    if (e.map && Object.prototype.hasOwnProperty.call(e.map, String(val))) val = e.map[String(val)];
    if ((val == null || val === '') && e.empty != null) val = e.empty;
    v[k] = val == null ? '' : String(val);
  });
  const f = function (t) { return h(String(t || '').replace(/\{(\w+)\}/g, function (_, k) { return v[k] || ''; })); };
  return '<div class="vw-claim">' + (x.icon ? icon(x.icon, 14) : '') + '<b>' + f(x.title) + '</b>' + (x.chips || []).map(f).filter(Boolean).map(function (c) { return chipHtml({ label: c }); }).join('') + (x.line ? '<span class="faint">' + f(x.line) + '</span>' : '') + '<span class="grow"></span><span class="faint vw-12">' + h(x.by || '') + '</span></div>';
}
/* 插槽认领卡片原件的 PDL 入口：未被认领时保留原样输出。 */
PDL_COMPONENTS.claim = function (p, sc, root) { const data = pvDeep(p.data, root, sc), claimed = pdlChain(p.slot, data); return claimed ? pvClaim(claimed, data) : monoBlock(data[p.fallback]); };
PDL_COMPONENTS.claim.catalog = { g: 'message', props: { slot: 'chat.tool.result', data: { lit: { tool: 'bash', result: 'ok' } }, fallback: 'result' } };
/* 视图在读取状态下：只画视图里的标题行（页头、详情头、面板顶栏，它们的操作照常可用），下面是组件库的状态；过期时状态在上、内容照常 */
function pvViewLoad(v, st, root) {
  const state = pvLoad(v, st, root, root);
  if (st === 'stale') return state + pvBlocks(v.blocks, root, root);
  /* 读取中照常画的：页头，和切换子视图的分段（换子视图时只有下面的内容换成骨架，分段本身不重画） */
  const bs = (v.blocks || []).filter(function (b) { return pvOk(b.when, root, root) && (b.type === 'head' || b.type === 'page' || (b.type === 'toolbar' && (b.items || []).some(function (c) { return c.type === 'seg'; }))); });
  if (bs[0] && bs[0].type === 'page') return '<div class="page">' + pvHead(bs[0], root, root) + state + '</div>';   /* 整页容器：状态放在页里 */
  return bs.map(function (b) { return b.type === 'toolbar' ? pvBlocks([b], root, root) : pvHead(b, root, root); }).join('') + state;
}

/* 小节目录跟着滚动标出当前小节（toc 块自己的行为）：目录的每一项指向同一视图里一个带 id 的小节（data-id）；
   装着目录的滚动容器滚动时，最后一个越过容器上沿（留 20 个单位的余量）的小节是当前项（aria-current），一个都没越过时是第一项。只改属性，不重画 */
document.addEventListener('scroll', function (e) {
  const sc = e.target, toc = sc.querySelector && sc.querySelector('.mtoc'); if (!toc) return;
  const items = Array.prototype.slice.call(toc.querySelectorAll('[data-id]')), top = sc.getBoundingClientRect().top, gap = 20 * (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--unit')) || 4);
  let cur = null; items.forEach(function (b, i) { const s = document.getElementById(b.dataset.id); if (s && (i === 0 || s.getBoundingClientRect().top - top < gap)) cur = b; });
  items.forEach(function (b) { if (b === cur) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current'); });
}, true);
/* 消息导航的键盘（组件库）：焦点在一格刻度上时，上下、Home / End、翻页在刻度之间移动焦点（同一个 keyStep） */
KEY_FNS.push(function (e) {
  const t = e.target; if (!t || !t.classList || !t.classList.contains('cafe-tick')) return false;
  const ticks = Array.from(document.querySelectorAll('button.cafe-tick')), k = keyStep(e, ticks.indexOf(t), ticks.length, { page: true });
  if (k == null) return false; e.preventDefault(); ticks[k].focus(); return true;
});
/* 消息导航的当前位置（组件库）：消息在消息流的视口里时，导航里对应的那一格带 data-vis（高亮）。由视口观察驱动，不在滚动事件里逐帧量；
   观察器跟着消息流走：消息流、消息、刻度进了文档时由引擎的进树通知（treeMatch）接上。只改刻度上的一个属性，不重画 */
const TICK_VIS = new Set(), TICK_IO = { io: null, root: null, inter: new Set() };
function tickVisMark(mid) {
  const on = Array.from(TICK_IO.inter).some(function (m) { return m.isConnected && m.dataset.mid === mid; });
  if (on) TICK_VIS.add(mid); else TICK_VIS.delete(mid);
  document.querySelectorAll('.cafe-tick[data-mid="' + CSS.escape(mid) + '"]').forEach(function (t) { t.toggleAttribute('data-vis', on); });
}
function tickVisRoot(s) {
  if (!s || TICK_IO.root === s) return;
  if (TICK_IO.io) TICK_IO.io.disconnect();
  TICK_IO.root = s; TICK_IO.inter.clear(); TICK_VIS.clear();
  TICK_IO.io = new IntersectionObserver(function (es) {
    const mids = {};
    es.forEach(function (e) { if (e.isIntersecting && e.target.isConnected) TICK_IO.inter.add(e.target); else TICK_IO.inter.delete(e.target); mids[e.target.dataset.mid] = 1; });
    Object.keys(mids).forEach(tickVisMark);
  }, { root: s });
  s.querySelectorAll('[data-stream] > .cafe-m[data-mid]').forEach(function (m) { TICK_IO.io.observe(m); });
}
/* 重画之后按记下的可见消息重新标刻度：可见性只改这一个属性、不写进 HTML——写进去的话，切一个工作台标签让消息流变窄一格，
   视口里的消息就换了，下一次画出来的刻度 HTML 和上一次不同，整块主区跟着重画，滚一下就冒滚动条 */
PAINT_SYNC.push(function () { document.querySelectorAll('.cafe-tick[data-mid]').forEach(function (t) { t.toggleAttribute('data-vis', TICK_VIS.has(t.dataset.mid)); }); });
treeMatch('#stream', tickVisRoot);
treeMatch('#stream [data-stream] > .cafe-m[data-mid]', function (m) { const s = m.closest('#stream'); if (s !== TICK_IO.root) tickVisRoot(s); else TICK_IO.io.observe(m); });
/* 视图引擎经组件库画的入口（PV_DRAW，见 engine/pdl-view.js） */
/* 按身份管自己孩子的列表（组件库通用：消息流、消息导航……；块的根带 data-own="类型"）——每一项是一个单元：按键记下它上次的数据对象、
   读到的页面级的值和界面状态、画出来的 HTML。数据没变由应用决定：没变的一项交来的还是上次那个对象（只比引用，不比内容）；
   主题的 item 映射在单元里面做（PV.units 登记的块），只有要重画的那一项才映射。带变化来源的重画里，这三样都没变的单元只交一个壳（keptStub）；
   DOM 上由 unitsOwn 按键对齐：没变的节点留在原位、变了的换掉、新的插进去、没了的拿掉 */
const UNITS = {};
/* 长列表一下子多出很多新的单元（第一次打开、换了对话）：先画最后（最新的）UNITS_FIRST 个，前面的先留着，原处是通用的读取中；
   之后每一帧补一批（一批比一批多），补的那一下只重画这个列表（它读过 UNITS_HELD 里自己那一项）；补上来的不算新到达。跳到一条还没画的消息时先全画上 */
const UNITS_FIRST = 12, UNITS_HELD = pdlTrack({}, 'UNITS');   /* 还没补上的：界面状态（读过它的列表在补上一批时重画） */
let UNITS_FILLING = false;
function unitsHeld(id, items, keyOf, was) {
  const held = UNITS_HELD[id], keys = items.map(keyOf);
  if (held) {   /* 只留开头那一段、而且后面还有画出来的：别的情况（同一个列表换了一组项）就全画 */
    held.keys.forEach(function (k) { if (keys.indexOf(k) < 0) held.keys.delete(k); });
    let lead = 0; while (lead < keys.length && held.keys.has(keys[lead])) lead++;
    if (held.keys.size && lead === held.keys.size && lead < keys.length) return held.keys;
    delete UNITS_HELD[id];
  }
  if (UNITS_FILLING) return null;   /* 补画（含全画上）的这一下不再留 */
  let lead = 0; while (lead < keys.length && !was[keys[lead]]) lead++;
  const n = Math.min(lead, keys.length - UNITS_FIRST); if (n <= UNITS_FIRST) return null;
  UNITS_HELD[id] = { keys: new Set(keys.slice(0, n)), batch: UNITS_FIRST };
  settleHold(new Promise(function (done) { unitsFill(id, done); }));
  return UNITS_HELD[id].keys;
}
function unitsFill(id, done) {
  requestAnimationFrame(function () {
    const held = UNITS_HELD[id]; if (!held) { done(); return; }
    const keys = Array.from(held.keys); held.batch *= 2;
    keys.slice(Math.max(0, keys.length - held.batch)).forEach(function (k) { held.keys.delete(k); });   /* 先补挨着已画部分的那些 */
    if (!held.keys.size) delete UNITS_HELD[id]; else held.left = held.keys.size;   /* 还剩几个：读过它的列表重画 */
    UNITS_FILLING = true; try { render(true); } finally { UNITS_FILLING = false; }
    if (UNITS_HELD[id]) unitsFill(id, done); else done();
  });
}
ENGINE_PARTS.unitsAll = function () {
  const ids = Object.keys(UNITS_HELD); if (!ids.length) return false;
  ids.forEach(function (id) { delete UNITS_HELD[id]; });
  UNITS_FILLING = true; try { render(true); } finally { UNITS_FILLING = false; }
  return true;
};
function unitsHtml(id, items, keyOf, draw, root) {
  const was = UNITS[id] || {}, now = {}, rootNow = {};   /* 页面级的值对每一项都一样：这一次只算一遍 */
  const rootSame = function (r) { if (!(r[0] in rootNow)) rootNow[r[0]] = JSON.stringify(root[r[0]]); return rootNow[r[0]] === r[1]; };
  const held = unitsHeld(id, items, keyOf, was);
  let heldAt = false;
  const html = items.map(function (it) {
    const key = keyOf(it), u = was[key];
    if (held && held.has(key)) { if (heldAt) return ''; heldAt = true; return '<div class="units-held" data-units-held>' + viewState('loading', { count: 3 }) + '</div>'; }
    if (u && RENDER_CHANGED && u.gen === RENDER_GEN && (u.item === it || u.json === JSON.stringify(it)) && !readsHit(u.reads, RENDER_CHANGED) && u.rootReads.every(rootSame)) {   /* 这一项的数据：同一个对象，或者值一样 */
      readsReplay(u.reads, true); now[key] = u; return u.html ? keptStub('unit:' + id + '|' + key, u.html) : '';
    }
    /* 交给这一项的根是一个会记读取的代理：读到根上哪个字段就记下它和它的值（嵌套子视图用它们自己的根，不在这里） */
    const reads = new Set(), rootReads = [], seen = {}, at = new Proxy(root, { get: function (t, k) { if (typeof k === 'string' && !seen[k]) { seen[k] = 1; rootReads.push([k, JSON.stringify(t[k])]); } return t[k]; } });
    READ_SCOPES.push(reads);
    let out; try { out = draw(it, at); } finally { READ_SCOPES.pop(); }
    reads.forEach(function (r) { for (let i = 0; i < READ_SCOPES.length; i++) READ_SCOPES[i].add(r); });
    now[key] = { item: it, json: JSON.stringify(it), gen: RENDER_GEN, reads: reads, rootReads: rootReads, html: out }; return out;
  }).join('');
  UNITS[id] = now;
  return html;
}
function unitsItem(b, it, root) { return b.item ? Object.assign({}, it, pvDeep(b.item, root, it)) : it; }
/* DOM 上的对齐：nodeKey(节点) 给出它的键（没有键的按出现顺序和原来的比，一样就留着）；
   hook 是组件自己在对齐时要做的（消息流的到达动效）：start(live, next, old) → 这一次的上下文，kept(原节点)，added(新节点, 同键的原节点, 上下文) */
function unitsOwn(nodeKey, hook) {
  return function (live, next) {
    const old = new Map(), loose = [];
    Array.prototype.forEach.call(live.childNodes, function (c) { const k = nodeKey(c); if (k) old.set(k, c); else loose.push(c); });
    const ctx = hook ? hook.start(live, next, old) : null;
    let li = 0;
    const plan = Array.prototype.map.call(next.childNodes, function (n) {
      const k = nodeKey(n), o = k ? old.get(k) : null;
      if (o && (n.dataset.kept || NODE_HTML.get(o) === streamVer(n))) { if (hook) hook.kept(o); return o; }   /* 这一项没变（只交了壳，或画出来一样）：原节点留着 */
      if (n.dataset && n.dataset.kept) return n;   /* 只交了壳、这里没有原节点：由 keptFill 换回完整的 */
      if (!k) { const c = loose[li++]; if (c && c.isEqualNode(n)) return c; }
      if (n.nodeType === 1) { NODE_HTML.set(n, streamVer(n)); if (hook) hook.added(n, o, ctx); }
      return n;
    });
    placeKids(live, plan);
  };
}
/* 消息流：单元的键——正在回复的占位按它的回合（data-run），其余按消息 id；新出现的消息有到达动效（这条流画之前就有、至少一条消息还在才算；正式消息接替占位不再到达） */
function streamUnitKey(it) { return it.kind === 'typing' ? 'typing:' + it.mid : String(it.mid); }
function streamNodeKey(n) { return n.nodeType === 1 ? (n.dataset.run ? 'typing:' + n.dataset.run : n.dataset.mid || null) : null; }
OWN.stream = unitsOwn(streamNodeKey, {
  start: function (live, next, old) {
    return { hadTyping: old.has('typing') || Array.prototype.some.call(live.children, function (c) { return c.dataset.mid === 'typing'; }),
      had: Array.prototype.some.call(next.children, function (n) { const k = streamNodeKey(n); return k && k.indexOf('typing:') !== 0 && old.has(k); }) };
  },
  kept: function (o) { o.classList.remove('arrive'); },
  added: function (n, o, c) { if (!o && c.had && !UNITS_FILLING && (n.dataset.mid === 'typing' || !c.hadTyping)) n.classList.add('arrive'); }
});
/* 消息导航：一格一个单元，按消息 id */
OWN.ticks = unitsOwn(function (n) { return n.nodeType === 1 ? n.dataset.mid || null : null; });
Object.assign(PV.units, { stream: 1, ticks: 1 });
/* 开进一个容器的东西：frame 节点（有视图画视图，只有地址画框）、页面；盖住容器时最前面是通用返回 */
function pvOpened(l, key, cover) {
  const f = String(l.f), fr = navNodeOf(l), fk = fr ? f.slice(5) : null;
  const body = fr ? (fr.type !== 'frame' ? pdlView(fk) : pvBlocks([{ type: 'frame', key: fk, src: fr.src, title: fr.title || '' }], {}, {})) : PAGES[f] ? PAGES[f]() : '';
  return '<div class="opened" data-opened="' + h(key) + '">' + (cover ? engineBack({ act: 'back', data: ' data-c="' + h(key) + '"' }) : '') + body + '</div>';
}
Object.assign(PV_DRAW, { node: pvNode, control: pvControl, load: pvLoad, toc: pvWithToc, viewLoad: pvViewLoad, state: viewState, opened: pvOpened });

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
function frameSizePrune() {
  document.querySelectorAll('iframe[data-frame-size]').forEach(function (el) { frameSizeHold(el); if (el._frameHeight) el.style.height = el._frameHeight; });
  FRAME_SIZE_PENDING.forEach(function (el) { if (!el.isConnected) { el._frameSizeDone(); el._frameSizeDone = null; FRAME_SIZE_PENDING.delete(el); } });
}
onRender(frameSizePrune);
LOCAL_NORM.push(function (root) {
  (root.matches('iframe[data-frame-size]') ? [root] : Array.from(root.querySelectorAll('iframe[data-frame-size]'))).forEach(function (el) { el.style.removeProperty('height'); if (!el.getAttribute('style')) el.removeAttribute('style'); });
});
