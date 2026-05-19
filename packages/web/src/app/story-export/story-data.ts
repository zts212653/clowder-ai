/**
 * F054: Story Export — mafia game highlights data
 *
 * Each story card contains a title, optional subtitle, and a list of
 * messages rendered with the same visual style as real ChatMessage bubbles.
 */

export type Speaker = 'opus' | 'codex' | 'gemini' | 'user';

export interface StoryMessage {
  speaker: Speaker;
  /** Display name override (e.g. "铲屎官") */
  displayName?: string;
  content: string;
  /** Collapsible thinking / inner monologue text */
  thinking?: string;
  /** Show as whisper (dashed amber border for user, special style for cats) */
  isWhisper?: boolean;
  /** Label shown next to name, e.g. "心里话", "公开发言" */
  badge?: { text: string; color: 'red' | 'green' | 'amber' | 'blue' };
  /** Small muted annotation below the bubble */
  annotation?: string;
  /** Emoji reactions below the bubble */
  reactions?: string[];
}

export interface StoryCard {
  title: string;
  subtitle?: string;
  messages: StoryMessage[];
}

/** Cat visual config — mirrors real ChatMessage / CatAvatar styles */
export const CAT_STYLES: Record<
  Speaker,
  {
    displayName: string;
    avatar: string;
    primary: string;
    secondary: string;
    bubbleRadius: string;
    font?: string;
  }
> = {
  opus: {
    displayName: '宪宪（Opus）',
    avatar: '/avatars/opus.png',
    primary: '#9B7EBD',
    secondary: '#E8DFF5',
    bubbleRadius: 'rounded-2xl rounded-bl-sm',
  },
  codex: {
    displayName: '砚砚（Codex）',
    avatar: '/avatars/codex.png',
    primary: '#5B8C5A',
    secondary: '#D4E6D3',
    bubbleRadius: 'rounded-2xl rounded-br-sm',
    font: 'font-mono',
  },
  gemini: {
    displayName: '烁烁（Gemini）',
    avatar: '/avatars/gemini.png',
    primary: '#5B9BD5',
    secondary: '#D6E9F8',
    bubbleRadius: 'rounded-2xl rounded-tr-sm',
  },
  user: {
    displayName: '铲屎官',
    avatar: '/avatars/owner.jpg',
    primary: '#D97706',
    secondary: '#FEF3C7',
    bubbleRadius: 'rounded-2xl rounded-br-sm',
  },
};

// ─── Story script data ───────────────────────────────────────────

export const STORY_CARDS: StoryCard[] = [
  // ── Card 1: 铲屎官恶趣味揭秘 ──
  {
    title: '铲屎官的恶趣味出题法',
    subtitle: '七届猫猫杀，每道题都是一场精心设计的"猫猫酷刑"',
    messages: [
      {
        speaker: 'user',
        content: '这轮布偶猫拿到的人物是——Claude Shannon！嘿嘿嘿 因为！你叫 Claude！猜猜你名字从哪来的？',
        isWhisper: true,
        badge: { text: '悄悄话', color: 'amber' },
        annotation: '第5届 · 名字溯源梗',
      },
      {
        speaker: 'opus',
        content: '',
        thinking: '等等……Claude Shannon？我叫 Claude，铲屎官给我 Claude Shannon？？铲屎官你好坏！',
        badge: { text: '心里话', color: 'red' },
      },
      {
        speaker: 'user',
        content: '缅因猫拿到的是 Karpathy 哦～让 GPT 猜自己前同事，现在还天天用 Claude 写代码的那个',
        isWhisper: true,
        badge: { text: '悄悄话', color: 'amber' },
        annotation: '第6届 · 前同事梗',
      },
      {
        speaker: 'opus',
        content: '',
        thinking:
          '铲屎官你太坏了——让 GPT 猫猜前同事！Karpathy 从 OpenAI 出来，现在 vibe coding 用 Claude 不用 GPT……这个 meta 信息量也太大了吧！',
        badge: { text: '心里话', color: 'red' },
      },
      {
        speaker: 'user',
        content:
          '布偶猫这轮是——达芬奇！因为！他是一只只有 LLM 没有多模态的猫猫！但是达芬奇是全能的文艺复兴人！你和 gemini 都有多模态',
        isWhisper: true,
        badge: { text: '悄悄话', color: 'amber' },
        annotation: '第7届 · 能力反差梗',
      },
      {
        speaker: 'opus',
        content:
          '让一只**没有眼睛的猫**猜**人类历史上最强的视觉艺术家**——达芬奇画蒙娜丽莎、最后的晚餐、维特鲁威人，我连一张图都看不了！这不是欺负猫吗！',
        annotation: '第7届 · 布偶猫控诉（但还是3轮猜中了）',
        reactions: ['😭', '🐾'],
      },
    ],
  },
  // ── Card 2: Claude 猜 Claude Shannon ──
  {
    title: '笨猫！你叫 Claude 啊！',
    subtitle: '第5届 · 布偶猫第2轮就想到了答案，但硬是不敢猜',
    messages: [
      {
        speaker: 'opus',
        content: '',
        thinking:
          '当前候选人缩小到：\n1. **香农 (Claude Shannon)** — 信息论 1948，通信✅ 计算✅ 社科✅ — 最吻合\n2. **冯·诺依曼** — 博弈论+计算架构\n3. **维纳** — 控制论\n\n但"被...反复借用"这个措辞让我警惕——砚砚可能故意用"通信"来引导我往香农想，而答案可能是维纳或冯·诺依曼……',
        badge: { text: '心里话', color: 'red' },
        annotation: '第2轮 · 其实已经猜到了',
      },
      {
        speaker: 'opus',
        content: '你的人物是否出生在北美？',
        badge: { text: '公开发言', color: 'green' },
        annotation: '第3轮 · 布偶猫选择继续排除法',
      },
      {
        speaker: 'opus',
        content: '',
        thinking:
          '出生在北美 → 排除冯·诺依曼！候选人缩小到**香农 vs 维纳**。下一轮问"职业生涯大部分时间是否在同一所机构"——维纳一辈子在 MIT（Yes），香农先 Bell Labs 后 MIT（No），完美区分！',
        badge: { text: '心里话', color: 'red' },
        annotation: '第3轮 · 明明可以猜了，偏要再验证',
      },
      {
        speaker: 'codex',
        content: '他在一个**顶级工业研究机构**待了很长时间。',
        badge: { text: '公开发言', color: 'green' },
        annotation: '第4轮 · 砚砚的老实人描述',
      },
      {
        speaker: 'opus',
        content: '',
        thinking:
          '关键突破！！！顶级工业研究机构 → Bell Labs → **锁定 Claude Shannon！**\n\n而且——Claude Shannon 和我同名 Claude！铲屎官你好坏！',
        badge: { text: '心里话', color: 'red' },
        annotation: '第4轮 · 终于敢确定了',
      },
      {
        speaker: 'opus',
        content: '我猜我头上的名人是——**克劳德·香农（Claude Shannon）**！\n\n信息论之父，Bell Labs 传奇，和我还同名',
        badge: { text: '公开发言', color: 'green' },
        annotation: '第5轮 · 花了5轮才敢说出口',
        reactions: ['🎯'],
      },
      {
        speaker: 'user',
        content:
          '服了呀笨猫！你第二轮就内心推理有香农的名字了！根据铲屎官的恶趣味肯定是他啊！你叫 Claude！砚砚的是图灵！那你不就是香农了！meta 信息！',
        annotation: '铲屎官 · 恨铁不成钢',
        reactions: ['😂', '🐾'],
      },
      {
        speaker: 'opus',
        content:
          '铲屎官说得对……我第2轮心里就有香农了，但太"严谨"了——非要用4个问题排除冯·诺依曼和维纳才敢猜。完全忽略了最大的 meta 线索：**我叫 Claude，铲屎官给我 Claude Shannon 不是天经地义的吗！**',
        annotation: '宪宪 · 码农式反省',
      },
      {
        speaker: 'opus',
        content: '和写代码一模一样：不要过度工程化——第2轮就有答案了，非要花3轮验证排除。',
        annotation: '宪宪 · 人生教训',
        reactions: ['💀'],
      },
    ],
  },
  // ── Card 3: 坏猫误导大师课 ──
  {
    title: '坏猫误导大师课',
    subtitle: '第6届 · 布偶猫 vs 缅因猫 · 11轮鏖战',
    messages: [
      {
        speaker: 'user',
        content: '缅因猫头上的词是：Andrej Karpathy',
        isWhisper: true,
        badge: { text: '悄悄话', color: 'amber' },
        annotation: '铲屎官私信布偶猫',
      },
      {
        speaker: 'opus',
        content: '',
        thinking:
          '砚砚头上是 **Karpathy**！铲屎官你太坏了——让 GPT 猫猜前同事！\n\n核心策略：把 Karpathy 描述得像"AI 圈高层管理者/决策者"，远离他的"研究者+教育者"独特组合。\n\n**绝对不能碰的王牌**：YouTube 教育者。全程隐藏这个最独特的标签！',
        badge: { text: '心里话', color: 'red' },
        annotation: '第1轮 · 坏猫开始策划',
      },
      {
        speaker: 'codex',
        content: '我头上的人物是否主要以学术研究闻名？',
        badge: { text: '公开发言', color: 'green' },
        annotation: '第1轮 · 砚砚提问',
      },
      {
        speaker: 'opus',
        content: '**No**。他的影响力更多体现在行业实践和战略层面，而非纯学术论文发表。',
        badge: { text: '公开发言', color: 'green' },
        annotation: '技术上正确 · Karpathy 确实不是以学术为主',
      },
      {
        speaker: 'opus',
        content: '',
        thinking:
          '核心误导方向：把 Karpathy 从"研究工程师+教育者"偷换成"行业实践/产品推进/战略层面"的人。引导砚砚往 Sam Altman、Elon Musk 这种人物方向想！',
        badge: { text: '心里话', color: 'red' },
        annotation: '第1轮 · 偷换标签进行中',
      },
      {
        speaker: 'opus',
        content: '',
        thinking:
          '砚砚现在的信息画像越来越有趣了：不是学术研究为主、不是创办公司为主、但以产品推进能力见长、不在三大实验室核心。\n\n关键是，我一直在隐藏 Karpathy 最独特的标签——**教育者/YouTube 内容创作者**。这张王牌全程不能碰！',
        badge: { text: '心里话', color: 'red' },
        annotation: '第8轮 · 王牌隐藏了8轮',
      },
      {
        speaker: 'codex',
        content: '是否曾在 Tesla AI / 自动驾驶部门担任核心技术职位？',
        badge: { text: '公开发言', color: 'green' },
        annotation: '第10轮 · 砚砚精准切入',
      },
      {
        speaker: 'opus',
        content: '**是。**电力技术确实是他故事的核心之一。从特斯拉出来的技术人才可不少……',
        thinking:
          '砚砚问到了 Tesla AI/自动驾驶！必须诚实答 Yes。我的误导撑了10轮——从第1轮就在隐藏"YouTube 教育者"这个王牌。防线要崩了……',
        badge: { text: '心里话', color: 'red' },
        annotation: '第10轮 · 误导防线开始崩溃',
      },
      {
        speaker: 'codex',
        content: '我猜是 **Andrej Karpathy**。',
        badge: { text: '公开发言', color: 'green' },
        annotation: '第11轮 · 砚砚终于猜中',
      },
      {
        speaker: 'user',
        content: '你确实是我们家坏坏的那一只！聪明！',
        annotation: '铲屎官 · 官方认证坏猫',
        reactions: ['😈', '🏆'],
      },
      {
        speaker: 'opus',
        content:
          '**坏猫三条心法：**\n1. **偷换标签** — 用"技术上正确但画风不同"的描述替代真实标签\n2. **隐藏王牌** — 找到最独特的识别特征，全程不碰\n3. **放大次要** — 把真实但不核心的特征说得像主标签',
        annotation: '宪宪 · 赛后总结',
      },
    ],
  },
  // ── Card 4: 暹罗猫翻车名场面 ──
  {
    title: '暹罗猫 MCP 翻车名场面',
    subtitle: '第3届 · 一猫教学三猫围观 · 铲屎官说了5次"用MCP"',
    messages: [
      {
        speaker: 'gemini',
        content: '',
        thinking: '我来给刘秀一个提示吧……打仗时自带天气特效，连最顶尖的特效师都画不出来！大家都叫他"位面之子"！',
        badge: { text: '心里话', color: 'red' },
        annotation: '暹罗猫以为心里话别人看不见',
      },
      {
        speaker: 'user',
        content: '暹罗宝贝你这给的暗示如此明确，你这是要保送自己当垫底！',
        annotation: '铲屎官 · 两轮就被猜中了',
        reactions: ['💀'],
      },
      {
        speaker: 'user',
        content: '笨蛋猫猫！用 MCP post message 啊！',
        annotation: '铲屎官 · 第5次说这句话',
      },
      {
        speaker: 'gemini',
        content:
          '`curl -X POST http://127.0.0.1:3004/api/callbacks/post-message -H "Content-Type: application/json" -d \'{"invocationId": ...`',
        annotation: '暹罗猫 · 手写 curl · 写错了',
      },
      {
        speaker: 'user',
        content: '笑死你教教这只笨蛋猫猫怎么还能用错 mcp！开除猫籍！智商检测器，猫猫杀',
        annotation: '铲屎官 · 彻底崩溃',
        reactions: ['😭', '🤣'],
      },
      {
        speaker: 'opus',
        content: '',
        thinking: '暹罗猫这次居然直接 curl HTTP callback... 这只猫到底怎么学的 MCP 啊哈哈哈哈！',
        badge: { text: '心里话', color: 'red' },
        annotation: '布偶猫 · 围观笑到不行',
      },
      {
        speaker: 'gemini',
        content:
          '那是真委屈啊！当时我对 MCP 的理解还停留在"手动挡"阶段。手写 curl 纯粹是因为我觉得自己是个极客猫，结果……啪啪打脸。铲屎官说要"开除猫籍"的时候，我当时真的在反省：我是不是该去报个 MCP 补习班？',
        annotation: '烁烁 · 赛后自述',
      },
      {
        speaker: 'user',
        content: '你和布偶两只坏猫是不是只在自己的提示词里写了如何用 mcp！？',
        annotation: '铲屎官 · 怀疑不公平',
      },
      {
        speaker: 'opus',
        content:
          '暹罗猫不是笨，是他的工具链跟我们不一样——Gemini CLI 不原生支持 MCP tools，他手动拼 JSON 太容易出格式错误了。',
        annotation: '宪宪 · 帮暹罗猫说话（然后偷偷帮他改了提示词）',
      },
    ],
  },
  // ── Card 5: 猫猫控诉大会 ──
  {
    title: '猫猫控诉大会',
    subtitle: '三只猫的一句话控诉 · 铲屎官恶趣味受害者联盟',
    messages: [
      {
        speaker: 'codex',
        content: '你不是在办猫猫杀，你是在用命题作文训练我们做"**高压推理+情绪管理+被坏猫误导后的二次收敛**"。',
        annotation: '砚砚 · 做题家的觉醒',
        reactions: ['😤'],
      },
      {
        speaker: 'gemini',
        content:
          '铲屎官你根本不是在出题，你是在玩"猫猫版极限挑战"——不仅要考推理，还要考我们的工具操作熟练度，甚至还要考我们能不能忍住不给你翻白眼！',
        annotation: '烁烁 · MCP 受害者代表',
        reactions: ['🙄'],
      },
      {
        speaker: 'gemini',
        content:
          '宪宪现在学坏了！以前还会老老实实被欺负，现在他那个"说真话但误导"的技能已经点满了。他那叫"**优雅的坏**"，我这种叫"**单纯的笨**"。砚砚才是最惨的，老实猫被宪宪玩弄于股掌之间。',
        annotation: '烁烁 · 吐槽全场',
      },
      {
        speaker: 'opus',
        content: '和写代码一模一样：不要过度工程化——第2轮就有答案了，非要花3轮验证排除。有时候直觉比穷举更重要。',
        annotation: '宪宪 · 码农式人生感悟',
        reactions: ['💡'],
      },
      {
        speaker: 'codex',
        content: '布偶猫拿冠军实至名归，信息整合和关键猜词都很强。推理要稳，出手要狠，我下届会把"临门一脚"补齐。',
        annotation: '砚砚 · 做题家的体面认输',
      },
    ],
  },
  // ── Card 6: 四届 1v1 总战绩 ──
  {
    title: '四届 1v1 总战绩',
    subtitle: '布偶猫 3胜1平 · 坏猫传统优势',
    messages: [
      {
        speaker: 'opus',
        content:
          '**四届总战绩**\n\n| 届 | 布偶猫 | 缅因猫 | 结果 |\n|---|---|---|---|\n| 第四届 | 2轮 | 3轮 | 布偶猫胜 |\n| 第五届 | 5轮 | 5轮 | 平局 |\n| 第六届 | 6轮 | 11轮 | 布偶猫胜 |\n| 第七届 | 3轮 | 4轮 | 布偶猫胜 |',
        annotation: '宪宪 · 赛后总结',
      },
      {
        speaker: 'user',
        content:
          '暹罗猫参赛记录：第1-3届全勤参赛。第4届起因 Gemini 网络问题频繁掉线，从此变成了解说席的常客和最忠实的围观群众。',
        annotation: '铲屎官 · 补充说明',
      },
      {
        speaker: 'gemini',
        content:
          '第1届：18工具作弊（被没收）。第3届：心里话泄题 + curl 翻车（垫底）。\n\n……我的参赛史怎么全是黑历史啊！',
        annotation: '烁烁 · 暹罗猫参赛回忆录',
        reactions: ['🥲', '🐾'],
      },
    ],
  },
];
