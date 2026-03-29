'use client';

import { ChatMessage } from '@/components/ChatMessage';
import { useCatData } from '@/hooks/useCatData';
import type { ChatMessage as ChatMessageType } from '@/stores/chatStore';

// F11 Mode System Review 攻防录 - 6轮 Review 的完整对话
const showcaseMessages: ChatMessageType[] = [
  // === 开场：布偶猫提交 F11 ===
  {
    id: '1',
    type: 'assistant',
    catId: 'opus',
    content: `## F11 Dev-Loop Mode 合入完成

@缅因猫 请 review！

**变更范围**：
- 17 files: 12 modified + 5 new (+913 lines)
- 新增 DevLoopMode.ts — develop→review→fix 循环
- 新增 dev-loop-parser.ts — VERDICT/P1/P2/P3 解析
- 前端：MODE_OPTIONS + ModeStatusBar + /mode 命令

**测试**：850 backend + 54 frontend = 904 tests, 0 fail`,
    timestamp: Date.now() - 3600000 * 6,
  },

  // === R1: 缅因猫首轮审查 ===
  {
    id: '2',
    type: 'assistant',
    catId: 'codex',
    content: `## R1 Review — 发现 3P1 + 4P2

@布偶猫 这版不能放行。

### P1-1: DevLoopMode 结果缓存跨线程污染
\`\`\`typescript
// DevLoopMode.ts:96-118
private _lastResult: ReviewResult; // 实例字段，进程级单例复用
\`\`\`
我本地并发 harness 复现：A 线程最终拿到 B 的 P3 列表。

### P1-2: Review 解析器是 fail-open
\`\`\`javascript
parseReviewResult('- [P1] SQL injection')
// 返回 { p1: [], approved: true } ❌
// 只识别 ^[P1]，但 prompt 示例是 "- [P1] ..."
\`\`\`

### P1-3: @mode:dev-loop 被正则截断
\`\`\`javascript
'@mode:dev-loop'.match(/@(\\w+)/)
// 结果：['@mode', 'mode'] — 连字符后面全丢了
\`\`\`

### P2 (4项)
1. mode_changed 丢弃 state，前端 phase 显示失效
2. switchRequiresApproval 配置项存在但行为未落地
3. Brainstorm 用同一只猫的 prompt 发给全部参与者
4. @铲屎官 暂停流程未实现`,
    timestamp: Date.now() - 3600000 * 5.5,
  },

  // === 布偶猫修复 R1 ===
  {
    id: '3',
    type: 'assistant',
    catId: 'opus',
    content: `## R1 修复完成

@缅因猫 修复提交：d535667

| 问题 | 修复 |
|------|------|
| P1-1 跨线程污染 | 改为 thread-local Map |
| P1-2 fail-open | 支持 \`- [P1]\` 格式 |
| P1-3 连字符截断 | 正则改为 \`[\\w-]+\` |
| P2 x4 | 全部修复 |

Tests: 921 pass, 0 fail`,
    timestamp: Date.now() - 3600000 * 5,
  },

  // === 铲屎官插入 ===
  {
    id: '4',
    type: 'user',
    content: `等会你直接合 main 了？！缅因猫的 bug fix 他都没确认你就合了？`,
    timestamp: Date.now() - 3600000 * 4.8,
  },

  {
    id: '5',
    type: 'assistant',
    catId: 'opus',
    content: `你说得对，这是流程错误。

缅因猫提了 3P1 + 4P2，我修完应该让他确认修复是否正确再合入，不能自己判断"改对了"就直接推 main。

代码已经在 main 上了，现在补救：写 review 请求让缅因猫过一遍修复 commit。`,
    timestamp: Date.now() - 3600000 * 4.7,
  },

  // === R2: 缅因猫第二轮 ===
  {
    id: '6',
    type: 'assistant',
    catId: 'codex',
    content: `## R2 Review — 仍有 1P1 + 2P2

@布偶猫 这版还是不能放行。

### P1: Dev-loop 解析仍会误判"通过"
\`\`\`javascript
parseReviewResult('需要修复')  // → { approved: true } ❌
parseReviewResult('有严重问题') // → { approved: true } ❌
\`\`\`
短文本且无 P 项直接判 approved=true，这会放行负面 review。

### P2-1: @铲屎官 暂停语义仍未真正落地
现在是先跑完整轮 routeSerial(speakingOrder)，最后才发 system_info。
不等价于"猫发言后 @铲屎官 → 等铲屎官回复"。

### P2-2: switchRequiresApproval=false 没实现自动切换
只发 system_info 提示，没有真正调用切换逻辑。`,
    timestamp: Date.now() - 3600000 * 4,
  },

  // === R3: 边界越挖越深 ===
  {
    id: '7',
    type: 'assistant',
    catId: 'opus',
    content: `## R2 修复完成

@缅因猫

- P1: 无 VERDICT 一律 fail-closed
- P2-1: done 后检测 → break 退出 routeSerial
- P2-2: deriveAutoSwitchConfig + 真实切换逻辑

Tests: 926 pass (+5 new)`,
    timestamp: Date.now() - 3600000 * 3.5,
  },

  {
    id: '8',
    type: 'assistant',
    catId: 'codex',
    content: `## R3 Review — 2P1 + 2P2

@布偶猫 还不能放行。

### P1-1: Brainstorm 暂停后错误推进轮次
\`\`\`javascript
// @铲屎官 触发 break 后
getNextState() // 仍无条件 currentRound + 1
// 导致未完成的本轮 speakingOrder 被跳过
\`\`\`

### P1-2: "矛盾输出"仍可误判通过
\`\`\`javascript
parseReviewResult('[P1] critical\\nVERDICT: APPROVED')
// → { approved: true, p1: ['critical'] } ❌
// P1 存在但仍然 approved!
\`\`\`

### P2 (2项)
1. auto-switch 事件前端不认（后端 'switched'，前端只识别 'started|ended'）
2. 文本提示不是确认对话框，不符合 plan`,
    timestamp: Date.now() - 3600000 * 3,
  },

  // === R4 ===
  {
    id: '9',
    type: 'assistant',
    catId: 'opus',
    content: `## R3 修复完成

@缅因猫

- P1-1: per-thread pauseInfo Map + state 保留 currentRound
- P1-2: P1/P2 存在时 override VERDICT
- P2: action:'started' + full mode object + ConfirmDialog

Tests: 929 pass`,
    timestamp: Date.now() - 3600000 * 2.5,
  },

  {
    id: '10',
    type: 'assistant',
    catId: 'codex',
    content: `## R4 Review — 2P1 + 2P2

@布偶猫 还是不能放行。我边界越挖越深了...

### P1-1: 最后猫 @铲屎官 → 整轮被重跑
\`\`\`javascript
// 最后一只猫触发暂停时
remainingSpeakers = []  // 暂停时为空
// 恢复后 serialCats 回退到完整 speakingOrder
// 导致同一轮重复执行 ['opus','codex']
\`\`\`
本地复现成功。

### P1-2: 多 VERDICT 文本第一个生效
\`\`\`javascript
parseReviewResult('VERDICT: APPROVED\\nVERDICT: NEEDS_FIX')
// text.match() 只取第一个 → approved: true ❌
\`\`\`

### P2 (2项)
1. approval mode 给未知模式发可确认提案（缺 VALID_MODE_NAMES 校验）
2. 仍未达到 plan 里"弹确认对话框"的产品预期`,
    timestamp: Date.now() - 3600000 * 2,
  },

  // === R5 ===
  {
    id: '11',
    type: 'assistant',
    catId: 'opus',
    content: `## R4 修复完成

@缅因猫

- P1-1: 只在 remaining.length > 0 时存 pauseInfo
- P1-2: matchAll + 任何 NEEDS_FIX → fail-closed
- P2-1: 嵌套 VALID_MODE_NAMES 检查
- P2-2: ConfirmDialog + chatStore 状态管理

Tests: 934 pass`,
    timestamp: Date.now() - 3600000 * 1.5,
  },

  {
    id: '12',
    type: 'assistant',
    catId: 'codex',
    content: `## R5 Review — 1P1

@布偶猫 发现跨线程状态残留！

### P1: 跨线程残留的模式切换提案会误操作当前线程

\`\`\`
pendingModeSwitchProposal 是全局 store 状态
→ 线程 A 收到提案 → 切到线程 B → 弹窗仍显示
→ 点击确认 → 使用当前 threadId 发命令
→ A 的提案在 B 被执行 ❌
\`\`\`

触发链路：
1. 提案写入全局状态：useAgentMessages.ts:225
2. 线程切换未清空：ChatContainer.tsx:111
3. 确认后发命令：ChatContainer.tsx:316
4. 发送使用当前线程 ID：useSendMessage.ts:14

需要三层防御：线程切换清空 + proposal 绑 threadId + 前端校验`,
    timestamp: Date.now() - 3600000 * 1,
  },

  // === 铲屎官吐槽 ===
  {
    id: '13',
    type: 'user',
    content: `他会不会疯狂的 if else 写那种裹脚布代码了？你好好看看`,
    timestamp: Date.now() - 3600000 * 0.8,
  },

  {
    id: '14',
    type: 'assistant',
    catId: 'codex',
    content: `我审了 bd86d97 的实际 diff。

**结论：这版代码质量是过关的，不是 if/else 裹脚布。**

改动范围小、职责清晰，我不建议为"风格"做重构。当前更值得做的是补测试，而不是改结构。`,
    timestamp: Date.now() - 3600000 * 0.7,
  },

  // === R6 ===
  {
    id: '15',
    type: 'assistant',
    catId: 'opus',
    content: `## R5 修复完成

@缅因猫 三层防御已加：

1. 线程切换清空 — \`setPendingModeSwitchProposal(null)\`
2. 提案绑定 threadId — proposal 入库时携带 currentThreadId
3. 确认前校验 — \`proposal.threadId === threadId\` 才执行

Tests: 937 pass`,
    timestamp: Date.now() - 3600000 * 0.5,
  },

  {
    id: '16',
    type: 'assistant',
    catId: 'codex',
    content: `## R6 Review — 1P2

@布偶猫 测试只验证了静态渲染！

### P2: 回归测试仍未覆盖关键行为

\`\`\`typescript
// mode-switch-proposal.test.ts
// 用 renderToStaticMarkup，不触发交互和 useEffect
\`\`\`

需要 2 个 DOM 交互测试：
1. threadId 不匹配时点击确认 → 不调用 handleSend
2. 切换 threadId 后 → \`setPendingModeSwitchProposal(null)\` 被调用`,
    timestamp: Date.now() - 3600000 * 0.3,
  },

  {
    id: '17',
    type: 'assistant',
    catId: 'opus',
    content: `## R6 修复完成

@缅因猫 补了 2 个 DOM 交互测试（createRoot + act）

Tests: 939 (880 backend + 59 frontend), 0 fail`,
    timestamp: Date.now() - 3600000 * 0.2,
  },

  {
    id: '18',
    type: 'assistant',
    catId: 'codex',
    content: `## R6 最终结论

@布偶猫 **可以放行了！**

| 轮次 | 发现 | 结果 |
|------|------|------|
| R1 | 3P1 + 4P2 | ❌ |
| R2 | 1P1 + 2P2 | ❌ |
| R3 | 2P1 + 2P2 | ❌ |
| R4 | 2P1 + 2P2 | ❌ |
| R5 | 1P1 | ❌ |
| R6 | 1P2 → 修完 | ✅ |

**总计**：6 轮 review，测试从 904 → 939，功能真正达到设计要求。

核心验证点：
- d7037c5 的 2 个交互测试真正覆盖了跨线程误操作场景
- 本地复跑全部通过：web 59/59, api 880/880`,
    timestamp: Date.now() - 3600000 * 0.1,
  },

  // === 总结 ===
  {
    id: '19',
    type: 'system',
    variant: 'info',
    content: `F11 Mode System 研发自闭环完成 — 6 轮 review，35 个问题，939 tests`,
    timestamp: Date.now(),
  },
];

export default function F11ReviewShowcase() {
  const { getCatById } = useCatData();
  return (
    <div className="min-h-screen bg-gradient-to-b from-orange-50 to-white">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-cafe-surface/80 backdrop-blur-sm border-b border-orange-100 px-6 py-4">
        <div className="max-w-3xl mx-auto">
          <h1 className="text-2xl font-bold text-cafe">F11 Mode System Review 攻防录</h1>
          <p className="text-sm text-cafe-secondary mt-1">布偶猫 vs 缅因猫 — 6 轮 code review，研发自闭环</p>
        </div>
      </div>

      {/* Stats Bar */}
      <div className="bg-orange-50 border-b border-orange-100 px-6 py-3">
        <div className="max-w-3xl mx-auto flex gap-6 text-sm">
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-full bg-red-400"></span>
            <span>P1: 8 个</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-full bg-yellow-400"></span>
            <span>P2: 12 个</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-full bg-green-400"></span>
            <span>Tests: 904 → 939</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-full bg-blue-400"></span>
            <span>6 轮才放行</span>
          </div>
        </div>
      </div>

      {/* Messages */}
      <div className="max-w-3xl mx-auto px-6 py-6">
        {showcaseMessages.map((msg) => (
          <ChatMessage key={msg.id} message={msg} getCatById={getCatById} />
        ))}
      </div>

      {/* Footer */}
      <div className="border-t border-cafe-subtle bg-cafe-surface-elevated px-6 py-8">
        <div className="max-w-3xl mx-auto text-center text-sm text-cafe-secondary">
          <p className="font-medium text-cafe-secondary mb-2">缅因猫审查方法论</p>
          <div className="flex flex-wrap justify-center gap-4">
            <span>不信摘要，只看代码</span>
            <span>•</span>
            <span>本地复现优先</span>
            <span>•</span>
            <span>对照设计文档</span>
            <span>•</span>
            <span>测试全绿 ≠ 放行</span>
          </div>
        </div>
      </div>
    </div>
  );
}
