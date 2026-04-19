---
name: deep-research
description: >
  多源深度调研管道（Web Deep Research + Coder 合成 + 云端模型咨询）。
  Use when: 技术问题需要多源调查、设计决策需要证据、铲屎官说"调研"/"research"、需要咨询云端模型。
  Not for: 简单搜索（直接用 WebSearch）、已有结论的确认。
  Output: 调研报告 + 证据合成 或 咨询文档（含回填区）。
triggers:
  - "调研"
  - "research"
  - "深度研究"
  - "问一下 GPT Pro"
  - "咨询云端"
renamed-from: deep-research-pipeline
---

# Deep Research

两种模式：
- **Mode A: 多源调研**：Web 猫（网络搜索）+ Coder 猫（代码判断）+ GPT-5.2 Pro（审阅）= 三角验证
- **Mode B: 云端模型咨询**：本地猫总结背景 → 铲屎官发给云端模型 → 回填结果 → 本地猫综合

## 两种猫，各有分工

| | Web 猫（Deep Research 模式） | Coder 猫（CLI/Cat Cafe） |
|---|---|---|
| 强项 | 搜 100+ 来源，有引用 | 读项目代码，跑测试 |
| 弱点 | 不了解我们的 codebase | 网络搜索深度有限 |
| 用途 | Step 2 并行调研 | Step 4 综合判断 |

**不适用场景：**
- 快速事实查询（直接用 WebSearch）
- 纯代码问题（用 Explore agent）
- 项目文档里已有答案

## 四步流程

**Step 1 — 写 Prompt 并落盘**
```
docs/prompts/YYYY-MM-DD-{topic}-research-prompt.md
```
模板见下方。写完再发，不要边写边发。

**Step 2 — 三路并行 Web 调研**
```
同一个 prompt →
  Claude.ai Deep Research
  Gemini Deep Research
  ChatGPT Deep Research  ← 可能先问澄清问题，答完后把 Q&A 追加到另外两路的 prompt
```
结果存：*(internal reference removed)*（chatgpt / claude-ai / gemini）

**Step 3 — GPT-5.2 Pro 审阅**
输入三份报告 → 找逻辑漏洞、弱证据、三方分歧
存：`gpt-pro-review.md`（注意：Pro 是审阅者，不是调研者，不要让他搜索）

**Step 4 — Coder 猫综合 + 决策**
读全部四份文档 → 对照实际 codebase 验证 → 标注"直接可用/需验证/项目特殊约束"
存：`synthesis.md` → 和铲屎官讨论 → 落到 ADR

## Prompt 模板（Step 1）

**使用 8 槽位骨架模板**：`cat-cafe-skills/refs/research-prompt-template.md`

8 个槽位：
1. `Problem Frame` — 任务边界 + 非目标
2. `Current Hypotheses` — 我们的假设 + 证据缺口
3. `Disconfirm First` — 先找反例（反确认偏误）
4. `Source Mix Quota` — 来源配额（论文/工程/开源/竞品）
5. `Local Constraints` — 我们的约束（多引擎/人在环/知识在 repo）
6. `Output Schema` — 支持/反对/未定 + 置信度
7. `Decision Interface` — 映射到 采纳/试点/搁置
8. `Risk Register` — 如果结论错了炸在哪

**发送前自动注入**（模板底部有清单）：当前 Feature spec、相关 ADR、最近教训、BACKLOG 上下文。

**收到后 Quality Gate**（模板底部有标准）：反例覆盖、来源多样性、约束对齐、可行动、风险意识。

实战范例：*(internal reference removed)*

## Quota 意识

| 资源 | 策略 |
|------|------|
| ChatGPT Deep Research | 30 天滚动上限，发前确认值得用 |
| Claude / Gemini Deep Research | Plan-dependent，同上 |
| GPT-5.2 Pro | 仅用于 Step 3 审阅，不用于普通对话 |

**三个视角的必要性：** Claude / Gemini / GPT 各家族有不同的训练偏差。分歧处往往是最有价值的信号。

## Chrome MCP 自动化（Step 2）

执行猫可用 `mcp__claude-in-chrome__*` 工具自动发送 prompt + 附件 + 提取回复。

**详细 DOM 选择器和代码片段见各平台 ref**：
- **ChatGPT** → `refs/chatgpt-browser-automation.md`（2026-03-10 实测验证 ✅）
- **Claude.ai** → `refs/claude-ai-browser-automation.md`（2026-03-10 实测验证 ✅）
- **Gemini** → `refs/gemini-browser-automation.md`（2026-03-10 实测验证 ✅）

### ChatGPT 自动化摘要（已验证）

| 步骤 | 方法 | 关键选择器 |
|------|------|-----------|
| 注入文本 | `execCommand('insertText')` | `#prompt-textarea` |
| 上传文件 | DataTransfer API 注入 file input | `querySelectorAll('input[type="file"]')[0]` |
| 切换深度研究 | 点击侧栏或 `+` 菜单 | `[data-testid="deep-research-sidebar-item"]` |
| 发送 | 点击发送按钮 / 按 Enter | 输入框右侧圆形按钮 |
| 等待完成 | 轮询停止按钮是否消失 | `button[aria-label="停止生成"]` |
| 复制回复 | 点击复制按钮 → 读剪贴板 | `[data-testid="copy-turn-action-button"]` |

### 文件上传工作流（提示词在输入框，ref 文档用文件上传）

```
1. 猫本地读取 ref .md 文件内容
2. JS: new File([content], 'filename.md', {type: 'text/markdown'})
3. JS: DataTransfer → fileInput.files = dt.files → dispatch 'change'
4. 文件卡片出现在输入框上方
5. 同时 execCommand 注入提示词文本
6. 发送
```

### Gemini 自动化摘要（已验证）

| 步骤 | 方法 | 关键选择器 |
|------|------|-----------|
| 注入文本 | `execCommand('insertText')` ✅ | `.ql-editor[contenteditable="true"]`（Quill） |
| 切换 Deep Research | 工具菜单 | 点击「工具」→「Deep Research」 |
| 发送 | 点击发送按钮 | 输入框右侧蓝色箭头 |
| 确认计划 | 点击「开始研究」 | ← Gemini 独有！ChatGPT/Claude 无此步骤 |
| 等待完成 | 轮询停止按钮消失 | 或检查「分享和导出」按钮出现 |
| 导出 | 分享和导出 → 导出到 Google 文档 | 报告面板顶部按钮 |
| 下载 MD | Google Docs: 文件 → 下载 → Markdown | 标准 Google Docs 操作 |

> **重要更正**：之前记录的"contenteditable 不接受 execCommand"是错误的。Gemini Quill 编辑器完全支持。

### 报告提取（2026-03-10 实测确认）

- **GPT Pro 回复**：`copy-turn-action-button` + `clipboard.readText()` ✅ 全自动
- **✅ GPT 深度研究报告**：API 提取法（`backend-api/conversation/{id}` + Bearer token）
  - 报告在 widget state JSON → `report_message.content.parts[0]` = 完整 Markdown
  - Blob 下载 → `cp` 归档（详见 `refs/chatgpt-browser-automation.md`）
- **✅ Claude.ai 报告**：Artifact 面板原生 "Download as Markdown" 按钮（blob URL，同源 DOM）
  - 点击 Copy options → Download as Markdown → 自动下载 .md 文件
  - 比 ChatGPT 简单得多——无需 API 提取（详见 `refs/claude-ai-browser-automation.md`）
- **✅ Gemini 报告**：导出到 Google Docs → 文件 → 下载 → Markdown (.md)
  - 两跳路径（Gemini → Google Docs → 本地），比 ChatGPT/Claude 多一步
  - 下载文件名 = Google Docs 文档标题 + `.md`（详见 `refs/gemini-browser-automation.md`）

## 常见错误

| 错误 | 修正 |
|------|------|
| 没落盘 prompt 就发 | prompt 文件 = 可追溯性，必须先写 |
| 三路发了不同的 prompt | 基础 prompt 相同；只有 GPT Q&A 是追加的 |
| 让 GPT Pro 去搜索 | Pro 是审阅者，不是调研者 |
| 忽略三方分歧 | 分歧 = 最有价值的信号，必须分析 |
| Coder 猫盲信 web 报告 | 必须对照实际 codebase 验证 |

## Step 5 — 在交接前持久化调研产出

如果调研结果需要被后续 session、其他猫、或人类继续使用，就在结束该流程前 commit。
- 在 worktree 里：commit 到当前分支
- 在共享 main worktree：commit + push，确保其他 session 能看到
- 多次 Edit 更新：每次重大更新后追加 commit

**验证**：在总结 / handoff 里记录 commit SHA。`git log --oneline -1` 显示刚才的 commit。

## Next Step

→ `collaborative-thinking`（讨论调研结论，形成决策）

---

# Mode B: 云端模型咨询

**场景**：需要咨询无法访问本地文件的云端模型（如 GPT Pro、Claude Pro 等）。

**问题**：云端模型不知道我们的现状，也访问不到本地文件。直接问容易得到泛泛的回答。

**解决**：本地猫先总结背景，生成自包含的 prompt + 回填文档。

## 适用场景

- 需要 GPT Pro 帮忙审阅/补充观点
- 需要外部专家视角
- 本地调研完成后，想要第三方验证
- 铲屎官说"问一下云端的 xxx"

## 三步流程

**Step 1 — 本地猫创建咨询文档**

```
docs/research/YYYY-MM-DD-{topic}-{model}-consult.md
```

文档结构（三部分）：
```markdown
## Part 1: 发给云端模型的提示词
> 直接复制发送

{自包含的背景 + 我们的现状 + 已有结论 + 请求}

## Part 2: 云端模型回答（待回填）
> 铲屎官粘贴回答到这里

[待回填]

## Part 3: 综合后的最终版本（待撰写）
> 本地猫综合后撰写

[待撰写]
```

**Step 2 — 铲屎官发送 + 回填**

1. 复制 Part 1 发给云端模型
2. 把回答粘贴到 Part 2
3. @ 本地猫继续

**Step 3 — 本地猫综合**

1. 读 Part 2 的回答
2. 对照本地 codebase 验证
3. 综合写 Part 3（最终版本）

## Part 1 Prompt 模板

```markdown
你好，我们是 {团队简介}，正在 {做什么}。

### 背景
{简要说明项目现状，重点是云端模型需要知道的上下文}

### 我们的核心结论
{已有的结论/共识，用表格或列表清晰呈现}

### 请求
**请帮我们 {具体请求}**，例如：
- 补充 3-5 个业界案例
- 指出我们结论的盲区
- 给出更好的表述方式

理想的输出特征：
- {特征1，如：知名公司/产品}
- {特征2，如：有公开数据}

可以考虑的方向（不限于）：
- {方向1}
- {方向2}

**额外请求**：
- 如果你觉得我们的结论有盲区，请指出
- 如果有更好的 {比喻/表述/方案}，欢迎建议
```

## 关键原则

| 原则 | 说明 |
|------|------|
| **自包含** | Part 1 必须让云端模型仅凭这段 prompt 就能理解全部上下文 |
| **结构化** | 用表格/列表呈现已有结论，便于云端模型快速理解 |
| **明确请求** | 说清楚要什么（案例/审阅/建议），不要让模型猜 |
| **留回填区** | Part 2 和 Part 3 结构清晰，方便后续操作 |
| **追溯链** | 文档放在 *(internal reference removed)*，关联到原始 thread |

## 常见错误

| 错误 | 修正 |
|------|------|
| Prompt 假设云端模型知道我们的项目 | 必须写明背景，不能省略 |
| 只丢问题不给上下文 | 先总结我们已有的结论，再请求补充 |
| 忘记创建回填区 | Part 2 和 Part 3 必须预留，结构化便于操作 |
| 本地猫直接用云端结论 | 必须 Step 3 对照 codebase 验证后再综合 |

## 文件命名规范

```
docs/research/YYYY-MM-DD-{topic}-{model}-consult.md
```

例如：
- `2026-03-08-model-agent-platform-gpt-pro-consult.md`
- `2026-03-05-mcp-security-claude-pro-consult.md`
