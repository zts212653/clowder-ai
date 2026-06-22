/**
 * F245 Phase A Task4 — 爪感差采集 precision/recall 语料（AC-A2 gate）
 *
 * 每条 { text, markers }：markers 是该 text 的已知正确提取结果。
 *   - 真 marker：markers 列出期望的 { tool, symptom }（tool 可为 undefined）
 *   - 干扰项：markers = []（不应误抓）
 *
 * 覆盖真实 precision 挑战：markdown link / 代码下标 / 其它中括号标签 / 错误前缀 /
 * 半截 marker / 无前缀嵌套方括号；以及 recall 全分隔符与多 marker 场景。
 * 复用于 Phase B precision 回归——改 extractPawFeelMarkers 必须保持本语料绿。
 */

export const PAW_FEEL_CORPUS = [
  // ===== 真 marker（recall）=====
  { text: '调试时 [爪感差: rg 输出噪音太多] 干扰判断', markers: [{ tool: 'rg', symptom: '输出噪音太多' }] },
  { text: '[爪感差：hold_ball 重复唤醒浪费猫粮]', markers: [{ tool: 'hold_ball', symptom: '重复唤醒浪费猫粮' }] },
  {
    text: '[爪感差: cat_cafe_search_evidence: 命中低需要多刀]',
    markers: [{ tool: 'cat_cafe_search_evidence', symptom: '命中低需要多刀' }],
  },
  { text: 'L0 格式 [爪感差: grep+不支持 PCRE 正则]', markers: [{ tool: 'grep', symptom: '不支持 PCRE 正则' }] },
  {
    text: '[爪感差: mcp__claude-in-chrome__computer 点击经常无响应]',
    markers: [{ tool: 'mcp__claude-in-chrome__computer', symptom: '点击经常无响应' }],
  },
  {
    text: '[爪感差: 这一整套流程太绕没有单一工具背锅]',
    markers: [{ tool: undefined, symptom: '这一整套流程太绕没有单一工具背锅' }],
  },
  {
    text: '两个连着 [爪感差: a 慢] [爪感差: b 卡]',
    markers: [
      { tool: 'a', symptom: '慢' },
      { tool: 'b', symptom: '卡' },
    ],
  },
  { text: '混合 [TODO] 后面 [爪感差: ripgrep 噪音] 收尾', markers: [{ tool: 'ripgrep', symptom: '噪音' }] },
  // cloud review P2-1：含冒号 npm script 工具名（空格优先于冒号，不拆坏）
  { text: '[爪感差: alpha:start 启动慢]', markers: [{ tool: 'alpha:start', symptom: '启动慢' }] },
  { text: '[爪感差: test:redis 偶发超时]', markers: [{ tool: 'test:redis', symptom: '偶发超时' }] },
  // cloud review P2-2：symptom 内一层嵌套方括号不截断（recall）
  { text: '[爪感差: rg 输出含 [WARN] 标签太多]', markers: [{ tool: 'rg', symptom: '输出含 [WARN] 标签太多' }] },

  // ===== 干扰项（precision，零误抓）=====
  { text: '正常 markdown [链接文本](https://example.com/path) 不是 marker', markers: [] },
  { text: '代码里 arr[0] 和 list[index] 是下标不是 marker', markers: [] },
  { text: '标签 [TODO] [FIXME] [2026-06-18] 都不是爪感差', markers: [] },
  { text: '错误前缀 [爪感: 缺一个字] 和 [感差: 也缺字]', markers: [] },
  { text: '半截 [爪感差: 没有闭合括号就继续写下去', markers: [] },
  { text: '无前缀嵌套方括号 [外层 [内层] 收尾] 不是 marker', markers: [] },
  { text: '纯文本完全没有任何标记符号也没有 marker', markers: [] },
];
