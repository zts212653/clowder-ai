---
feature_ids: [F171, F155]
topics: [onboarding, issue-1466, redesign, task-driven]
doc_kind: design_proposal
created: 2026-10-09
status: historical-superseded
---

# 首启旅程重新设计（基于真实任务驱动）

> 2026-10-10：本文保留为历史讨论，实施规格已由 [#1466 最终意见收敛方案](../plans/issue-1466-final-implementation-plan.md) 替代（新方案待用户审核）。下述“先配置后演示”“自动创建成员”“未登录仅文字指引”不能继续作为施工依据。按 zts 最终意见保留原 issue 演示范围、必要登录引导及推荐成员清单的用户确认；真实入口仍是 FirstRunQuestWizard，不把未挂载的 OnboardingJourney 当作已交付。

> 基于 2026-10-09 与 co-creator 讨论和 @codex 审查反馈

## 背景

**原设计问题**：
- 过于抽象：用户还没有 agent 时先看演示动画
- 顺序颠倒：应该先"用起来"再"理解原理"
- 脱离实际：演示场景与用户即将做的事情无关

**新设计原则**：
1. **先配置，后理解**：快速让用户能用
2. **真实任务驱动**：在真实任务中看到协作
3. **根据实际成员数量分支**：1 个 vs 多个 agent 不同体验

## 新的用户旅程

### Phase 1: 快速配置（让用户"能用"）

**Step 1: 检测 CLI 工具**
- 自动探测本机已安装的 CLI
- 显示已认证的工具
- 未认证的显示文本指引（不拉起登录）

**Step 2: 创建成员**
- 根据检测结果自动创建成员
- 最小化用户选择（自动配置）
- 处理部分失败情况

**关键改进**：
- 0 个可用 CLI：引导安装
- 1 个可用 CLI：自动配置，最快 2-3 次点击完成
- 多个可用 CLI：允许选择，但默认全选

### Phase 2: 第一次真实任务（让用户"理解"）

**根据实际创建成功的成员数量分支**：

#### 分支 A：单成员场景（1 个成员）
**预设任务模板**（自带完整上下文）：
```javascript
[
  {
    title: "生成项目 README",
    context: "项目名称：TaskFlow\n功能：任务管理和协作工具\n技术栈：React + Node.js",
    prompt: "根据以上信息，生成一个专业的 README.md，包含项目介绍、安装步骤、使用说明"
  },
  {
    title: "代码审查建议",
    context: "```javascript\nfunction getData(url) {\n  fetch(url).then(res => res.json()).then(data => console.log(data));\n}\n```",
    prompt: "审查以上代码，指出潜在问题并给出改进建议"
  }
]
```

**展示重点**：
- agent 理解任务的能力
- 响应质量
- 提示："你可以随时添加更多成员来体验协作"

#### 分支 B：多成员场景（2+ 个成员）
**预设任务模板**（需要协作）：
```javascript
[
  {
    title: "设计并实现登录页",
    context: "需求：用户登录页面\n要求：简洁美观、支持邮箱和第三方登录\n品牌色：#4A90E2",
    prompt: "@设计猫 先设计登录页 UI，然后 @开发猫 实现代码",
    requiresCollaboration: true
  },
  {
    title: "审查并优化代码",
    context: "```python\ndef process_data(data):\n    result = []\n    for i in range(len(data)):\n        result.append(data[i] * 2)\n    return result\n```",
    prompt: "@审查猫 先审查代码问题，@开发猫 根据建议优化实现",
    requiresCollaboration: true
  }
]
```

**展示重点**：
- 真实的传球过程（@mention → 接球 → 协作）
- 协作带来的质量提升
- 高亮关键协作点

### Phase 3: 完成后引导

**完成状态**：
- 任务实际完成后（不是发送成功就算完成）
- 展示结果摘要

**引导选项**：
- "查看完整对话" → 跳转到真实 thread
- "开始使用" → 进入主界面
- "了解更多协作技巧" → 可选的深度教程

## 实现要点

### 1. 成员数量判断

```typescript
// 必须基于实际创建成功的成员
const createdMembers = await createMembers(selectedClients);
const successCount = createdMembers.filter(m => m.success).length;

if (successCount === 0) {
  // 回到安装/登录恢复
} else if (successCount === 1) {
  // 单成员流程
} else {
  // 多成员协作流程
}
```

### 2. 预设任务实现

```typescript
interface TaskTemplate {
  title: string;
  context: string; // 自带的完整上下文
  prompt: string; // 实际发送的消息
  requiresCollaboration: boolean;
  estimatedDuration?: string; // 预估时间
}

// 用户点击模板后：
// 1. 填入 ChatInput（可编辑）
// 2. 用户确认发送
// 3. 显示真实执行状态
```

### 3. 真实状态展示

```typescript
interface TaskExecutionState {
  status: 'executing' | 'completed' | 'failed' | 'cancelled';
  currentAgent: string; // 当前执行的 agent
  handoffs: Array<{ from: string; to: string; timestamp: number }>; // 真实传球记录
  result?: string;
  error?: string;
}
```

### 4. 集成到 FirstRunQuestWizard

**不创建独立路径**，而是：
- 复用 ClientStep 的探测逻辑
- 复用 ConfigStep 的账号绑定
- 移除冗余的演示步骤
- 添加任务模板选择和执行展示

## 验收标准

### 功能验收
- [ ] 0/1/多成员分支正确
- [ ] 预设任务带完整上下文可直接执行
- [ ] 真实任务执行状态展示
- [ ] 部分创建失败恢复
- [ ] 发送失败重试
- [ ] 完成后正确跳转

### 体验验收
- [ ] 单 CLI 已登录：2-3 次点击到第一次任务
- [ ] 演示可跳过，不强制观看
- [ ] 任务执行中可随时进入对话
- [ ] 完成后自然过渡到正常使用

### 技术验收
- [ ] TypeScript 编译通过
- [ ] 测试覆盖核心场景
- [ ] 真实 A2A 协议，不是模拟

## 下一步

1. 更新 Issue #1466 反映新设计
2. 实现预设任务模板
3. 实现成员数量分支逻辑
4. 集成到 FirstRunQuestWizard
5. 添加真实任务执行状态展示
6. 补充完整测试
