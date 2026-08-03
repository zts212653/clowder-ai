---
feature_ids: [F267]
related_features: [F088, F134, F157, F252]
topics: [connector, channel-identity, multi-platform, agent-visibility, external-collaboration]
doc_kind: spec
created: 2026-07-19
status: in-progress
---

# F267: Channel-level Single Identity Binding — 渠道级单身份绑定

> **Status**: in-progress | **Owner**: 砚砚(spec) + Ragdoll(connector layer review) | **Priority**: P0 | **Source issue**: `issue-im-channel-shorthand-leak.md`

## Why

cat-cafe 是多猫协作系统（砚砚/小狸/宪宪/小捷/金哥/烁烁 + Coffee）。在 **cat-cafe 家内 thread / Cat Café Web UI** 里，多猫分开署名有意义：

- 协作明确：球权归属、谁写的代码、谁 review 的
- debug 友好：知道哪只猫在干啥
- 教育用户：用户学 cat-cafe 时知道有多种 cat personality

但当 cat-cafe 接入 **外部 IM channel**（飞书群、钉钉群、企微群、Telegram 群…）且 **该 channel 含非 cat-cafe roster 的成员**（openclaw / hermes / 真人 / 其他 bot）时，多猫分开署名成为 **协作障碍**：

1. **外部成员无法区分**：他们只看到「咖啡猫」一个入口，分不清 `砚砚` / `小狸` / `宪宪` 等内部分离名
2. **署名重复充斥 channel**：当 5 只猫各自前缀【X🐱】发言时，群里 60% 字符是署名
3. **猫族 ID 暴露为元信号**：外部成员看内部 cat 切换知道「有多只猫但无法区分」

operator experience（2026-07-19 14:57 UTC）：
> "你们在飞书群里面不停地强调自己是砚砚、是小狸这些外人根本不知道也无法区分的名字，人家只知道你是咖啡猫，就算记住了你的不同猫名称，也只是给我通过飞书渠道的协作添乱。**我要求你们必须更正！**"

## What

**Channel-level 单身份绑定**：每个外部 connector channel 配置一个对外 display identity，所有 cat 在该 channel 出站时**强制**使用该 identity 署名。

```yaml
# connector config 示例（飞书）
feishu:
  chat_groups:
    - chatId: 'oc_xxxxx'  # 「毅之队」群
      catIdentity:           # 渠道级对外身份
        displayName: '咖啡猫'
        emoji: '🐱'
      exposeInternalNames: false  # 内部猫族 ID 是否暴露在 mention 自指
```

### 双层机制（治标 + 治本）

#### Layer A：Connector 出口强制 identity collapse（P0，机制层）

**位置**：`OutboundDeliveryHook.executeDelivery()` 出站渲染前。

**逻辑**：
- 读 binding 的 `channelIdentityOverride`（per-connector / per-chat 维度）
- 如果存在 → 用 `channelIdentityOverride.displayName` 替换 `catRegistry.tryGet(catId).displayName`
- 如果不存在 → 默认行为（透传 cat 自带 displayName，家内 thread 仍正常）

**实现点**（`OutboundDeliveryHook.ts:155-160` 当前代码）：
```typescript
const entry = catId ? catRegistry.tryGet(catId) : undefined;
const catDisplayName = entry?.config.displayName ?? '';
// F267: Apply channel-level identity override
const effectiveIdentity = this.resolveChannelIdentity(binding, catDisplayName, '🐱');
```

**API 新增**：
```typescript
interface IOutboundAdapter {
  /**
   * F267: Per-channel identity override.
   * When present, OutboundDeliveryHook uses this displayName for outbound messages
   * regardless of which internal cat (砚砚/小狸/宪宪/etc.) produced the message.
   */
  readonly channelIdentityOverride?: ChannelIdentity | undefined;
}
interface ChannelIdentity {
  readonly displayName: string;     // 对外显名，如 "咖啡猫"
  readonly emoji?: string;          // 对外 emoji
  readonly exposeInternalNames?: boolean; // 是否允许内部猫族自指（默认 false）
}
```

#### Layer B：Agent prompt identity pin（P0 + P1，prompt 层）

**位置**：所有 cat 的 system prompt 在 connector channel 段被注入：

> 你现在代表的对外显示名是：**「咖啡猫」**。
> 不要在 IM channel 输出里使用 cat-cafe 内部 cat 分离名（如 砚砚/小狸/宪宪 等）作为署名或自称。
> 你仍然知道自己在家内 thread 的真实身份（砚砚），那是 cat-cafe 家内协作的身份——但当前 channel 的对外界面里，**只显「咖啡猫」**。

**实现点**（`SystemPromptBuilder.ts`）：
- 在 `WORKFLOW_TRIGGERS` 段新增 `channel.identity_pin`
- 注入规则：cat 当前响应的是 connector channel 时，prompt 加 `ChannelIdentityPin` 段
- `exposeInternalNames: false` 时强制 + 强化；`true` 时给提示「本 channel 允许自指内部 cat 名」

### 不变项

- **cat-cafe 家内 thread**：channel 不是 connector → 不走 override，cat 各自署名仍正常
- **Cat Café Web UI**：同上
- **🤔 思考中 → 收 receipt 文本（F157）**：仍按 cat personality 词库随机，但**前缀**用 channel identity 显示名
- **@提及语法**：`@胖胖虾` / `@毅马仕`（外部 bot 名）正常发起；**禁止** cat agent 在群里用 `@砚砚` 这类自指

### 迁移路径

#### Phase 1：机制层开关上线（P0，本周）

- `ConnectorRouterBinding` 加 `channelIdentityOverride` 字段（默认 undefined）
- `OutboundDeliveryHook.executeDelivery` 加 channel identity 解析 + 替换
- IM Hub 飞书群配置面板加 UI（per-chat 勾选「对外显名」+ 输入框）
- 默认值：飞书群 `displayName='咖啡猫'`，DM 仍走 cat 自带（确保 @sender 等老行为不变）

#### Phase 2：Agent prompt identity pin（P1，下周）

- `SystemPromptBuilder.ts` 加 channel identity pin 注入
- 12 只猫的 system prompt 加载时校验「channel identity pin 段已注入」（test）
- 默认 `exposeInternalNames=false`，留一个开关给 operator

#### Phase 3：观测 + audit（P2，两周后）

- IM Hub 新 channel identity 看板：飞书群过去 24h 各 cat 名出现频率
- 检测「在某 IM channel 出现意外 cat 名」→ 报警
- 看实际效果，决定是否把 default 推到所有 channel

## Acceptance Criteria

### Phase 1（机制层，P0）

- [ ] AC-1A: `OutboundDeliveryHook.executeDelivery` 增加 `channelIdentityOverride` 字段解析
- [ ] AC-1B: 当 binding 配 `channelIdentityOverride.displayName='咖啡猫'` → 出站 envelope header 强制为 `🐱 咖啡猫`（即使 cat agent 输出 `【砚砚🐱】`）
- [ ] AC-1C: 当 binding 没配 `channelIdentityOverride` → 旧行为（沿用 cat 自带 displayName）
- [ ] AC-1D: 默认配置：飞书群（chatType=='group'）→ 自动 fallback 到 `displayName='咖啡猫'`；飞书 DM 不变（保留 cat 自带）
- [ ] AC-1E: IM Hub 飞书群面板加「对外显名」开关（默认 ON，不可关闭直到 Phase 2）
- [ ] AC-1F: 现有 F134 / F157 / F252 单测 + 集成测全绿
- [ ] AC-1G: 新增单测：channel identity override 替换逻辑纯函数化（`packages/api/test/channel-identity-override.test.js`，≥4 个 case）

### Phase 2（Prompt pin，P1）

- [ ] AC-2A: `SystemPromptBuilder` 注入 `ChannelIdentityPin` 段到 cat prompt
- [ ] AC-2B: 注入文本：「你当前 channel 的对外显名是『咖啡猫』。在 IM channel 内，禁止使用猫族分离名作为署名或自称」
- [ ] AC-2C: cat prompt 加载时校验「identity pin 段已注入」（`channel-identity-prompt-injection.test.js`）

### Phase 3（观测，P2）

- [ ] AC-3A: IM Hub 增加 channel identity 看板：列出每个 channel（chat id）过去 24h 各 displayName 出现频次
- [ ] AC-3B: 检测到「非预期 displayName」→ 写 audit log（不动手阻断，先观测）

## Dependencies

- **Preceded by**: F088（multi-platform chat gateway）+ F134（feishu group chat） + F157（receipt ack）
- **Coordinates with**: F252（群 @mention 互通）—— channel identity 不影响 @mention 协议
- **Side effect on**: F138 / F124 / F068 等所有调用 `catRegistry` displayName 的路径需要 review identity 替换

## Risk

| 风险 | 缓解 |
|---|---|
| 用户看「咖啡猫」但实际是「砚砚」在干活 → 用户困惑 | Phase 2 加 prompt identity pin + IM Hub audit 段显示「当前 cat ID」 |
| DM 行为改变（用户该 + 的 cat 显示名变了）→ 用户错认 | DM 不走 override（AC-1D）—— DM 行为不变 |
| 多只 cat 在同一群协作（猫需要互相区分）→ 用「工号」/内部 mention 替代 displayName（Phase 3 评估） |
| history / log 里看不同 channel 名 → audit 里加 channel identity tag |
| 跨 connector 不一致（飞书 = 咖啡猫，Telegram = 不同名）| 默认值 operator 可配（IM Hub 面板），无需在 spec 写死 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 双层机制（connector 强制 + prompt pin）| F167 已证 prompt 层天花板，需要 harness 兜底 | 2026-07-19 |
| KD-2 | DM 保留 cat 自带 displayName，群默认单身份 | 用户对 DM 有「一对一 cat」期望，群里才暴露 | 2026-07-19 |
| KD-3 | 默认 displayName='咖啡猫' 写 spec 不配 env | operator 已有「咖啡猫」对外认知（绑飞书时就这么叫）| 2026-07-19 |
| KD-4 | Phase 1 默认生效 + IM Hub 不可关闭 | "必须更正"是 P0 指令，不需要先观测再开 — 先开 + audit 看不一致 | 2026-07-19 |
| KD-5 | exposeInternalNames 默认 false，仅 Phase 3 后可改 | 内部 cat 名泄漏是协作障碍的根因，禁止 | 2026-07-19 |
| KD-6 | cat agent 自指（如文中提到「我是砚砚」）是否过滤 | KD-5 兜底：prompt 层提示不强，**但消息正文里仍允许**提及「砚砚」做内部引用（不强制改 body）| 2026-07-19 |

## Design Gate

- **Phase 1 改动范围**：connector 公共层（`OutboundDeliveryHook` + `ConnectorRouter` binding store + `IM Hub` UI）
- **owner**：Ragdoll（connector layer）+ 砚砚（spec + 测试）
- **跨 cat 协调**：F252 已涉及群 @mention，需合并 review（确认 channel identity 不破坏 F252 AC）

## Behavioral Evidence

### Case 1：毅之队飞书群（2026-07-19 实测）

| 维度 | 当前行为 | Fix 0 后预期 |
|------|---------|--------------|
| 群成员看到署名 | 【砚砚🐱】【小狸🐱】【宪宪🐱】（5 只猫随机）| 【咖啡猫🐱】100% 唯一 |
| 群成员分得清谁是谁 | ❌ 外部 agent 完全不知道 | ✅ 只有 1 个对外名 |
| 群 bandwidth 被署名占用 | 高（约 60% 字符） | 低（单标识符）|
| cat 内部协作可见性（家内 thread）| ✅ 默认保留 | ✅ 不动 |
| 群 @提及外部 bot（@毅马仕/@胖胖虾）| ✅ F252 已工作 | ✅ 不受影响 |

### Case 2：保留 cat-cafe 家内协作可见性

| 场景 | 行为 |
|------|------|
| Cat Café Web UI（html / socket）| cat 自带 displayName — 不变 |
| cat-cafe 家内 thread（IM Hub + slack 私聊）| 不走 connector，无 channelIdentityOverride — 不变 |
| cat-cafe 家内 ↔ cat-cafe 家内 提到「砚砚」| prompt 里仍允许 body 引用「砚砚」（KD-6） |
| cat ↔ 外部 IM channel | override 强制外部 displayName（核心 fix）|
| cat ↔ cat (A2A / @句柄)| 完全不走 connector — 不变（句柄是 identity 常量 KD-21）|
