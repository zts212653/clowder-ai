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

**坏直觉**：报文件路径 "见 `packages/web/foo.tsx`"
**场景 trigger**：
- 铲屎官说"打开 X" / "看看那个文件"
- 想让铲屎官直接看到目标文件
- 文档 / 代码 / 设计图

**用法**：F148 navigation 系统，自动定位 + 高亮 + 上下文展开

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
