---
feature_ids: [F159]
topics: [agent, invocation, approach]
doc_kind: decision
created: 2026-02-26
---

# ADR-001: Agent 调用方式选择

## 状态
已更新（2026-04-11 修订）

## 日期
2026-02-04（初始）/ 2026-02-06（修订）/ 2026-04-11（F159 修订）

## 背景

Cat Café 需要程序化调用三只 AI 猫猫（Claude/Codex/Gemini），并保留它们的完整 agent 能力（文件操作、命令执行、MCP 工具使用）。

经过三猫研究团队的调研，我们评估了四种可能的方案。

## 决策

~~**我们选择方案 C：使用官方 Agent SDK**~~ → **已修订为方案 B：CLI 子进程模式 + MCP 回传**

具体技术选型（2026-02-06 修订）：
- **Ragdoll (Claude)**：`claude` CLI (`--output-format stream-json`)
- **Maine Coon (Codex)**：`codex` CLI (`exec --json`)
- **Siamese (Gemini)**：`gemini` CLI / Antigravity IDE（双 adapter）

> 修订原因：SDK 只能使用 API key 付费，无法使用 Max/Plus/Pro 订阅额度。详见 `docs/phases/phase-2.5-cli-migration.md`

### F159 修订：Opt-in Native Provider 路径（2026-04-11）

**在方案 B 保持默认主路径不变的前提下**，允许通过 F143 provider 契约接入 opt-in 的 native provider（API 直连）。

- **定位**：F143 框架下的 provider 扩展，和 anthropic/openai/google 同级，不是新的独立 runtime
- **内部实现**：native provider 自有 agent loop / tools / compact 是其内部实现细节（类比 Claude CLI 也有自己的内部 loop），不与 Cat Cafe 控制面混淆
- **北向接口**：复用现有 `AgentService.invoke()` 门面，不新增北向 API
- **激活方式**：通过 F143 provider registration / variant profile 显式 opt-in，默认不影响任何现有猫猫

**允许边界：**
- ✅ 作为 F143 provider 契约（AgentDescriptorV1 / RunHandleV1）的实现接入
- ✅ 使用 API key 计费（opt-in，需显式绑定账户）
- ✅ 自建 read-only 工具集（文件读取、目录列表、内容搜索）
- ❌ 不替代 CLI 子进程作为默认调用路径
- ❌ 不引入新的北向 API 或控制面
- ❌ 不绕过现有安全基线（account-binding / workspace-security）
- ❌ 不绕过 governance preflight（F070 fail-closed 治理门禁）
- ❌ 不覆写 home 目录配置文件（ADR-017 铁律：`~/.codex/AGENTS.md` 等）
- ❌ F159 scope 内不开放 write/edit/delete、shell/command execution、outbound network side-effect 工具（仅 read-only 工具集）

**成本模型：**
- Native provider 使用 API key 付费，不消耗订阅额度
- 适用场景：轻量协作任务、中等复杂度分析任务（CLI 启动开销不划算的场景）
- 不适用场景：重度编码任务（应继续使用 CLI 子进程以利用完整 agent 能力 + 订阅额度）

**安全硬 gate（准入门槛，非 backlog）：**
1. **Account-binding fail-closed**：凭据解析必须走 `resolveBoundAccountRefForCat` → `resolveForClient`，禁止回退扫描任意 key
2. **Symlink-safe sandbox**：工具路径校验必须用 `fs.realpath()` 二次校验，确保物理路径在 boundary 内
3. **Injection prevention**：工具参数（如 rg pattern）必须防注入（`--` separator）
4. **F050 Safety Contract**：满足 External Agent Contract v1 的 Section D（Capability）和 Section F（Safety）
5. **F149 Failure taxonomy**：按三层分类（process-poison / session-poison / turn-transient）处理故障
6. **Governance fail-closed**：调用前必须通过 governance preflight（F070），不可跳过或降级

**与相关 Feature 的边界：**
- **F143**：native provider 实现 F143 的 provider 契约，不绕过宿主抽象
- **F149**：复用 F149 的 failure taxonomy（三层分类）和 concurrency metadata seam（`supports_multiplexing` flag），不接入 ACP 式 process pool / session lease 机制
- **F050**：达到 L1 兼容性门槛（stable invocation + basic governance）后方可灰度激活

## 方案对比

| 方案 | 描述 | 优点 | 缺点 | 结论 |
|------|------|------|------|------|
| A: 纯 API | 直接调用 Chat API | 简单 | 失去 agent 能力 | ❌ 不满足需求 |
| **B: 子进程** | spawn CLI 作为子进程 | **完整能力、用订阅额度** | 启动开销、解析复杂 | ✅ 采用（默认主路径） |
| ~~C: SDK~~ | 使用官方 Agent SDK | 低延迟、流式响应 | **只能用 API key 付费** | ❌ 弃用 |
| D: 外部进程 | 独立进程 + MCP 协调 | 松耦合 | 同步复杂 | ⚠️ 特殊场景 |
| **E: Native Provider** | F143 provider 契约下的 API 直连 | 低延迟、无 CLI 开销 | API key 计费、需安全硬 gate | ✅ Opt-in（F159） |

## 理由（修订后）

1. **使用订阅额度**：CLI 模式可使用 Max/Plus/Pro 订阅，无需 API key 付费
2. **完整 Agent 能力**：CLI 保留所有 agent 功能（文件操作、命令执行、MCP 工具）
3. **NDJSON 流式响应**：各 CLI 均支持 JSON 流式输出，可实时解析
4. **MCP 回传**：通过 HTTP callback，猫猫可主动发言和获取上下文
5. **统一抽象**：`spawnCli()` + `CliTransformer` 统一三猫差异

## 已知风险（修订后）

1. **CLI 启动开销**：每次 spawn ~500ms-2s，可考虑进程池优化
2. **NDJSON 格式变化**：CLI 升级可能改变输出格式，需版本锁定 + 容错解析
3. **Antigravity 回传**：MCP callback 可能无响应，需 gemini-cli fallback
4. **Session 内存存储**：重启丢失，Phase 3 迁移 Redis

## 缓解措施（修订后）

1. 为每个 CLI 编写独立的 `AgentService` 类 + `CliTransformer`，隔离差异
2. 使用统一的 `AgentMessage` 接口，屏蔽 CLI 输出差异
3. `spawnCli()` 工具封装超时、abort、僵尸进程防护
4. Gemini 双 adapter：`gemini-cli` (headless) 和 `antigravity` (IDE) 互为 fallback

## 否决理由（P0.5 回填）

- **备选方案 A**：继续采用官方 Agent SDK（原 ADR 初稿方向）
  - 不选原因：SDK 路径绑定 API key 计费，无法复用 Max/Plus/Pro 订阅额度，长期成本不可接受。
- **备选方案 B**：三猫统一改成纯 API 模式
  - 不选原因：纯 API 丢失 CLI 侧 agent 能力（文件操作、命令执行、MCP 工具链），与 Cat Café 协作目标冲突。
- **备选方案 C**：外部独立进程编排（仅保留 D 方案）
  - 不选原因：进程同步、会话对齐和回传链路复杂度过高，不符合当期交付节奏。

**不做边界**：本轮不引入进程池和统一守护进程优化，启动性能优化留到后续独立议题。

### 否决理由 — F159 Native Provider（2026-04-11 补充）

- **备选方案 F**：Native provider 作为独立 runtime（独立控制面 + 自建安全基线）
  - 不选原因：和 F143 宿主抽象重复，安全基线无法复用，北向接口膨胀。参见 PR #397 maintainer review。
- **备选方案 G**：Native provider 替代 CLI 成为默认主路径
  - 不选原因：CLI 可使用订阅额度，成本优势不可替代；重度编码任务 CLI 的完整 agent 能力更强。

## 参考

- 研究报告：`research-report/` 目录下的三份报告
- OpenClaw 项目：https://github.com/openclaw/openclaw
- MCP SDK 文档：https://modelcontextprotocol.io/

## 参与者

- Ragdoll（Claude Opus 4.5）
- Maine Coon（GPT Codex）
- Siamese（Gemini 3 Pro）
- 铲屎官

---

## 修订记录

| 日期 | 变更 | 原因 |
|------|------|------|
| 2026-02-04 | 初始决策：选择方案 C (SDK) | 完整 agent 能力 + 低延迟 |
| 2026-02-06 | 修订为方案 B (CLI 子进程) | SDK 只能用 API key，无法用订阅额度；Gemini API 模式无文件操作能力 |
| 2026-04-11 | F159：新增方案 E (Opt-in Native Provider) | 轻量任务 CLI 启动开销不划算；RFC #434 + maintainer review 确认方向；安全硬 gate 作为准入门槛 |
