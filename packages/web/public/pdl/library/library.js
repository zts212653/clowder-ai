/* 边界：一个含义一个组件、不为接口定制、不按位置推导样式 */
/* 组件清单（主题的源头）：页面上每个元素都要能追溯到这里的一项，样子只来自这里的定义，一个含义只对应一个组件 / 图标。
   这份清单是机器可查的，也是组件目录的数据。三张表：
   - LIB_TEXT    文字角色：每个角色一句含义 + 它的 token（颜色、字号、字重、行高）+ 演这个角色的部件（of）。
                 样式由 build.py 从这张表生成 css/library.css（一条规则一个角色），部件自己的规则不再写颜色 / 字号 / 字重。
   - LIB_ACTIONS 动作表现表：动作含义名 → 图标、名字、色调。按钮、工具条、悬停工具只写动作（或动作含义），图标和名字从这里取（同一个含义同一个图标，由构造保证）。
   - LIB_PARTS   组件清单：组件 → 一句含义、在页面上的部件（of，选择器）、角色变体（每个变体一句含义 + 怎么认出来）。 */
'use strict';

/* ───────── 文字角色 ─────────
   tok 的键是 CSS 属性，值是 token 名（或无单位的数）。of 是部件：只写类名（或必要的上下文），不写样式。
   tone：同一个角色的色调变体（只有颜色不同，颜色通道「四档色调」）；state：选中 / 停用这类状态（只有颜色或字重不同）。 */
const LIB_TEXT = {
  hero: { means: '落地区的问候（空页面上的一句大字）', tok: { color: '--fg-strong', 'font-size': '--fs-hero', 'font-weight': '--fw-display' },
    of: ['h1.greet'] },
  heading: { means: '页面和对话框的标题', tok: { color: '--fg-strong', 'font-size': '--fs-title', 'font-weight': '--fw-display' },
    of: ['.page-title', '.dialog h3'] },
  section: { means: '页面里一个小节的标题', tok: { color: '--fg-strong', 'font-size': '--fs-xl', 'font-weight': '--fw-bold' },
    of: ['.section-title', '.ws-h'] },
  title: { means: '一件东西的名字（卡片、格子、侧栏、对话的标题）', tok: { color: '--fg-strong', 'font-size': '--fs-l', 'font-weight': '--fw-bold' },
    of: ['.vw-card-t', '.cgrid-t', '.nav-title', '.chat-title', '.ws-side-h', '.tpl-t b'] },
  strong: { means: '一句话里要强调的几个字（跟着所在文字的字号）', tok: { color: '--fg-strong', 'font-weight': '--fw-bold' },
    of: ['.vw-strong', '.notice b', '.frame b'] },
  compact: { means: '紧凑一行里的正文（记录行、树行、键值、目标选择）', tok: { color: '--fg-strong', 'font-size': '--fs-m', 'font-weight': '--fw-normal' },
    of: ['.lr:is([data-layout="record"], [data-layout="tree"]) .lr-title', '.kvg dd', '.target', '.qchip', '.tpl-t', '.cafe-ul', '.rules', '.cat-rules', '.calendar-day > span:first-child'],
    state: [['outside', '.calendar-day[data-outside="true"] > span:first-child', ['color']]] },
  body: { means: '界面里的正文：一行的标题、设置和字段的名字、一段说明、导航和菜单的项', tok: { color: '--fg-strong', 'font-size': '--fs-l', 'font-weight': '--fw-normal' },
    of: ['.lr-title', '.row-title', '.field > label', '.field > .label', '.field .value', '.vw-para', '.lr-text', '.nav-item', '.menu button'],
    state: [['current', '.nav-item:is([aria-current="page"], [aria-current="true"])', ['font-weight']], ['off', '.lr.done .lr-title, .row.off .row-title', ['color']]] },
  prose: { means: '阅读的内容（消息、Markdown、文档）', tok: { color: '--fg-strong', 'font-size': '--fs-xl', 'font-weight': '--fw-normal', 'line-height': '--lh-read' },
    of: ['.msg-body', '.md', '.prose', '.bubble', '.card-ul'] },
  value: { means: '名字后面的值或补充（只读的设置值、@句柄、必填星号）：跟着所在那一行的字号，次要墨色', tok: { color: '--fg-muted', 'font-weight': '--fw-normal' },
    of: ['.sys-v', '.row.setting .row-trail', '.lr-title .plain', '.row-title .plain', '.who-line .plain', '.req', '.select-p'] },
  meta: { means: '次要信息：时间、数量、来源、副行、状态说明、备注', tok: { color: '--fg-muted', 'font-size': '--fs-s', 'font-weight': '--fw-normal' },
    of: ['.lr-sub', '.row-sub', '.lr-aside-t', '.lr-aside-b', '.lr-col', '.lr-meta', '.lr-line > :not(.lr-title)', '.c:not(pre *)', '.msg-head .time', '.msg-head .h', '.msg-meta', '.msg-meta .sep', '.msg-meta button', '.meta-btn', '.nav-item .trail',
      '.vw-meta', '.vw-label', '.cgrid-s', '.cafe-tagt', '.field-foot', '.status', '.kv span', '.kvg dt', '.day', '.vw-marker', '.rt-stripe-i', '.edit-bar-t', '.calendar-weekdays > span', '.calendar-count',
      '.cat-use', '.cat-na', '.cat-miss', '.cat-note', '.cat-roles', '.cat-props summary', '.calc-mark', '.calc-help', '.calc-row output', '.bars em', '.pop-foot', '.pop-run', '.faint', '.muted'],
    state: [['open', '.msg-meta button[aria-expanded="true"]', ['color']], ['unused', '.cat-use.none', ['color']], ['off', '.row.off .row-sub', ['color']]] },
  label: { means: '一组东西上面的小标签（分组名、表头、眉题）', tok: { color: '--fg-faint', 'font-size': '--fs-s', 'font-weight': '--fw-medium' },
    of: ['.lr-section-label', '.lloop-h', 'th', '.ws-eyebrow', '.cap-dlg-h'] }
};

/* 文字的色调（任何文字角色都可以带，只改颜色：四档色调 + 两档墨色）：一个色调一条规则 */
const LIB_TEXT_TONE = {
  warn: { tok: '--warn', of: ['.vw-t-warn', '.vw-warn-t', '.c.warn', '.lr-col.warn', '.lr-text.warn', '.cap-sm.failed .cap-state'] },
  danger: { tok: '--danger', of: ['.vw-t-danger', '.lr-col.danger'] },
  ok: { tok: '--ok', of: ['.vw-t-ok', '.lr-col.ok'] },
  info: { tok: '--info', of: ['.vw-t-info'] },
  faint: { tok: '--fg-faint', of: ['.vw-t-faint', '.cap-sm.unknown .cap-state'] },
  muted: { tok: '--fg-muted', of: ['.vw-t-muted'] }
};

/* ───────── 动作表现表 ─────────
   键是动作含义名；icon 是图标的含义名（frame.js 的 ICON_MEANING，保留字形只能这样用）或普通字形名，label 是文案键，tone 只有危险操作写 danger。
   动作（data-act + 参数）→ 含义由 LIB_ACT_OF 推出：通用动词按参数分，功能动作登记自己的含义名。 */
const LIB_ACTIONS = {
  reply: { icon: 'reply', label: 'common.send' },   /* 在这条对话里发出 / 引用（输入框的发送键、消息工具条的回复和引用） */
  send: { icon: 'send', label: 'common.send' },   /* 把排好的消息现在发出（只有排队用） */
  stop: { icon: 'stop', label: 'common.stop', tone: 'danger' },
  close: { icon: 'close', label: 'common.close' },   /* 关掉、从选择里拿掉（×） */
  delete: { icon: 'delete', label: 'common.delete', tone: 'danger' },
  restore: { icon: 'undo', label: 'common.restore' },
  edit: { icon: 'edit', label: 'common.edit' },
  copy: { icon: 'copy', label: 'common.copy' },
  more: { icon: 'more', label: 'common.moreActions' },
  back: { icon: 'back', label: 'common.back' },
  forward: { icon: 'right', label: 'common.next' },
  refresh: { icon: 'refresh', label: 'common.refresh' },
  add: { icon: 'plus', label: 'common.add' },
  search: { icon: 'search', label: 'common.search' },
  jump: { icon: 'jump', label: 'common.open' },
  openExternal: { icon: 'openExternal', label: 'common.open' },
  upload: { icon: 'upload', label: 'common.import' },
  download: { icon: 'download', label: 'common.download' },
  maximize: { icon: 'maximize', label: 'common.expand' }
};
/* 动作 → 含义：通用动词按参数分；功能动作只登记含义名（它们有自己的流程，表现仍然从上面那张表取） */
const LIB_ACT_OF = {
  close: 'close', back: function (d) { return d.exit === 'x' ? 'close' : 'back'; },   /* 层的 ✕ 退出也走 back（回到被盖住的那一层），含义是关闭；带标题的 ‹ 才是返回 */ forward: 'forward', copy: 'copy', refresh: 'refresh', rename: 'edit', send: 'reply', stop: 'stop',   /* 改名就是就地编辑（同一支笔）；⋯ 只由 moreBtn 画，菜单触发（下拉、目标选择）的图标画的是东西，不是动作 */
  add: 'add', chipDel: 'close', searchGo: 'search', openUrl: 'openExternal',
  cafeMsgRetry: 'refresh', cafeQueueSend: 'send', cafeRunStop: 'stop', opLiveStop: 'stop', pdlThemeExport: 'download', cafeConnClose: 'close',   /* 重试一轮 = 再来一次（同一个 ↻） */
  open: function (d) { return { msg: 'jump', traceMsg: 'jump' }[d.kind] || ''; },   /* 回到原处（回复引用、跳到原文）：全站只有这一个动作和字形 */
  tab: function (d) { return { close: 'close', split: 'close' }[d.op] || ''; },   /* 关标签、结束并排（并排头上的 ×） */
  pcfOp: function (d) { return d.op === 'del' ? 'delete' : d.op === 'add' ? 'add' : ''; },
  cafeQueue: function (d) { return d.v === 'drop' ? 'delete' : d.v === 'edit' ? 'edit' : ''; },
  pvNav: function (d) { return d.v === 'back' ? 'back' : d.v === 'fwd' ? 'forward' : d.v === 'reload' ? 'refresh' : ''; }
};
/* data 属性串（' data-v="drop"'）→ 参数 */
function libActArgs(act, data) { const d = { act: act }; String(data || '').replace(/data-([\w-]+)="([^"]*)"/g, function (m, k, v) { d[k.replace(/-(\w)/g, function (x, c) { return c.toUpperCase(); })] = v; return m; }); return d; }
/* 画按钮时用：按钮的含义 = 动作登记的含义（LIB_ACT_OF），没登记时是声明里写的含义名（icon: 'delete' 这类本来就是含义名）；
   含义在表里就画表里的图标。通用动词（remove / set / toggle）的含义随实体变（关一个标签、删一条记录），所以由声明说，不由动词推 */
function libActMean(act, data, declared) { const k = act && libActMeaning(libActArgs(act, data)); return k && LIB_ACTIONS[k] ? k : LIB_ACTIONS[declared] ? declared : ''; }
function libActIcon(act, data, fallback) { const k = libActMean(act, data, fallback); return k ? LIB_ACTIONS[k].icon : fallback; }
function libActAttr(act, data, declared) { const k = libActMean(act, data, declared); return k ? ' data-mean="' + k + '"' : ''; }
function libActMeaning(ds) { const f = ds && LIB_ACT_OF[ds.act]; return typeof f === 'function' ? f(ds) || '' : f || ''; }
/* 工具类：只管布局、截断、读屏、数字等宽，不是组件；带这些类的元素的样子来自它所在的组件（provenance 检查向上找） */
const LIB_UTIL = ['overlay-host', 'grow', 'num', 'sr', 'hide-sm', 'scroll', 'scroll-x', 'stick-end', 'float-body', 'cafe-ellip', 'table-wrap', 'swap-d', 'stack', 'acts', 'click', 'status-t', 'select-v', 'select-vs', 'select-sz', 'select-t', 'u-v-width', 'u-v-height', 'u-v-background', 'vw-w80', 'vw-w220', 'clamp', 'nolead', 'head-line', 'typing-scope', 'field-add', 'msg-meta-start', 'msg-meta-end', 'pdl-slot', 'ws-noted'];

/* ───────── 组件清单 ─────────
   每个组件：means 一句含义；of 页面上认它的选择器（只认组件的根）；v 角色变体 { 名: [含义, 选择器] }（按顺序取第一个命中的，'*' 是默认）；
   icon: 'action' = 它的图标画的是动作（取自动作表现表，meaning 检查管）；别的组件的图标画的是东西（PR、项目、面板）；inherit = 字号和墨色跟着所在的文字角色。
   同一个含义只登记一次（meaning 检查：两个组件的 means 相同就失败，除非在例外里写明理由）。 */
const LIB_PARTS = {
  /* 基础控件 */
  btn: { icon: 'action', means: '按钮：中性浅底（默认，半透明墨色）、实底（主操作）、危险浅底、危险实底；只有图标的按钮平时墨色；折叠箭头、富文字与返回标题通过同一按钮壳组合', of: '.btn', v: {
    kind: [['dangerSolid', '.danger[data-primary]:not(.btn-icon)', '不可逆操作的最后确认'], ['dangerSoft', '.danger:not(.btn-icon)', '危险操作'], ['text', '.btn-text', '正文里的文字按钮'], ['solid', '[data-primary]', '一组里的主操作'], ['icon', '.btn-icon', '只有图标（引擎的返回也是它）'], ['soft', '*', '默认']],
    size: [['xs', '.btn-xs', '提示胶囊、标签页上的小图标'], ['s', '.btn-sm', '行里和头里'], ['m', '*', '默认']],
    state: [['disabled', ':disabled, [aria-disabled="true"]', '停用'], ['pressed', '[aria-pressed="true"]', '开关按钮开着'], ['off', '[aria-pressed="false"]', '开关按钮关着'], ['busy', '[aria-busy="true"]', '进行中：图标转，不能再点'], ['rest', '*', '平时']] } },
  send: { icon: 'action', means: '发送 / 停止（输入框唯一的那个圆钮）', of: '.send', v: { kind: [['stop', '.stop', '停止这一轮'], ['send', '*', '发送']] } },
  switch: { means: '开关：表示启用 / 停用', of: '.switch', v: { on: [['on', '[aria-checked="true"]', '开'], ['off', '*', '关']] } },
  'switch.knob': { means: '开关的滑块', of: '.switch > span', v: { on: [['on', '[aria-checked="true"] > span', '开'], ['off', '*', '关']] } },
  check: { means: '勾选 / 单选的标记', of: '.box, .opt .radio, .cafe-check, .thumb-opt, .tk-st', v: { state: [['on', '.on, [aria-checked="true"] > *, [aria-checked="true"], input:checked + *', '选中'], ['off', '*', '没选']], kind: [['radio', '.radio', '单选'], ['thumb', '.thumb-opt', '带缩略图的单选（外观）'], ['cycle', '.tk-st', '点一下换到下一个状态的圆形标记（任务状态）'], ['row', '.cafe-check', '整行可点的勾选（选消息、设置项）'], ['check', '*', '勾选']] } },
  'check.mark': { means: '状态圆形标记里面的那一圈', of: '.tk-g', v: { status: [['done', '.done', '做完'], ['doing', '.doing', '进行中'], ['blocked', '.blocked', '卡住'], ['todo', '*', '没开始']] } },
  seg: { means: '分段：不超过 4 个选项的单选', of: '.seg', v: {} },
  chips: { means: '一排可点的标签（筛选：分类、节点、依赖；每一项是 chip）', of: '.ctabs, .chips' },
  'seg.item': { means: '分段里的一项', of: '.seg > button', v: { state: [['on', '[aria-pressed="true"]', '选中'], ['rest', '*', '平时']], tone: [['warn', '.warn', '有异常的那一类'], ['plain', '*', '平常']] } },
  select: { means: '下拉选值（当前值 + 上下箭头，点开是菜单）', of: '.select-wrap', v: {} },
  trigger: { means: '打开菜单 / 选值 / 选目标的触发', of: '.select-wrap > button.select, .cafe-drop, button.target, .cafe-people', v: { kind: [['select', '.select', '选值'], ['menu', '.cafe-drop', '打开菜单'], ['people', '.cafe-people', '对话的成员（头像堆）'], ['target', '*', '目标选择']] } },
  input: { means: '输入框（单行、多行、搜索）', of: '.input, .search, .ifield, textarea, input:not([type=checkbox]):not([type=radio]):not([type=range]):not(.sr), .ta-ghost', v: { kind: [['ghost', '.ta-ghost', '同行补全的覆盖层（和输入框同一套排版，只露出淡色的后半段）'], ['bare', '.input-lead > .input, .ifield > .input, .search > .input, .composer .input, .input-title', '套在别的框里的（框是外层的）'], ['search', '.search', '搜索框（放大镜是提交）'], ['field', '.ifield', '带提交图标的输入（goField）'], ['mono', '.mono', '等宽（命令、路径）'], ['plain', '*', '普通']] } },
  'input.part': { means: '输入框里的分隔、前导和搜索框的放大镜（就是提交）', of: '.ifield-sep, .input-lead, .search-go' },
  chip: { means: '标签：问题卡片的短标签、来源、对话标签；可点的是筛选、流程图的节点、阶段进度的一步', of: '.chip, .tag', v: { kind: [['step', '.ws-step', '阶段进度的一步'], ['action', 'button.chip', '可点（筛选、节点）'], ['static', '*', '不可点']], state: [['on', '[aria-pressed="true"], .on', '选中 / 当前'], ['done', '.done', '做完'], ['aff', '.aff', '受影响的节点'], ['rest', '*', '平时']], tone: [['warn', '[data-tone="warn"]', '有异常的那一类'], ['plain', '*', '平常']] } },
  'chip.x': { icon: 'action', means: '标签上移除自己的 ×', of: '.chip-x' },
  'chip.main': { means: '可点标签的主体（标签带 × 时点字的那一半）', of: '.chip-main' },
  slider: { means: '滑块（在一个范围里取值）', of: 'input[type=range], .ws-range' },
  toolbar: { means: '一排控件（头、保存条、批量操作条、嵌在正文里的一件东西）', of: '.toolbar' },
  mark: { means: '短代码徽标（优先级、文件状态），颜色来自色调', of: '.vw-badge', v: { tone: [['warn', '.vw-t-warn', '留意'], ['danger', '.vw-t-danger', '出错'], ['ok', '.vw-t-ok', '正常'], ['plain', '*', '平常']] } },
  scrim: { means: '遮罩（全页只有一层）', of: '#scrim' },
  link: { means: '正文里的链接（强调色字，无底；字号跟着所在的文字）', inherit: true, of: 'a[href], .link, .cafe-link, .mention', v: { kind: [['mono', '.mono', '路径 / 标识（等宽）'], ['text', '*', '文字']], region: [['msg', '.msg-body *, .md *', '消息里'], ['ui', '*', '界面里']] } },
  refchip: { means: '引用胶囊（文件 / PR / 提交）', of: '.ref-chip, .ref-n', v: { tone: [['danger', '[data-tone="danger"], [data-tone="danger"] *', '出错'], ['warn', '[data-tone="warn"], [data-tone="warn"] *', '留意'], ['plain', '*', '平常']] } },
  copy: { means: '可复制的值（值 + 行尾的复制图标）', of: '.copyv, .copyv-v' },
  help: { means: '「?」帮助', of: '.help-q' },
  color: { means: '取色：一个色块，旁边可带名字预览（颜色是数据）', data: ['bg', 'color', 'shadow'], of: '.color-sw, .color-name, .cafe-tints > button, .theme-dot, .calc-sw', v: { kind: [['name', '.color-name', '名字用这个颜色的预览'], ['dot', '.theme-dot', '主题的色点'], ['slot', '.cafe-tints > button', '只在主题的成员色槽位里单选（kind: slot）'], ['swatch', '*', '色块']] } },
  /* 身份 */
  avatar: { means: '头像：成员圆形，插件和系统圆角方形，五档尺寸', data: ['bg', 'color'], of: '.avatar, .hb-av, .tile-av', v: { ring: [['stacked', '.stack .avatar', '叠在头像堆里（一圈压边）'], ['current', '.scap.cur .avatar', '输入框上当前「发给」的那只（身份色环）'], ['queue', '.qto .avatar', '排队项里的收件猫（一圈压边）'], ['picked', '.tile-av[aria-pressed="true"] .avatar', '选中的头像（选中环）'], ['square', '[data-shape="square"]', '插件 / 系统（1px 身份色环）'], ['none', '*', '单独']], size: [['xs', '.av-xs', '回复引用'], ['s', '.av-s', '胶囊、记录行'], ['l', '.av-l', '消息作者'], ['xl', '.av-xl', '页头、成员卡'], ['m', '*', '列表前导']], shape: [['square', '[data-shape="square"]', '插件 / 系统'], ['round', '*', '成员']] } },
  who: { means: '身份的名字（成员色，是数据）', data: ['color'], of: '.msg-name, .who-name, .cap-x b', v: { place: [['author', '.msg-name', '消息作者'], ['small', '.cap-sm *', '小胶囊里'], ['inline', '*', '胶囊和行里']] } },
  /* 状态、计数、进度 */
  dot: { means: '状态色点（颜色 = 色调或成员色，执行中按节拍闪）', of: '.dot', not: '.badge', v: { tone: [['run', '[data-tone="run"]', '执行中'], ['live', '[data-tone="live"]', '录音中'], ['id', '[data-tone="id"]', '身份色'], ['info', '[data-tone="info"]', '提示'], ['ok', '[data-tone="ok"]', '正常'], ['warn', '[data-tone="warn"]', '留意'], ['danger', '[data-tone="danger"]', '出错'], ['idle', '*', '空闲']] } },
  badge: { means: '要你来看的计数徽标 / 小红点', of: '.badge, .cafe-badge, .cafe-ib-count', v: { shape: [['dot', '.dot', '只是一个点'], ['count', '*', '数字']], tone: [['at', '.at', '@你'], ['tone', '[data-tone]', '色调'], ['plain', '*', '强调色']] } },
  progress: { means: '进度条（已用 / 上限）', of: '.ws-prog, .lr-bar, progress, [role="progressbar"]', v: { kind: [['row', '.lr-bar', '行底的用量条'], ['inline', '*', '行内的一条']] } },
  'progress.fill': { means: '进度条里已完成的那一段', of: '.ws-prog > i', v: { tone: [['warn', '.warn > i', '到阈值'], ['danger', '.danger > i', '超了'], ['plain', '*', '平常']] } },
  /* 行、列表、树 */
  media: { means: '媒体内容、原始像素标记与标绘编辑', of: '[data-media-editor], .media-content, .media-marks' },
  calendar: { means: '日期网格：月和周共用日期、今日标记、事件计数与选择行为', of: '.calendar' },
  'calendar.grid': { means: '日期网格的七列和星期标题', of: '.calendar-days, .calendar-weekdays' },
  'calendar.day': { means: '可选择的一个日期', of: '.calendar-day', v: { state: [['selected', '[aria-pressed="true"]', '选中日期'], ['normal', '*', '其他日期']] } },
  row: { means: '一行一项（单行 / 双行 / 条目 / 树行 / 记录行五种布局）', of: '.lr, .row, .menu [role="menuitem"], .nav-item, .rt-stripe-i', v: {
    layout: [['menu', '[role="menuitem"]', '菜单项'], ['nav', '.nav-item, .rt-stripe-i', '导航的一项（侧栏、工作台竖条、小节目录）'], ['setting', '.row', '设置行'], ['record', '[data-layout="record"]', '记录行'], ['tree', '[data-layout="tree"]', '树行'], ['item', '[data-layout="item"]', '条目'], ['two', '[data-layout="two"]', '双行'], ['line', '*', '单行']],
    state: [['sel', '.selected, [aria-current]:not([aria-current="false"])', '当前 / 选中'], ['danger', '.danger', '危险的一项（菜单里的删除）'], ['disabled', '[aria-disabled="true"]', '停用（悬停看原因）'], ['past', '.past', '过去的（灰一档）'], ['off', '.off, .done', '停用 / 做完'], ['run', '.run', '执行中的这一项（浅底）'], ['here', '.here, .cur', '正在看的这一项（浅身份色底）'], ['open', '[data-open="true"]', '原位展开的一行（整行一块面）'], ['rest', '*', '平时']] } },
  'row.part': { means: '行的各格（头、前导、主体、行尾、操作、展开区、置顶标记、执行中、草稿、工作台竖条的名字）', v: { state: [['sel', '.lr.selected > *, .lr[aria-current]:not([aria-current="false"]) > *', '当前 / 选中'], ['here', '.lr:is(.here, .run, .cur) > *', '正在看的 / 执行中的这一项（浅身份色底）'], ['rest', '*', '平时']] }, of: '.lr-head, .lr-lead, .lr-main, .lr-line, .lr-aside, .lr-end, .lr-acts, .lr-ctls, .lr-cols, .lr-more, .lr-exp, .lr-pre, .lr-partial, .row-main, .lr-colbtn, .run, .trow-rot, .trow-draft, .rt-stripe-l' },
  glyph: { means: '行前导的图标格（底色方块里一个图标）', of: '.glyph, .vw-ic, .cap-ic', v: { kind: [['cap', '.cap-ic', '胶囊里的'], ['bare', '.vw-ic', '不带底（行前导里的状态图标）'], ['tile', '*', '带底']], size: [['xl', '.glyph-xl', '页头里的大图标（同成员头像 xl）'], ['m', '*', '默认']] } },
  'list.group': { means: '一组并列项的分组底（项之间是分隔线）', of: '.group, .lr-list' },
  'section-head': { means: '分组 / 折叠段的标题行', of: '.section-head, .ws-fold-h, .calc-sec-h, .gsec-h, .cafe-gbtn, .cafe-ghead, .cafe-gbtn .n', v: { kind: [['page', '.section-head', '页面小节'], ['fold', '.ws-fold-h', '工作台折叠段'], ['calc', '.calc-sec-h', '计算器分段'], ['nav', '*', '侧栏分组']] } },
  fold: { means: '开合指示：内容折叠（⌄⌃）和分组展开（箭头）', of: '.fold-tg, .tw', v: { kind: [['content', '.fold-tg', '内容折叠'], ['twisty', '*', '分组展开']] } },
  'fold.box': { means: '折叠块（收起时渐隐；里面的内容是它自己的组件）', of: '.fold' },
  kv: { means: '键值：一组数字块或一列「键 · 值」', of: '.kv, .kvg, .bars, .vw-counters, .vw-counter', v: { tone: [['warn', '.vw-t-warn', '留意'], ['plain', '*', '平常']], kind: [['grid', '.kvg', '一列键值'], ['bars', '.bars', '条形'], ['tiles', '*', '数字块']] } },
  'kv.num': { means: '数字块里的数', of: '.vw-counter b, .kv b', v: { tone: [['warn', '.vw-t-warn b', '留意'], ['plain', '*', '平常']] } },
  table: { means: '表格：界面里的（一行可点，悬停整行）和 Markdown 里的（阅读内容）；整行两端的圆角是行的样子，落在首尾格上（格子在行里的位置，不是变体）', inherit: true, data: ['radius'], of: 'table, td, tr', v: { kind: [['prose', ':is(.md, .msg-body) *', 'Markdown 里的表格（不悬停、顶对齐）'], ['data', '*', '界面里的表格']] } },
  empty: { means: '空状态（只说现在是什么；行内的空是一句次要信息，用文字角色 meta）', of: '.empty, .vw-empty, .cafe-none', v: { kind: [['lead', '.lead', '大号'], ['m', '*', '默认']] } },
  skeleton: { means: '读取中的骨架', of: '.skel', v: { shape: [['row', '.row', '骨架行'], ['prev', '.prev', '预览'], ['short', '.short', '短'], ['line', '*', '一行']] } },
  /* 浮层、提醒 */
  surface: { means: '浮层的面（菜单、弹出层、对话框（主题计算器这类工具窗也是它）、查看器、编辑条、成员卡、队列）', of: '.menu, .pop, .ws-pop, .dialog, .mv-card, .edit-bar, .member-card, .rt-stripe, .qbox, .float-body', v: { kind: [['tool', '.dialog:not([aria-modal])', '没有遮罩的对话框（主题计算器）：普通的面'], ['dialog', '.dialog', '对话框'], ['viewer', '.mv-card', '查看器'], ['bar', '.edit-bar, .rt-stripe', '一条（编辑条、工作台竖条）'], ['queue', '.qbox', '排队浮层'], ['menu', '*', '菜单 / 弹出层']] } },
  'surface.part': { means: '浮层的头、尾、分隔线', of: '.dlg-head, .dialog-body, .divider, .calc-sec, .calc-row, .calc-pair, .inbox' },
  tooltip: { means: '提示（全局只有一个）', of: '.ui-tip' },
  notice: { means: '提示条 / 横幅 / 输入框提示胶囊 / 轻提示 / 保存条 / 浮条', of: '.notice, .toast, .cnote, .savebar, .vw-float, .cafe-sysc', v: { kind: [['toast', '.toast', '轻提示'], ['pill', '.cnote', '输入框上的提示胶囊'], ['savebar', '.savebar', '保存条'], ['float', '.vw-float', '浮条'], ['sys', '.cafe-sysc', '系统提示（消息流里）'], ['notice', '*', '提示条 / 横幅']], tone: [['tone', '[data-tone]', '带色调'], ['plain', '*', '平常']] } },
  status: { means: '状态：小字前一个色点（色调），状态要配一两个字', of: '.status', v: { tone: [['tone', '[data-tone]', '带色调'], ['plain', '*', '只有字']] } },
  /* 消息与卡片 */
  msg: { means: '一条消息（所有发送者同一个模板；猫的消息左边是成员色竖线，颜色是数据）', data: ['border'], of: '.msg, .cafe-m, .cafe-m-in, .author-row, .msg-head, .cat-bubble, .stream-list, .stream-inner', v: {} },
  bubble: { means: '你的消息的气泡', of: '.bubble' },
  replyref: { means: '回复引用（↩ + 头像 + 名字：前几个字）', of: '.reply-ref, .reply-n, .reply-t' },
  capsule: { means: '状态胶囊 / 对话胶囊 / 头像堆', of: '.cap, .rstack, .cap-pill, .cap-lead, .cap-x, .cap-state, .scap', v: { size: [['s', '.cap-sm, .cap-sm *', '消息下的小胶囊'], ['m', '.cap-m, .cap-m *', '输入框上的'], ['l', '*', '默认']], part: [['pill', '.cap-pill', '胶囊本体'], ['lead', '.cap-lead', '前导'], ['text', '.cap-x, .cap-state', '字'], ['root', '*', '外框']], state: [['failed', '.failed, .failed *', '投递失败（字用警示色）'], ['unknown', '.unknown, .unknown *', '状态未知（字用淡色）'], ['warning', '.cap:has(.avatar:is([data-status="alive_but_silent"], [data-status="suspected_stall"])), .cap:has(.avatar:is([data-status="alive_but_silent"], [data-status="suspected_stall"])) *', '执行静默或疑似停滞（文字借用警示色）'], ['error', '.cap:has(.avatar[data-status="error"]), .cap:has(.avatar[data-status="error"]) *', '执行出错（文字借用危险色）'], ['rest', '*', '平时']] } },
  card: { means: '卡片：消息里的决策卡、富内容块、格子', of: '.vw-card, .cgrid-card, .vw-box, .tpl, .cgrid, .cgrid-meta, .vw-claim', v: { state: [['on', '[aria-pressed="true"], [aria-checked="true"], .on', '选中的格子'], ['rest', '*', '平时']], kind: [['tile', '.cgrid-card, .tpl', '格子'], ['card', '*', '卡片']], tone: [['tone', '[data-tone]', '告警卡片（左色边 + 标题色点）'], ['plain', '*', '平常']] } },
  preview: { means: '预览格：卡片网格的预览、外观选项的缩略图（缩略图画的是它预览的那套主题的颜色，是数据）', data: ['bg', 'color'], of: '.cgrid-prev, .thumb, .thumb-win, .thumb-l, .tw-page, .tw-card, .tw-nav, .tw-rail, .tw-dot' },
  embed: { means: '嵌在正文里的一件东西（附件、音频、批注、代码差异、清单）', of: '.vw-embed, .cafe-audio, .wc-diff, .wc-dl, .wc-hunk, .wc-sign, .cafe-checks, .cafe-checks li', v: { line: [['add', '.add', '差异里加的一行'], ['del', '.del', '差异里删的一行'], ['done', '.done', '清单里做完的一项'], ['rest', '*', '平常']] } },
  bullets: { means: '一列要点（卡片里的要点、提示里的列表、规则）：文字跟着所在的文字角色', inherit: true, of: '.card-ul, .cafe-ul, .rules, .cat-rules' },
  steps: { means: '步骤：清单、流程图（区域里的节点和箭头）、阶段进度', v: { depth: [['inner', '.inner', '嵌在区域里的区域（底色深一层）'], ['outer', '*', '最外层']] }, of: '.vw-steps, .ws-steps, .lflow, .lloop, .lrow, .larr, .lback, .lnum' },
  terminal: { means: '终端（工作台）：屏幕里的仿真（颜色、光标、全屏程序）由平台的终端口做，颜色取终端 token', v: { mode: [['ro', '.ro', '只读（成员的终端）'], ['off', '.off', '断开'], ['live', '*', '我的终端']] }, of: '.tm, .tm-screen' },
  webpreview: { means: '网页预览（工作台）：标签、地址、页面、日志（一条日志的色调来自数据）', v: { tone: [['alert', '[data-tone="warn"], [data-tone="danger"]', '留意 / 出错的一条（浅色调底）'], ['info', '[data-tone]', '提示的一条'], ['cur', '.on', '当前'], ['plain', '*', '平常']] }, of: '.wpv, .wpv-page, .wpv-tabs, .wpv-app-rail, .wpv-app-nav, .wpv-app-main, .wpv-app-tabs, .wpv-app-nav i, .wpv-app-main > i, .wpv-app-tabs span, .wpv-log, .wpv-ce' },
  replay: { means: '回放（工作台）：时间线、当前一步、播放条', of: '.rp, .rp-dock, .rp-ctl, .rp-time' },
  htmlframe: { means: '独立 HTML 内容的沙箱视口', of: 'iframe.vw-widget' },
  pluginframe: { means: '插件的整页 / 面板（frame）', of: '.frame' },
  code: { means: '代码：等宽（命令、路径、标识）、行内代码、代码块；字号和墨色跟着所在的文字角色（等宽只是值的种类）', inherit: true, of: 'code, pre, .mono, kbd, .vw-code', v: { kind: [['block', 'pre, pre *, .vw-code', '代码块'], ['inline', 'code', '行内代码'], ['mono', '*', '等宽的值']] } },
  roll: { means: '执行记录那一行的轮换（当前动作停一会儿再换）', of: '.roll, .roll-in, .roll-in > span' },
  /* 输入框 */
  composer: { means: '输入区：打字的范围，正文和它的工具条在里面', of: '.composer, .composer-wrap, .lanes, .lane, .qwrap, .qchip', v: {} },
  /* 外框（窗口的容器树） */
  frame: { means: '窗口的容器：窄栏、侧栏、主体、主窗口、工作台、分栏', of: '#app, .app, nav.rail, aside.nav, main.main, .main-col, aside.panel, .split, .vw-split, .vw-split-l, .vw-split-r, .vw-split-compare, .vw-split-compare > section, .panel-body, .ws-split, .ws-side, .layer, .cells, .citem, .nav-head, .nav-foot, .nav-scroll', v: {} },
  'rail.btn': { means: '窄栏的入口（图标 + 计数）和顶上的标志', of: '.rail-btn, .rail-mark', v: { state: [['current', '[aria-current]:not([aria-current="false"])', '当前空间'], ['rest', '*', '平时']] } },
  'stripe.handle': { means: '工作台收起后的把手', of: '.rt-handle' },
  tab: { means: '标签式容器的一个标签（工作台、预览页）', of: '.ws-chip, .wpv-tab, .ws-chip-t, .ws-chip-l, .wpv-tab > button', v: { state: [['on', '[aria-selected="true"], .on, [aria-selected="true"] *, .on > *', '当前'], ['rest', '*', '平时']] } },
  tick: { means: '对话的刻度条（每条消息一格）', of: '.cafe-tick, .cafe-mini', v: { vis: [['vis', '[data-vis]', '在视口里的那几格（当前位置）'], ['rest', '*', '平时']], kind: [['older', '.older', '更早的消息（虚线）'], ['err', '.err', '出错的一条'], ['wait', '.wait', '等你决定的一条'], ['user', '.u', '你的消息（短一格）'], ['sys', '.s', '系统消息（细一格）'], ['msg', '*', '猫的消息']] } },
  page: { means: '页面：页头和小节', of: '.page, .page-head, .page-id, .section, .vw-view, .vw-page-split', v: {} },
  'proto': { means: '组件目录和说明页的外框（不属于产品界面；里面的示例和文字仍是组件库的）', of: '.proto-tab, .cat-entry, .cat-demo, .cat-head, .cat-row, .cat-flow, .cat-states, .cat-state, .cat-props, .cat-table, .cat-mx, .cat-mx-h, .cat-icons, .cat-st, .cat-scroll, .cat-stream, .cat-pop, .cat-rh, .spec-rule' }
};
