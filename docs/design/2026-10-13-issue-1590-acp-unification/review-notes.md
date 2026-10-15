---
feature_ids: [F143, F161]
topics: [acp, review, capability-parity]
doc_kind: review
created: 2026-10-13
---

# 独立内容复核与修订

复核者：独立子代理 `/root/acp_plan_review`；作者为 `/root`。同模型独立上下文复核，属于方案内容检查，不是跨家族正式实现批准，也未运行真实模型或全仓测试。

复核范围：统一目标、AgentService 既有能力、源码/标准判断、验收命令、权限/取消与回滚合同。结论：方向可实施，值得进入双端实现验证；未发现 P1，两项 P2 在方案交付前必须补齐。

| Finding | 独立证据 | 修订落点 |
|---|---|---|
| P2：完整范围遗漏 Claude bg/PTY/API-key/canary | claude-carrier-factory.ts 79–90；ClaudeBgCarrierService.ts 279–286 的 chain-key 与轮换 UUID | README 范围、capability-matrix 独立成员行、architecture 桥策略、contracts §9、implementation W0/W6、V24 |
| P2：北向声明与 continuity barrier 不够可执行 | types.ts 811–831；invoke-capacity-snapshot.ts 390–406；route-serial.ts 的 injectsL0Natively 消费 | C27、contracts §9 的声明表与 verdict→drain→settle→prompt 顺序、V24 反例、W0/W6 |

作者处理：两项均接受并补齐；未缩减统一范围。原复核者定向回读后确认 carrier 范围 P2 关闭，并指出 barrier 参数还需精确：settle 接收 `{ evidence, compactions }`，epoch 更新属于 settle 内的既有 owner。已按实际类型更正 §9，不在 settle 前另造 epoch 更新路径；最终定向回执另记下方。

最终定向回执：两项 P2 均关闭，未发现新的实质问题；确认 bg/PTY/API-key/canary 范围与 V24、北向声明和 settle barrier 已补齐。此回执仅确认方案内容修订完成，不代表实现、能力不退化或生产迁移验收。

作者增量检查：8 份 Markdown 的 13 个相对链接、27 个 capability ID、24 个 case ID 与交叉引用、8 个现有 API 测试路径通过；诊断脚本 `node --check` 与 `git diff --check` 通过。所有本次文件均低于 200 行。

复核已核定的事实：固定 Claude bridge systemPrompt/preempt steering、Codex public steering 无 caller target/turn receipt、官方 ACP _meta/扩展方法与可选 elicitation/compaction 均与正文相符。权限拒绝、取消静止、回滚与现有测试入口未见实质错误。

完整实现、真实能力保持、部署/默认迁移审批和 Feature close 均尚未发生，不能由本内容复核代替。

## 本轮用户 R1–R4 与文档/实施意见

本节保留实施前的方案复核状态；随后代码、真实运行与独立审查进展见 [执行回执](execution-evidence.md)，不能将下表的历史“未实现”读作当前进度。

| 反馈 | 判断与本轮处置 | 运行问题状态 |
|---|---|---|
| R1 P0 exact turn fence | 接受；W4.P先导出native ID、caller target原样到native fence，明确race反例/L1+L2与Go/No-Go | 尚未实现/真实验证，不能因文档修订记问题已消失 |
| R2 P0非打断notice | 接受；核到上游候选#1175仍OPEN，W5.P验证next语义、UUID/结果、pending交互，定义自维护成本与升级演练 | 未获上游接受回执、未实现补丁；语义仍需证明 |
| R3 P1默认allow | 接受修复要求；W2.S修两transport默认allow，W3.P接factory/nativepolicy/审批并覆盖V11分支；范围限定现有证据 | 本轮仅计划明确化，默认allow源码尚未修改；不推断整个平台审批已绕过 |
| R4 P1barrier集成 | 接受；独立V24-C定义I01–I08真实恢复/压缩/crash/全新进程/持久/UI与准确settle顺序 | 集成测试尚未落盘/运行；L1不可代替L2/L3 |
| README/扩展状态/成功标准 | 加回滚决策树、标准/vendor/候选/拟议/补丁状态、W4/W5全部成功条件 | 文档可审阅；不表示扩展现有支持 |
| W1优先、P0决策点、每Gate独立审查 | W1继续独立最高优先；前置原型双Go才继续全面迁移；G0–G5各自非作者/目标/版本/证据/失效回执 | 无运行Gate已passed，前一阶段批准不能代下一阶段 |

同型边界审视：不把协议可表达、候选代码、mock通过、文档复核或前一Gate通过转换成下一层支持。permission异常/无合法reject选项、候选next优先于pendingUserInputCount、barrier发送前/后crash等反例已加入相应验收。

本轮非作者复核回执：`/root/acp_plan_review` 定向检查R1–R4和新增计划后通过，未发现新的实质finding；确认W1独立优先、W2.S先于真实原型、双Go后全面增强、V24-C桥就绪即提供G3子集，未形成依赖循环。仅方案内容通过，P0/P1运行问题仍待实现/验收，不批准迁移。

取证限制：作者本轮已实际回读#1175 metadata/diff；复核者尝试独立访问GitHub时连接失败，采用作者回读证据，不声称复核者也独立读取远端成功。本轮增量检查10份MD/19相对链接、27能力/24主场景、8个现有测试路径与git diff均通过；所有修改仍为方案文档。
