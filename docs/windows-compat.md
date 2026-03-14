# Windows 平台兼容性修复

> 分支: `win/spawn-fix` | 日期: 2026-03-14 | 状态: 已验证

## 背景

Clowder AI 最初在 macOS 上开发，CLI 子进程调用（`claude`、`codex`、`gemini`）在 Windows 上无法启动，报错 `spawn claude ENOENT`。根本原因是 Windows 上 npm 全局安装的命令行工具以 `.cmd` shim 脚本形式存在，Node.js `child_process.spawn()` 在不启用 `shell: true` 的情况下无法解析 `.cmd` 文件。

## 修改的文件

### 1. `packages/api/src/utils/cli-spawn.ts`

**问题**: `defaultSpawn()` 直接调用 `spawn('claude', args)`，Windows 下找不到 `claude` 可执行文件。

**修复方案**: Windows 上绕过 `.cmd` shim，直接用 `node` 启动底层 JS 脚本。

新增函数:

| 函数 | 用途 |
|------|------|
| `resolveCmdShimScript(command)` | 解析 `.cmd` shim 文件，提取底层 `.js` 入口脚本路径 |
| `escapeCmdArg(arg)` | 当 shim 解析失败时，为 `shell: true` 模式转义命令行参数 |

`resolveCmdShimScript` 的解析策略:
1. **已知路径快速匹配** — 检查 `%APPDATA%/npm/node_modules` 下 `claude` 和 `codex` 的标准安装路径
2. **动态 .cmd 解析** — 通过 `where <command>.cmd` 定位 shim 文件，解析内容中 `%dp0%` 相对路径，提取实际 JS 脚本
3. **缓存** — `resolvedShimCache` (Map) 缓存解析结果，避免重复文件系统查找

`defaultSpawn` 修改后的行为:
```
Windows 平台:
  shim 解析成功 → spawn('node', [scriptPath, ...args])  // 直接启动，无 shell
  shim 解析失败 → spawn(command, escapedArgs, { shell: true })  // 降级方案

非 Windows 平台:
  行为不变 → spawn(command, args)
```

### 2. `packages/api/src/domains/cats/services/agents/providers/ClaudeAgentService.ts`

**问题 A**: API 服务器运行在 Claude Code 内部，子进程继承了 `CLAUDECODE=1` 环境变量，导致 Claude CLI 拒绝启动（"nested session detected"）。

**问题 B**: Claude CLI 在 Windows 上需要 git-bash，但非标准安装路径（如 `I:\Git\`）下无法自动发现。

**修复方案**:

新增函数:

| 函数 | 用途 |
|------|------|
| `findGitBashPath()` | 在 Windows 上定位 git-bash 可执行文件（带缓存） |

`findGitBashPath` 的搜索策略:
1. 检查标准安装路径 `C:\Program Files\Git\bin\bash.exe`
2. 通过 `where bash` 动态发现所有 bash.exe，用正则 `\\Git\\.*\\bash\.exe$` 过滤（排除 WSL bash）
3. 结果缓存到 `cachedGitBashPath`，仅查找一次

`buildClaudeEnvOverrides` 改动:
- **返回值类型**: 从 `Record<string, string | null> | undefined` 改为 `Record<string, string | null>`（始终返回对象）
- **始终清除**: `CLAUDECODE` 和 `CLAUDE_CODE_ENTRYPOINT` 环境变量（防嵌套检测）
- **Windows 专属**: 自动设置 `CLAUDE_CODE_GIT_BASH_PATH` 环境变量
- 调用处 `cliOpts.env` 从条件传递改为始终传递

## 启动方式

Windows 上项目不使用 `dotenv`（原始 macOS 开发流程用 bash `source .env`），需要改用 Node.js 内置的 env-file 加载:

```bash
# 启动 API（Windows）
cd worktrees/win-spawn-fix
node --env-file=.env packages/api/dist/index.js

# 启动前端
cd packages/web && pnpm dev
```

注意 `.env` 中的 `API_SERVER_PORT` 必须与前端期望的端口一致（默认 3002）。

## 验证结果

| 智能体 | CLI 工具 | 状态 |
|--------|---------|------|
| Opus (布偶猫) | `claude` | 已验证 — session 建立、响应正常 |
| Codex (缅因猫) | `codex` | 已支持（同一 spawn 机制） |
| Gemini (暹罗猫) | `gemini` | 已支持（同一 spawn 机制） |

## 已知限制

- Windows 上 Claude CLI 偶发 libuv assertion crash (`UV_HANDLE_CLOSING`)，是 Claude CLI 的外部 bug，非本项目问题
- `resolveCmdShimScript` 目前只内置了 `claude` 和 `codex` 的已知路径快查，其他命令走通用 `.cmd` 解析
