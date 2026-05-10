---
name: console-dev
description: >
  Console 前端交付范式：4 道门禁驱动的前端开发流程。
  Use when: 开发/修改前端页面、组件、样式；修复 UI 不一致；新增页面或重构布局。
  Not for: 纯后端 API 开发、纯计算逻辑重构（不触及 UI state/form/auth/navigation）、独立 Design System token 定义（那是设计文档的事）。
  Output: 通过 4-gate 验证的前端代码 + 视觉自检证据。
triggers:
  - "写前端"
  - "改页面"
  - "UI 开发"
  - "console-dev"
  - "前端范式"
not_for:
  - "纯后端 API"
  - "纯计算逻辑（不触及 UI state/form/auth/navigation）"
  - "设计 token 定义"
---

# Console-Dev：前端交付范式

可复用的前端开发门禁流程。不绑定具体项目、框架或 Design System——聚焦**决策逻辑和质量边界**。

## 4-Gate 流程

```
Product Gate → Design-System Gate → Implementation Gate → Verification Gate
     ↑                                                          │
     └──── 任何 gate 不过 → 回退到对应 gate 修复 ────────────────┘
```

---

## Gate 1: Product Gate — 先定用户路径

**核心问题**：这个功能的入口在哪？用户怎么到达它？

### 入口层级决策树

```
新功能上线：
├─ 用户每天用？ → L1 主导航（极慎重，通常 ≤5 个）
├─ 管理/配置？ → L2 设置分区
├─ 只读/分析？ → L3 设置子 tab
└─ 特殊场景？ → L4 独立路由
```

### 状态矩阵（State Matrix）

功能涉及的每个视图，列出所有可能状态：

| 维度 | 必须覆盖的状态 |
|------|--------------|
| 数据 | loading / empty / partial / full / error |
| 权限 | owner / member / guest / unauthenticated |
| 交互 | default / hover / active / disabled / focus |
| 响应 | desktop / tablet / mobile |

**不画状态矩阵不开工**——happy path 以外的状态是 bug 的温床。

---

## Gate 2: Design-System Gate — Token First

**核心问题**：所有视觉属性是否走 design token？

### 规则

1. **新代码**：hardcoded 颜色/间距/圆角 = lint error，不例外
2. **旧代码迁移**：允许 lint override，但必须是**债务清单**（有文件名、有消化排期），不是永久豁免
3. **Token 命名分层**：`semantic > component > primitive`
   - Primitive: `--color-brown-500`（不直接用）
   - Semantic: `--accent`, `--surface`, `--text-muted`
   - Component: `--card-bg`, `--modal-close-fg`（仅组件内部）
4. **组件模式复用**：同类 UI（表单、列表、弹窗）先查已有 primitive，有则复用，无则抽象后再写

---

## Gate 3: Implementation Gate — 拆分与安全

**核心问题**：代码能被下一个人读懂和安全修改吗？

### 组件拆分

- **200 行**：触发拆分审查（"这个文件是否能拆？"）
- **350 行**：默认必须拆，除非有明确结构理由
- 拆分方向：sub-component（视觉独立块），不是 utils（逻辑碎片）
- 优先拆**可独立测试/复用**的块

### 表单范式

先定义 layout primitive（Section → Item → Input），再组合。不要每个表单从 div 开始重写。

### 安全值边界

- 敏感值（API key / token / password）**只显示不回写**
- 前端展示用 redacted placeholder（如 `••••••`）
- **确定策略（不允许"或"）**：
  - 编辑已有记录时：未改动的 redacted 字段从 submit payload 中 **omit**（不发送）
  - 用户显式输入了 redacted marker 字符串 → **block submit** + 提示用户
  - 后端必须做**二次校验**：收到 redacted marker → 拒绝写入
- 永远不要让 display value 成为 draft value 的初始值（如果它是脱敏的）

### 渐进迁移策略

引入新规范时：
1. 新代码即时强制（lint error）
2. 旧代码列入 override 清单（文件粒度，非目录）
3. 清单有消化排期（每 sprint 消化 N 个文件）
4. 清单 size 只减不增——新文件违规 = PR 退回

---

## Gate 4: Verification Gate — 证据驱动

**核心问题**：类型过了 ≠ UI 没坏。你亲眼看了吗？

### 必须验证

1. **Golden path**：核心流程走通
2. **State matrix 抽样**：至少覆盖 empty / error / disabled 各一个
3. **Sibling regression**：改了共享 primitive → 抽样验证兄弟页面
4. **Modal checklist**：footer 不重复、滚动容器对、sticky action 在、移动端不溢出
5. **暗色模式**：如果项目支持，必须切换验证

### 证据形式

- 截图 / GIF（关键状态）
- 浏览器 console 无新 warning
- lint + type check 全绿

---

## 常见失败模式（Anti-Patterns）

| 模式 | 症状 | 对策 |
|------|------|------|
| State matrix blindness | 只做 happy path，上线后空态/错误态全裸 | Gate 1 强制画矩阵 |
| Modal lifecycle drift | footer 重复、高度溢出、sticky 丢失 | Gate 4 modal checklist |
| Display/Submit 混淆 | redacted 值被当真值提交回服务器 | Gate 3 安全值边界 |
| Shared primitive 回归 | 改一个 FormItem，十个页面样式崩 | Gate 4 sibling regression |
| Migration 无边界 | override 清单只增不减，变成永久豁免 | Gate 3 清单 size 只减不增 |
| 入口膨胀 | 每个功能都想占 L1 位置 | Gate 1 层级决策树 |

---

## 与其他 Skill 的关系

- **pencil-design**：产出设计稿 → 本 skill 的 Gate 2 输入
- **quality-gate**：本 skill 的 Gate 4 是 quality-gate 的前端子集
- **tdd**：逻辑测试由 tdd 覆盖，本 skill 补视觉验证
- **Design System 文档**（如 `console-design-system.md`）：具体 token 值/组件样式的真相源，本 skill 不重复

## 参考

- `refs/f190-frontend-lessons.md` — F190 Console 重构中的具体案例
