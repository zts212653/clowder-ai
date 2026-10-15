# #1590 两条可证伪原型

这些脚本只在当前 worktree 的 `.cat-cafe/tmp/acp-prototypes/` 准备固定上游副本，不接生产。`*.test.template.ts` 复制到上游测试目录后执行；其相对 import 按生成位置解析。当前两条原型已分别独立Go，fixed pins/逐条件证据及失效条件见 `docs/design/2026-10-13-issue-1590-acp-unification/prototype-gates.md`；完整G0–G5和迁移仍未通过。下文held为历史样本的当时限制。

Codex 研究副本固定到 `51f78d67e46c3a96ee8d8bf4e43fc917ab21c73e`。从 worktree 根执行 `node scripts/acp-spikes/prepare-codex-prototype.mjs <研究副本绝对路径>`；在生成的 codex 目录执行 `npm ci --ignore-scripts`、`node build.mjs`、`node node_modules/vitest/vitest.mjs run src/__tests__/clowder-fence.test.ts`。另在 worktree 根用 API 的 tsx loader 执行 `codex-native-fence.test.ts`。

Codex 扩展提供 snapshot、exact steer 与 receipt，不能作为生产控制端口。现已有真实 native ID export、caller fence、有效/陈旧/非空未知/取消目标；2026-10-14 补上隔离持久认领、warm/cold 对账和 native clientId 证明，见控制恢复回执。设置 `CLOWDER_CONTROL_JOURNAL` 与冻结 `CLOWDER_CONTROL_BINDING_REVISION` 才启用持久路径；未设置时保留原型进程缓存。`CLOWDER_SPIKE_LOSE_NATIVE_REPLY=after-first` 只用于接受后故障注入。原型 journal 不承诺断电持久或活动断线存活，生产仍须复用既有 durable owner，完整 W4.P 仍 held。

`codex-stable-owner.mts` / `run-codex-stable-owner.mts` 是专用只读、随机令牌的loopback test owner，用实际HTTP响应中断证明存活owner中的native A仍可经ACP控制。不是生产HTTP consumer/principal/lease/persistence实现。公开策略检查用fake桥，真实fixture/no-duplicate/native fence另验；原owner退出反例保持。

Codex自动title也会新增native turn/start，历史计数按 `codex-budget-audit.json` 纠正。`prepare-codex-prototype.mjs --disable-auto-title` 准备独立 `codex-no-title`，链接baseline依赖后构建；`CLOWDER_SPIKE_DISABLE_AUTO_TITLE=1` 只禁测试title。用生成的clowder-title-budget检查默认行为/测试禁用，默认产品标题功能不改。最终stable owner运行器限1 ACP prompt、90秒/3秒退出grace，已观察1 native turn/start/0title，底层provider请求数和费用仍unknown、无USD硬限。须已有明确授权并设置 `CLOWDER_SPIKE_AUTHORIZED=1`，新样本名可用 `CLOWDER_SPIKE_RUN_ID`，禁止覆盖原证据。

Claude 研究副本固定到 v0.70.0 / `d0aafb1ca26427285ffaeac8d8a4452fff28e9c3`。从 worktree 根执行 `prepare-claude-prototype.mjs <研究副本绝对路径>`；生成目录安装锁定依赖后执行 `node node_modules/vitest/vitest.mjs run src/tests/clowder-next-boundary.test.ts`。这是未修 baseline，预期 1 通过、2 失败。

增加 `--patch-next` 回填 next 分支、窄 notice route、UUID 回执与原型协商。当前边界检查 3 通过；历史 2 通过/1 失败的“不允许 pending 时入队”判据已按独立审查纠正，真实 SDK 的未回答权限等待证据另存。完整上游 #1175 diff 与固定 v0.70.0 不兼容单独记录。

`--patch-followup` 是本地 narrow patch：原生命令 UUID → model message ID → tool ID → followup run ID 确认所有权，避免 owned autonomous idle 吞掉 steering 主请求的结清；外来任务的债务与 usage 仍分离。原无补丁的两类确定性 RED 已观察，修正版受影响 steering/next 检查 29 项通过，并重跑真实 now/next。生成目录用 `node node_modules/vitest/vitest.mjs run src/tests/acp-agent.test.ts src/tests/clowder-next-boundary.test.ts -t 'turn steering|W5.P'` 验证。

`--patch-cancel-queued` 补原子 native interrupt+queued 撤销、single-flight 入场 barrier、未知 SDK ingress 退役和已知 usage 保留。它依赖 **非公开 SDK `Query.request`**，仅 SDK0.3.232/0.3.285 + native2.1.296 已实测；next 还须 native `interrupt_cancel_queued_v1`。initialize 的 prototype 路由声明不代表 binding 已支持 next；缺 seam/cap 时入场拒绝。非法回执退役 query，不能用公开 interrupt 冒充。该补丁未获社区接受，版本/维护/生产限制见 `notice-boundary-evidence.md`。原型受影响 cancel/interrupt/usage/steering/next110项通过。

`prepare-claude-sdk-upgrade.mjs` 只在私有目录复制实际 SDK0.3.285 artifact、对齐其支持的 Zod4 peer/内容类型，未改全局安装或工作区依赖；旧 npm lock 保留为历史 pin。编译后执行同一原型检查；这一升级已取得真实回执，不是完整升级矩阵。

`--fault-ingress` 准备独立 `claude-ingress-fault`，使用已有 baseline 的 node_modules。测试钩子须 `CLOWDER_SPIKE_HOLD_SDK_NEXT=1`，将真实 SDK 输入泵的 next 延迟2秒，记录 native spawn/exit，不默认用于普通原型。

`run-claude-notice-boundaries.mts` / `claude-boundary-harness.mts` 是可审查的有界运行器；运行前须明确认证/出站授权并设置 `CLOWDER_SPIKE_AUTHORIZED=1`。当前用户已授权，不能将该授权移植给其他用户。`CLOWDER_SPIKE_SDK_VARIANT=upgrade/ingress` 选择样本，`CLOWDER_SPIKE_RUN_ID` 指定新样本名。运行前原子认领目录、保存源文件/参数/SHA，已有目录（含未完成/失败样本）拒绝覆盖。用API的tsx loader执行；`CLOWDER_SPIKE_NATIVE_VERSION`只支持冻结2.1.296（默认）或2.1.299，私有pinned-cli内二进制必须匹配 `claude-native-binding.mts` 的SHA，不沿PATH静默升级。

`run-codex-fence-repeat.mts` 在同一固定no-title binding做2次A→B，每次真实有效A+operation重放，B活动时由native拒绝stale A。限4个ACP prompt/180秒，fixture8秒/12次，无USD硬限；生成的native RPC计数不是provider模型轮次。需要同一明确授权和新的 `CLOWDER_SPIKE_RUN_ID`，默认 `fence-repeat-1`；原子认领目录并在模型访问前保存执行源，禁止覆盖已有样本。

`readonly-fixture-mcp.mjs` 只读取指定目录内的 synthetic sentinel，固定 scenario、8秒/12次上限，没有任意路径/命令入口。认证副本/实际 env/原始日志留私有 `.cat-cafe/tmp/`，不加入 Git；Claude预算2美元/8 SDK turns，禁 hooks/用户指令。elicitation 回答是固定合成布尔值，不是产品真人 UI。原型Go只证明fixed pins的技术路线，生产阶段仍按执行回执逐项验收。
