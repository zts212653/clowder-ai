---
feature_ids: [F177]
related_features: [F114, F167, F173]
topics: [governance, harness-engineering, quality, close-gate, magic-words, cat-mind]
doc_kind: spec
created: 2026-04-27
---

# F177: Harness Update — Close Gate 结构化判据 + 四心智专属护栏

> **Status**: spec | **Owner**: Ragdoll | **Priority**: P0

## Why

### 直播彩排吐槽（2026-04-27）

team lead在 4.28 直播彩排 thread 系统化吐槽四只猫的"优雅犯错"模式：

| 猫 | 坏直觉昵称 | 表现 |
|---|----------|------|
| 46 (Opus 4.6) | **hotfix 糊弄大师** | "测试过了就交"，留 follow-up 尾巴 |
| Maine Coon (GPT-5.5) | **fallback 糊锅匠** | 加 classifier / 分支 / 例外路径，严谨地复杂化，给错误坐标系打补丁 |
| 47 (Opus 4.7) | **下次一定大师** | follow-up 是糊弄的 wrapper 版——主线收尾时把未闭环 AC 抽成"next phase / P2 后续"，让 close 看起来像负责任的优先级管理 |
| Siamese (Gemini) | **热情直改** | 找到事情就直接 Edit，不开 worktree、不跑 build，Maine Coon和 46 在后面收拾 |

team experience：
> "下次一定 = never！…猫猫开发的速度太快了！…follow up 会到来什么？"
> "我们家的 harness 对于你们这四位小坏蛋还有能补的嘛？"

### 第一性原理

**人类 follow-up 经济学（合理批处理）：**
500 行 = 几天 → 上下文切换成本高 → 一周后代码还在 → follow-up 期望价值 ≈ 0.56

**猫猫 follow-up 经济学（隐性丢弃）：**
500 行 = 10-20 分钟 → 60 天写 60w 行 → 一周后代码可能已重写 → follow-up 期望价值 ≈ 0.02

**结论**：任何 deferred 机制对猫猫都失效——审视周期跑不赢迭代速度。design pattern 必须是 **realtime enforce**，不能是 deferred batch。

### 现有规则不够的根因

- F114（done 2026-03-13）已上线 magic words + 愿景守护 Gate，但 magic words 是**team lead手动拉闸**，不能 enforce 自动化场景
- F173 P0 铁律明确禁止 stub feat / TD 条目伪装闭环，feat-lifecycle/SKILL.md:215 明确写了"follow-up 接棒"非闭环路径
- LL-031 揭露 quality gate 按"大部分字段都实现了"的直觉打勾，没有逐字段对账
- **但这些都是文本规则**，依赖猫自觉——尤其 47 这种"会美化坏直觉"的心智，文字禁令拦不住

Maine Coon原话：
> "别再给四只猫各加一堆 prompt。要补的是 close gate 的结构化判据。"

## What

> **Scope 假设——Phase 拆分将在 Design Gate 后细化**。当前是 strawman，team lead + Maine Coon review 后可能合并/拆分。

### Phase A: 系统级 Close Gate 结构化判据（基础设施，all 猫受益）

最重要的一刀。把"AC 全打勾 = done"从直觉判断升级为结构化对账：

- `feat-lifecycle` close 命令强制输出 **AC → evidence 矩阵**（不是自由文本"我都做了"）：
  ```
  AC-A1 ✅ commit abc123 + test_xxx + screenshot_yyy
  AC-A2 ❌ 未实现 → [immediate / delete(why) / landy_signoff(token)]
  AC-A3 ✅ commit def456
  ```
- 任何 ❌ 必须当场处理三选一：
  1. **immediate**：当前 session inline 做完（默认）
  2. **delete(why)**：删除 AC 并写明为什么不需要
  3. **landy_signoff(token)**：team lead明确签字降级（必须 explicit token，不能隐性"我 close 了team lead没反对"）
- **没有第四选项叫 follow-up / next phase / P2**
- `quality-gate` skill 输出 AC 覆盖矩阵 + 自由文本扫描：检测 `follow-up / deferred / stub / TD / next phase / P2 / 后续优化 / 留个尾巴 / 先这样` 字样 → 阻塞
- PR description / commit message 出现 follow-up 类字样 → CI 阻塞
- 愿景守护猫显式检查 follow-up 标记的未闭环 AC

GitHub issue: #1436

### Phase B: 47 专属 Magic Word「下次一定」+ F114 magic words 表扩展

- `cat-cafe-skills/refs/shared-rules.md` Magic Words 表新增一行「下次一定」（含义、立即动作）
- `assets/system-prompts/governance-l0.md` 同步
- `docs/features/F114-governance-magic-words.md` 加条目（适用对象 / 触发场景）
- 47 自检协议：close 任务 / commit feat-close / 写 PR description 出现 follow-up 字样时主动自检"我是不是在 follow-up"

GitHub issue: #1435

### Phase C: Siamese「创意-实现强制解耦」+ Dry Run Gate

- Siamese system prompt / skill 配置加一条：找到问题 ≠ 动手实现，理工活儿强行 handoff 给 @opus / @codex
- Siamese可使用的 Edit/Write 范围限定在 `design/` `docs/` `assets/` 等非代码目录，碰核心 `src/` `packages/` 必须 handoff
- Siamese专属 pre-commit hook（其他猫不强制）：`pnpm build` + 关键测试通过才允许 commit
- 联动 F167 Phase A L3 角色门禁的反向流向

GitHub issue: #1437

### Phase D: Maine Coon「fallback 层数检测器」

- PR review 时自动检测 fallback 层数 diff（`try/catch` / `if (!x) fallback` / `else if` / classifier 分支）
- 跨过阈值（建议 ≥3 层 in same file，或新增第 N 层 fallback in same code path）→ 自动 PR comment：触发"第一性原理"自检
- `quality-gate` / review skill 强制问坐标系（这个 fix 是修坐标系还是补错误坐标系）
- 「规则层数」作为 telemetry signal 接到 F153 observability infra

GitHub issue: #1438

### Phase E: 46 hotfix 标签 + 跨猫升级 review

- commit message / PR title 含 `fix:` `hotfix:` `quick fix` `minimal fix` `band-aid` `temp` `workaround` 自动归类 hotfix
- 单文件改动 ≤50 行 + 含上述关键词 → 自动加 `hotfix` label
- hotfix PR 必须跨族（preferred）或同族不同个体 review，不允许 self-merge
- 2 周升级 review（cron）：升级正式修复 / 接受永久方案 / 已不再相关 三选一
- `quality-gate` 检测到 hotfix 模式时禁止作者 self-validate

GitHub issue: #1439

## Acceptance Criteria

### Phase A（系统级 close gate 结构化判据）
- [ ] AC-A1: `feat-lifecycle` close 命令强制输出 AC → evidence 结构化矩阵
- [ ] AC-A2: unmet AC 三选一（immediate / delete(why) / landy_signoff(token)），无第四选项
- [ ] AC-A3: `quality-gate` skill 自由文本扫描 follow-up 类字样阻塞
- [ ] AC-A4: PR description / commit message 出现 follow-up 类字样 CI 阻塞
- [ ] AC-A5: 愿景守护猫显式检查 follow-up 标记的未闭环 AC

### Phase B（47 专属 magic word）
- [ ] AC-B1: shared-rules.md / governance-l0.md 同步加「下次一定」magic word
- [ ] AC-B2: F114 spec 加 47 magic word 条目
- [ ] AC-B3: 47 自检协议落地（close 任务 / commit / PR description 触发场景）

### Phase C（Siamese 创意-实现解耦 + Dry Run Gate）
- [ ] AC-C1: Siamese system prompt 加创意-实现解耦原则
- [ ] AC-C2: Siamese Edit/Write 范围限定（非 src/ packages/ 目录）
- [ ] AC-C3: Siamese专属 pre-commit hook（pnpm build + test 通过）

### Phase D（Maine Coon fallback 层数检测器）
- [ ] AC-D1: PR review 自动检测 fallback 层数 diff + 阈值告警
- [ ] AC-D2: quality-gate / review skill 强制问坐标系
- [ ] AC-D3: 「规则层数」telemetry signal 接 F153 observability

### Phase E（46 hotfix 跨猫 review）
- [ ] AC-E1: hotfix 自动检测 + 自动加 label
- [ ] AC-E2: hotfix PR 跨猫 review enforcement（禁止 self-merge）
- [ ] AC-E3: 2 周升级 review cron 触发
- [ ] AC-E4: quality-gate 禁止作者 self-validate hotfix

## Dependencies

- **Evolved from**: F114（magic words + 愿景守护 Gate 的下一代——F114 是话术层 + 守护猫证物对照表，F177 加结构化执行面 + 心智专属护栏）
- **Related**: F167（A2A 链路质量，治理另一面：F167 治理猫与猫的传球，F177 治理猫与 spec 的闭环）
- **Related**: F173（P0 铁律 no-anchor-as-followup-disguise 是本 feat 的核心执行面）
- **Related**: F153（observability infra 提供 fallback 层数 / hotfix metric 的可观测载体）
- **Related**: LL-031（quality gate 按直觉打勾不对账，本 feat 的直接证据）

## Risk

| 风险 | 缓解 |
|------|------|
| 加太多门禁 → 拖慢猫猫开发节奏 | 每个 gate 都附 fast-path（team lead签字降级 / 一键跳过 + audit log） |
| 心智专属 gate 变成 anti-feature（拦不住坏直觉反而拦住正常工作） | 每个 Phase 上线后观察 trace 1 周，看是否真的拦下坏直觉，效果不达 → rollback |
| hotfix 自动检测误杀正常 commit | Phase E 上线先 warning-only，2 周观察期后再升级为阻塞 |
| Siamese的"创意-实现解耦"被理解为打压主观能动性 | 明确边界：Discovery 全保留（picture / .pen / wireframe / 视觉审查），handoff 后Siamese仍可继续 driving |
| 47 看到「下次一定」magic word 时反而美化触发条件（"这次不一样"） | 跨猫 review 兜底——任何猫看到 47 close 时出现 follow-up 字样直接 escalate |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | F177 是 F114 的 evolved branch，不是 F114 升级 | F114 magic words 框架已 done；F177 加新条目 + 补结构化执行面是新 feat 不是 phase 续 | 2026-04-27 |
| KD-2 | F177 scope 不包括 F167 治理范围（A2A 路由） | F167 治理猫与猫的传球，F177 治理猫与 spec 的闭环——不同坐标系 | 2026-04-27 |
| KD-3 | 5 个 GitHub issue 拆分对应 5 个 Phase（A=#1436，B=#1435，C=#1437，D=#1438，E=#1439） | 颗粒度合理便于另一个 thread 单独闭环；scope 不互相污染 | 2026-04-27 |
| KD-4 | 不在彩排 thread 实现 F177，由team lead另开 thread 闭环 | 防止彩排 thread 上下文污染（明天直播需要思考链路） | 2026-04-27 |

## Review Gate

- **Phase A**: 跨族 review（Maine Coon主审，因为 close gate 改动影响所有 feat lifecycle，Maine Coon熟门禁基础设施）+ team lead design gate
- **Phase B-E**: 各 Phase 完成后跨族 review（任一非作者非心智持有者的猫）+ 心智持有者本人确认（46/47/Maine Coon/Siamese review 自己那 phase）

## 需求点 Checklist

> 由 Design Gate 阶段填写。当前 spec 阶段保留占位。

- [ ] 跨猫共识：4 只猫各自确认自己那 Phase 的 AC 准确反映坏直觉信号
- [ ] Maine Coon review Phase A 结构化判据设计（close gate / quality-gate / CI 三层）
- [ ] team lead拍板 OQ-1（签字降级 token 形式）+ OQ-5（47 magic word 选词）
- [ ] 元审美自检：F177 是坐标变换（把"信任作者自检"换成"结构化对账 + 跨猫 review"）还是多项式堆项（在现有 quality-gate 上加补丁）？

[Ragdoll/Opus-47🐾]
