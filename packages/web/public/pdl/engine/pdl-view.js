/* 边界：引擎只放机制与时机，不认任何具体名字、不为单个位置打补丁 */
/* 页面内容也是页面描述：视图 = 一棵块树（纯数据），只引用组件库。
   渲染引擎读视图描述，从视图模型取字段，用组件库画出来。块、控件、片段只在这个文件里登记（lint：pdl-block）。

   视图模型（VM）是绑定层：把原始数据整理成页面要显示的字段（已经是给人看的文字、状态色等）。

   取值：只有视图描述里的模板字符串会被解析——
     '@a.b'  当前作用域（列表的一项）里的字段；'$.a.b' 视图模型根上的字段；别的字符串原样当文字
     { lit: '…' }  以 @ 或 $. 开头的字面量
     't:包.键' / { t: '包.键', args: [...] }  文案包里的字（见 engine/i18n.js）；视图里给人看的字都写成文案键
     来自视图模型的数据（列表项里的字符串等）永远原样显示，不再当取值路径
     when: '@x' / '!@x'  有值才画 / 没值才画（块、行、列、控件、片段都可以带；空数组算没值）
   词汇（契约见下面的 PDL_SCHEMA）：
     块    box head toolbar section list tree settings form kv stats text label notice tabs split each ordered fold
           steps disclosure frame empty view component pre markdown content search choices tags（整页 = 视图的 page: true + head）
     控件  button（角色 meta / nav / cycle / title）switch seg select search input（rows = 多行）check text（角色 value / meta）status more back chip grow component
           行 = 行模板名或就地的 { layout, … }（五种行布局，见 lrow.js ROW_LAYOUTS）；控件也可以直接放在块的位置上
     片段  文字（tone tip mono num strong mark variant） lit who icon glyph dot status chip chips（each：每项的片段）use control hint br roll */
'use strict';
const PDL_VIEWS = {};
/* 块的画法：块类型 → function (块, 作用域, 根)（组件库登记，见 library/blocks.js）；视图引擎只按类型派发 */
const PDL_BLOCKS = {};
/* 视图引擎经组件库画的几样（组件库登记）：node(模板, 作用域, 根) 节点模板；control(控件) 直接放在块位置上的控件；load(块, 状态) 块的读取状态；viewLoad(视图, 状态) 视图的读取状态；
   toc(fn) 画一段并把小节目录换成目录；state(种类, o) 读取状态 / 空状态 */
const PV_DRAW = {};
const PDL_ROWS = {};             /* 行模板：按名字引用 */
const PDL_COMPONENTS = {};       /* 组件库里有名字的复合组件：块 component / 片段 use 只能引用这里的 */
const VM = pdlReads('vm');       /* 绑定层：视图模型 */
const REGION_TABS = {};          /* 标签式区域的绑定（状态的读写由区域的拥有方提供，见 pdl.js 的 rt*） */
function rtBind(r, b) { REGION_TABS[r] = b; }
const PDL_NODES = {};
/* 画法是登记的函数，应用按名字给数据——viewFn(名字, 视图模型)。应用不调用组件库 */
const VIEW_FNS = {};
function viewFn(name, vm) { return VIEW_FNS[name](vm); }
/* 有名字的 PDL 片段（主题登记）：视图模型按数据选一行展开时画哪一段，只写片段的名字（PDL_FRAGS.名），不引用主题的代码 */
const PDL_FRAGS = {};            /* 节点模板：keyed 插槽（如 chat.node）按 key 分派到这里；插件按同样格式贡献 */
/* 组件的角色变体：一个组件只有一个默认样子；变体只表示真正不同的角色，每个变体的含义写在这里（契约的一部分，组件目录也从这里读）。
   不在这张表里的变体不存在：墨色、字重、留白、对齐、所在位置都不是变体——组件的默认就是它们的样子。新增变体先在这里写清楚它是什么角色 */
const PDL_ROLES = {   /* 每个角色的含义（组件目录显示的那句话）在文案包 catalog.role.<组件>.<角色>，这里的注释是同一句 */
  box: [
    'card',   /* 自成一体的一张卡片（消息里的决策卡、富内容块、评审表单） */
    'group',   /* 一组并列项的分组底（项之间是分隔线） */
    'composer',   /* 输入区：打字的范围，正文和它的工具条在里面 */
    'log',   /* 跟随最新的滚动区（消息流、执行记录）：贴底，新内容出现在底部 */
    'scroll',   /* 占满所在容器剩下高度的滚动区（收件箱、回放） */
    'expand',   /* 一行或一项展开出来的详情区（缩进在它的主人下面） */
    'inline',   /* 子块排成一行，放不下时换行 */
    'columns',   /* 子容器并排：按声明的顺序从左到右，自带宽度的（目录）不伸缩，其余平分剩下的宽度 */
    'viewport',   /* 内嵌的视口（页面预览）：占满可用高度，裁掉溢出 */
    'hero',   /* 落地区：空页面的问候和开始方式 */
    'dock'   /* 停靠在内容盒底部的一块（落地页预览作品时的输入框） */
  ],
  toolbar: [
    'head',   /* 容器的标题行：一排格子，返回在最前面 */
    'savebar',   /* 有未保存的改动时贴在底部的保存条 */
    'selection',   /* 对选中项的批量操作条 */
    'embed',   /* 嵌在正文里的一件东西（附件、小组件、音频、批注） */
    'marker',   /* 流里居中的一条标记（更早的消息、已删除、导入来源） */
    'float'   /* 浮在内容上面的一条（查找结果、语音建议） */
  ],
  head: [
    'detail',   /* 下钻出来的详情或子层的头：眉题、副标题，取下钻的返回 */
    'hero'   /* 落地区的问候 */
  ],
  pop: [
    'card'   /* 非滚动的悬停摘要卡；与滚动弹出层共用浮层外壳 */
  ],
  text: [
    'value',   /* 一项设置 / 字段的值（只读）：正文字号的次要墨色；mono / num 是值的种类 */
    'para',   /* 一段正文 */
    'meta',   /* 次要信息（时间、数量、来源、状态说明） */
    'title',   /* 卡片的标题 */
    'list'   /* 一列要点 */
  ],
  part: [
    'meta',   /* 片段里的次要信息 */
    'badge',   /* 短代码徽标（优先级、文件状态），颜色来自 tone */
    'twisty'   /* 跟着所在按钮的展开状态转动的箭头 */
  ],
  button: [
    'meta',   /* 次要信息那一行里的文字按钮（过程记录、召回、轨迹） */
    'nav',   /* 页面目录里的一项（和侧栏导航同一种行） */
    'cycle',   /* 点一下换到下一个状态的圆形标记（任务状态） */
    'title',   /* 可点的标题（点了改名） */
    'drawer',   /* 打开侧栏抽屉（只在侧栏收成抽屉时出现） */
    'reveal'   /* 把收起的侧栏放回来（侧栏是抽屉时没有它） */
  ],
  check: [
    'row'   /* 列表行前面的选择框（名字只给读屏） */
  ],
  more: [
    'row'   /* 列表行尾的“更多”（带行的键） */
  ],
  choices: [
    'multi'   /* 多选：一项一个勾选 */
  ],
  input: [
    'title'   /* 就地改名的标题输入 */
  ],
  select: [
    'member'   /* 选成员：带头像，可多选 */
  ],
  seg: [
    'tabs'   /* 分类标签：一行轻量的分类（带数量） */
  ],
  split: [
    'aside',   /* 主栏 + 侧栏（不是列表 → 详情） */
    'compare'  /* 两个等价内容对照；窄容器自然换行 */
  ],
  stats: [
    'counters'   /* 一行计数 + 操作（不是一格一格的数字） */
  ],
  steps: [
    'checks',   /* 清单：做完的打勾 */
    'flow',   /* 流程图：区域里的节点和箭头 */
    'progress'   /* 阶段进度：做完 / 当前 / 未到；有动作时每一步可点 */
  ]
};
function R(k) { return PDL_ROLES[k].slice(); }
/* 每个块 / 控件声明自己接受的属性（组件契约）：1 = 任意值或数据绑定；数组 = 只能取这些枚举 / 档位（'$' 表示也可以是数据绑定）。
   PDL 里出现没声明的属性、或者枚举外的字面值，结构检查（pdl-schema）就报错。新增属性先在这里声明 */
const PDL_SCHEMA = {
  /* 结构属性：任何块 / 控件都可以带（界面树的节点）。key 稳定键（插件和用户层按它定位）；kind 种类决定编辑布局时能怎么动
     （region 区域可以互换、container 容器在父级里按种类允许的方式排序、actions 操作组里的操作只在组内排序、content 页面内容不动）；
     essential 必要元素（不能隐藏）；locked 固定位置（不参与排序、没有编辑标记）；ordered 这个容器的子项可以由用户排序；
     focus 需要专注：遮罩落在它下面一层，它的层抬到遮罩上面（弹窗、区域、卡片、引导里的聚光灯都一样）；
     stay 在弹窗里点它不算“选了一项”（就地切换、多选），声明了 pick 的弹窗不关 */
  /* 弹窗的声明（PDL_POPUPS）：at、exit、drag 三项必填；exit 是 exit 枚举的一个子集 */
  _popup: { at: ['trigger', 'center', 'corner', 'top', 'fill'], within: 1, exit: ['outside', 'esc', 'x', 'pick', 'leave'], drag: ['true', 'false'], focus: ['true', 'false'], fixLayer: ['true'], view: 1, when: 1, state: 1, close: 1, closeArgs: 1, body: ['page'], demo: 1, via: 1 },   /* view 是内容视图，when 是既有 STATE_ROOTS 的状态路径；state 是主人，不作打开条件。 */
  /* 行模板（列表的 row：PDL_ROWS 里的实体模板，或列表声明里就地写的字段映射）：layout 必填，取组件库的一种行布局（lrow.js ROW_LAYOUTS；tree 只由树块用）；
     其余是数据绑定。_rowNo：每种布局不接受的字段（单行没有副行，只有条目有竖排尾部，记录行不能再展开） */
  _row: { layout: ['line', 'two', 'item', 'record'], key: 1, lead: 1, title: 1, inline: 1, sub: 1, meta: 1, cols: 1, acts: 1, tone: 1, color: 1, bar: 1, act: 1, args: 1, note: 1, expand: 1, more: 1, moreWhen: 1, moreAfter: 1, cur: 1, aside: 1, subLines: 1, label: 1, help: 1, when: 1 },
  _rowNo: { line: ['sub', 'meta', 'aside', 'subLines'], two: ['aside', 'subLines'], item: [], record: ['sub', 'meta', 'aside', 'subLines', 'expand'] },
  _node: { item: 1, load: 1, loading: 1, error: 1, stale: 1, empty: 1, retry: 1, stay: 1, focus: 1, key: 1, kind: ['region', 'container', 'actions', 'entry', 'action', 'content'], essential: 1, move: 1, locked: 1, ordered: 1, span: ['s', 'm', 'l'] },
  app: { demo: 1, name: ['entry', 'stripe', 'handle'], region: 1, when: 1 },
  back: { act: 1, args: 1, label: 1, when: 1 },   /* 返回放在这里（引擎的返回）；act / args 是没有返回可回时的去处 */
  box: { blocks: 1, faint: 1, fill: 1, follow: 1, note: 1, open: 1, tone: ['$', 'info', 'ok', 'warn', 'danger'], variant: R('box'), when: 1 },
  jump: { act: 1, args: 1, icon: 1, label: 1, tip: 1, when: 1, hideWhileTyping: 1 },
  notices: { items: 1, key: 1, when: 1, hideWhileTyping: 1 },
  stack: { items: 1, when: 1 },
  button: { act: 1, args: 1, aria: 1, busy: 1, danger: 1, disabled: 1, expanded: 1, items: 1, icon: 1, iconOnly: 1, label: 1, link: 1, menu: 1, note: 1, open: 1, parts: 1, pressed: 1, state: 1, submit: 1, tip: 1, current: 1, primary: 1, size: ['xs'], variant: R('button'), when: 1, who: 1 },
  capsules: { act: 1, from: 1, label: 1 },
  check: { act: 1, args: 1, label: 1, tint: 1, value: 1, variant: R('check'), when: 1 },
  chip: { act: 1, args: 1, check: 1, ellip: 1, faint: 1, icon: 1, kind: 1, label: 1, pressed: 1, thumb: 1, tint: 1, tip: 1, tone: 1, when: 1, x: 1 },
  choices: { act: 1, args: 1, from: 1, group: 1, value: 1, variant: R('choices'), when: 1 },
  component: { props: 1, use: 1, when: 1 },
  content: { annotations: 1, fold: 1, html: 1, note: 1, raw: 1, when: 1 },
  result: { actions: 1, blocks: 1, key: 1, label: 1, status: ['$', 'approved', 'rejected', 'expired', 'withdrawn', 'closed', 'unconfirmed'], when: 1 },
  tints: { act: 1, args: 1, value: 1, label: 1 },
  toc: { note: 1, when: 1 },   /* 小节目录：条目来自同一视图里带 id 的小节标题（锚点），不另给数据 */
  disclosure: { act: 1, args: 1, blocks: 1, count: 1, key: 1, note: 1, open: 1, sub: 1, title: 1, trail: 1, when: 1 },   /* act：开合由视图模型管（open 来自数据，点了执行 act，参数 k = key）；没写时开合是组件自己的状态 */
  each: { blocks: 1, control: 1, from: 1, when: 1 },
  empty: { action: 1, help: 1, icon: 1, text: 1, when: 1 },
  fold: { blocks: 1, height: ['m', 's'], key: 1, shape: ['$', 'bottom'], when: 1 },
  dialog: { pop: 1, title: 1, help: 1, wide: 1, layout: ['viewport', 'fill'], span: ['full'], form: 1, error: 1, actions: 1, footer: 1, blocks: 1, when: 1 },   /* footer：底部区域的块声明，与标题栏 actions 分开。 */
  form: { args: 1, blocks: 1, from: 1, htmlId: 1, id: 1, note: 1, when: 1 },
  frame: { html: 1, src: 1, message: 1, on: 1, icon: 1, note: 1, plugin: 1, tall: 1, title: 1, what: 1, when: 1 },   /* html 自动量内容；src 填满视口。on.message 把框内消息交给动作，origin 的判断属于应用。 */
  grow: { when: 1 },
  head: { actNote: 1, tools: 1, descAction: 1, actions: 1, close: 1, count: 1, desc: 1, eyebrow: 1, help: 1, label: 1, lead: 1, meta: 1, note: 1, sub: 1, title: 1, variant: R('head'), when: 1 },
  input: { change: 1, complete: 1, grow: 1, disabled: 1, id: 1, input: 1, on: 1, label: 1, rows: 1, code: 1, lead: 1, listFrom: 1, reload: 1, max: 1, mono: 1, num: 1, placeholder: 1, post: 1, ro: 1, invalid: 1, secret: 1, value: 1, variant: R('input'), when: 1,
    go: 1, args: 1, icon: 1, goLabel: 1, cancel: 1, more: 1, tint: 1, add: 1 },   /* go：回车 / 框里的图标提交到这个动作（组件库 goField）；cancel：Esc / 失焦；more：同一个框里的另几个输入；tint：框里的选色 { id, value, input, label }（组件库的取色器） */
  kv: { actions: 1, from: 1, when: 1 },
  label: { action: 1, count: 1, help: 1, text: 1, tip: 1, when: 1 },
  lanes: { lanes: 1, when: 1 },   /* 每条道：{ share（不写 = 按内容定宽）, name, scroll, align: 'start' | 'center' | 'end', attach: 'above' | 'straddle', items } */
  list: { actions: 1, count: 1, empty: 1, emptyAction: 1, expand: ['many'], from: 1, group: 1, groups: 1, id: 1, inline: 1, label: 1, next: 1, optional: ['true'], order: 1, partial: 1, row: 1, rows: 1, scroll: 1, searchable: ['true'], when: 1 },   /* searchable：列表头里一个本地筛选框（只筛已经读到的项，不发请求） */
    /* 列表总是画出来（没有数据时是组件库的空状态，文字是 empty）；label / count = 列表自己的组标签；optional = 只在有项时才有的子组：没有项时连组标签一起不画 */
  markdown: { annotations: 1, clamp: 1, empty: 1, from: 1, more: 1, text: 1, when: 1 },
  more: { args: 1, items: 1, k: 1, label: 1, menu: 1, size: ['s', 'm'], variant: R('more'), when: 1 },   /* items：菜单项在这里声明（pvMenu）；menu：老的按名字登记的菜单 */
  notice: { action: 1, each: 1, from: 1, items: 1, note: 1, num: 1, parts: 1, strong: 1, text: 1, tone: ['$', 'info', 'ok', 'warn', 'danger'], when: 1 },
  ordered: { blocks: 1, order: 1, when: 1 },
  picker: { act: 1, args: 1, items: 1, auto: 1, autoTip: 1, check: 1, disabled: 1, icon: 1, label: 1, parts: 1, prefix: 1, tip: 1, when: 1, who: 1 },
  pre: { annotations: 1, rows: 1, text: 1, when: 1 },
  pop: { blocks: 1, page: 1, pos: 1, view: 1, label: 1, variant: R('pop'), when: 1 },
  opts: { empty: 1, from: 1, when: 1 },
  chatpage: { bar: 1, body: 1, dock: 1, head: 1, side: 1, top: 1 },   /* 子容器 stream / composer 的顺序由用户层的 order['main.chat'] 决定 */
  ticks: { from: 1, older: 1, when: 1 },
  threads: { from: 1, groups: 1, heads: 1, move: 1, note: 1, other: 1, rename: 1, when: 1 },
  range: { args: 1, change: 1, id: 1, input: 1, label: 1, max: 1, min: 1, step: 1, unit: 1, value: 1, when: 1 },
  reply: { ref: 1 },
  search: { form: 1, id: 1, input: 1, on: 1, label: 1, note: 1, placeholder: 1, value: 1, when: 1, wide: 1 },
  section: { actions: 1, blocks: 1, from: 1, help: 1, id: 1, keep: 1, key: 1, label: 1, note: 1, open: 1, row: 1, rows: 1, title: 1, when: 1 },
  seg: { act: 1, args: 1, from: 1, options: 1, value: 1, variant: R('seg'), when: 1 },
  select: { span: 1, act: 1, args: 1, change: 1, from: 1, id: 1, invalid: 1, label: 1, multi: 1, none: 1, options: 1, prefix: 1, value: 1, variant: R('select'), when: 1 },
  send: { args: 1, disabled: 1, stop: 1, stopping: 1, tip: 1 },
  settings: { from: 1, plain: 1, row: 1, rows: 1, when: 1 },
  slot: { ctx: 1, slot: 1 },
  split: { left: 1, picked: 1, right: 1, scroll: ['panes'], follow: ['left', 'right', 'both'], variant: R('split'), when: 1 },   /* follow：独立滚动的一侧跟随最新内容；picked：窄屏下钻的选中状态。 */
  stats: { actions: 1, from: 1, items: 1, variant: R('stats'), when: 1 },   /* 数字块只有两种：一格一格的数字（默认）、一行计数 + 操作（counters） */
  status: { text: 1, tone: ['$', 'info', 'ok', 'warn', 'danger'], when: 1 },
  steps: { act: 1, args: 1, from: 1, variant: R('steps'), when: 1 },
  stream: { from: 1, id: 1 },   /* id：这条消息流的名字（同名的流里，新出现的消息走统一的“到达”动效；对话主流就是 chat.stream 视图） */
  switch: { act: 1, args: 1, disabled: 1, label: 1, tip: 1, value: 1, when: 1 },   /* label 是名字（提示和读屏），开关旁边不写字 */
  tabs: { act: 1, after: 1, args: 1, close: 1, from: 1, label: 1, parts: 1, selected: 1, tip: 1 },
  text: { actions: 1, count: 1, faint: 1, for: 1, from: 1, help: 1, label: 1, mono: 1, num: 1, parts: 1, sep: 1, text: 1, tip: 1, tone: ['$', 'info', 'ok', 'warn', 'danger'], variant: R('text'), when: 1 },
  tiles: { act: 1, from: 1 },
  tags: { add: 1, empty: 1, from: 1, pick: 1, remove: 1, when: 1, id: 1, k: 1, kind: 1, label: 1, lock: 1, placeholder: 1, values: 1 },   /* values：一列字（别名、参数）的编辑器（id / k / kind / lock，增删走 chipAdd / chipDel） */   /* 标签编辑器（唯一一个）：一排标签（色调点 · 名字 · 对话数；pick 时可勾选，remove 时带 ×）+ 新建标签的输入 */
  toolbar: { args: 1, form: 1, hidden: 1, id: 1, items: 1, left: 1, note: 1, parts: 1, right: 1, tone: ['$', 'warn'], variant: R('toolbar'), when: 1 },
  tree: { divider: 1, fileAct: 1, fileArgs: 1, flat: 1, id: 1, nodes: 1, ready: 1, row: 1, select: 1, when: 1 },   /* divider：行之间画分隔线（缺省不画：文件树）；flat：只有一层（没有展开指示）；ready：子级随数据一起给出（不懒加载）；select：{ act, args } 点行是选中（有子级的行用展开指示开合） */
  upload: { accept: 1, hidden: 1, multiple: 1, icon: 1, iconOnly: 1, id: 1, label: 1, msg: 1, args: 1 },
  copy: { label: 1, mono: 1, tail: 1, tip: 1, v: 1, value: 1, when: 1 },   /* 可复制的值：值 + 复制图标（label 说复制的是什么，tip 是值的提示，v 是复制的内容，默认就是值） */
  view: { id: 1, data: 1, when: 1 },
  typed: { slot: 1, of: 1, data: 1, blocks: 1, when: 1 },   /* 按渲染类型画：of 是类型（容器.子类型），data 是这一项交给模板的数据，blocks 是没有模板时宿主的默认画法 */   /* data 显式给子视图的正文 VM；未声明时由子视图自己的 vm 取数。 */
  /* 视图模型里直接给的控件（表单字段的 control） */
  kvlist: { add: 1, del: 1, empty: 1, eye: 1, input: 1, key: 1, keyPh: 1, path: 1, ro: 1, rows: 1, single: 1 },
  avatar: { args: 1, lead: 1, size: ['$', 'xs', 's', 'm', 'l', 'xl'], upload: 1 },
  color: { id: 1, input: 1, label: 1, preview: 1, slots: ['name'], value: 1, when: 1 }
};

/* ───────── 本地化 ───────── */
/* 视图描述是静态数据，从不改写。文案键（'t:包.键'，或不带参数的 { t }）在取用时换成当前语言的字：引擎的入口（pvBlocks / pvControl / pvRow / pvParts）
   拿到一段描述就换一次，按描述对象记住结果（换语言时作废）；换出来的对象再进入口时直接用。带参数的 { t, args } 留到取值时（参数是绑定）。
   插件后来登记的描述也一样，不用另存原始描述 */
const PV_LOC = { lang: null, memo: new WeakMap(), done: new WeakSet() };
function pdlLoc(v) {
  if (!v || typeof v !== 'object') return v;
  if (PV_LOC.lang !== S.lang) { PV_LOC.lang = S.lang; PV_LOC.memo = new WeakMap(); PV_LOC.done = new WeakSet(); }
  if (PV_LOC.done.has(v)) return v;
  let x = PV_LOC.memo.get(v); if (!x) { x = pdlLocalizeNode(v); PV_LOC.memo.set(v, x); } return x;
}
function pdlLocalizeNode(v) {
  if (typeof v === 'string') return v[0] === 't' && v[1] === ':' ? tc(v.slice(2)) : v;
  let out = v;
  if (Array.isArray(v)) out = v.map(pdlLocalizeNode);
  else if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    if (typeof v.t === 'string' && Object.keys(v).length === 1) return tc(v.t);
    out = {}; Object.keys(v).forEach(function (k) { out[k] = pdlLocalizeNode(v[k]); });
  }
  if (out && typeof out === 'object') PV_LOC.done.add(out);
  return out;
}

/* ───────── 取值 ───────── */
/* 值的写法：{ of: '@数据', item: 每项的值模板（数组逐项取）, sep: ' · '（数组连成一句，空项跳过）, fmt: 组件库 FORMATS 的名字（时间 / 时长 / 大小 / 数字）,
   slice: [起, 止]（原样截取，不加 …）, max: 18（超出截断加 …）, case: 'lower' | 'upper', gte: N（不小于 N 时为 true：给 map 当键或给 when） } */
function pvOf(v, sc, root) {
  let x = pv(v.of, sc, root); if (x == null) return x;
  if (Array.isArray(x) && v.item) x = x.map(function (y) { return pv(v.item, y, root); });
  if (Array.isArray(x) && v.sep != null) x = x.filter(function (y) { return y != null && y !== ''; }).join(v.sep);
  if (v.fmt) x = ENGINE_PARTS.format(v.fmt, x);
  if (v.slice) x = String(x).slice(pv(v.slice[0], sc, root), v.slice[1] == null ? undefined : pv(v.slice[1], sc, root));
  if (v.max && String(x).length > v.max) x = String(x).slice(0, v.max) + '…';
  if (v.case === 'lower') x = String(x).toLowerCase();
  if (v.case === 'upper') x = String(x).toUpperCase();
  if (v.gte != null) x = x >= pv(v.gte, sc, root);
  return x;
}
/* 画一个组件单元（列表的一项）时打开：记下它读到的页面级的值（'$.' 绑定 → 值），下次比一比就知道这一项要不要重画 */
function pv(v, sc, root) {
  if (v && typeof v === 'object' && v.lit != null) return v.lit;
  if (v && typeof v === 'object' && v.map && 'of' in v) { const k = pvOf(v, sc, root); return pv(k != null && k in v.map ? v.map[k] : v.map._, sc, root); }   /* 按值取：{ of: '@state', map: { error: 'danger', … , _: 默认 } }；键可以先经过下面的写法（比如 gte）；取到的值照常解析（'t:…'、{ t, args }、'@…'） */
  if (v && typeof v === 'object' && 'of' in v) return pvOf(v, sc, root);
  if (v && typeof v === 'object' && typeof v.t === 'string') return tc.apply(null, [v.t].concat((v.args || []).map(function (a) { return pv(a, sc, root); })));   /* 文案键带参数 */
  if (typeof v !== 'string') return v;
  if (v[0] === 't' && v[1] === ':') return tc(v.slice(2));   /* 't:包.键'：文案包里的字（当前语言） */
  if (v === '@') return sc;
  if (v[0] === '@' || v.indexOf('$.') === 0) {
    const base = v[0] === '@' ? sc : root, path = v[0] === '@' ? v.slice(1) : v.slice(2);
    const got = path.split('.').reduce(function (o, k) { return o == null ? o : o[k]; }, base);
    return got;
  }
  return v;
}
function pvOk(w, sc, root) { if (w == null) return true; if (Array.isArray(w)) return w.every(function (x) { return pvOk(x, sc, root); });   /* 一组条件：都成立才算 */
  const neg = w[0] === '!', x = pv(neg ? w.slice(1) : w, sc, root); const ok = Array.isArray(x) ? x.length > 0 : !!x; return neg ? !ok : ok; }
function pvArgs(args, sc, root) {
  if (typeof args === 'string') return argAttrs(pv(args, sc, root) || {});   /* 整组参数来自视图模型：值原样用 */
  const o = {}; Object.keys(args || {}).forEach(function (a) { o[a] = pv(args[a], sc, root); }); return argAttrs(o);
}
function pvArgsObj(args, sc, root) { if (typeof args === 'string') return pv(args, sc, root) || {}; const o = {}; Object.keys(args || {}).forEach(function (a) { o[a] = pv(args[a], sc, root); }); return o; }
/* 一组项（下拉的选项这类）写在 PDL 里时：固定项 + { from, item } 按一组数据展开（item 里 @ 是那一项）；每项的字段按绑定取值，when 不成立的项不出 */
function pvItems(list, sc, root) {
  if (!Array.isArray(list)) return pvList(list, sc, root);
  const out = [];
  const one = function (it, s) { if (Array.isArray(it)) { out.push(it.map(function (x) { return pv(x, s, root); })); return; } if (it && typeof it === 'object' && !pvOk(it.when, s, root)) return; out.push(it && typeof it === 'object' ? pvArgsObj(it, s, root) : it); };
  list.forEach(function (it) { if (it && it.from && it.item) pvList(it.from, sc, root).forEach(function (x) { one(it.item, x); }); else one(it, sc); });
  return out;
}
/* 菜单项（more 的 items）：每项 { label, act, args, when, tone: 'danger', cur, why }；{ from, item } 按一组数据各出一项（item 里 @ 是那一项）；{ scope } 是范围名 */
function pvMenu(items, sc, root) {
  const out = [];
  const one = function (it, s) { if (!pvOk(it.when, s, root)) return; if (it.scope != null) { out.push({ scope: pv(it.scope, s, root) }); return; }
    out.push({ label: pv(it.label, s, root), act: it.act, data: pvArgsObj(it.args, s, root), danger: it.tone === 'danger', cur: !!pv(it.cur, s, root), why: pv(it.why, s, root) || '', help: pv(it.help, s, root) || undefined, stay: !!it.stay }); };
  (items || []).forEach(function (it) { if (it.from) pvList(it.from, sc, root).forEach(function (x) { one(it.item, x); }); else one(it, sc); });
  return out;
}
function pvText(v, sc, root) { const x = pv(v, sc, root); return x == null ? '' : h(String(x)); }
function pvList(v, sc, root) { const x = Array.isArray(v) ? v : pv(v, sc, root); return Array.isArray(x) ? x : []; }
function ctlJoin(a, b) { return (a || '') + (b || ''); }
function pvAnnot(l, sc, root) { if (!l) return null; if (typeof l === 'string') { const t = pv(l, sc, root); if (Array.isArray(t)) return t.map(function (x) { return typeof x === 'string' ? { text: x, pos: 'after' } : x; }); if (t && typeof t === 'object') return t; return t ? { text: t, pos: 'after' } : null; } const t = pv(l.text, sc, root); return t ? { text: t, pos: l.pos || 'after', tone: pv(l.tone, sc, root) } : null; }
function pvNote(n) { return n ? ' data-note="' + n + '"' : ''; }
const PV = { units: {}, ro: 0, inert: 0, ctTitle: '', leadSize: '', load: '', viewId: '', tabKey: '' };   /* ctTitle：正在画的容器的名字（工作台标签的标题），视图下钻返回的默认名字 */   /* units：按单元画、自己逐项映射 item 的块（组件库登记） */
/* stay 的标记：不占布局的一层（display: contents），弹窗引擎看点击落在不在 [data-stay] 里 */
function pvStay(html) { return html ? '<span class="vw-stay" data-stay>' + html + '</span>' : ''; }
/* item：按数据重复的块 / 控件（from，或写成绑定的 options / items）每一项的字段在这里声明：对每一项按 item 取值（@ 是那一项），盖在这一项的数据上，
   组件照常读这些字段——文字、状态、动作都由主题写，数据只给值 */
function pvItemize(b, sc, root) {
  if (!b || !b.item) return b;
  const key = b.from != null ? 'from' : typeof b.options === 'string' ? 'options' : typeof b.items === 'string' ? 'items' : null; if (!key) return b;
  const o = Object.assign({}, b); o[key] = pvList(b[key], sc, root).map(function (x) { return Object.assign({}, x, pvDeep(b.item, root, x)); }); return o;
}
function pvBlocks(blocks, sc, root) {
  return (pdlLoc(blocks) || []).filter(function (b) { return pvOk(b.when, sc, root) && !(b.key && pdlNodeHidden(b.key)); }).map(function (b) {
    if (b.plugin) pdlPluginNeed(b.plugin);   /* 插件插进来的块画出来了：取回它的子树（延迟加载） */
    const st = b.load ? pv(b.load, sc, root) : '';   /* 块的读取状态（load 绑定到数据层的状态）：加载中 / 出错 / 空都由组件库画，块只声明文字 */
    if (st && st !== 'stale') return PV_DRAW.load(b, st, sc, root);
    if (!PV.units[b.type]) b = pvItemize(b, sc, root);   /* 按单元画的块（组件库登记）自己逐项映射：只有要重画的那一项才映射 */
    const f = PDL_BLOCKS[b.type] || (PDL_SCHEMA[b.type] ? function (c) { return PV_DRAW.control(c, sc, root); } : null); if (!f) console.error(tc('engine.block.error', b.type)); const x0 = f ? f(b, sc, root) : '',   /* 控件也可以直接放在块的位置上（比如容器的固定件） */ x = st ? PV_DRAW.load(b, st, sc, root) + x0 : x0;
    const y0 = x && pv(b.focus, sc, root) ? '<div class="vw-focus-slot"><div class="vw-focus" data-focus>' + x + '</div></div>' : x, y = b.key ? pvProjected(b.key, y0) : y0; return y && b.stay ? pvStay(y) : y;
  }).join('');   /* focus / stay：包一层标记（遮罩和层级、弹窗的 pick 由引擎推导） */
}
/* 投影：任何有 key 的容器都可以有打开的东西——叠里压着的（cover）盖住它原来的内容（带通用返回），并排打开的（beside）接在后面 */
function pvProjected(key, html) {
  const s = NAV.st[key], top = s && s.length > 1 ? s[s.length - 1] : null, on = NAV.on[key] || [];
  if (!top && !on.length) return html;
  return (top ? PV_DRAW.opened(top, key, true) : html) + on.map(function (f) { return PV_DRAW.opened({ f: f, a: {} }, key, false); }).join('');
}
/* 用给定的视图模型画一个视图的内容（模态窗、对话框的正文：壳由调用方给） */
function pdlViewOf(id, root) { const v = pdlLoc(PDL_VIEWS[id]); return v && root ? pvBlocks(v.blocks, root, root) : ''; }
/* 视图里的下钻（列表 → 详情盖住了列表）：视图只声明“什么时候是下钻、回去执行哪个动作”（drill），返回由引擎放进返回槽（detail），
   详情自己的头把它画出来——和区域的通用返回是同一个组件。来源的名字默认是这个容器的名字（视图声明的 title，或者工作台标签的标题）；
   来源本身是数据时（弹出层的上一页）才写 label。页面里不手写返回按钮 */
function pdlDrillOf(v, root) {
  const d = (v.drill || []).find(function (x) { return pvOk(x.when, root, root); }); if (!d) return null;
  return { act: d.act, data: pvArgs(d.args, root, root), label: d.label ? pvText(d.label, root, root) : v.title ? pvText(v.title, root, root) : PV.ctTitle };
}
/* 一个信息只说一次：视图里小节头 / 页头已经用行内状态说了的事，提示不再说一遍。画视图之前先收集各个头上的状态文字（只看视图模型根上能定的） */
function pvHeadStatuses(blocks, root) {
  const out = [];
  (function walk(x) {
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (!x || typeof x !== 'object') return;
    if ((x.type === 'head' || x.type === 'section') && pvOk(x.when, root, root)) [].concat(x.actions || []).forEach(function (c) { if (c && c.type === 'status' && pvOk(c.when, root, root)) { const s = pv(c.text, root, root); if (s) out.push(pvSay(s)); } });
    Object.keys(x).forEach(function (k) { if (k !== 'actions' && x[k] && typeof x[k] === 'object') walk(x[k]); });
  })(pdlLoc(blocks));
  return out;
}
function pvSay(s) { return String(s == null ? '' : s).replace(/[。.！!\s]+$/, '').trim(); }
function pvSaidInHead(strong, text) { const msg = pvSay(pvSay(strong) + (text || '')); return !!msg && (PV.said || []).some(function (s) { return s.indexOf(msg) >= 0; }); }   /* 提示说的整句已经包含在某个头的状态里 */
/* 画一个视图：视图描述 + 视图模型 */
function pdlView(id) {
  const v = pdlLoc(PDL_VIEWS[id]); if (!v) return '';
  if (v.plugin) { pdlPluginNeed(v.plugin); if (!v.blocks) return ''; }   /* 插件的视图：第一次画时取回它的子树（延迟加载）；还没取回时只有节点声明，先画空 */
  const root = v.sources ? (VM.plugin ? VM.plugin(v.plugin, v.sources) : null) : vmRead(v.vm);   /* 插件视图：数据来自它登记的请求（应用的通用 VM.plugin 去读） */
  if (!root) return v.empty ? PV_DRAW.state('empty', { text: pvText(v.empty, {}, {}) }) : '';
  const placed = backPlaced(v.blocks, root);   /* 视图自己声明了返回放在哪（back 控件）：标题行不取返回 */
  const prevId = PV.viewId, load = root.load || PV.load || '', prevSaid = PV.said;   /* 视图的读取状态：视图模型给的（数据层），或者所在工作台标签的 */
  PV.viewId = id; PV.load = ''; PV.said = pvHeadStatuses(v.blocks, root);
  if (v.readonly) PV.ro++;
  if (placed) BACK.placed++;
  try {
    const body = PV_DRAW.toc(function () { return backIn('detail', pdlDrillOf(v, root), function () { return load ? PV_DRAW.viewLoad(v, load, root) : pvBlocks(v.blocks, root, root); }); });
    if (v.bare) return body;   /* 不包外层：直接放进现有布局的一段（如对话页头部） */
    return '<div class="vw-view' + (v.page ? ' page' + (typeof v.page === 'string' ? ' vw-page-' + v.page : '') : '') + (v.readonly ? ' readonly' : '') + '" data-view="' + id + '">' + body + '</div>';
  } finally { if (v.readonly) PV.ro--; if (placed) BACK.placed--; PV.viewId = prevId; PV.said = prevSaid; }
}

/* ───────── 视图树：导出和按层级查询（agent 不看前端代码也能知道页面长什么样） ─────────
   pdlViewTree()      整棵树：视图、行模板、可用的块和组件
   pdlQuery(f)        遍历所有视图（行模板展开进去），每个节点带 path / type / depth；
                      f: { view, type, depth, maxDepth, binds: '字段名', act: '动作名' } 任意组合 */
function pdlViewTree() { return { views: PDL_VIEWS, rows: PDL_ROWS, blocks: Object.keys(PDL_BLOCKS), components: Object.keys(PDL_COMPONENTS) }; }
function pdlQuery(f) {
  f = f || {}; const out = [];
  const walk = function (node, path, depth, view) {
    if (Array.isArray(node)) { node.forEach(function (n, i) { walk(n, path + '[' + i + ']', depth, view); }); return; }
    if (!node || typeof node !== 'object') return;
    const type = node.type || (path.slice(-4) === '.row' ? 'row' : null);
    if (type) {
      const json = JSON.stringify(node);
      const ok = (!f.type || f.type === type) && (f.depth == null || f.depth === depth) && (f.maxDepth == null || depth <= f.maxDepth) &&
        (!f.binds || json.indexOf('@' + f.binds) >= 0 || json.indexOf('$.' + f.binds) >= 0) && (!f.act || json.indexOf('"act":"' + f.act + '"') >= 0);
      if (ok) out.push({ view: view, path: path, type: type, depth: depth, node: node });
    }
    Object.keys(node).forEach(function (k) {
      const v = node[k];
      if (k === 'row' && typeof v === 'string' && PDL_ROWS[v]) walk(PDL_ROWS[v], path + '.row', depth + 1, view);
      else if (v && typeof v === 'object') walk(v, path + '.' + k, depth + (type ? 1 : 0), view);
    });
  };
  Object.keys(PDL_VIEWS).forEach(function (id) { if (!f.view || f.view === id) walk(PDL_VIEWS[id].blocks, id, 0, id); });
  return out;
}
/* 轮换的一行：节点重新生成时（重画、缓存的 HTML）按开始时刻把相位接上，不从头滚 */

/* 窄屏布局状态变了：分栏换模式，重画 */
const VIEWPORT = pdlTrack({ narrow: matchMedia('(max-width: 900px)').matches }, 'VIEWPORT');   /* 窗口是不是窄屏：界面状态（读过它的块在它变了时重画） */
matchMedia('(max-width: 900px)').addEventListener('change', function (e) { VIEWPORT.narrow = e.matches; render(true); });
