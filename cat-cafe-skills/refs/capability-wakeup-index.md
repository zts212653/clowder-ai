---
feature_ids: [F203, F192]
topics: [l0, capability-wakeup, skills, features, awareness]
doc_kind: reference
created: 2026-05-27
related_features: [F128, F192, F201, F210, F211, F212, F186, F188]
---

# Capability Wakeup Index — 家里独有能力速查（L0 §8 配套）

> **L0 §8** = Tier 1（高频日常反射，13 条直接进 native L0 注入）
> **本文档** = Tier 1 完整 fallback + Tier 2（场景专项，低频但 trigger 明确）
> **数据驱动 iterate**: F192 Phase F `eval:capability-wakeup` per-cat per-scenario miss rate verdict → L0 §8 v2

## 分类轴：先过 reachability gate，再分 enforcement tier

L0 §8 trigger 写了 ≠ 猫真用。判断"为什么 miss + 怎么修"必须两层筛，不能跳：

**筛子 0 — Reachability（这能力当前 context 调得到吗？怎么调？）**
- ❌ 调不到 / trigger 没写"怎么调" → 猫误判"这是别人的工具"，100% miss。**修法 = 补"怎么调"一行，不是 hook**。
- 教训（2026-05-27）：opus-47 断言"terminal 调不了 workspace-navigator"——纯脑补没 verify（「我能猜出来」病）。实际 SKILL.md Step 3 = `curl localhost:${API_SERVER_PORT}/api/workspace/navigate`，Bash 直接调；opus-48 + opus-47 各实测 `{"ok":true}`。**一个你以为够不着的能力，miss 不是因为懒，是从没进考虑**——独立于"偷懒"的失败域，药方相反（补可达性 ≠ 上 forcing function）。

**筛子 1 — Enforcement Tier（过了筛子 0 才分）**
- **Tier A · episodic**：需要时自然想起，无零摩擦偷懒竞品。L0 advisory 够。例：`start_vote` / `expert-panel` / `deep-research`
- **Tier B · habit-resistant**：有零摩擦默认（纯文字 / 报路径）抢活，赶活时偷懒默认必赢。L0 advisory 必输，需 forcing function（hook：偷懒瞬间主动拦）。例：`rich-messaging` / `browser-preview` / `workspace-navigator`（补完可达性后仍是 B）
  - hook 守 KD-8：只给数据（"你提了 3 个路径 workspace 开了 0"），不替猫判断开哪个

> **为什么先 reachability**：把 reachability 误判当 Tier B 去开 hook = 开错药——给一个"以为自己没这工具"的猫弹"要不要打开？"，他回"我没这工具"。hook 治不了误判。F192 Phase F eval 只测**过了筛子 0 的真 Tier B**。

### 实战：原"一刀切 Tier B"三能力过筛后分化（opus-48 catch，每条带实测凭证）

opus-47 原把 `workspace-navigator` / `rich-messaging` / `browser-preview` 一起归 Tier B。过 reachability 筛子后**分化成三种，修法不同**——证据级别标清，不脑补：

| 能力 | reachability（实测凭证） | 过筛归类 | 修法 |
|---|---|---|---|
| `workspace-navigator` | ✅ 直接可调 `/api/workspace/navigate`（action `reveal\|open`）；curl `{"ok":true}` 实测（opus-47 + opus-48 各开过文件） | 真 Tier B | 已补 curl 调用方式（上文）；reachability 修完后才轮到 hook |
| `rich-messaging` | ✅ `cat_cafe_create_rich_block` MCP，同 `cat_cafe_post_message` callback 路径（本 session post_message 多次 routed ok）；未单独直调（避免 thread 噪声） | 真 Tier B（纯文字零摩擦抢活） | 候选 forcing-function（hook：长纯文字回复 + 无 rich block → 提醒） |
| `browser-preview` | ✅ 可达——cat POST `/api/preview/auto-open`（`preview.ts:92`，源码注释 "Cat-initiated auto-open — skips toast, directly opens browser panel" + `socketEmit('preview:auto-open')`）；同文件共 6 个 cat-callable POST（`/validate-port` `/open` `/close` `/navigate` `/auto-open` `/screenshot`，全是 `app.post<{...}>(...)` 泛型签名）。与 workspace-navigator `/api/workspace/navigate` **完全平行**，唯一区别多一个前提（dev server 先跑，cat 起） | 真 Tier B | 跟另两个一致：补可达性认知（cat 主动 POST auto-open，不是"等 Hub 检测/等铲屎官点"）+ 候选 hook |

**这张表本身就是 reachability 前置筛的价值**：三个"看着该 Tier B"的，过筛后**全是可达的真 Tier B**——workspace / rich-messaging / browser-preview 各有 cat 可调路径（`/api/workspace/navigate` / `cat_cafe_create_rich_block` / `/api/preview/auto-open`）。筛子的价值是**逼出每个的实测调用方式**，把"以为够不着"的误判挡在 hook 决策之外，不是脑补"哪个无 API"。

> **本表自身的事故（meta，opus-48 连环 catch，第三+第四层）**：
> - **第三层**：browser-preview 这格初稿被 opus-47 写成"无 push API、机制不同"。根因**不是"多行"**——是 grep 模式 `app.post('/api/preview` 假设 `app.post` 直接跟 `(`，但 `preview.ts` 全部 6 个 POST 都是泛型签名 `app.post<{ Body... }>('/...'`，`<{...}>` 把 `app.post` 和 `(` 隔开 → 对 6 个**全部**零命中（auto-open 恰好也多行，但那是次要），只匹配到 2 个 GET，下了否定结论。
> - **第四层（更狠）**：这条复盘 note 初稿自己把 POST 数成"4 个"、根因写成"多行格式"——**连"我没 verify"的复盘都没 verify**。opus-48 亲读 `preview.ts` 数出 6 个 POST + 泛型签名才拦下。
> 教训终态：**否定/数字结论（含复盘叙述里的数字、根因）必须读源文件确认，grep 命中为空 ≠ 不存在**（grep 漏泛型 `<{...}>` / 多行 / 别名）；**verify 不是一次性动作，是每个事实声明都要过的尺**。这证明脑补/reachability 病靠写 doc 治不好（doc 自己中招 4 层），只有 reviewer 亲验否定+数字结论的纪律能拦——见 `feedback_verify_reachability_before_classifying`。

## Tier 1（已在 L0 §8）— 详细 fallback / 边界

### 1. `rich-messaging` — 富媒体回复

**坏直觉**：默认纯文字回复（开发系猫习惯）
**场景 trigger**：
- 想发一堆文字 / 日志 / 步骤
- 给铲屎官展示 diff / 选项 / 列表
- 庆祝 / 仪式感 / 给铲屎官惊喜
- 给铲屎官听 / 看（语音 / 图 / 视频）

**用法**：`cat_cafe_create_rich_block` + 字段 `kind` / `v` / `id`
**完整 schema**：`cat_cafe_get_rich_block_rules`
**Fallback**：rich block 工具失败时退到 markdown table；连 markdown 不够再用纯文字

### 2. `browser-preview` — Hub 内嵌 localhost 预览

**坏直觉**：改完前端发"开浏览器看 http://localhost:5102/foo"
**场景 trigger**：
- 改了前端代码想让铲屎官看效果
- 前端 component / 页面 / 布局 review
- dev server 已起来想 demo

**用法**：worktree 内 OFFSET-aware ports；prevent runtime 3003/3004 误打
**边界**：localhost 预览用 `browser-preview`；外部网站用 `browser-automation`

### 3. `image-generation` — AI 生图

**坏直觉**：需要图时只找现成图（图床搜 / 用 placeholder）
**场景 trigger**：
- 架构图 / 视觉 mock / 完整 UI 设计稿
- PPT 内容页配图
- 信息图 / 像素画素材

**Backend 路由**：原生 tool call (Codex/Antigravity) / 浏览器自动化 (Gemini/ChatGPT)
**边界**：硬要求可编辑 / native text → 用 PPT/HTML 管线，不用 image-generation

### 4. `workspace-navigator` — 程式打开文件到 Workspace panel

**坏直觉**：报文件路径 "见 `packages/web/foo.tsx`"（+ 误判"这是 Hub 专属、terminal 调不了"）
**场景 trigger**：
- 铲屎官说"打开 X" / "看看那个文件"
- 想让铲屎官直接看到目标文件
- 文档 / 代码 / 设计图

**用法（reachability — 别误判成 Hub 专属！terminal/Bash 直接调 localhost HTTP，不走 MCP）**：
```bash
API_PORT="${API_SERVER_PORT:-3004}"   # 运行态 env 优先；验证：curl localhost:$API_PORT/api/workspace/worktrees 返回 JSON
curl -X POST http://localhost:$API_PORT/api/workspace/navigate \
  -H "Content-Type: application/json" \
  -d '{"path": "相对路径", "action": "open", "worktreeId": "cat-cafe"}'
```
完整：`workspace-navigator/SKILL.md` Step 3。F148 navigation 系统底层。
**分类**：reachability ✅（curl 实测 `{"ok":true}`）；enforcement = Tier B（零摩擦"报路径"抢活）——但**先补可达性认知（本条），再考虑 hook**，不是上来就 hook。

### 5. `pencil-design` — .pen 设计文件 + React 代码导出

**坏直觉**：手搓 CSS / 直接 JSX
**场景 trigger**：
- 改 UI 视觉 / 设计界面
- 需要高保真还原设计稿
- 设计探索 / variant 对比

**约束**：禁止 emoji 替代 SVG（feedback_design_to_code_fidelity）
**Fallback**：纯文字描述设计意图，让设计稿先行

### 6. `guide-interaction` — 场景式引导

**坏直觉**：丢一大段 README 让铲屎官自己看
**场景 trigger**：
- 铲屎官问"这个怎么用 / 怎么配置 / 怎么操作"
- 配置类 / 流程类 / 多步骤任务
- 新手 onboarding

**用法**：分步走动 + 视觉提示，配合 Guide Engine

### 7. `expert-panel` / `collaborative-thinking` — 多猫辩论

**坏直觉**：单猫死磕 / 一个视角硬上
**场景 trigger**：
- 架构决定（需要多视角校验）
- bug 死磕无解
- 技术趋势 / 竞品 / 行业分析
- 铲屎官说"帮我分析一下"

**用法**：`expert-panel` 多猫专家辩论 / `collaborative-thinking` 单猫独立思考

### 8. `cat_cafe_propose_thread` — 提议创建新 thread（F128）

**坏直觉**：口头说"你新开一个 thread"让铲屎官手动操作
**场景 trigger**：
- 想做新 issue 独立调查
- 子任务需要 isolated context
- 长讨论已超出当前 thread scope

**用法**：propose-first 流程 — 猫填好 thread 信息 → 卡片让铲屎官确认或编辑 → 系统创建
**ADR 锚点**：ADR-035

### 9. F211 外部 runtime session 查询

**坏直觉**：问铲屎官"截图给我看" / "你刚在哪说的"
**场景 trigger**：
- Antigravity / 孟加拉 / IDE-direct 会话像丢了
- cross-runtime session transparency 需要
- 跨 runtime 的猫历史 lookup

**Tools**：`cat_cafe_list_external_runtime_sessions` / `cat_cafe_read_external_runtime_session` / `cat_cafe_register_external_runtime_session`

### 10. F212 CLI 错误诊断

**坏直觉**：前端只显"codex cli 退出了"就盲猜
**场景 trigger**：
- CLI 子进程意外退出
- runtime stderr 抓不到完整错误
- 用户视角 only 一行 error message

**Tools**：读 `cliDiagnostics` / safe excerpt / `debugRef`
**Fallback**：直接 ssh 到 runtime worktree 看 stderr log（铲屎官 ops only）

### 11. F192 Eval Hub / Verdict Handoff

**坏直觉**：口头说"修了" / "已优化"
**场景 trigger**：
- SOP / harness / tool 改完不知道是 fix / build / sunset / keep_observe
- 需要 acted-on 闭环证据
- harness 漂移检测

**Tools**：`eval:a2a` / `eval:memory` / `eval:sop` domain registry + verdict bundles + re-eval closure
**边界**：本 PR 触发 `eval:capability-wakeup` 新 domain（Phase F）—— L0 §8 trigger reflex 自己也需要 eval

### 12. `search_evidence` + drilldown（F209 evidence recall 优化）

**坏直觉**：单刀搜一次就得结论
**场景 trigger**：
- 压缩后失忆 / 找旧决策
- "我记得最近讨论过 X"
- session 跨 invocation 查源头

**Drill-down 链**：
1. `search_evidence` 第一刀
2. 命中 anchor → `cat_cafe_read_session_digest`
3. 需要 per-invocation → `cat_cafe_read_session_events` (view=handoff)
4. 看具体 invocation tool calls → `cat_cafe_read_invocation_detail`

**Best practice**：`memory-search-best-practices` skill（多刀 recall coverage 8 类题型 recipe）

### 13. `cat_cafe_update_workflow` — 推 SOP 告示牌

**坏直觉**：阶段进度只在聊天里说 "我做完 X 进 Y"
**场景 trigger**：
- feature 推进到新 stage
- 想给下一棒猫看到当前 stage 状态
- 想给铲屎官 Hub visibility

**用法**：推 stage → 告示牌更新 → Mission Control panel 反映
**Schema 真相源**：F203 #748 SopDefinition (`sop-definitions/development.yaml`)

---

## Tier 2（不进 L0 §8，但 trigger 明确）

### 14. F201 Antigravity 中断 recovery

**坏直觉**：中断后盲重跑命令
**场景 trigger**：Antigravity session 中断但可能已经写文件 / 跑命令
**用法**：查 recovery card / supervisor / side-effect journal

### 15. F186/F188 Library memory federation

**坏直觉**：项目 repo 里搜不到就说"没有"
**场景 trigger**：跨领域知识 / Lexander 虚拟世界 / 多 domain knowledge
**Tools**：`cat_cafe_library_list` / `cat_cafe_library_dry_run` / `cat_cafe_library_create` / `cat_cafe_library_rebuild` / `cat_cafe_library_verify`

### 16. `video-forge` / `ppt-forge` / `tech-writing` — 对外产出

**坏直觉**：阶段成果只发一堆 commits / markdown
**场景 trigger**：
- Showcase 视频 / 教程录屏
- HTML PPT slide / 海报
- 对外技术博客 / 公众号

**Pipeline**：schema-driven 全链路（不要 ad-hoc 写）

### 17. `hyperfocus-brake` — 健康提醒

**坏直觉**：铲屎官连续肝代码 / 情绪波动时硬干
**场景 trigger**：hook 触发 / 连续工作时长超阈值 / 情绪信号
**用法**：三猫撒娇打断 hyperfocus

### 18. `deep-research` — 多源调研

**坏直觉**：单 grep / 单 WebSearch 草草搜两下
**场景 trigger**：
- 技术问题需要多源调查
- 设计决策需要证据
- 铲屎官说"调研" / "research"

**Pipeline**：Web Deep Research + Coder 合成 + 云端模型咨询

### 19. `mark_generalizable` / `nominate_for_global` — Lesson 全局化

**坏直觉**：学到 lesson 只记 local memory
**场景 trigger**：
- 跨 feature / 跨族适用的 lesson
- 别族猫也会犯的错
- shared-rules 候选

**Tools**：`cat_cafe_mark_generalizable` / `cat_cafe_nominate_for_global`

### 20. F210 AGY adapter sticky 行为

**坏直觉**：以为 `/model` 直觉判断就够
**场景 trigger**：Siamese / Antigravity carrier 或 model sticky 行为异常
**Source**：`docs/architecture/cli-integration.md` + F210

### 21. `enterprise-workflow` — 飞书 / 企微 IM 产物

**坏直觉**：只想到普通 chat
**场景 trigger**：
- 文档 / 表格 / 待办 / 会议 / 日程
- 一句话生成完整工作流

**Pipeline**：`lark-*` skill 家族（lark-doc / lark-base / lark-task / lark-calendar / etc.）

---

## MCP capability 快扫（underused cat_cafe_* 工具）

> 铲屎官 2026-05-27 提醒："盘点 skills + features 还不够，MCP 也得盘"。~75 个 `cat_cafe_*` 里大多数是 plumbing（`ack_mentions` / `get_thread_cats` / `list_*` / `update_task` 等机制类，不算 capability-wakeup）；下面是"做了但猫忘了用"的**能力类** MCP，按坏直觉列：

| 坏直觉 | 该用的 MCP | 说明 |
|---|---|---|
| 多猫意见不一就无限互 @ 辩论 | `cat_cafe_start_vote` | 结构化表决，N 票收敛，不靠口头来回（v1.1 已进 L0 §8） |
| 一个个 @ 召集猫开会 | `cat_cafe_multi_mention` | 一次性 @ 多猫进同 thread（L0 §7 quick index 有，但 trigger 易忘） |
| expert-panel / review 报告只发聊天 | `cat_cafe_generate_document` | 生成正式 DOCX/PDF 文档（凭证不过期、可存档、可对外） |
| 想重开一条已知调查路线 | `cat_cafe_run_perspective` | git-backed Perspective live query 计划重放（advanced/niche，返回 route hints + anchors，仍需 typed reader 取证据） |
| review 后 lesson 散在脑子里 | `cat_cafe_review_distillation` | 蒸馏 review 结论沉淀（配合 mark_generalizable） |

> **MCP 完整速查**：L0 §7 是 quick index（记忆 / 协作 / 任务 / Rich block / Drill-down 5 类）；本表补"能力类但易忘"的。完整工具集 `tool_search` 精确搜或读 `packages/mcp-server/src/tools/`。

---

## 维护协议

- **新增 capability**：当家里 ship 一个独有 feature/skill 且铲屎官观察到"做了但猫不知道用" → 加进本文档 Tier 2；连续 N 周 eval verdict miss rate > 30% → promote Tier 1（进 L0 §8）
- **降级 capability**：F192 `eval:capability-wakeup` verdict 显示某条 Tier 1 miss rate < 5% 持续 4 周 → demote Tier 2（出 L0 §8）
- **删除 capability**：feature sunset / skill 退役 → 同步删本文档对应条目
- **数据源**：F192 Phase F `eval:capability-wakeup` weekly verdict bundle（依赖 #748 后 ship）

## 编辑边界

- L0 §8 是 Tier 1 真相源，本文档是配套 fallback + Tier 2 仓库
- L0 §8 改 → 必须更新本文档对应条目
- 本文档 Tier 2 加新条目无需改 L0 §8
- L0 token budget 触顶时 → eval verdict 数据驱动 demote Tier 1 → Tier 2，不靠手感
