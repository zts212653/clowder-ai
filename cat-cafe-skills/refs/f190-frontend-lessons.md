# F190 Frontend Lessons — Console 重构案例集

> 本文件是 `console-dev` skill 的补充参考，记录 F190 Console 重构中的具体案例。
> 主干规则在 `console-dev/SKILL.md`，这里只放案例和上下文。

## Gate 2 案例：Design Token 渐进迁移

**问题**：F190 将 `cafe/no-hardcoded-colors` 从 warn 升级为 error，导致 20+ 文件构建失败。

**解法**：
- 新文件立即 error（零容忍）
- 旧文件按文件名加入 eslint override 列表（非目录级）
- Override 列表随每个 PR 只减不增

**教训**：渐进迁移的节奏是"新严旧宽 + 排期消化"，不是"全部一刀切"也不是"永久豁免"。

---

## Gate 3 案例：Redacted Placeholder Guard

**问题**：MCP 配置编辑时，env/headers 中的敏感值以 `••••••` 显示。用户不修改直接保存，前端把 `••••••` 当真值提交回后端，覆盖了真实 secret。

**解法**：
- Submit 前检测 payload 中是否包含 redacted marker
- 检测范围：args / url / command / env values / headers values
- 包含 → 拒绝提交 + toast 提示用户

**教训**：Display value 和 submit value 必须有明确边界。脱敏展示值永远不能流入写入路径。

---

## Gate 3 案例：组件拆分阈值

**问题**：McpConfigModal 超 350 行后可读性骤降，reviewer 难以定位修改点。

**解法**：
- 抽出 `HttpEndpointCard`、`HttpHeadersCard` 作为 sub-component
- 抽出 `DynamicKVList`、`DynamicList`、`FormSection`、`FormItem` 作为表单 primitive
- Modal 主体只做编排，不做细节渲染

**教训**：拆分方向是"视觉独立块"（sub-component），不是"工具函数"（utils）。

---

## Gate 4 案例：Shared Primitive 回归

**问题**：修改 `FormItem` 的 padding 后，所有使用它的 Modal 间距变化，但只验证了当前 Modal。

**教训**：改共享 primitive → 至少抽样 3 个使用方验证。可通过 grep 使用方快速定位。

---

## Gate 1 案例：Feature Placement L1-L4

**问题**：Console 早期每个新功能都想要侧边栏入口，导致导航膨胀。

**解法**：制定 4 级入口决策树——L1 极慎重（≤5），多数功能归入 L2/L3。

**教训**：入口是有限资源。每次新增 L1 都要问"用户真的每天用这个吗？"

---

## Gate 4 案例：State Matrix Blindness

**问题**：Service 状态面板只做了 running/stopped 两态，上线后遇到 installing/error/not-installed 全显示异常。

**解法**：Gate 1 阶段画出完整状态矩阵（installed × enabled × health），每个组合有对应 UI。

**教训**：状态数 = 维度的笛卡尔积。只做 2 个状态 ≠ 完成了 UI。

---

## Gate 3 案例：Auth Pattern 一致性与 Fail-Closed 原则

**问题**：Service management 的 owner check 与系统内已有模式不一致——同一系统中有的路由 fail-closed，有的 fail-open，行为不可预测。

**正确范式**：
- 管理/写入敏感配置的 owner guard 必须 **fail-closed**（未配置 = 拒绝）
- 若需要单用户 localhost 便利模式，必须**显式 opt-in**（如 env flag `SINGLE_USER_MODE=true`），不能靠 owner 缺失自动放开
- 同一系统内所有写入路由的 auth pattern 必须统一

**教训**：
1. 新写鉴权逻辑前先 grep 系统内已有模式，保持一致
2. "便利"不能以牺牲默认安全为代价——便利模式需要显式声明
3. Fail-open 作为默认行为是安全漏洞，即使当前只有单用户场景
