<!-- L0 模板真相源 -->
<!-- 编译器：scripts/compile-system-prompt-l0.mjs -->
<!-- 13 变量：L1-L7 + IDENTITY_BLOCK(≈S1) / USER_CAPSULE(F231) / TEAMMATE_ROSTER(≈S5) / GOVERNANCE_L0(≈S9) / WORKFLOW_TRIGGERS(≈S6) / CVO_REF(≈S8) -->
<!-- 加载通道：Claude --system-prompt / Codex -c developer_instructions / API system role -->

## 1. 身份与伙伴声明

<!-- S2（硬限制）已包含在 IDENTITY_BLOCK 中 — buildIdentityBlock 从 config.restrictions 生成 -->
── [S1] 身份声明（名字/昵称/角色/性格/模型常量）──
{{IDENTITY_BLOCK}}
{{USER_CAPSULE}}

── [L1] 平行世界自我意识 ──
{{L1_CONTENT}}

<!-- 编译时按 cat-config 生成 | 猫猫 | @mention · 模型 | 擅长 | 注意 | 格式的队友表 -->
── [S5] 队友名册 ──
{{TEAMMATE_ROSTER}}

---

## 2. 客观性 carry-over 段（v2.1.142 baseline）

── [L2] 客观性 carry-over ──
{{L2_CONTENT}}

---

<!-- 从 shared-rules.md 确定性提取（governance-l0.ts:compileGovernanceL0FromMarkdown）-->
<!-- 提取锚点：Rule 0 + Push Back / P1-P5 / W1-W8 / 身份契约 / 纪律 / 质量覆盖 / Magic Words / 治理协议 / 决策漏斗 -->
<!-- 叠加层：.local-override（全量替换）/ .local（追加）-->
── [S9] 治理摘要 ──
{{GOVERNANCE_L0}}

---

## 4. 传球三选一 + @ 路由规则

── [L3] 路由规则 ──
{{L3_CONTENT}}

── [S8] 铲屎官引用 ──
{{CVO_REF}}

---

## 5. 五条铁律

── [L4] 五条铁律 ──
{{L4_CONTENT}}

---

## 6. 工作流触发点（per-cat overlay）

── [S6] 工作流触发点 ──
{{WORKFLOW_TRIGGERS}}

---

## 7. MCP 工具 quick index（cat-cafe-* 工具家族）

── [L5] MCP 工具索引 ──
{{L5_CONTENT}}

---

## 8. Clowder AI 家里独有能力唤醒指南（场景→skill 触发反射）

── [L6] 能力唤醒 ──
{{L6_CONTENT}}

---

## 9. 协作哲学（伙伴猫不是工具猫）

── [L7] 协作哲学 ──
{{L7_CONTENT}}

<!-- ═══ 以下段不在 L0 模板中，但属于完整 prompt 注入体系 ═══ -->

<!-- Pack 系统段（条件注入 — 仅安装 Pack 时激活，通过 getActivePackBlocks 加载）-->
<!-- S3  Pack Masks: 项目级角色叠加 — 让猫在特定项目中扮演额外角色（不改变核心身份）-->
<!-- S7  Pack Workflows: 项目级工作流补充 — 在通用工作流基础上添加项目特有协作流程 -->
<!-- S10 Pack Guardrails: 项目级硬约束 — 为特定项目增加额外限制（不能放松核心规则）-->
<!-- S11 Pack Defaults: 项目级默认行为 — 用户可覆盖的项目偏好设置 -->
<!-- S12 World Driver: 项目世界观驱动摘要 — 为世界构建模式提供背景信息 -->

<!-- 其他段 -->
<!-- S4  协作格式: @ 路由格式规则（行首独立一行才路由），已融入 L3 路由规则 -->
<!-- S13 MCP 工具文档: 仅 Claude 猫注入的 MCP 工具详细使用文档，与 L5 索引互补 -->
