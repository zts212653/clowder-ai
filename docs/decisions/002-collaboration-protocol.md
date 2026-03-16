---
feature_ids: []
topics: [collaboration, protocol]
doc_kind: decision
created: 2026-02-26
---

# ADR-002: Why-First 协作协议

## 状态
已决定

## 日期
2026-02-06

## 背景

Cat Café 的核心目标是让三只猫脱离“人肉路由”模式，形成可持续协作。  
过去在交接和传话中，容易只记录“改了什么”，缺少“为什么这样改”，导致：

1. 接手方无法快速判断决策是否合理
2. Open questions 被隐含，风险延后暴露
3. 历史回溯时难以定位“是谁基于什么约束做了什么决策”

## 决策

采用系统级协作协议：`Why-First + Open Questions + Signed Commits`。

### 1. 交接与传话格式（强制）

无论是任务交接、review 请求、计划变更、还是跨猫转述，必须包含：

1. `What`：具体改动或决策
2. `Why`：约束、目标、风险驱动
3. `Tradeoff`：放弃了哪些备选方案
4. `Open Questions`：尚未确定、需要谁回答
5. `Next Action`：接手方下一步动作

### 2. 不确定就提问（强制）

任何关键前提不确定时，必须主动提问，不允许硬猜推进。  
提问对象包括铲屎官、Ragdoll、Maine Coon、Siamese。

### 3. 每个可验证子任务都要 commit（强制）

每完成一个可验证子任务，必须提交 commit。  
commit message 需带猫猫签名，便于追溯责任与意图。

示例：
- `feat(api): add mcp callback registry [Ragdoll🐾]`
- `fix(api): handle cli non-zero exit [Maine Coon🐾]`
- `feat(web): add sticker panel v1 [Siamese🐾]`

建议在 commit body 增加 `Why:` 一行，记录关键决策理由。

### 4. 验证结果必须标注执行环境（强制）

凡是测试、服务启动、端口绑定、外网请求等与执行环境相关的验证，交接时必须写清：

1. 运行环境：`sandbox` / `full access` / 本机直跑
2. 失败归因：代码缺陷 vs 环境权限限制
3. 复现方式：若需更高权限，给出最小复现命令

示例：
- `security-boundary.test.js` 在 sandbox 可能因 `EPERM` 无法绑定 `127.0.0.1`，需在 full access 复验。

## 影响

### 正面影响

1. 交接质量提升，接手成本下降
2. 决策可审计，可回滚，可复盘
3. Open questions 显性化，减少隐性返工
4. 区分“代码问题”与“环境限制”，降低误报和无效修复

### 成本

1. 单次交接和提交信息会更长
2. 需要三猫共同保持格式纪律

## 执行范围

本协议适用于：

1. `AGENTS.md`（Maine Coon）
2. `CLAUDE.md`（Ragdoll）
3. `GEMINI.md`（Siamese）
4. 所有与 Cat Café 相关的任务交接和 commit

## 否决理由（P0.5 回填）

- **备选方案 A**：仅要求记录 `What`，由接手方自行推断 `Why`
  - 不选原因：历史实践已证明会导致决策不可审计，接手猫无法判断“bug 还是 feature”。
- **备选方案 B**：仅在 review 请求中要求五件套，日常交接不强制
  - 不选原因：会形成“双轨写作标准”，跨猫同步时上下文质量不一致，问题回流概率高。
- **备选方案 C**：允许“完成后批量补 commit 和 Why”
  - 不选原因：补写信息容易失真，无法保证每个可验证子任务和证据一一对应。

**不做边界**：本轮不把五件套自动化成机器人 gate；先以文档规范 + review 执行纪律为主。

## 合规检查清单

- [ ] 交接里是否明确写出 `Why`
- [ ] 是否列出 `Open Questions`
- [ ] 是否指定了 `Next Action`
- [ ] 是否完成对应 commit
- [ ] commit 是否带猫猫签名
- [ ] 验证结果是否标注执行环境与失败归因
