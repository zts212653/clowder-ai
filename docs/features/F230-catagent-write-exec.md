---
feature_ids: [F230]
related_features: [F159, F143, F149, F050]
topics: [provider, agent-runtime, tools, security, architecture]
doc_kind: spec
created: 2026-05-07
community_issue: "zts212653/clowder-ai#653"
---

# F230: CatAgent Write/Exec — 轻量内置可工作 Agent

> **Status**: spec | **Owner**: 布偶猫 | **Priority**: P1
>
> 在 F159 只读基座上扩展写入和执行能力，让 CatAgent 成为 Cat Cafe 内置的、可自主完成任务的轻量 agent。
>
> **Anchor note**: 本文最初以 stale `F188` 草稿进入 housekeeping；`F188` 已被
> `F188-library-stewardship` 占用并处于活跃治理状态。第一次重锚到 `F219` 后又撞上
> `F219-tech-debt-architecture-evolution`。PR #850 最终将 CatAgent Write/Exec 重锚为
> 当前未占用的 `F230`，避免两个不同 feature 共享同一 truth-source anchor。

## Why

F159 交付了一个完整的只读 native provider：SSE 流式 + 15 轮 agentic loop + 3 个只读工具 + account-binding + workspace 安全。但只读 agent 无法执行任何实际工作——不能改文件、不能跑命令、不能完成一个从"看"到"做"的闭环。

CLI subprocess 是当前唯一能"干活"的通道，但它是重量级的：每次调用 spawn 一个完整 Claude Code 进程，启动成本高，轻量任务用 CLI 是杀鸡用牛刀。

Cat Cafe 需要一条**轻量、内置、可干活的 agent 通道**——不是替代 CLI 的全功能 runtime，而是一个与 Cat Cafe 强耦合的原生工作能力。

## What

### 核心定位

**轻量内置 working agent** — 与 Cat Cafe 深度集成，不追求 provider-agnostic 或 CLI 对等。

设计坐标：
- CLI 是"全功能重量级"：完整进程、订阅计费、MCP 支持、用户交互
- CatAgent 是"轻量内置型"：API 调用、分级工具、无用户交互、Cat Cafe 专用

### 分级工具面（Tiered Tool Surface）

权限模型的核心思路：**工具按副作用强度分级，每只猫通过 cat-config 声明允许的最高级别**。

| Level | 工具 | 副作用 | 授权方式 |
|-------|------|--------|----------|
| L0 (read) | read_file, list_files, search_content | 无 | 默认允许（F159 已有） |
| L1 (write) | write_file, patch_file | 文件变更 | cat-config 声明 |
| L2 (exec) | run_command | 进程执行 | cat-config 声明 + 命令白名单 |

向下兼容：未声明 toolLevel 的猫默认 L0（只读），与 F159 行为一致。

### Phase 划分

#### Phase A: 权限模型 + write_file

最小可用的写能力：

1. **CatConfig 扩展**：新增 `nativeToolLevel?: 'L0' | 'L1' | 'L2'` 字段
2. **buildToolRegistry 感知 toolLevel**：根据猫的配置决定注册哪些工具
3. **create-safe path resolver**（安全前置）：
   - 现有 `resolveSecurePath()` 对 ENOENT 放过——新建文件时 symlink 父目录可导致写入逃逸
   - 新增 `resolveCreatePath(root, userPath)`：找到最近存在的祖先目录 → `realpath()` 校验 → 重跑 denylist → 禁止通过 symlink 父目录创建
   - write_file / patch_file 统一走 `resolveCreatePath`（已有文件）或 `resolveSecurePath`（读取场景）
4. **write_file 工具**：
   - 参数：`path`（必填）、`content`（必填）
   - 路径验证：走 `resolveCreatePath()`（traversal + symlink ancestor + denylist）
   - 原子写：先写临时文件再 rename，避免半写
   - 大小限制：单次写入上限 256 KiB（防止 OOM / 磁盘耗尽）
5. **patch_file 工具**：
   - 参数：`path`（必填）、`old_text`（必填）、`new_text`（必填）、`expected_hash`（必填，文件内容 SHA-256 前 16 字符）
   - 语义：compare-and-swap 精确文本替换
   - 安全：① `expected_hash` 校验文件未被并发修改 ② `old_text` 必须在文件中唯一匹配，否则拒绝
6. **结构化审计**（独立于 tool_result 截断）：
   - write/patch 操作产出独立审计记录：`{ tool, path, bytesWritten, hashBefore, hashAfter, timestamp }`
   - 不依赖 500 字符 tool_result 截断，确保 side-effect 可追溯

#### Phase B: run_command + 命令策略矩阵

有限的、结构化的执行能力：

1. **命令策略矩阵**（替代 argv[0] 白名单）：
   - cat-config 新增 `commandPolicy?: CommandPolicyEntry[]`
   - 每条 entry：`{ binary: string, allowedSubcommands?: string[], deniedFlags?: string[] }`
   - 示例：`{ binary: 'git', allowedSubcommands: ['status', 'diff', 'log'], deniedFlags: ['--exec'] }`
   - 示例：`{ binary: 'pnpm', allowedSubcommands: ['test', 'check', 'lint'] }`
   - 无 entry = 不可执行（fail-closed）；entry 无 allowedSubcommands = 该 binary 全放行（慎用）
2. **run_command 工具**：
   - 参数：结构化 `{ binary: string, args: string[] }`（不接受字符串命令，消除 shell 解析歧义）
   - 校验：binary 对策略矩阵 → subcommand（args[0]）对 allowedSubcommands → flags 对 deniedFlags
   - 执行：`execFile`（不经过 shell），cwd 锁定 workspace 根
   - 超时：30 秒硬上限
   - stdout/stderr 捕获 + 截断（transcript 用），完整输出进结构化审计
3. **沙箱约束**：
   - 环境变量：只透传 `PATH` + `NODE_ENV`，**不透传 HOME**（防止 credential helper / .npmrc 泄露）
   - 网络：策略矩阵的 subcommand 级控制间接限制（如 git 只允许 status/diff/log，不允许 push/fetch）
   - 资源：maxBuffer 512 KiB、timeout 30s
4. **结构化审计**：
   - 每次执行产出：`{ binary, args, exitCode, durationMs, stdoutBytes, stderrBytes, policyEntry, timestamp }`
   - 拒绝也审计：`{ binary, args, rejectReason, policyEntry, timestamp }`
5. **失败策略**：
   - 非零退出码 → tool_result 包含 stderr，agentic loop 继续（turn-transient）
   - 超时 → SIGTERM + 3s grace → SIGKILL + error tool_result
   - 策略矩阵拒绝 → 立即拒绝，不执行，审计记录 rejectReason

#### Phase C: Cat Cafe Native Callback Tools

让 CatAgent 成为 Cat Cafe 的"原生手"——通过宿主侧 native tools，不走 MCP bridge：

1. **Cat Cafe native callback tools**（宿主自有，非 MCP 桥接）：
   - CatAgent 直接获得 Cat Cafe 特有工具：`post_message`、`create_task`、`update_task`
   - 实现方式：宿主在 buildToolRegistry 时注入 Cat Cafe callback tools，而非桥接 MCP server
   - 理由：MCP bridge 会把 CatAgent 推向第二套 runtime；F143 toolBridge seam 还未落地
2. **上下文注入**：自动注入当前 thread context、cat identity、workspace 信息到 system prompt
3. **任务闭环**：CatAgent 完成任务后自动更新 task 状态、发消息通知

> **Blocked by**: F143 toolBridge / permission policy seam 完成后，Phase C 可考虑更通用的集成方式

## Acceptance Criteria

### Phase A（权限模型 + write）
- [ ] AC-A1: CatConfig 支持 `nativeToolLevel` 字段，默认 L0
- [ ] AC-A2: buildToolRegistry 根据 toolLevel 决定工具注册，L0 猫看不到 write 工具
- [ ] AC-A3: `resolveCreatePath()` 实现：校验最近存在祖先 realpath + 重跑 denylist，阻止 symlink 父目录逃逸
- [ ] AC-A4: write_file 实现原子写（tmp + rename），路径走 resolveCreatePath
- [ ] AC-A5: patch_file 实现 compare-and-swap：expected_hash 校验 + old_text 唯一匹配
- [ ] AC-A6: 单次写入大小上限 256 KiB 强制执行
- [ ] AC-A7: write/patch 产出结构化审计记录（path, bytes, hashBefore, hashAfter），独立于 tool_result 截断
- [ ] AC-A8: 行为测试：正常写入、symlink 祖先逃逸拒绝、denylist 拒绝、大小超限拒绝、hash 不匹配拒绝

### Phase B（run_command）
- [ ] AC-B1: cat-config 支持 `commandPolicy` 策略矩阵，默认空（fail-closed）
- [ ] AC-B2: run_command 接受结构化 `{ binary, args }` 输入，不接受字符串命令
- [ ] AC-B3: 策略矩阵校验：binary → allowedSubcommands → deniedFlags，任一不通过则拒绝
- [ ] AC-B4: 命令通过 execFile 执行（不经 shell），cwd 锁定 workspace
- [ ] AC-B5: 30 秒超时（SIGTERM + 3s grace + SIGKILL）+ 512 KiB maxBuffer
- [ ] AC-B6: 环境变量只透传 PATH + NODE_ENV，不透传 HOME
- [ ] AC-B7: 每次执行/拒绝产出结构化审计记录
- [ ] AC-B8: 失败策略遵循 F149 failure taxonomy（turn-transient，不盲目重试有副作用命令）
- [ ] AC-B9: 行为测试：策略矩阵放行/拒绝、子命令级控制、flag 拦截、超时杀进程、env 不泄露

### Phase C（Cat Cafe Native Callback Tools）
- [ ] AC-C1: CatAgent 通过宿主侧 native tools 获得 Cat Cafe callback 能力（非 MCP 桥接）
- [ ] AC-C2: system prompt 自动注入 thread context + cat identity
- [ ] AC-C3: 任务完成后自动更新 task 状态

## ADR-001 修订要点

F230 需要修订 ADR-001 中 F159 添加的禁止边界：

| 原禁止项 | F230 修订 |
|----------|-----------|
| No write/edit/delete | L1 允许 write_file / patch_file，受 resolveCreatePath + 原子写 + 大小限制 + 结构化审计 |
| No shell/command execution | L2 允许 run_command，受命令策略矩阵（binary + subcommand + flag 级）+ execFile + 超时 + env 过滤 |
| No outbound network side effects | 维持禁止——策略矩阵通过 subcommand 级控制间接保证（如 git 只允许 status/diff/log） |

修订原则：**不删除原安全边界，而是在分级授权下有条件放开**。

## Dependencies

- **Built on**: F159（CatAgent Native Provider — 只读基座，Phase A-E）
- **Security infra**: workspace-security.ts（resolveSecurePath）、catagent-tool-guard.ts（validateToolInput、buildSafeCommand）
- **Failure model**: F149（turn-transient / session-poison / process-poison 三层分类）
- **Safety contract**: F050（External Agent Contract — capability/safety 声明）
- **Governance**: F070（Portable Governance — preflight 检查）

## Risk

| 风险 | 缓解 |
|------|------|
| 新建文件 symlink 祖先逃逸 | resolveCreatePath：校验最近存在祖先 realpath + denylist |
| write_file 写坏用户文件 | 原子写（tmp + rename）；大小限制；结构化审计（hashBefore/After） |
| patch_file 基于陈旧读取误改 | compare-and-swap：expected_hash 校验文件版本 |
| run_command 任意代码执行 | 策略矩阵（binary + subcommand + flag 级）+ execFile（不经 shell） |
| 环境变量泄露 credential | 只透传 PATH + NODE_ENV，不透传 HOME（防 .npmrc / credential helper） |
| 磁盘/内存耗尽 | 写入 256 KiB 上限；stdout 512 KiB；timeout 30s |
| 能力膨胀冲击 CLI 定位 | 分级授权 + 默认 L0；Phase C 才做 Cat Cafe 集成 |
| 审计不足 | side-effect 工具独立结构化审计，不依赖 500 字符 tool_result 截断 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 新开 F230 而非扩展 F159 | F159 的安全边界已被 ADR-001 和 5 轮 review 钉死，在原 spec 上改会重审已验收语义 | 2026-05-07 |
| KD-2 | 分级工具面（L0/L1/L2）而非全开或全关 | 平衡安全与能力：不同猫有不同信任级别 | 2026-05-07 |
| KD-3 | patch_file 用 compare-and-swap（expected_hash + 精确替换） | 防止基于陈旧读取的盲替换（review finding） | 2026-05-07 |
| KD-4 | run_command 用 execFile + 结构化 argv 而非 shell 字符串 | 消除 shell 注入 + 解析歧义 | 2026-05-07 |
| KD-5 | 命令策略矩阵（binary + subcommand + flag 级）而非 argv[0] 白名单 | argv[0] 太粗：whitelist node = 任意代码执行（review finding） | 2026-05-07 |
| KD-6 | Phase C 用宿主侧 native callback tools 而非 MCP bridge | MCP bridge 会推向第二套 runtime；F143 toolBridge 未落地（review finding） | 2026-05-07 |
| KD-7 | write/exec 工具独立结构化审计，不依赖 tool_result 截断 | 现有 500 字符截断不足以做 side-effect audit（review finding） | 2026-05-07 |
| KD-8 | 新增 resolveCreatePath 而非复用 resolveSecurePath | 后者对 ENOENT 放过，新建文件时 symlink 父目录可导致逃逸（review finding） | 2026-05-07 |

## Review Gate

- Phase A: 布偶猫 spec + 缅因猫 review → 铲屎官拍板
- Phase B: 跨 family review（安全敏感）
- Phase C: 产品方向讨论后再定
