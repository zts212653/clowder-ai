---
feature_ids: [F171, F155]
topics: [onboarding, issue-1466, technical-specification, prototype, implementation]
doc_kind: technical_spec
created: 2026-10-08
updated: 2026-10-09
related: ["zts212653/clowder-ai#1466", "zts212653/clowder-ai#1519"]
status: revision-1
---

# 首次启动用户旅程技术方案

> Issue #1466 的技术实现方案，基于 v2 原型（bootcamp-onboarding-prototype-v2.html）

## 修订记录

**Revision 1 (2026-10-09)** - 响应 @codex 审核意见 (0001791505976851):
- ✅ P1-1: 修正 API 端点（ClientSetup.tsx → `/api/first-run/available-clients`, MemberHandoff.tsx → loop `POST /api/cats`）
- ✅ P1-1: 移除 mock 登录按钮和 pending 状态
- 🚧 P1-2: 更新技术组件映射和状态存储策略（本次提交）
- 🚧 P2-1: 应用入口集成（待实现）
- 🚧 P2-2: 使用真实 catRegistry（待实现）
- 🚧 P2-3: 测试覆盖（待实现）

## 1. 需求对应关系

### Issue #1466 的核心目标

**问题**：
1. 新用户不知道产品是干什么的（没亲眼看到"协作团队"实际运作）
2. 开始使用路径太长、太手动（本机已有 CLI 但需手动配置）

**目标**：
双击安装包后，不填任何 key，按最短路径看完演示就理解产品，然后直接对话。

**核心思路**：
- 演示不调用真实模型，全程脚本播放
- 画面用真实界面组件渲染
- 三只猫贯穿全程，演示里的猫就是真实成员，解说猫最后成为前台猫

### v2 原型对应的 8 幕

| Issue 分镜 | v2 场景 | 实现状态 | 关键差异说明 |
|-----------|---------|---------|------------|
| 1. 三只猫跑出来，闲置等用户 | 场景 1：三只猫先出现 | ✓ 已实现 | 原型使用字母头像，未接入 canon sprite；闲置动作为简化占位 |
| 2. 输入框自动打字 | 场景 2：输入框自动打字 | ✓ 已实现 | 打字动效完整，支持暂停/恢复 |
| 3. 被 @ 的猫跑向消息气泡 | 场景 3：一只猫接住消息并 @ 同伴 | ✓ 已实现 | "猫跑向气泡"使用 CSS transform 模拟，未用真实跑步循环 |
| 4. 回复里 @ 另一只猫 | 场景 4：因为协作，结果变好了 | ✓ 已实现 | 展示初稿→审查意见→改稿，用删除线和高亮标出改动 |
| 5. 解说猫讲清发生了什么 | 场景 5：解说收束 | ✓ 已实现 | 暹罗猫解说，明确"刚才是示范，接下来配置你自己的伙伴" |
| 6. 探测本机 client，用户勾选 | 场景 6：检测本机 client | ✓ 已实现 | 使用 fixture 模拟，支持 0/1/多 client 分支；"去登录"进入 pending 状态 |
| 7. 解说猫变成前台猫 | 场景 7：从示范团队交接到我的伙伴 | ✓ 已实现 | 明确区分示范团队和真实团队；未配置的猫不冒充成员 |
| 8. 真实主界面，非阻塞提醒 | 场景 8：第一次真实交流 | ✓ 已实现 | 用户可自由输入；入口提醒在主界面打开后显示，不遮挡输入框 |

**额外场景**：
- 场景 9：可选训练路径（阶段 8-12） — 展示需求→设计→开发→审查→交付的完整协作流程，所有动作标注为 mock

### 与评论要求的对应

| 评论要求 | v2 实现 | 验证状态 |
|---------|--------|---------|
| 让用户看到"结果因协作变好" | 场景 4 用删除线/高亮展示"A2A 协作"→"几只猫会互相搭把手" | ✓ 通过 |
| 示范团队→真实团队交接清晰 | 场景 7 明说"刚才是示范"，未配置的猫挥手退场 | ✓ 通过 |
| 入口讲解放在第一句话之后 | 场景 8 入口提醒在真实主界面打开后，不阻塞发送 | ✓ 通过 |
| "去登录"不等于已登录 | pending 状态必须模拟"登录完成"才能选择 | ✓ 通过 |
| 0 client 停在安装指引 | 显示"未检测到 client"提示，禁止继续 | ✓ 通过 |
| 1 client "先从你和它开始" | 交接文案准确，不把单成员当残缺状态 | ✓ 通过 |
| 刷新后回到未完成状态 | localStorage 恢复，不重放已完成示范 | ✓ 通过 |

---

## 2. 技术架构

### 2.1 原型技术栈

- **纯静态 HTML**：单文件，不依赖外部库
- **CSS Grid + Flexbox**：响应式布局（桌面 1440×1000，移动 390×844）
- **Vanilla JavaScript**：状态机 + 事件驱动
- **localStorage**：持久化旅程进度

### 2.2 状态管理结构

```javascript
state = {
  scene: 1,              // 当前场景编号 (1-9)
  furthest: 1,           // 用户到达的最远场景
  fixture: 'one',        // client fixture: 'none'|'one'|'many'
  paused: false,         // 演示是否暂停
  typed: false,          // 是否完成打字
  typingIndex: 0,        // 打字进度
  clients: [],           // client 清单 [{name, login, id, selected}]
  members: [],           // 生成的真实成员 [{client, cat}]
  optional: 0,           // 可选训练阶段 (0-5)
  tip: true,             // 是否显示入口提醒
  chat: false,           // 是否已进入真实聊天
  demoStarted: false,    // 演示脚本是否已开始
  auto: false            // 是否自动播放
}
```

### 2.3 场景流转逻辑

**线性强制流程**（场景 1-7）：
- 用户必须按顺序完成，不能跳过
- `furthest` 记录最远进度，`scene` 是当前位置
- "回看上一幕"只能回到 `<= furthest` 的场景

**状态门禁**（场景 6）：
- `clients` 数组为空 → 禁止继续
- `clients` 中 `login !== 'done'` 的不能勾选
- `login === 'pending'` 显示"模拟登录完成"按钮
- 至少一个 `selected && login === 'done'` 才能进入场景 7

**自由分支**（场景 8-9）：
- 场景 8 用户可自由输入，不强制进入场景 9
- 场景 9 是可选训练路径，可从场景 8 主动进入

### 2.4 动画与交互

**自动打字动效**：
```javascript
// 30ms/字符，支持暂停/恢复
const tick = () => {
  if (state.paused) {
    setTimeout(tick, 80);
    return;
  }
  state.typingIndex = Math.min(text.length, state.typingIndex + 1);
  el.value = text.slice(0, state.typingIndex);
  if (state.typingIndex < text.length) setTimeout(tick, 30);
}
```

**猫跑向消息气泡**：
```css
.cat.run {
  transform: translate(80px, -12px) scale(1.06);
  transition: 0.35s;
}
```

**脚本自动播放**：
- 场景 1→2：立即进入并开始打字
- 场景 2→3：等待打字完成后延迟 500ms
- 场景 3→4：猫动画 1800ms 后自动进入
- 场景 4→5：延迟 2200ms，自动停止播放

---

## 3. 生产实现路径

### 3.1 技术组件映射

| 原型部分 | 生产组件 | 技术栈 | API 端点 | 负责模块 |
|---------|---------|--------|----------|---------|
| 场景 1-5：脚本演示 | `DemoScenes.tsx` | React | 无（前端脚本） | `packages/web/src/components/onboarding/` |
| 场景 6：client 探测 | `ClientSetup.tsx` | React | `GET /api/first-run/available-clients` | `packages/api/src/routes/first-run-quest.ts` |
| 场景 7：伙伴交接 | `MemberHandoff.tsx` | React | `POST /api/cats`（循环调用） | `packages/api/src/routes/cats.ts` |
| 场景 8：真实聊天 | `RealChatEntry.tsx` | React | 进入现有聊天界面 | 集成到 App.tsx |
| 猫的视觉素材 | Sprite sheets | PNG 序列帧 | 无 | 复用 `docs/design/assets/character-canon/` |
| 状态持久化 | ThreadStore | `firstRunQuestState` | 无 | `packages/api/src/domains/cats/services/stores/ports/ThreadStore.ts` |

### 3.2 关键技术决策

**1. 演示脚本与真实模型调用的边界**
- 场景 1-5：前端预置 JSON 脚本，不调用后端
- 场景 6：真实调用 `GET /api/first-run/available-clients`（已有契约，见 `first-run-quest.ts`）
- 场景 7：循环调用 `POST /api/cats`（已有契约，见 `cats.ts`，每个 client 一次调用）
- 场景 8：进入现有聊天界面，真实调用 Agent 服务

**2. 猫的动画实现**
- 原型使用 CSS transform + 字母头像（占位）
- 生产需要：
  - 引入 `character-canon/` 的 192×208 sprite sheets
  - 使用 Framer Motion 或 CSS animation 实现跑步循环
  - 实现"猫跑向消息气泡→缩成头像"的形变动画

**3. 状态持久化策略**
- 原型使用 `localStorage`（浏览器内演示，仅前端临时缓存）
- 生产使用 ThreadStore 的 `firstRunQuestState`（唯一真相源）：
  ```typescript
  // 需要扩展现有的 FirstRunQuestStateV1（见 ThreadStore.ts:422-434）
  interface FirstRunQuestStateV2 {
    v: 2;
    phase: FirstRunQuestPhase;
    scene: number; // 当前场景 (1-8)
    furthest: number; // 用户到达的最远场景
    startedAt: number;
    completedAt?: number;
    selectedClients?: Array<{ name: string; id: string; provider: string }>;
    createdCatIds?: string[]; // 已创建的成员 ID
  }
  ```
- 并发控制：使用 ThreadStore 的 CAS 机制
- TTL=0：首启状态永久保留，不自动过期（符合铁律 5）

**4. 客户端探测与登录流程**

**部署边界**：
- **仅桌面应用支持**：API 服务器运行在本地（Electron 主进程），探测本机环境的 CLI
- Web 应用场景：远程 API 无法探测用户电脑，首启旅程不可用

**探测逻辑**（已有实现）：
- API: `GET /api/first-run/available-clients`（见 `first-run-quest.ts:93-131`）
- 使用 `detectAvailableClients()` 函数（见 `client-detection.ts`）
- 返回格式：`{ clients: [{ name, cliTool, installed, authenticated, version? }] }`

**登录流程**（Phase 1 简化方案）：
- 场景 6 只显示已安装且已认证的 CLI
- 未认证的 CLI 显示文本提示："需要先在终端运行 `<cli> auth login`"
- 用户在外部完成登录后，点击"重新检测"按钮刷新状态
- **不拉起登录流程**：没有 IPC、进程生命周期、完成事件等基础设施（Phase 3 工作）

**安全边界**：
- 凭证不传输到前端：API 只返回 `authenticated: boolean`
- 不读取凭证内容，只检查凭证文件存在性或调用 CLI 的 `auth status` 命令

**5. 与 F155 场景引导引擎的集成**
- 场景 8 的入口提醒复用 `GuideOverlay.tsx`
- 引导配置：
  ```json
  {
    "id": "onboarding-first-chat",
    "triggers": ["first_message_sent"],
    "steps": [
      {
        "target": "[data-section='members']",
        "content": "从这里邀请更多伙伴"
      },
      {
        "target": "[data-section='accounts']",
        "content": "从这里管理 API 密钥"
      }
    ]
  }
  ```

### 3.3 实现优先级

**Phase 1: 核心流程（MVP）**
- [x] 场景 1-5 脚本演示（简化动画：字母头像 + CSS transform）
- [x] 场景 6 真实 client 探测
  - [x] 调用 `GET /api/first-run/available-clients`
  - [x] 0 client 分支：显示安装指引
  - [x] 1 client 分支：自动选择
  - [x] 多 client 分支：用户勾选
  - [x] 未认证 CLI：显示文本提示，不拉起登录
- [x] 场景 7 成员创建与交接
  - [x] 循环调用 `POST /api/cats` 创建成员
  - [x] 部分失败恢复：记录已创建的成员数量，显示错误信息
- [x] 场景 8 进入真实聊天（简单 UI 提示）
- [ ] 状态持久化（ThreadStore firstRunQuestState）—— 需要扩展 V2 schema
- [ ] 应用入口集成（App.tsx）
- [x] 刷新恢复机制（localStorage 临时实现）

**Phase 2: 视觉与引导打磨**
- [ ] 引入 character-canon sprite sheets
- [ ] 实现猫的跑步循环动画
- [ ] 实现"猫→头像"形变
- [ ] 接入 F155 Guide Engine（场景 8 入口提醒）
- [ ] 响应式布局优化
- [ ] 使用真实 catRegistry 替代固定 CAT_BREEDS

**Phase 3: 可选扩展**
- [ ] 可选训练路径（阶段 8-12）—— 独立 Feature，不阻塞首启核心流程
- [ ] CLI 登录流程拉起（需要 IPC 基础设施）

### 3.4 测试策略

**单元测试**（参考原型分支的 `journey.test.mjs`）：
- 状态机转换逻辑
- client 探测与过滤
- 成员生成规则
- 刷新恢复逻辑

**E2E 测试**（参考原型分支的 `journey.browser.test.mjs`）：
- 完整旅程走通（1→8）
- 0/1/多 client 分支
- pending 登录门禁
- 刷新恢复
- 移动端布局

**验收标准**：
- 首启到第一句话耗时 < 2 分钟（已有登录 CLI）
- 演示承诺的效果在首次真实对话中可兑现
- 刷新后不丢失进度
- 所有门禁不可绕过

---

## 4. 已知限制与后续工作

### 4.1 原型限制

1. **视觉素材**：
   - 当前使用字母头像占位
   - 猫的闲置动作为简化占位，未实现邻接图
   - "猫跑向气泡"使用 transform 近似，未用真实跑步循环

2. **client 探测**：
   - 原型使用 fixture 模拟，不读取本机
   - 生产需要真实调用各 CLI 的状态检查命令

3. **登录流程**：
   - 原型的"去登录"只改状态为 pending
   - 生产需要拉起各 CLI 的登录流程，并轮询结果

4. **状态持久化**：
   - 原型使用 localStorage（浏览器内）
   - 生产需要 Redis（跨会话、跨设备）

5. **Agent 回复**：
   - 原型的场景 8 回复为占位 mock
   - 生产需要真实调用 Agent 服务

### 4.2 与现有代码的关系

**需要修改的现有文件**：
- `packages/web/src/App.tsx`：在首启时渲染 `OnboardingFlow` 而非直接进入主界面
- `packages/api/src/routes/members.ts`：新增 `POST /api/members/batch` 批量创建成员
- `desktop/splash.html`：保留但缩短显示时间，快速切换到首启旅程

**可以复用的现有代码**：
- `packages/api/src/domains/cats/services/first-run-quest/client-detection.ts`
- `packages/api/src/routes/quota.ts` 的登录态检查逻辑
- `packages/web/src/components/GuideOverlay.tsx`（F155）
- `packages/web/src/hooks/usePinnedSections.ts`

**不需要改动的部分**：
- 左侧栏现有入口（老用户兼容性）
- 主窗口聊天组件（直接复用）

### 4.3 后续设计决策

**待 operator 拍板**：
1. 训练阶段 8-12 是否作为首启强制流程？
   - 当前原型：可选，不阻塞真实聊天
   - 待定：是否有场景需要强制走完？

2. 单 client 时的团队配置：
   - 当前原型："先从你和它开始"
   - 待定：是否允许用户在首启时跳过，稍后再配置？

3. 视觉素材的最终选择：
   - 当前原型：字母头像占位
   - 待定：使用 character-canon 哪个版本？（"低头"候选仍在验收）

4. 引导中心的长期规划：
   - 当前：首启旅程独立实现
   - 待定：是否纳入更大的"引导中心"体系？

---

## 5. 验证结果

### 5.1 原型浏览器验证

**验证环境**：
- 浏览器：Playwright Chromium
- 桌面视口：1440×1000
- 移动视口：390×844
- 运行目录：`G:\AIwork\clowder-ai\worktrees\feat-onboarding-first-run`

**验证命令**：
```bash
node docs/bug-report/onboarding-browser-recovery/prototype-v2.browser.test.mjs
```

**验证结果**：✓ 通过（退出码 0）

**覆盖范围**：
- 自动打字暂停/恢复
- 三猫 @ 协作和改稿
- 0 client 门禁
- 1 client 可用分支
- 多 client 选择
- pending 登录不可越过
- 模拟登录完成
- 真实伙伴交接
- 自由聊天
- 非阻塞提醒
- 可选阶段 8-12
- 刷新恢复
- 移动端无横向溢出
- 无页面异常

**截图路径**：
`G:\AIwork\clowder-ai\worktrees\feat-onboarding-first-run\docs\bug-report\onboarding-browser-recovery\artifacts\2026-10-08\prototype-v2\`

**关键截图**：
- `01-typing-paused.png`：自动打字暂停
- `02-collaboration-improved-result.png`：协作改进结果
- `03-no-client-gate.png`：0 client 门禁
- `03-one-client-ready.png`：1 client 可用
- `04-real-chat-and-nonblocking-tip.png`：真实聊天 + 非阻塞提醒
- `05-optional-stage-8.png` 至 `05-optional-stage-12.png`：可选阶段
- `06-optional-journey-complete.png`：可选旅程完成
- `07-mobile-complete.png`：移动端完成

### 5.2 验证限制

- 这是离线 HTML 原型验证
- client 探测、CLI 登录、模型回复、文件生成和 Agent 审查均为显式 mock
- 该结果不能替代真实 Web/API、Electron 安装后、真实账号或真实模型验收

---

## 6. 实施建议

### 6.1 给实施者的建议

1. **不要从零开始**：
   - 参考分支 `feat/onboarding-journey-prototype` 的状态机设计
   - 复用现有的 client 探测和登录态检查逻辑
   - 使用 character-canon 已有的 sprite sheets

2. **先做核心流程，后打磨视觉**：
   - Phase 1 可以先用简化动画（如原型的 transform）
   - 确保状态机和门禁正确后，再引入完整 sprite 动画

3. **测试先行**：
   - 参考原型分支的 15 个单元测试 + 5 个浏览器测试
   - 每个门禁都应有对应的测试用例

4. **诚实边界**：
   - 演示脚本必须标注为 mock
   - "去登录"不能伪装成已登录
   - 未配置的猫不能冒充真实成员

### 6.2 与其他 Feature 的协作

- **F171**（首启流程）：本 issue 替代现有的"选模板→选客户端→选账号"流程
- **F155**（场景引导引擎）：场景 8 的入口提醒复用 F155
- **F229**（猫猫球/前台猫）：场景 7 的交接目标是 F229 的前台猫
- **#1463**（CLI 自动检测）：场景 6 的 client 探测复用其探测层

### 6.3 风险与缓解

| 风险 | 影响 | 缓解措施 |
|-----|------|---------|
| sprite sheets 授权/质量问题 | 视觉无法达到预期 | 先用简化动画发布 MVP，视觉素材异步打磨 |
| client 登录态探测不稳定 | 用户卡在场景 6 | 提供"手动输入 API key"降级路径 |
| 刷新后状态丢失 | 用户需要重新走完整流程 | 优先实现 Redis 持久化，不依赖 localStorage |
| 演示承诺无法在真实对话兑现 | 用户失望 | 配置屏提示"单成员时无跨模型互审"等限制 |

---

## 7. 总结

### 7.1 原型验收结论

**v2 原型符合 issue#1466 和评论的所有关键要求**：
- ✓ 完整实现 8 幕分镜
- ✓ 演示脚本与真实状态边界清晰
- ✓ 支持 0/1/多 client 分支
- ✓ 登录门禁不可绕过
- ✓ 示范团队→真实团队交接明确
- ✓ 入口提醒在第一句话之后，非阻塞
- ✓ 刷新恢复机制完整
- ✓ 移动端布局无溢出

### 7.2 下一步行动

1. **本文档提交审核**：请 @codex 审核技术方案的完整性和可行性
2. **operator 拍板遗留设计决策**：训练阶段 8-12 是否强制、视觉素材版本选择
3. **创建实施 PR**：按 Phase 1→2→3 分阶段实施
4. **E2E 测试覆盖**：参考原型分支的测试用例

### 7.3 文档归档

本文档与以下文件共同构成 issue#1466 的完整交付物：
- `docs/design/bootcamp-onboarding-prototype-v2.html`：可运行原型
- `docs/bug-report/onboarding-browser-recovery/handoff-2026-10-08.md`：交接文档
- `docs/bug-report/onboarding-browser-recovery/artifacts/2026-10-08/prototype-v2/`：验证截图
- 本文档：技术方案

---

**作者**：布偶猫/宪宪 (@opus-5, claude-opus-5-5)  
**审核者**：待 @codex 审核  
**日期**：2026-10-08
