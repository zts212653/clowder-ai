---
feature_ids: [F150]
topics: [guidance-engine, ux, security, architecture]
doc_kind: discussion
created: 2026-03-27
---

# F150 场景引导引擎 讨论纪要

**日期**: 2026-03-27 | **参与者**: 布偶猫/宪宪(opus)、缅因猫/砚砚(gpt52)、暹罗猫/烁烁(gemini25)、铲屎官

## 背景

铲屎官提出：Console 功能日益复杂，但入口简单，需要一套场景化引导系统。核心诉求：
1. 页面元素加标签，通过编排文档控制引导流程，新增场景不改代码
2. 用户通过与猫猫对话自然触发引导
3. 复杂外部流程（如飞书对接）也纳入引导体系
4. **猫猫能实时观测用户操作状态**，免截图，能主动诊断问题

## 各方观点

### 布偶猫/宪宪（架构）
- 四层解耦架构：Element Tags → Guide Catalog (YAML) → Guide Engine (Frontend) → MCP Tools
- 命名空间式标签 `data-guide-id="settings.auth.add-provider"`
- 六种步骤类型：console_action / external_instruction / collect_input / verification / branch / information
- 双向可观测模型：Guide Engine 实时上报字段状态 + 用户行为 → 猫猫感知
- Guide Engine 自治为主 + 猫猫接管为辅
- 新增 `guide-authoring` Cat Cafe skill

### 缅因猫/砚砚（安全 + 可测性）
- 三条安全门禁 AC-S1/S2/S3（见共识区）
- 现有代码基础：Hub 深链、HubAddMemberWizard、事件管道已有，不是绿地项目
- CI 契约测试：tag 存在性 + flow schema + auto_fill_from 校验 + verifier 注册
- `observe.fields` 对 sensitive 字段只上报 `{filled, valid}`，禁止侧信道泄漏

### 暹罗猫/烁烁（视觉 + UX）
- 聚光灯遮罩：柔和边缘 + 猫咖橙呼吸灯
- 内外步骤视觉区分：猫咖橙(内部) vs 深空灰+外部Logo(外部)
- 沉浸式 collect_input：非模态 inline form，磁吸感呼吸效果
- 视觉状态机：猫眼观测指示灯（正确→眯眼绿勾，错误→圆眼警示，停滞→晃动求助）
- 跨系统胶囊 HUD：`[控制台]──[飞书]` 双端状态指示
- 心跳验证：Webhook 握手成功 → HUD 闪橙 + 动效反馈
- auto_fill_from "数据飞入" 微动效

## 共识

### 架构共识
1. **数据驱动**：Flow YAML 编排，新场景 = 写文档 + 打标签 + 截图，不改业务代码
2. **稳定标签**：`data-guide-id` 命名空间式，语义而非位置
3. **六种步骤类型**：覆盖内部操作、外部指引、数据收集、自动验证、条件分支、纯信息
4. **双向可观测**：猫猫实时感知用户状态，主动诊断，免截图
5. **三层触发**：对话触发(主) + 主动发现 + 目录浏览
6. **Guide Engine 自治为主**：标准流程 Engine 跑，用户卡住时猫猫接管

### 安全共识（P0 硬门禁）
- **AC-S1: Sensitive Data Containment** — sensitive 值仅服务端持有，前端只拿 secretRef，刷新后强制重填，observe 不上报长度/前缀
- **AC-S2: Verifier Permission Boundary** — 只允许 verifierId 引用，sideEffect=true 必须 confirm:required，带 thread/user scope guard
- **AC-S3: CI Contract Gate** — flow schema 合法性 + tag 存在性 + auto_fill_from 校验 + verifier 注册校验 + skip_if 限声明式 DSL + 退出路径

### UX 共识
- 内外步骤用色彩/图标/HUD 位置区分
- collect_input 为非模态 inline form
- 视觉状态机反映观测状态
- verification 失败显示视觉自检清单（基于错误码）

### 已拍板的决策
1. `collect_input` 敏感值刷新后**不恢复**，强制重填
2. 有副作用的 verification 按配置 `confirm: required | auto`，CI 校验 sideEffect→confirm 规则
3. P0 `skip_if` 限声明式比较（eq/in/exists/gt/lt），禁止表达式

## 分歧

**无实质分歧。** 三猫从架构/安全/UX 三个维度互补，方向一致。

## 否决方案

| 方案 | 否决理由 |
|------|---------|
| Route 1: 纯前端硬编码引导 | 每加场景都改代码，维护成本高，违背"编排文档驱动"原则 |
| Route 2: 纯 MCP 动态生成步骤 | 可控性差，DOM 漂移风险，无法做 CI 契约测试 |

## 行动项

| # | 行动 | 负责 | 依赖 |
|---|------|------|------|
| 1 | 立项 F150，写 feature 文档（含安全 AC + 视觉 AC） | 布偶猫/宪宪 | 铲屎官确认 |
| 2 | AC-S1/S2/S3 测试矩阵草案 | 缅因猫/砚砚 | F150 文档就绪 |
| 3 | 内外步骤视觉区分 + 非模态 collect_input 概念稿 | 暹罗猫/烁烁 | F150 文档就绪 |
| 4 | P0 场景编排：添加成员(纯内部) + 飞书对接(跨系统) | TBD | 设计稿 + 安全 AC 就绪 |

## 收敛检查

1. 否决理由 → ADR？**有** → 否决 Route 1 (硬编码) 和 Route 2 (纯动态)，理由记录在本纪要"否决方案"段。待立项后迁入 feature 文档 ADR 段。
2. 踩坑教训 → lessons-learned？**没有** — 本次是新功能设计讨论，无踩坑。
3. 操作规则 → 指引文件？**没有** — 安全规则 (AC-S1/S2/S3) 是 feature-specific AC，不是全局操作规则。
