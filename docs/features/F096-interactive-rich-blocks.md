---
feature_ids: [F096]
related_features: [F087, F022]
topics: [rich-blocks, interactive, frontend, ux]
doc_kind: spec
created: 2026-03-11
---

# F096: Interactive Rich Blocks — 可交互富文本组件

> **Status**: done | **Owner**: Ragdoll | **Completed**: 2026-03-13
> **Priority**: P1 | **Evolved from**: F022（Rich Block 基础架构） | **Related**: F087（猫猫训练营）

## Why

当前 Rich Block 系统有 5 种 kind（card/diff/checklist/media_gallery/audio），全部是**只读展示**。很多场景需要用户在富文本中直接操作——选方案、勾选项、点按钮——而不是手动打字。

### team experience（2026-03-11）

> "我们能做成可交互的富文本！Claude Code 有那个啊！你弹出一个东西让我选和 ☑️！我们按道理有前端！难道不能吗？这样的富文本别的地方还能用？！"

### 核心动机

Cat Café 有完整的 Web 前端，交互能力远超 CLI。可交互 Rich Block 是**通用基础设施**，不只服务 F087 训练营，还能用于 CVO 决策、Review 投票、确认操作等所有需要用户选择的场景。

## What

在现有 Rich Block 架构上新增 `interactive` kind，支持用户在富文本中做选择/操作，结果自动转为聊天消息发出。

### 设计原则

1. **交互结果 = 自动发一条消息**：前端把用户选择注入 ChatInput 并自动发送。后端猫猫收到的就是普通文字，**零后端改动**
2. **渐进增强**：不支持交互的客户端（未来 CLI/API）降级为纯文本展示
3. **通用复用**：不为 F087 定制，所有场景都能用

### Interactive Types

| interactiveType | 说明 | 用户操作 | 自动发送的消息示例 |
|-----------------|------|---------|-------------------|
| `select` | 单选列表 | 点选项 → 确认（`customInput` 时先输入） | "我选了：方案 A" / "其他：我的想法" |
| `multi-select` | 多选列表 | 勾选多个 → 确认 | "我选了：Node.js, pnpm" |
| `card-grid` | 卡片网格 | 点卡片或随机抽 → 确认 | "我选了：猫猫盲盒" |
| `confirm` | 确认/取消 | 点按钮 | "确认" / "取消" |

### 数据结构

```typescript
// packages/shared/src/types/rich.ts 新增

interface RichInteractiveBlock extends RichBlockBase {
  kind: 'interactive';
  interactiveType: 'select' | 'multi-select' | 'card-grid' | 'confirm';
  title?: string;
  description?: string;
  options: InteractiveOption[];
  maxSelect?: number;          // multi-select 时限制最大选择数
  allowRandom?: boolean;       // card-grid 显示"随机抽"按钮
  messageTemplate?: string;    // 自定义发送消息模板，{selection} 占位符
  disabled?: boolean;          // 已交互后禁用
  selectedIds?: string[];      // 已选择的 option IDs（回显用）
  groupId?: string;            // Phase C: 同 groupId 的 block 统一提交
}

interface InteractiveOption {
  id: string;
  label: string;
  emoji?: string;
  icon?: string;               // café SVG 图标名，优先于 emoji
  description?: string;
  level?: number;              // card-grid 分组用（难度等级）
  group?: string;              // 分组标题
  customInput?: boolean;       // 选中后展开自由输入框
  customInputPlaceholder?: string;
}
```

### 前端交互流程

```
猫猫发送含 interactive block 的消息
  → 前端渲染对应的交互组件（按钮/卡片/checkbox）
  → 用户点击选择
  → 前端组装消息文本（使用 messageTemplate 或默认模板）
  → 自动填入 ChatInput 并发送
  → Block 状态更新为 disabled + 回显 selectedIds
  → 猫猫收到普通文字消息，正常处理
```

### 复用场景

| 场景 | interactiveType | 来源 Feature |
|------|----------------|-------------|
| 训练营选引导猫 | `card-grid` | F087 |
| 训练营选任务 | `card-grid` + `allowRandom` | F087 |
| CVO 拍板方案 | `select` | 通用 |
| 环境检测确认 | `confirm` | F087 |
| Review 多选标记 | `multi-select` | 通用 |
| 危险操作确认 | `confirm` | 通用 |

## Acceptance Criteria

### Phase A（核心交互框架） ✅

- [x] AC-A1: `RichBlockKind` 新增 `'interactive'`，类型定义含 4 种 interactiveType
- [x] AC-A2: 前端 `InteractiveBlock.tsx` 渲染器，支持 select / multi-select / card-grid / confirm
- [x] AC-A3: 用户选择后自动发送消息（填入 ChatInput + submit）
- [x] AC-A4: 交互完成后 block 变为 disabled 状态 + 回显已选
- [x] AC-A5: `cat_cafe_create_rich_block` MCP 工具支持 `kind: 'interactive'`
- [x] AC-A6: 后端 Zod 校验支持 interactive block schema
- [x] AC-A7: card-grid 的 `allowRandom` 实现随机选择动画

### Phase B（渐进增强） ✅

- [x] AC-B1: 非交互客户端降级为纯文本展示（option 列表 + "请输入编号选择"）
- [x] AC-B2: Rich Block Rules 文档更新，猫猫知道怎么用 interactive block

### Phase C（表单组：多 block 统一提交） ✅

- [x] AC-C1: `RichInteractiveBlock` 新增可选 `groupId` 字段，同 groupId 的 block 归为一组
- [x] AC-C2: 同组 block 选择后不立刻发消息，只更新本地选中状态
- [x] AC-C3: 同组最后一个 block 下方显示"全部提交"按钮（所有 block 都有选择后才可点）
- [x] AC-C4: 提交时汇总所有 block 的选择，发一条合并消息
- [x] AC-C5: 提交后同组所有 block 同时变 disabled + 持久化
- [x] AC-C6: 无 `groupId` 的 block 保持现有行为（独立提交）

## Dependencies

- **Evolved from**: F022（Rich Block 基础架构）
- **Blocked by**: 无（现有 Rich Block 架构已就绪）
- **Related**: F087（猫猫训练营，首个重度使用者）

## Risk

| 风险 | 缓解 |
|------|------|
| 前端交互与 ChatInput 耦合 | 通过事件系统解耦，不直接操作 DOM |
| 用户快速连点导致重复发送 | disabled 状态 + debounce |
| Block 渲染闪烁（WebSocket 推送时） | 沿用现有 RichBlockBuffer 去重机制 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 交互结果 = 自动发消息，后端零改动 | 最小侵入，猫猫无需特殊处理 | 2026-03-11 |
| KD-2 | 4 种 interactiveType 覆盖主要场景 | select/multi-select/card-grid/confirm 足够通用 | 2026-03-11 |
| KD-3 | 交互后 block 变 disabled | 防止重复操作，保留选择记录 | 2026-03-11 |
| KD-4 | 持久化到 `message.extra.rich`（PATCH endpoint） | 终态基座，刷新不丢状态（P1：每步产物是终态） | 2026-03-11 |
| KD-5 | 随机选择用闪烁高亮减速动画（CSS + setInterval） | 有期待感，纯前端实现无需额外库 | 2026-03-11 |
| KD-6 | 同组 block 用 `groupId` 统一提交，无 groupId 保持独立 | team lead反馈：一次发 N 个问题应全选完一起提交 | 2026-03-11 |

## Review Gate

- Phase A: @codex

## 需求点 Checklist

| ID | 需求点（team experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | "弹出一个东西让我选和☑️" | AC-A2, AC-A3 | test + screenshot | [x] |
| R2 | "别的地方还能用" — 通用组件 | AC-A1~A6 | 多场景 test | [x] |
| R3 | F087 训练营选任务需要 card-grid | AC-A2, AC-A7 | F087 集成测试 | [x] |
| R4 | 随机抽功能 | AC-A7 | manual + screenshot | [x] |
| R5 | "都选完一起提交" — 多 block 统一提交 | AC-C1~C6 | test + manual | [x] |

## Post-ship Bugs / Lessons

| # | 问题 | 根因 | 修复 | 教训 |
|---|------|------|------|------|
| B1 | select 点击立刻发送，误点无法撤回 | SelectInteraction 的 `onSelect` 直接触发 `handleSelect`（发消息+disable） | 加 `pendingId` 状态 + "确认选择"按钮，点选项只高亮不发送 | 单选也需要确认步骤——用户点错了没有回头路，UX 基本功 |
| B2 | confirm 发出的消息只有"取消"，多 block 时无法区分回答的是哪个问题 | `buildSelectionMessage` 的 confirm 分支硬编码返回 `'确认'`/`'取消'`，不带 block title | 加 `title` 参数，无 messageTemplate 时自动拼上：`"取消 — 确认部署到生产环境？"` | 消息必须自带上下文——异步对话中 "是/否" 没有意义，必须说清楚"对什么说是/否" |
| B3 | customInput 在中文输入法下回车误提交，且文本可能丢失 | 缺少 IME `isComposing` 守卫 + 父子组件同 tick 闭包读取旧值 | 补 `isComposing` 守卫；提交链改为 ref/实时同步，保证拿到最新文本 | 文本输入场景必须单独检查 IME 和 React 闭包，不能只测英文键盘路径 |
| B4 | `create_rich_block` 实时富块挂错气泡，callback 消息会粘连到旧 bubble | rich_block 无 `messageId` 时前端错误回退到 stream bubble；done 后 stale `invocationId` 未清理 | `useAgentMessages` 优先关联最近 callback 消息；done 时清空 stale `invocationId` | 富块渲染和消息气泡边界是同一条实时链路，必须一起测 |
| B5 | 分组提交早期版本对 `customInput`、badge 计数、card-grid 确认链路处理不完整 | group 模式下 customText 通道、badge state 和 card-grid 两步确认最初没一起设计完 | 补全 `InteractiveBlockGroup` customTexts 通道、实时同步/清空逻辑、badge 归零、card-grid 确认步骤 | 多 block 表单不是“单块逻辑乘 N”，必须以整组交互链路做 review 和测试 |

### 覆盖检查
- [x] 每个需求点都能映射到至少一个 AC
- [x] 每个 AC 都有验证方式
- [x] 前端需求已准备需求→证据映射表（若适用）
