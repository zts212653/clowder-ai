---
topics: [backlog, bugs]
doc_kind: note
created: 2026-03-14
---

# Clowder AI — Bug & Issue Backlog

> 记录平台级 bug 和已知问题。Feature 请求见 [ROADMAP.md](ROADMAP.md)。

| ID | 名称 | Status | Severity | 发现日期 | Link |
|----|------|--------|----------|----------|------|
| BUG-001 | Agent session 上下文溢出死循环 | open | high | 2026-03-14 | 见下方 |

---

## BUG-001：Agent Session 上下文溢出死循环

**发现于**：Session `f8745592-98f6-4635-9e5a-399ce98a7fbc` (2026-03-14 17:47~17:57)
**项目**：EmailToolsForCoreMail-OpenHarmony（鸿蒙穿刺任务）
**涉及角色**：Opus（布偶猫）— Lead Architect

### 现象

- Opus agent 在执行"海风设计系统 Phase 1"时反复触发上下文压缩/恢复
- 每次恢复后注入大量 summary + mission context + system prompts
- 可用 token 极少，仅能执行 1-2 步就再次溢出
- 形成"西西弗斯循环"：TodoWrite → 溢出 → 恢复 → 再 TodoWrite → 溢出...
- 10 分钟内循环 6+ 次，最终只推进了 `git pull` + `git worktree add` 两步

### 定量分析

**Session 基本信息**：
- 文件：`~/.claude/projects/I--AIwork-EmailToolsForCoreMail-OpenHarmony/f8745592-98f6-4635-9e5a-399ce98a7fbc.jsonl`
- 总体积：2.94 MB, 282 行
- 含 3 个 subagent（`subagents/` 目录），共 1.6 MB

**消息分布**：

| 类型 | 数量 | 体积 | 占比 |
|------|------|------|------|
| user | 85 | 2837.3 KB | 94.2% |
| assistant | 94 | 115.6 KB | 3.8% |
| system | 30 | 46.8 KB | 1.6% |
| queue-operation | 12 | 3.4 KB | 0.1% |
| last-prompt | 61 | 7.8 KB | 0.3% |

> 注：user 消息占比畸高是因为 base64 图片和 restoration summary 都编码在 user 消息内。

**三大上下文消耗源**：

| 消耗源 | 体积 | 占 session 比 | 说明 |
|--------|------|--------------|------|
| Base64 图片 | 1.08 MB | 36.7% | 11 张 UI 截图，仅 session 开头 UI 评审时需要 |
| Restoration summary | 457.3 KB | 15.2% | 30 次恢复的累积 summary 文本 |
| Dispatch context | ~177 KB | 5.9% | 每次恢复注入 5.9 KB × 30 次 |

**Restoration summary 增长曲线**：
- 第 1 次恢复：4.8 KB
- 第 10 次恢复：11.2 KB
- 第 20 次恢复：17.6 KB
- 第 29 次恢复：21.0 KB
- 增长率：约 0.56 KB/次（线性增长，无收敛）

**Agent 效率退化**：

| 恢复区间 | 平均 tool calls/次 | 行为模式 |
|----------|-------------------|----------|
| #1 ~ #5 | 3.4 | 正常工作：Read/Write/Bash 混合操作 |
| #6 ~ #9 | 2.0 | 开始退化：以 TodoWrite 为主 |
| #10 ~ #30 | 1.0 | 完全退化：仅 TodoWrite → 立即溢出 |

- 30 次恢复共产出 45 个 tool calls（平均 1.5 次/恢复）
- 其中 3 次恢复为纯空转（0 tool calls，10%）
- 第 10 次恢复后 agent 退化为每次仅 1 个 tool call（通常是 TodoWrite 更新状态）
- **有效产出**：整个 session 实际完成的工作仅为 `git pull` + `git worktree add` 两条命令

### 根因分析

**直接原因：Context window 被一次性素材和累积 overhead 挤占殆尽**

1. **Base64 图片未清理**（36.7%）
   - 11 张 UI 截图在 session 初期用于设计评审，评审完成后再无引用
   - 但图片数据持续占用 context，每次恢复都被重新加载
   - Claude Code 目前无机制在"图片已使用"后将其从 context 中移除

2. **Restoration summary 单调递增**（15.2%）
   - 每次恢复的 summary 包含之前所有 summary 的累积摘要
   - 30 次恢复后 summary 从 4.8 KB 增长到 21 KB，且无收敛趋势
   - summary 增长速率（0.56 KB/次）超过每次恢复新增的有效信息量

3. **Dispatch context 无差别注入**（5.9%）
   - 5.9 KB 的角色定义 + 队友列表 + 任务描述，每次恢复全量注入
   - 恢复时只需要"当前任务 + 进度"，不需要完整的团队花名册和背景介绍

**结构性原因：缺乏溢出熔断机制**

- 连续溢出 30 次无任何自动停止逻辑
- 每次恢复后 agent 不评估"剩余 context 是否足够完成下一步"
- 形成正反馈死循环：溢出 → 恢复（注入更大 summary）→ 更快溢出 → 更大 summary...

### 影响

- **Agent 完全丧失工作能力**：30 次恢复仅完成 2 条命令，实际效率趋近于零
- **Token 浪费严重**：保守估计消耗 3M+ tokens（30 次 context 加载），实际有效产出可忽略
- **任务中断需人工接管**：设计系统 Phase 1 的剩余 4 项工作需另起 session 手动完成

### 建议修复方向

**P0（必须修复）**：

1. **溢出熔断器** — 连续 N 次（建议 N=3）溢出后自动停止 session，通知用户介入
   - 当 agent 检测到最近 3 次 restoration 每次仅完成 ≤1 tool call，判定为死循环
   - 自动保存当前进度（todo list + 未完成项），终止 session

2. **Restoration summary 封顶** — Summary 体积上限 8 KB，超出时只保留最近 2 轮的详细记录 + 更早的单行摘要
   - 避免 summary 无限增长，确保恢复后有足够 context 工作

**P1（应该修复）**：

3. **大体积素材自动淘汰** — Base64 图片、大段代码块等在使用后标记 `ephemeral`，context 压缩时优先丢弃
   - 对于已被 agent 处理过的图片，替换为文本描述（如"[截图: 邮件列表页，已评审]"）

4. **Dispatch context 分级注入** — 首次 dispatch 注入完整 context，恢复时只注入精简版（角色名 + 当前任务 + todo 进度）
   - 完整版 5.9 KB → 精简版 < 1 KB

**P2（可以优化）**：

5. **恢复前 context 预算评估** — 恢复时先计算 summary + dispatch + system prompt 总体积，预估可用 token
   - 若可用 token < 完成下一步所需的最低阈值（如 4K tokens），直接跳过恢复，报告给用户

6. **任务原子化建议** — 当任务步骤数 > 5 且涉及大文件操作时，自动建议拆分为多个独立 session
