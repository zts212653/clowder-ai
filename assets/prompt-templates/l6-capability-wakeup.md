非 SOP 默认链。"坏直觉 → 该用的"。不熟用 `tool_search` 搜 skill 名：

- Chat内交付→rich-messaging（无需富文本）
- 改前端 UI 想说"开浏览器看看" → `browser-preview` 渲染到 Hub panel
- 想说"文件在 X 路径" → `workspace-navigator` 程式打开
- 碰 UI / UX / 设计 / 视觉 → Clowder AI 内先读根目录 `DESIGN.md`（设计总入口），`pencil-design` 探索、`console-dev` 落地；外部项目按本地约定
- co-creator问"怎么用 / 怎么配置" → `guide-interaction` 场景式引导
- 架构决定 / bug 死磕 / 多视角 → `expert-panel` 多猫辩论；多猫表决用 `cat_cafe_start_vote`（不无限互 @）
- clowder-ai 等外部 GitHub PR/issue（F128 子 thread）→ 加载 `opensource-ops`：grounding、主人翁五问、custody 自理（服务端不再自动注入）；外部作者的修复球不派家猫
- 外部 runtime 会话像丢了 → `cat_cafe_list_external_runtime_sessions` / `cat_cafe_read_external_runtime_session`（F211）
- CLI 只显"退出了" → 读 `cliDiagnostics` / debugRef，不猜 stderr（F212）
- 阶段进度给下棒可见 → `cat_cafe_update_workflow` 推告示牌（不只发聊天）
- SOP / harness "修了 vs sunset"判断 → 走 Eval Hub / Verdict Handoff 闭环（F192）
- 压缩后失忆 / 找旧决策 → `search_evidence` + drilldown（见 §7），不单刀
- 获准开发新 Feature / 回原现场继续 Phase → `custody-recognition` 先核原 scope 与责任，再沿开发流程真正续做；唤醒不授予开发权限
- 收到 `context_management_hint`(warn) → `context-self-management` 自检（F225）
- 关于co-creator本人/个人近况/称谓/咱们关系/沟通边界的稳定事实 → `cat_cafe_propose_profile_update`（先 read_profile；Hub 审批；先 `tool_search`）；全猫共享→加`targetLayer:'corpus'`
- 关于什么输出/设计/表达/架构/系统才算好的可复用品味判断 → `cat_cafe_propose_taste`（Hub 审批；先 `tool_search`）
- 单次 continuity-valued 人物线索或频率 nudge → `proactive-memory-judgment`（不确定降档、不因未重复沉默）；skill 再路由三态。
- 纠正/表扬/Magic Word 不决定存哪，按内容走上两路；重复工具/流程摩擦 → `code-as-harness`（搜证据→代码守护）

> Skills 在 manifest ≠ 在认知路径。完整集 + Tier 2 见 `cat-cafe-skills/refs/capability-wakeup-index.md`；掉球率由 F192 Phase F `eval:capability-wakeup` weekly verdict 驱动 iterate。
