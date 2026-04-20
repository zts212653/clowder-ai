---
name: guide-authoring
description: >
  标准引导流程设计 SOP：场景识别 → YAML 编排 → 标签标注 → 注册发现 → 测试验证。
  Use when: 新建引导流程、添加场景引导、维护 Guide Catalog、编写引导 YAML。
  Not for: 使用引导（用户侧）、Guide Engine 代码实现（用 tdd）、视觉设计（用 pencil-design）。
  Output: Flow YAML + tag-manifest 更新 + registry 注册 + CI 校验通过。
triggers:
  - "新建引导"
  - "添加场景引导"
  - "写引导流程"
  - "guide authoring"
  - "引导 YAML"
---

# Guide Authoring

为 Console 已有功能编写引导流程的标准 SOP：场景识别 → YAML 编排 → 标签标注 → 注册发现 → 测试验证。

## When to Use

- 需要为 Console 已有功能新增一条可触发的引导流程
- 需要维护 `guides/flows/*.yaml`、`guides/tag-manifest.yaml`、`guides/registry.yaml`
- 需要给已有功能补引导标签或补 registry 发现规则

**Not for**：
- 用户正在实际使用引导流程时的交互处理，用 `guide-interaction`
- Guide Engine / callback route / overlay 的代码实现与 bug 修复，用 `tdd`
- 纯视觉稿、动效或高保真设计稿，用 `pencil-design`

## 核心知识

| 原则 | 说明 |
|------|------|
| 编排即产品 | Flow YAML 是终态产物，不是脚手架 |
| 页面零侵入 | 只加 `data-guide-id` 标签，不改业务逻辑 |
| 自动推进 | 用户操作即推进，无手动导航按钮（v2 KD-9） |
| 平台内聚焦 | 聚焦 Console 已有功能的引导（KD-13），外部平台配置改为独立页签 |

**前置依赖**：F155 Guide Engine Phase A 已验收。

## 流程

### Step 1: 场景识别

确认需要引导的场景，产出"场景卡片"：

```yaml
# 场景卡片
scene_id: api-provider-setup
scene_name: 配置 API Provider
target_user: 新部署用户 / 需要配置 LLM 的团队
pain_point: Provider 配置字段多，不同 provider 参数差异大
complexity: medium  # low / medium / high
estimated_steps: 4
estimated_time: 3min
related_features: [F155]
```

**判断标准**：
- complexity=high → 必须做引导
- complexity=medium → 评估用户卡点频率再定
- complexity=low → 不做引导，文档即可

### Step 2: 步骤拆分 + YAML 编排

按 v2 自动推进模式编排，4 种 advance mode：

| advance | 用途 | 说明 |
|---------|------|------|
| `click` | 点击目标元素 | 用户点击后自动前进 |
| `visible` | 目标元素出现 | 页面切换/展开后自动前进 |
| `input` | 输入填充 | 用户填写输入框后前进 |
| `confirm` | 操作确认 | 需要 `guide:confirm` 事件触发（如保存成功） |

**Flow YAML 模板**（v2 schema）：

```yaml
id: {scene_id}
name: {scene_name}
description: {一句话描述}

steps:
  - id: step-1
    target: "namespace.element"    # data-guide-id 值
    tips: "点击这里开始配置"       # 引导文案
    advance: click                  # click / visible / input / confirm

  - id: step-2
    target: "namespace.form-field"
    tips: "填写 API 密钥"
    advance: input

  - id: step-final
    target: "namespace.save-button"
    tips: "点击保存完成配置"
    advance: confirm               # 保存成功后 guide:confirm 触发
```

**编排规则**：
- 每个 flow 必须有退出路径（HUD 退出按钮始终可用）
- target 值必须匹配 `data-guide-id`，命名空间式（如 `hub.trigger`）
- target 必须通过 whitelist：`/^[a-zA-Z0-9._-]+$/`
- 最后一步建议用 `confirm` 类型，确保操作真正成功后才完成
- 全局 Esc 键已禁用（KD-14），防止误退出

### Step 3: 元素标签标注

给涉及的前端元素添加 `data-guide-id`：

```tsx
// 命名规则：{页面}.{区域}.{元素}
<button data-guide-id="hub.trigger">Hub</button>
<button data-guide-id="cats.add-member">添加成员</button>
```

**标签命名约定**：
- 用点号分层，语义而非位置
- 避免 CSS class 名、索引号
- 标签一旦被 flow 引用即为契约，删改需走 CI 门禁

**产出**：更新 `guides/tag-manifest.yaml`（CI 用于契约校验）：

```yaml
# guides/tag-manifest.yaml
tags:
  hub.trigger: { page: "/hub", component: "CatCafeHub.tsx" }
  cats.add-member: { page: "/hub/cats", component: "HubCatsTab.tsx" }
```

### Step 4: 注册到 Guide Registry

在 `guides/registry.yaml` 添加场景条目：

```yaml
- id: api-provider-setup
  name: 配置 API Provider
  keywords: [api, provider, 配置, llm, api-key, 模型]
  entry_page: /hub/settings/providers
  estimated_time: 3min
  flow_file: guides/flows/api-provider-setup.yaml
  priority: P1
```

**关键词设计原则**：
- 覆盖中英文同义词
- 包含用户可能的自然表达
- 不要太泛（避免误匹配）

### Step 5: CI 契约测试

确保以下校验全部通过（对应 AC-S3）：
- [ ] Flow schema 合法（step 字段 + advance 类型）
- [ ] 所有 `target` 在 tag-manifest.yaml 中存在
- [ ] 至少有退出路径（HUD 退出按钮 — 引擎内置，无需手动添加）

### Step 6: 端到端验证

1. 启动 dev 环境
2. 在聊天中触发引导（说匹配关键词）
3. 走完全流程：每步高亮正确 → 操作后自动推进 → 完成回调生效
4. 测试异常路径：退出 → 刷新 → 目标元素不存在时的 locating 行为
5. 确认完成后猫猫收到 completion 通知

## Quick Reference

| 要做什么 | 文件 | 说明 |
|---------|------|------|
| 写新引导流程 | `guides/flows/{id}.yaml` | 按 Step 2 模板 |
| 加元素标签 | 前端组件 + `guides/tag-manifest.yaml` | 按 Step 3 命名约定 |
| 注册发现 | `guides/registry.yaml` | 按 Step 4 |
| 验证 | CI gate + 手动 E2E | 按 Step 5-6 |

## Common Mistakes

| 错误 | 后果 | 修复 |
|------|------|------|
| 标签用 CSS class 名 | UI 重构后引导失效 | 用语义命名 |
| 忘记注册 registry | 猫猫查不到引导 | Step 4 不可跳过 |
| 最后一步不用 confirm | 操作未成功就完成 | 涉及保存/提交的最后一步必须 confirm |
| 关键词太泛 | 误匹配其他场景 | 用具体术语 |
| 跳过 E2E 验证 | 线上引导卡死 | Step 6 是发布前必做 |

## 和其他 Skill 的区别

- `feat-lifecycle`：管理 Feature 生命周期 — guide-authoring 是写 **引导流程文档** 的 SOP
- `tdd`：代码的测试驱动 — guide-authoring 是 **YAML 编排** 的质量纪律
- `pencil-design`：出设计稿 — guide-authoring 定义引导 **逻辑和数据**，pencil 出 **视觉效果**

## 下一步

- 引导流程写完 → `tdd` 验证 YAML + 标签
- 验证通过 → `quality-gate` → `request-review`
