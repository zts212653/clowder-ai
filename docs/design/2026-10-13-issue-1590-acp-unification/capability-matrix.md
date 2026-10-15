---
feature_ids: [F143, F161]
related_features: [F254, F296, F300, F306, F318, F325]
topics: [acp, capability, parity, availability]
doc_kind: design
created: 2026-10-13
---

# 能力承接矩阵

基线见 README；此表是源码能力/产品合同，不是本次运行验收报告。`标准` 指协议可表达，不表示所选桥或宿主已实现。`扩展` 为固定 vendor 合同或本稿拟实现合同；`待验` 不能记支持。

| ID / 用户能力 | 原生/现有基线与目标 | ACP 承接方式及已知差异 | 可用门槛 / 验证 case |
|---|---|---|---|
| C01 实际 binary/HOME/profile/账号 | 当前 probe 与执行须一致；SDK 尚未显式 pin executable | execution/read 扩展 + 同一 launch plan | resolved/effective 绑定一致；V01 |
| C02 模型/强度/速度、served model | 保留现有选择与真实采用；served 未报即 unknown | 标准 configOptions/models + vendor/runtime config；不支持的值明确拒绝 | 每个已启用选项有采用回执；V02 |
| C03 创建/文本/思考流 | 所有已用本地 carrier 的基本对话 | 标准 new/prompt/update；现有 transformer | 顺序/最终文本/错误不丢；V03 |
| C04 图片、音频、resource/diff | 按各 carrier 已支持集合承接，不虚构新多模态 | 标准 content/capabilities；宿主 types 需补 resource 等；Codex audio 固定桥会过滤，不能宣称支持 | 已有输入类型零静默丢失；V04 |
| C05 工具成功/失败与完整结果 | Claude print/SDK 共用 parser 已证漏结果，需先修 | Claude bridge 已发同 ID rawOutput；#1519 ACP 映射已补 | 原生 ID/内容/状态贯穿实时→存储→重放；V05 |
| C06 并行、子工具、execution scope | 现有执行 scope 与父子关联保留 | 标准 toolCallId + 扩展 parent/native execution/principal | 同 ID 跨 session/child 不误配；V06 |
| C07 恢复、历史 replay、continuity preflight | 原生恢复与 F296 pre-prompt seam 不丢 | load/resume 按协商；桥扩展报告真实 native binding/epoch | 新会话不冒充恢复、replay 幂等、首 prompt 前 barrier；V07/V24 |
| C08 取消与上游静止 | 当前服务应停止模型/工具而非仅 UI 停字 | 标准 cancel + prompt cancelled + quiescence witness | deadline 内静止，未证不复用 lease；V08 |
| C09 L0/system/developer 指令 | 身份优先级保留 | Claude systemPrompt / Codex AIR；拟统一 trusted instruction 扩展 | native applied hash/role + 冲突输入与恢复验证；V09 |
| C10 MCP、skills、项目规则 | F145/现有 resolver、白名单、session credential | 标准 mcpServers + 原生 bridge provisioning | 内置/外部、轮换、项目 scope、requiredTools 都通过；V10 |
| C11 工具政策/审批 | 原生与平台既有审批边界保持；ACP factory 缺 handler | 标准 permission → 真实政策/审批 owner；移除默认 allow | allow/reject/cancel/超时来源可核；V11 |
| C12 真人问题/表单/URL | 现有 RuntimeInteraction 包括 native 问答 | 标准 elicitation（需协商且所选桥支持）或 typed 扩展 | pending/回答/拒绝/取消/迟到的真实 UI；V12 |
| C13 当前 context 与 window | 保留 carrier-specific 可信度；Codex app-server 尚未证明 authoritative usage | usage_update + 原生补充来源字段；不自动升可信度 | scope/source/epoch 有据，unknown 不触发阈值；V13 |
| C14 usage/cost、缓存、duration | 保留原生已提供字段及 exact/estimated 区分 | 标准 cost/usage 与 result/_meta 消费 + 扩展 | 不重复计费、不把累计当当前、不混货币；V13 |
| C15 压缩、自动阈值、身份 continuity | 原生 compact 与 F296 owner 的区分保留 | 协商 standard compaction + structured compact 扩展 | before/after/失败、缺窗口阈值不启用；V14 |
| C16 子 agent 生命周期与身份 | F306 semantic event/parent-child 与持久轨迹 | bridge 原始消息解析 → 有界 semantic extension | child start/final/error/取消不混主 turn；V06/V15 |
| C17 Codex exact turn 输入 | 已有 app-server expectedTurn 原生 fence | 固定 codex-acp steering 仅 sessionId/prompt；**必须补桥** | stale native turn 无副作用，回真实 turn；V16 |
| C18 Claude 非打断 notice | SDK queued_internal_turn 安全边界/结果关联 | 固定 claude-agent-acp steer preempt/abort；**必须另补非打断合同** | 主周期不断、notice UUID 与后续结果关联；V17 |
| C19 排队/抢占的诚实区分 | 用户普通发送/取消重启与精确追加不能混淆 | control.inputModes + typed receipts | 不支持 exact 时不自动另开 turn；V16/V17 |
| C20 Codex fork/compact | 现有 requestNativeFork/Compaction | structured control 扩展保留真实 native API | fork 父子/新绑定，compact observation；V14/V18 |
| C21 goal/review/status/inventory | 现有 F306 结构化接口、状态/plan/diff/guardian 等事件 | typed control + semantic event，非 slash 文本代替 | 同原生请求/回执/UI/历史效果；V18 |
| C22 experimental Realtime companion | 已启用 consumer 的 exact thread/text/websocket/v2 仍有效 | bridge 内原生连接 + 有界 ACP 扩展事件/control | opt-in、允许 consumer、exact binding与关闭；V19 |
| C23 HookCallback 与 freshness callbacks | SDK 原生 hooks、压缩/MCP callback 不丢 | 桥内注册函数；必要时 typed callback request | 真实 hook 触发、deadline、身份/权限一致；V10/V17/V20 |
| C24 池化、认证隔离、配置变更 | F149 pool/lease、现有 signature 退休 | 复用 pool，补桥/binding/instruction fingerprint | 双账号/双 cwd 不串；crash/config retirement；V21 |
| C25 轨迹、历史、UI 与 diagnostics | 现有 invocation/ToolEventLog/Bubble 及错误分类 | 同一 AgentMessage/semantic pipeline | 刷新/重连/重放等价，原始引用可核；V05/V07/V22 |
| C26 availability 与新人首次真实调用 | #1463 成员+carrier+节点；#1466承诺兑现 | bridge 贡献运行事实到已有 projection | installed/authenticated/ready 分离，unknown/stale诚实；V01/V23 |
| C27 北向能力/绑定声明 | AgentService 的 injectsL0Natively、usesChainKeyResume、contextBinding/ForCapacity、invocation continuity | 由同一有效 capability/实际绑定映射，不能固定默认值 | 原有 consumers 的分支、窗口解析、恢复 seal/create 与指令计数等价；V07/V09/V13/V24 |

## 各类成员迁移规则

| 成员/当前路线 | 验收基线 | ACP 未补齐时 |
|---|---|---|
| Claude print | 补 tool_result 后的 print 用户路径，及已有 hook/权限/恢复/MCP | 保持原服务；统一未完成 |
| Claude SDK | 上述公共集 + queued_internal_turn、callbacks、实际可执行物选择 | 非打断 notice 未验收不迁 SDK 成员 |
| Claude bg_daemon | 原生后台生命周期、按 chain key 恢复且 resumeSessionId 可换 UUID、既有 sidecar/transcript 语义 | 桥须保留 daemon owner 与 ID replacement，不能默认改 SDK或直接弃旧 native session |
| Claude interactive_pty | 原生交互输入/终端、tmux 环境、取消、transcript/最终输出与身份 | 可由桥复用原 PTY transport + 协商终端/交互合同；完整验收前保持原路线、统一未完成 |
| Claude API-key / OAuth 与 canary wrapper | 按 factory 的真实分支分别冻结认证、HOME/profile、billing 和 fallback 行为 | 不默换认证/计费，不把 API-key 分支误记为可复用本机 OAuth；不因 canary 失败盲发两次 |
| Codex app-server | 公共集 + 所有已暴露 typed native controls、continuity seam、exact turn、已启用 experimental | 不能为了统一删控制按钮或换成 exec 基线 |
| Codex exec | 其已用行为/工具/恢复/配置；不继承 app-server 的已验收声明 | 与原 exec 差分，能力升级另计 |
| DSH | 固定桥的 new/resume/config/prompt/cancel/tool 及实际使用的配置 | 不要求未有 fork/steer；缺必需身份通道或恢复证据仍阻断 |
| OpenCode/Kimi/其他 ACP | 各自原 carrier 和当前 ACP 路线的实际集合 | 不以别的 agent 的 capability 代填 |
| AGY/其他 legacy local | 自身已用能力 + F325 L0/认证/权限合同 | 桥无法承接时保留 native，明确未迁；不擅改计费或身份 |

平台治理功能位于 client 之上也要做回归：跨猫 @、任务/交接、共享记忆、授权、freshness、session continuity。wire 统一不会自动证明这些能力仍正常。

## Capability / availability 的消费方式

每条 capability 提供标准/vendor/自维护桥来源、固定版本、host consumer、policy 条件、实测 refs。UI 可以解释具体不可用原因，但隐藏既有功能不构成迁移通过。

`installed`、`authenticated`、`ready`、`supports feature`、`live verified` 是不同事实。低成本检测成功不代表真实 prompt 成功；已登录不证明某 bridge 使用相同 HOME；上游发事件不证明历史/UI 已消费。

默认迁移的 required 集是迁移前本成员集合加产品必须合同，不能在测试开始后通过删行让结果变绿。新增发现的原生能力补入矩阵并继续验收；experimental 只对已启用绑定纳入强制集，但禁用不能用于规避它。
