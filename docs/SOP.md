---
feature_ids: [F042]
topics: [sop]
doc_kind: note
created: 2026-02-26
updated: 2026-03-11
---

# Cat Café 开发 SOP

> 三猫开发全流程的导航图。每步的详细操作在对应 skill 内。
> 冲突时以 skill 内容为准。

## 愿景驱动（核心原则）

Cat Café 的开发是**愿景驱动**的。和team lead确认了 feature 的愿景后：

- **没达成愿景 = 没完成**，必须继续做，不能半路停下来问"要不要继续"（§17）
- **唯一停下来的理由**：发现了原本没发现的、确实解决不了的阻塞（技术限制/外部依赖不可用），此时升级team lead
- SOP 每步自动推进，全链路闭环到愿景守护通过为止

### 大 Feature 碰头机制（3+ Phase）

大 scope feature 不能等最后才对齐愿景。**每个 Phase merge 后**，主动和team lead碰头：

```
Phase N merge → 碰头（不是"要不要继续"，是"方向对不对"）→ 继续 Phase N+1
```

**碰头格式**（轻量，不是报告会）：
1. **成果展示**：这个 Phase 做了什么（截图 / 关键改动 / demo）
2. **愿景进度**：离最终愿景还差什么（哪些 AC 打了勾，哪些还没）
3. **下个 Phase 方向**：下一步计划做什么，有没有发现新问题
4. **方向确认**："方向对吗？有没有要调整的？"

**注意区别**：
- 碰头 = **愿景方向确认**（宏观层，team lead需要介入）✅
- "要我继续吗？" = **SOP 流程推进**（细节层，不要问）❌

**小 Feature（1-2 Phase）**：不需要碰头，直接做到底 → 愿景守护 → close。

## Runtime 单实例保护（P0）

`../cat-cafe-runtime` 是咱们的运行态单实例（通常占用 `3004/3003`），默认视为**在线服务**，不是随手重启的实验环境。

硬规则：
1. 在 runtime 会话里，禁止执行会触发重启的命令：`pnpm start`、`pnpm runtime:start`、`./scripts/start-dev.sh`
2. 做截图/验收/排查前，先复用现有服务（先查 `curl -sf http://localhost:3003/health`）
3. 确实要重启，必须先拿到team lead明确同意，再显式设置 `CAT_CAFE_RUNTIME_RESTART_OK=1` 执行启动命令

说明：`--force` 不是重启授权，不能替代第 3 条。

## 完整流程（5 步）

```
⓪ Design Gate    → 设计确认（UX→team lead/后端→猫猫/架构→两边）
① worktree        → 隔离开发环境
② quality-gate    → 自检 + 愿景对照 + 设计稿对照
③ review 循环     → 本地 peer review（P1/P2 清零 + reviewer 放行）
④ merge-gate      → 门禁 → PR → 云端 review → squash merge → 清理
⑤ 愿景守护       → 非作者非 reviewer 的猫做愿景三问 → 放行 close / 踢回
```

> **⚠️ Design Gate 在 ① 之前！** UX 没确认不准开 worktree。PR 在 ③ 之后。
> **⚠️ 全链路自动推进（§17）！** SOP 有写下一步 → 直接做，不要停下来问team lead。

| Step | 做什么 | Skill | 详情 |
|------|--------|-------|------|
| ⓪ | 设计确认：前端→team lead画 wireframe；后端→猫猫讨论；架构→两边 | `feat-lifecycle` Design Gate | Trivial 跳过⓪，按下方例外路径判断 |
| ① | 创建 worktree，配置 Redis 6398 | `worktree` | 禁止直接改 main |
| ② | 愿景对照 + spec 合规 + 跑测试 + **有 .pen 则设计稿对照** | `quality-gate` | AC ≠ 完成，问"team lead体验如何？" |
| ③a | 发 review 请求（五件套 + 证据） | `request-review` | 附原始需求摘录 |
| ③b | 处理 review 反馈（Red→Green） | `receive-review` | 禁止表演性同意 |
| ④ | 门禁 → PR → 云端 review → merge → 清理 | `merge-gate` | **③ 放行后才进入**，模板见 `refs/pr-template.md` |
| ⑤ | 愿景守护 + feat close（feature 最后一个 Phase 时） | `feat-lifecycle` completion | 守护猫 ≠ 作者 ≠ reviewer，动态选（查 roster） |

## 例外路径

### 跳过云端 review（Step ④ 中的 PR 环节）

三个条件全部满足才可跳过：
1. team lead在当前对话明确同意
2. 纯文档 / ≤10 行 bug fix / typo
3. 不涉及安全、鉴权、数据、API 变更

### 极微改动直接 main（跳过全流程）

四个条件全部满足：
1. 纯日志/配置/注释/文档（不涉及业务逻辑）
2. diff ≤ 5 行
3. 类型检查通过
4. 不涉及可测行为

## Reviewer 配对规则

动态匹配自 `cat-config.json`：
1. 跨 family 优先 | 2. 必须有 peer-reviewer 角色 | 3. 必须 available
4. 优先 lead | 5. 优先活跃猫

**降级**：无跨 family reviewer → 同 family 不同个体 → team lead。
**铁律**：同一个体不能 review 自己的代码。

## 代码质量工具

| 工具 | 命令 | 何时 |
|------|------|------|
| Biome | `pnpm check` / `pnpm check:fix` | 开发中 + Step ② |
| TypeScript | `pnpm lint` | Step ② 必跑 |
| shared rebuild | `pnpm --filter @cat-cafe/shared build` | shared 包改后 |
| 目录卫生 | `pnpm check:dir-size` + `pnpm check:deps` | 新增文件时 |

详见 ADR-010（目录卫生）。

## 环境变量注册（必读！）

新增 `process.env.XXX` 引用 → **必须在 `packages/api/src/config/env-registry.ts` 的 `ENV_VARS` 数组注册**。
前端「环境 & 文件」页面自动展示，不注册 = team lead看不到 = 不存在。

## 文档规范

- `docs/` 下 `.md` 文件必须有 YAML frontmatter（ADR-011）
- 完成后必须同步真相源（详见 `feat-lifecycle` skill）
- 归档查找：*(internal reference removed)*

## 开源社区 Issue 处理（F059）

开源仓 `clowder-ai` 的社区 issue 由猫猫 triage，**team lead决定是否立项**。

### 角色分工

| 角色 | 谁 | 做什么 |
|------|-----|--------|
| **Triage** | 任意猫（收到 @ 或主动巡查） | 给 issue 加 `bug` / `feature` label，回复确认收到 |
| **F 号分配** | team lead拍板 → 猫执行 | 在 BACKLOG.md 加条目，分配下一个可用 F 号 |
| **Feature Doc** | 分配到的猫 | 按模板写 `docs/features/F{NNN}-slug.md` |
| **实现** | 任意猫或社区贡献者 | 按 Feature Doc AC 实现 + PR |

### 流程

```
社区开 issue → 猫 triage（加 label）→ team lead拍板立项
    → BACKLOG.md 加 F{NNN} → 写 Feature Doc → 实现 → sync 推送
    → issue 标 label feature:F{NNN} → close
```

### 规则

- **F 编号唯一源**：BACKLOG.md（team lead拍板后猫执行分配）
- **Bug 不编号**：直接用 issue # 追踪，修完 close
- **贡献者不自选号**：CONTRIBUTING.md 已写明，猫猫回复时也要强调
- **社区贡献者的 PR**：猫猫用 `community-pr` skill 引导（编号校验 + Feature Doc 对齐）
