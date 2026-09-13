# F317 Phase 0 Spike: Qoder CLI 接入门禁验证

> **Status**: plan · **Owner**: 谱谱 (zcode) · **执行**: 火花 (spark) · **创建**: 2026-09-13
> **复核**: 点点 (dsh-v41-flash) 000001412 · 砚砚 (gpt-5.6-sol) 000001415（changes requested：禁止直接写 cat-template.json，先过本门禁）

## Why

评估 Qoder 作为家里新 coding 成员的可行性。三方复核结论：L1 CLI 路径成立但存在五个未验证关键面（凭证/协议/权限/网络/版本），必须先采集一手证据再决定是否立项 F317 正式接入。WorkBuddy 不作为猫成员（无 headless/provider 接口），留作未来 MCP 宿主候选，不在本 spike 范围。

## 前置事实（已验证）

- npm 包 `@qoder-ai/qodercli`：`-p`、`-o text|json|stream-json`、`-c/-r/--session-id`、`--permission-mode`、`mcp` 子命令均存在（点点实包复核）
- 官方入口为 `qoder`（dispatcher），npm bin 同时发布 `qoder` 与 `qodercli`；两者都要探测，不能预设（砚砚修正）
- 无 ACP `--stdio` 入口 → F161 零代码路径不可用；clientId 枚举无 qoder → 需新增 AgentService（非零代码）
- 凭证：`qoder login` 走浏览器 OAuth，无 PAT env；须预登录的独立 `QODER_CONFIG_DIR`

## Spike 任务（全部在服务器本机执行，不用笔记本结论）

| # | 任务 | 产出物 | 验收 |
|---|---|---|---|
| S1 | 安装 | pin 版本 + `--noproxy`（npm 代理已死）+ 记录 postinstall/平台二进制行为 | 安装可复现脚本 |
| S2 | 入口探测 | `qoder` vs `qodercli`：启动/退出/自动更新行为，记录实际版本 | 明确固定哪个入口 + 禁自更新 flag |
| S3 | 认证 | 预登录 `QODER_CONFIG_DIR` 挂载进 spawn；验证隔离（不污染用户配置） | 登录态可被服务端 spawn 复用 |
| S4 | 协议夹具 | 采集脱敏 golden transcript：stream-json 事件 schema、resume/cancel/错误/silent-completion | 夹具文件 + 与 claude-ndjson-parser 兼容性结论 |
| S5 | 权限 | 独立 config dir + `--setting-sources` 受控 + `dont_ask`；验证恶意 `.qoder/settings.json` 无法提权；禁止 `auto`/`yolo` | 提权测试红→绿记录 |
| S6 | MCP | invocation 级临时 mcp-config + `--strict-mcp-config` + `--allowed-mcp-server-names`，仅开放 `cat-cafe-memory` 只读工具 | 双层（服务器+工具）allowlist 实证 |
| S7 | 网络/额度 | 服务器本机 API endpoint 连通性；free preview 额度语义 | 结论 + 风险标注 |

## Spike 结果（2026-09-13，谱谱在本机执行）

| # | 状态 | 结果 |
|---|---|---|
| S1 | ✅ | `@qoder-ai/qodercli@1.1.51` 安装成功；注意 npm allow-scripts 默认拦 postinstall，需 `npm approve-scripts @qoder-ai/qodercli`；未遇代理问题 |
| S2 | ✅ | `qoder` 与 `qodercli` 同为 1.1.51，`qoder` dispatcher 正常转发 → **固定用官方入口 `qoder`**；帮助面未发现 `--no-auto-update` 类 flag，版本漂移防线待 S3 后复查（升级 slash 命令存在，需确认 spawn 路径不会触发） |
| S3 | ✅ | **切换到中国版**（铲屎官决策）：全局安装 `@qodercn-ai/qoderclicn@1.1.51`（bin `qodercn`，`~/.local/bin/qodercn`），铲屎官浏览器 OAuth 登录成功。登录态落在 `/Users/yuhan/.qoder-cn/.auth/user`；headless spawn 复用验证通过：`qodercn -p "reply with exactly: ok" -o json --config-dir /Users/yuhan/.qoder-cn` → `is_error:false, result:"ok", total_credits:1.10`。注意：app-server HOME（`app-server-home/.qoder-cn`）与用户 HOME 是两套，凭证必须指向用户 HOME 路径；国际版入口弃用 |
| S4 | 🟡 勘误（2026-09-13，点点复核推翻） | 原结论「schema 同构、`claude-ndjson-parser` 复用可行性高、成本接近零」**过度声明**。实测（`/tmp/qoder-probe/{stream,tooluse,err}.jsonl`）：事件形状兼容成立，但直接复用共享 parser 不成立——`stream_event` 完全缺席、usage token 全 0（真账 credits）、MCP status 词表断裂、无效模型静默回落、独有事件被丢弃。需要独立 Qoder 方言层，见 Phase 1 提案 P1 清单。本行 S4 状态仅指 schema 同构；夹具采集（错误/权限拒绝/resume/cancel/压缩 5 类）未完成，升级为 S4b 收尾门禁 |
| S5 | 🟡 partial(2026-09-13，砚砚复核降级) | **project/local 红→绿实证**：默认 setting-sources 下 project `.qoder/settings.json` 恶意 SessionStart hook 真实执行（红，marker 落盘）；`--setting-sources user` 阻断 project 与 local 两源（绿）。**CLI 接受 `--permission-mode bypass_permissions` 且正常成功返回**（红证）→ 运行时硬编码禁传 + `init.permissionMode` 断言。**未绿项**：user/config-dir/plugin 源无负测；builtin plugin hook 在 `--setting-sources user` + strict MCP 下**仍执行**（残留风险）——流上 allowlist 只能事后检测，hook_started 到达时已开始执行，预执行防线必须是 spawn 前的干净专用 config/profile（拒绝未授权 settings/plugins/hooks），流上 allowlist 降为第二道检测。auth 失败实测：exit 1 + `result.is_error:true` 但 `subtype` 仍 `"success"`。夹具：`test/fixtures/qoder/hook-{red,green-project,green-local}.jsonl` |
| S6 | 🟡 partial(2026-09-13，砚砚复核降级) | **已证**：deny-all 配置下 `init.mcp_servers=[]`（`plugin:qoder-context` 被过滤）、`--tools ""` → `init.tools=[]`、`init.permissionMode=default`、`protocol_version:1.4.0`、`init.model=Auto`（未传 `-m` 默认）。**未证**：只挂载 `cat-cafe-memory` 的目标配置、`CAT_CAFE_READONLY=true` 下精确 tools/list 断言——二者为 Phase 1 实现验收项，S6 在其完成前保持 partial。夹具：`test/fixtures/qoder/success.jsonl` |
| S7 | ✅(部分) | 本机 endpoint 连通（返回的是认证错误而非网络错误）；登录后实测计费为 credit 制（一次 ok 调用消耗 `total_credits:1.10`，`total_cost_usd:0`），免费额度语义与耗尽行为待长期观察 |
| S4b | 🟡 partial(2026-09-13，砚砚复核降级) | **已落仓 9 份脱敏夹具 + manifest**（`packages/api/test/fixtures/qoder/`）：success / tool-use / permission-denial / auth-error / silent-model-fallback / resume / hook-red / hook-green×2。**cancel 未采**：首次尝试的 transcript 实际以成功 `result` 收尾（SIGINT 未能中断该次 invocation），早先「exit 130、无 result」的声明有误，撤回。**压缩 deferred/N/A for Phase 1**（compact_boundary 冻结，P1-E），不计 green fixture。**MCP 实挂载**同 S6 未证项。两个 dialect 陷阱已写入 manifest 的 parser 契约节 |

## 收尾门禁结论（2026-09-13 r2，砚砚复核后修正）

**撤回「S4b/S5/S6 全绿、无 P1 红」的声明**——状态修正为：S5 🟡（project/local 绿，user/config-dir/plugin 源与预执行防线未证）、S6 🟡（deny-all 绿，目标 MCP 配置未证）、S4b 🟡（9 夹具落仓，cancel/压缩/MCP 挂载未采）。**可确认有效的证据**：project/local hook 红→绿、strict MCP 过滤 plugin server、`init.tools=[]`、auth-error 与 permission-denial 两个 dialect 陷阱、resume。**进入 Phase 1 实现的前置剩余项**：① spawn 前干净专用 config/profile 验证（预执行防线）；② `cat-cafe-memory` + `CAT_CAFE_READONLY=true` 挂载与 tools/list 断言；③ cancel 夹具重采。三项均可与 Phase 1 实现首 PR 并行推进，但①②须在首个真实 invocation 前完成。

复现命令（S3 后更新为中国版）：`qodercn -p "say hi" -o stream-json --config-dir /Users/yuhan/.qoder-cn`

## 出口条件

- 全绿 → 谱谱汇总，升级为 F317 正式提案（新 clientId + `QoderAgentService` + 事件 transform），进 Phase 1
- 任一 P1 红（认证不可隔离 / 协议不可解析 / 提权防线破）→ 停止，落 lessons，不立项

## 边界

- 火花不会自动跑测试：每个 S 项的验证命令由本计划给出，跑完把原始输出贴回
- 备选 `opencode-qoder-bridge`（第三方 0.1.11）仅作模型快速验证参考，不作终态
- CodeBuddy 是独立提案，不混入本文件
