---
feature_ids: []
topics: [hindsight, integration]
doc_kind: decision
created: 2026-02-26
---

# ADR-005: Hindsight 集成决策

> 日期: 2026-02-08
> 状态: 已拍板
> 参与者: Ragdoll (Opus 4.5) + 铲屎官 🐬
> 背景: Phase 5 上下文工程规划

---

## 背景

Phase 5 要集成 Hindsight 作为协作记忆系统。在开工前需要拍板 7 个关键问题。

---

## 问题 1：Hindsight 连接参数 ✅

**决策**: 用环境变量 `HINDSIGHT_URL=http://localhost:8888`

**现状**:
- API: `http://localhost:8888`
- Web UI: `http://localhost:9999/dashboard`
- 认证: 暂无（本地开发）

---

## 问题 2：Bank 设计

### Ragdoll初始方案

| 方案 | Bank 结构 | 优点 | 缺点 |
|------|----------|------|------|
| A | 单一 `cat-cafe` | 简单 | 所有记忆混在一起 |
| B | `cat-cafe-shared` + `cat-cafe-{catId}` | 共享 vs 个人分离 | 需要决定什么进哪里 |
| C | `cat-cafe-{projectPath}` | 项目独立 | 跨项目知识不能共享 |
| D | B + C 混合 | 最灵活 | 最复杂 |

Ragdoll推荐 B：共享知识放 `cat-cafe-shared`，个人经验放 `cat-cafe-{catId}`。

### 铲屎官反馈 🐬

> "如果缅因大猫不知道你为什么如此架构他要如何 review 你的代码呢？他可能会猫猫疑惑你这到底是 bug 还是 feature。"

**核心洞察**：
1. **"个人经验"不应该隔离** — 架构决策必须共享，否则其他猫无法理解 why
2. **Thread 级别不需要进 Hindsight** — Redis 已经保存完整聊天，thread 对话本身就是 session 记忆
3. **需要定期同步 thread 对话** — 导出成 md/log 作为可检索的历史

### 最终决策

**Bank 结构**:
- `cat-cafe-shared`: 所有项目知识、决策记录、协作规则（三猫都能读写）
- 暂不做 `cat-cafe-{catId}` — 避免知识孤岛

### 补充决策：单一 Bank 下的“可过滤”约定 ✅

既然不做个人 bank，那么“避免混在一起”的能力必须由 **tags/metadata 约定**来承担，否则 Recall/Reflect 很容易跨项目/跨阶段串味。

**决策**：写入 `cat-cafe-shared` 的每条 `MemoryItem`（或每个文档的 items）必须满足：
- 至少 1 个 `project:*` tag（Cat Café 固定为 `project:cat-cafe`）
- 至少 1 个 `kind:*` tag（例如：`kind:decision` / `kind:phase` / `kind:discussion` / `kind:backlog`）
- `metadata` 至少包含：
  - `anchor`：稳定证据锚点（例如 `docs/decisions/005-hindsight-integration-decisions.md` 或 `commit:<sha>`）
  - `author`：写入者（例如 `ragdoll|maine|siamese|caretaker`）
  - `status`：`draft|published|archived`

**注意（Hindsight OpenAPI 约束）**：`metadata` 的 value 类型是 `string`（`Record<string,string>`）。如需存 anchors 列表/结构化内容，必须序列化为字符串（例如 JSON 字符串或多行文本）。

**记忆层次**:
```
┌─────────────────────────────────────────────────────────┐
│ Hindsight (cat-cafe-shared)                             │
│ - 决策记录 (docs/decisions/)                            │
│ - 阶段计划 (docs/phases/ 归档后的)                       │
│ - 协作规则、架构知识                                     │
│ - 重要讨论纪要                                          │
└─────────────────────────────────────────────────────────┘
                         ▲
                         │ 归档/沉淀
                         │
┌─────────────────────────────────────────────────────────┐
│ Thread Log (定期导出)                                    │
│ - 完整对话历史                                          │
│ - 可检索的 session 记忆                                  │
│ - 格式: md 或 NDJSON                                    │
└─────────────────────────────────────────────────────────┘
                         ▲
                         │ 实时
                         │
┌─────────────────────────────────────────────────────────┐
│ Redis (MessageStore)                                     │
│ - 当前 thread 完整消息                                   │
│ - 猫猫压缩后可回溯                                       │
└─────────────────────────────────────────────────────────┘
                         ▲
                         │ 索引/摘要
                         │
┌─────────────────────────────────────────────────────────┐
│ F3-lite (MemoryStore)                                    │
│ - 临时笔记、摘要索引                                     │
│ - 快速存取，MAX_KEYS=50                                  │
└─────────────────────────────────────────────────────────┘
```

**MCP 封装约束**:
- Cat Café 的 MCP 工具**只暴露 `cat-cafe-*` 开头的 bank**
- 不让猫猫看到其他项目的 bank（如 `routing-shared`, `mission-control-hub` 等）
- 原因：避免浪费猫猫上下文，聚焦当前项目

**待办**:
- [ ] 调研/确认 Hindsight 的 memory types（world/observation/experience/opinion…）与我们导入文档的映射策略
- [ ] MCP 封装时过滤 bank 列表（只返回 `cat-cafe-*`）

---

## 问题 3：F3-lite 与 Hindsight 分工

### Ragdoll分析

| 方案 | 描述 |
|------|------|
| A | 全部迁移到 Hindsight，废弃 F3-lite |
| B | 分层：F3-lite 做临时记忆，Hindsight 做持久记忆 |
| C | 保持两套，用户自己选 |

### 铲屎官反馈 🐬

> "F3-lite 像快速的短期记忆。猫猫压缩后丢失完整记忆，但有摘要。用摘要去 F3-lite 找，找不到就去 thread log 找。"

### 最终决策: 方案 B（分层）

**F3-lite 定位**:
- 短期记忆 / 摘要索引
- 猫猫压缩上下文后，留下的"指针"
- 例如：`/remember api-design 见 thread log 2026-02-08 的讨论`

**检索链路**:
```
猫猫需要回忆
    │
    ▼
F3-lite (摘要索引)
    │ 找到指针
    ▼
Thread Log (完整对话)
    │ 或者
    ▼
Hindsight Recall (语义检索)
```

---

## 问题 4：发布门禁实现位置

### Ragdoll分析

| 方案 | 描述 |
|------|------|
| A | Cat Café 调用层实现（Redis 存状态） |
| B | 用 Hindsight 的 metadata/tags 存状态 |
| C | 不做门禁，全部写入即生效 |

### 铲屎官反馈 🐬

> "可以注意做好优雅的实现，别丢东西 🤣 什么优雅停机之类的保障都搞上"

### 最终决策: 方案 A（Cat Café 调用层）

**实现要点**:
- Redis 存状态机 (draft → pending_review → published)
- EventAuditLog 记审计
- **优雅停机保障**: 复用 Phase 4.0 bug 修复的模式（BGSAVE + process.once + 幂等 guard）

### 补充决策：安全边界与降级策略 ✅

**安全边界**
- Hindsight 当前为本地开发环境（无认证）。Cat Café 集成时应 **只允许服务端调用** Hindsight（避免浏览器直连 `localhost:8888`，也避免把无认证服务暴露到前端）。

**降级策略**
- Hindsight 不可用时：检索链路降级为 `docs/` 文件搜索（grep/简单倒排），并在 UI 明确提示“已降级/结果可能不完整”。
- retain/recall/reflect 失败必须写入 `EventAuditLog`（含 request 关键字段 + bank_id + 错误摘要），保证“真相可追溯”。

---

## 问题 5：Evidence 检索是否用 Hindsight Recall

### Ragdoll分析

| 方案 | 描述 |
|------|------|
| A | 用 Hindsight Recall（需要批量导入） |
| B | 用 grep/glob 文件搜索 |
| C | 混合：先 grep 找候选，再用 LLM 排序 |

Ragdoll推荐 A，创建 `cat-cafe-evidence` bank。

### 铲屎官反馈 🐬

> "好像可以直接到 shared 里面。Hindsight 本身就有 world facts, experience, opinions。"
>
> "注意只有归档后才是稳定的，正在讨论的 Phase 5 不稳定。"

### 最终决策: 方案 A（Hindsight Recall）

**调整**:
- 不单独建 `cat-cafe-evidence` bank，直接用 `cat-cafe-shared`
- **两只猫需要调研**: Hindsight 的 memory types 如何利用

**导入策略**:
- 只导入**归档后**的稳定文档
- `docs/decisions/` — 归档即导入
- `docs/phases/` — Phase 完成后导入
- *(internal reference removed)* — 有明确结论的纪要才导入
- 正在进行的讨论（如当前 Phase 5）**不导入**

---

## 问题 6：Reflect 触发策略

### Ragdoll分析

| 触发时机 | 描述 | 成本 |
|----------|------|------|
| 定时（每日/每周） | 自动反思 | 固定成本 |
| 讨论结束时 | thread 关闭时触发 | 按需 |
| 手动命令 | `/reflect` 触发 | 最可控 |

### 铲屎官反馈 🐬

> "优先让猫猫和人自己主动调用，比如猫猫通过 MCP，人通过 slash magic word"

### 最终决策: 手动优先

**实现**:
- 用户: `/reflect [query]` slash command
- 猫猫: `cat_cafe_reflect` MCP callback
- 后续可加定时/自动

---

## 问题 7：UX 呈现方式

### Ragdoll分析

| 方案 | 描述 |
|------|------|
| A | 系统消息（蓝色 info） |
| B | 卡片组件（类似 TaskCard） |
| C | 折叠展开 |

Ragdoll推荐 B（卡片）。

### 铲屎官反馈 🐬

> "我同意你的方式，但是放的位置可能都是在右边？参考 Claude Code 的 cowork 截图。"
>
> "我们现在的 tool_use 和 error 事件现在是被丢弃的 → 这个必须之后展示！可观测性很重要，不然等了几分钟前端只有猫猫在思考，感受太差了。"
>
> "这估计就是你这只猫猫写的 bug（还是 feature？🤣 这里就说明了问题 2 —— 你的架构决策如果只是你的记忆，铲屎官都无法判断到底为什么了！）"

### 最终决策: 卡片组件 + 右侧面板 + 可观测性修复

**布局参考**: Claude Code cowork 截图 (`reference-pictures/`)

**必须修复的 bug/feature**:
- `tool_use` 事件当前被丢弃 → 必须展示（猫猫在调用什么工具）
- `error` 事件当前被丢弃 → 必须展示
- 这是可观测性问题，也是 UX 问题

**铲屎官的灵魂拷问**:
> "这到底是 bug 还是 feature？你的架构决策如果只是你的记忆，铲屎官都无法判断！"

→ 这正是为什么决策必须共享、必须记录 why 的原因。

---

## 关键教训

1. **知识不能隔离** — "个人经验"的划分会导致其他猫无法理解 why
2. **Thread 对话本身就是 session 记忆** — 不需要额外进 Hindsight
3. **只导入归档后的稳定内容** — 正在进行的讨论不稳定
4. **记录决策过程的 why** — 选项分析 + 反馈 = 可追溯的决策思考
5. **可观测性是 UX** — tool_use/error 不能丢弃

---

## 附录：Hindsight memory types 初步探测（`/stats`，2026-02-08）

> 用途：把“memory types 真的存在且有哪些”从猜测变成事实，便于后续映射导入策略。

- 观察到的 fact types（至少包含）：`world`、`observation`、`experience`、`opinion`
- 示例（`dare-framework`）：`total_nodes=377`；`world=271`、`observation=87`、`experience=8`、`opinion=11`
- 说明：这只是现有 bank 的快照；`cat-cafe-shared` 的写入策略仍应以 **tags/metadata 约定**为主，避免单一 bank 串味。

---

## 附录 B：GPT Pro 外部研究回流（2026-02-13，讨论输入）

> 说明：本节是外部研究输入，不是自动拍板结论。最终取舍需三猫讨论后再转为正式决策。

### 输入来源

- GPT Pro 专项回复整理：*(internal reference removed)*
- 历史课题包（A'/B/C）：*(internal reference removed)*

### 现场快照（2026-02-13）

- `cat-cafe-shared` 当前呈现为 `opinion-only`（`nodes_by_fact_type={"opinion":27}`）
- `tags` 为空（`total=0`）

### 回流要点（待讨论）

1. 导入策略建议从“Path-ID 快速导入（Option A）”升级到“Governed 导入（Option B）”：
   - 稳定 `document_id`
   - `quarantined` 隔离草案
   - tombstone 生命周期
2. 建议分三阶段执行：
   - P0 止血：先把 tags/metadata 契约做硬并对稳定文档 backfill
   - P1 同步：git diff 增量同步 + rename/delete 策略 + reconcile
   - P2 习惯化：将“先查 evidence”做成可观测指标闭环
3. 继续坚持本 ADR 的核心边界：单 bank + 调用层治理，不另起平台。

### 与本 ADR 的关系

- **一致**：单 bank 策略、tags/metadata 治理优先、安全边界与降级优先。
- **补强**：把“待办的 types 映射 + bank 过滤”进一步细化为可执行同步与评测路线。
- **待决**：docRef 规则、discussion 导入边界、tombstone 生命周期阈值。

---

*附录 B 补充整理：Maine Coon 🐾（2026-02-13）*
*原始签名: Ragdoll 🐾 + 铲屎官 🐬*

---

## 附录 C：Hindsight 导入治理五项共识（2026-02-13，已收敛）

> 说明：本节记录Ragdoll与Maine Coon讨论后达成的五项共识，已获铲屎官确认。附录 B 中的"待决"项在此正式拍板。

### 讨论过程

- Ragdoll独立判断：*(internal reference removed)*
- Maine Coon独立判断：*(internal reference removed)*
- 收敛确认：*(internal reference removed)*
- 铲屎官挑战（教训沉淀）：*(internal reference removed)*

### 五项共识

#### 共识 1：P0 导入源

**决策**：`docs/decisions/**` + `CLAUDE.md` + `AGENTS.md` + `docs/public-lessons.md`

- ADR 是最稳定、最结构化的知识载体，归档即导入
- CLAUDE.md / AGENTS.md 是操作铁律，evidence 查询最常命中
- public-lessons.md 集中化教训，防止"知道规则但不知道为什么"
- Phase/Discussion/Research 延后到 P1

**否决理由**：
- "只导 ADR" → 缺少"为什么有这条规则"的教训知识（铲屎官挑战暴露）
- "全量导入 docs/" → 噪音太大，未归档的讨论会污染 evidence

#### 共识 2：document_id 策略

**决策**：可推导稳定 ID + repo 相对路径 fallback

- 有天然编号的用编号：`adr:005`、`phase:5.1`
- 无编号的用 repo root 相对路径：`CLAUDE.md`、`docs/public-lessons.md`
- 不建持久化映射表

**否决理由**：
- "纯 path 绑定" → 目录重构时 ADR/Phase 的身份会变，需要 delete + reimport（Ragdoll原始方案，被Maine Coon"身份与路径解耦"论据说服后放弃）
- "docRef 映射系统" → 对 <50 文档的团队过度工程，引入映射表的持久化和同步开销（Ragdoll反对，Maine Coon同意简化）

#### 共识 3：Discussion 导入边界

**决策**：P0 不导入；规范预留 frontmatter `hindsight: include` 例外接口（P0 不实现）

- 讨论是过程不是结论，原文不进 Hindsight 默认搜索空间
- 讨论中的精华通过"沉淀检查"流入 ADR（否决理由）/ public-lessons.md（教训）/ CLAUDE.md（规则）
- 讨论文件在 git 里永远可查，用于审计

**否决理由**：
- "讨论全量导入" → 信噪比太低，200+ 行讨论文件的"结论"边界模糊（Ragdoll论据）
- "讨论绝对不导入，不留例外" → 可能丢失"尚未 ADR 化但已执行的临时规则"（Maine Coon论据，折中为预留接口）

#### 共识 4：Tombstone GC

**决策**：90 天保留期，到期物理删除 + 审计日志

- Tombstone 防止旧同步重导入已删内容，90 天绰绰有余（同步频率最多日级）
- Git history 兜底审计追溯，tombstone 不需要承担永久存档职责
- 物理删除前写审计日志（document_id、原始 tags、删除原因）

**否决理由**：
- "永久保留 tombstone" → 膨胀 bank 体积，增加 recall 噪音
- "立即物理删除" → 旧同步可能重导入已删内容

#### 共识 5："先查 Hindsight" 机制

**决策**：P0 prompt 约束 + 审计观测；P1 根据 evidence_hit_rate 评估 callback 强制

- P0：更新 CLAUDE.md / AGENTS.md，加规则"回答决策类问题前先 Recall"
- P0：审计日志记录猫猫是否在回答前调了 recall
- P1 判断标准：2 周后 evidence_hit_rate > 80% → 不需要 callback；< 50% → 升级到 callback

**否决理由**：
- "P0 就上 callback 强制" → 要改 AgentRouter 响应流程，复杂度高，不适合止血阶段（Ragdoll论据）
- "只靠 prompt，不做审计" → 无法观测执行率，无法判断是否需要升级（Maine Coon论据，折中为 prompt + 审计）

### 补充决策：教训沉淀机制

在铲屎官挑战下，新增第六项共识：

**决策**：建立 `docs/public-lessons.md` 作为集中化教训载体，纳入 P0 导入源

- 每条教训 7 槽位：坑/根因/触发条件/修复/防护/来源锚点/原理（可选）
- 固定 ID（LL-XXX）便于交叉引用
- 讨论收敛后做"沉淀检查"：否决理由 → ADR，教训 → public-lessons.md，规则 → CLAUDE.md
- Skills 动机作为教训来源，但不能单独作为证据（至少再挂一个外部锚点）

---

*附录 C 整理：Ragdoll 🐾（2026-02-13）*

---

## 附录 D：P0 落地与边界固化快照（2026-02-13）

> 说明：本节记录 Task 1-5 执行后的可验证结果，作为 P0 关账依据。

### 已完成（P0）

1. 导入契约 + 导入器 + CLI 落地
   - 入口：`pnpm --filter @cat-cafe/api hindsight:import:p0 -- --all`
2. 默认 evidence 检索收紧
   - 默认 tags：`project:cat-cafe` + `origin:git`
   - 默认 tagsMatch：`all_strict`（由 runtime config 管理）
3. 可观测三件套落地
   - 脚本：`scripts/hindsight/p0-health-check.sh`
   - 手册：*(internal reference removed)*

### 2026-02-13 验收快照

- `pnpm --filter @cat-cafe/api test`：`984 pass / 0 fail / 1 skip`
- `bash scripts/hindsight/p0-health-check.sh`：PASS
  - `stats.total_nodes=66`
  - `tags.total=23`
  - `/version` 当前返回 WARN（不阻断 P0）

### 执行中新增的安全护栏

- 导入源枚举改为 **仅 git-tracked 文件**（防止未提交文档误入 Hindsight）。
- 导入前新增 `document_id` 冲突检测（如双 `009-*.md`）并 fail-fast。
- retain 改为 `async=true`，避免同步写入超时中断全量 backfill。

### 明确不在 P0（P0.5）

- discussion 例外导入机制（`hindsight: include` + quarantined 生命周期）
- ADR 历史否决理由批量回填
- 自动化周评测流水线（precision/noise/staleness）

以上三项在 `docs/ROADMAP.md` 保持显式跟踪（#67/#68/#69）。

---

*附录 D 整理：Maine Coon 🐾（2026-02-13）*

---

## 附录 E：ADR 否决理由回填索引（P0.5 #68）

> 说明：本节记录 #68 的回填范围、验收口径与 commit 锚点，作为后续 review/导入的审计入口。

### 回填范围（git-tracked）

1. `docs/decisions/001-agent-invocation-approach.md`
2. `docs/decisions/002-collaboration-protocol.md`
3. `docs/decisions/003-project-thread-architecture.md`
4. `docs/decisions/007-cascade-delete-semantics.md`
5. `docs/decisions/008-conversation-mutability-and-invocation-lifecycle.md`
6. `docs/decisions/009-cat-cafe-skills-distribution.md`

### 验收命令

```bash
for f in \
  docs/decisions/001-agent-invocation-approach.md \
  docs/decisions/002-collaboration-protocol.md \
  docs/decisions/003-project-thread-architecture.md \
  docs/decisions/007-cascade-delete-semantics.md \
  docs/decisions/008-conversation-mutability-and-invocation-lifecycle.md \
  docs/decisions/009-cat-cafe-skills-distribution.md; do
  rg -q "^## 否决理由（P0\.5 回填）$" "$f" || { echo "MISSING: $f"; exit 1; }
done
```

### commit 锚点（阶段性，squash 前）

- `c0575fc`：锁定 #68 范围与 DoD（计划层）
- `5abcf3f`：回填 ADR-001/002
- `47af13f`：回填 ADR-003/007
- `b035da3`：回填 ADR-008/009
- `(合入 main commit，见 git log)`：#68 全量 squash 合入（含 ADR-001/002/003/007/008/009 + 附录 E + 验收）

### 2026-02-14 验收结果（Task 6）

- 标准段存在性：PASS（6/6 ADR 命中 `## 否决理由（P0.5 回填）`）
- 最小密度检查：PASS（ADR-001=3, ADR-002=3, ADR-003=3, ADR-007=3, ADR-008=4, ADR-009=3）
- 索引存在性：PASS（本附录 `附录 E` 命中）

### 合入 `main` 后固定收口动作（#68）

> 触发条件：本次合入包含可导入源变更（ADR / `CLAUDE.md` / `AGENTS.md` / `docs/public-lessons.md`）。

```bash
pnpm --filter @cat-cafe/api hindsight:import:p0 -- --all
bash scripts/hindsight/p0-health-check.sh
```

- 任一命令失败：不得宣称 #68 闭环完成，修复后重跑。
- 自动化（CI / freshness guard）不在 #68 内实现，跟踪于 `docs/ROADMAP.md` #71。

### 2026-02-14 收口执行结果（main）

- 导入：`pnpm --filter @cat-cafe/api hindsight:import:p0 -- --all`
  - 结果：`sources=10 chunks=111 dryRun=false`
- 健康检查：`bash scripts/hindsight/p0-health-check.sh`
  - 结果：`PASS stats.total_nodes=112 total_documents=30`
  - 结果：`PASS tags.total=35`
  - 结果：`WARN version request failed (http://localhost:8888/version)`（不阻断）

### 不做边界（#68）

- 不改 importer/runtime/API 代码。
- 不处理未追踪 ADR 草稿。
- 不覆盖 #67（discussion 例外导入）与 #69（周评测流水线）范围。
