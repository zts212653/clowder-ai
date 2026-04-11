---
feature_ids: [F113]
topics: [deploy, onboarding, linux, macos, windows, community, directory-picker, cross-platform]
doc_kind: spec
created: 2026-03-13
source: community
community_issue: https://github.com/zts212653/clowder-ai/issues/14
---

# F113: Multi-Platform One-Click Deploy

> **Status**: in-progress | **Source**: clowder-ai #14 (mindfn) | **Priority**: P2

## Why

当前安装流程需要手动安装十几个依赖（Node.js、Redis、pnpm、Claude CLI 等），并手动配置环境变量。对新用户门槛过高，特别是非开发者背景的内测小伙伴。

此外，目录选择器（`pick-directory`）依赖 macOS 的 `osascript`，在 Linux/Windows 上完全不可用。我们已有自建的 WorkspaceTree 文件浏览器，应统一用 web-based 方案替代原生系统调用。

## What

### Phase A: Linux 一键安装 ✅

`scripts/install.sh` — 自动检测 Debian/Ubuntu、CentOS/RHEL/Fedora，安装依赖、配置环境变量、构建并启动服务。

- 系统依赖检测 + 自动安装（git、curl）
- fnm/Node.js 20 + pnpm + Redis
- AI CLI 工具安装（Claude Code、Codex、Gemini CLI）
- TTY 安全读取（非交互环境兼容）
- npm registry fallback（中国镜像）
- provider-profile 配置引导
- 2026-03-19：已吸收 `clowder-ai#128` 的 Linux TTY/install/runtime 修复（cat-cafe PR #565），保留内部 runtime 语义并补齐回归测试
- 2026-03-19：post-review follow-up（cat-cafe PR #566）已合入，补齐 `/workspace` provider-profile sharing 边界，并修正 installer completion banner 的家里端口口径

### Phase B: macOS 一键安装（PR #174 已合入 main，AC-B6 待验收）

**同一个 `scripts/install.sh` 的 Darwin 分支**（不是单独的 `install-mac.sh`）。macOS 无需 sudo，全程用户态安装。

核心能力：
- **Homebrew 自动安装**：Apple Silicon（`/opt/homebrew`）+ Intel（`/usr/local`）双路径检测；非 login shell 下也能发现已有 brew（`shellenv` 注入）
- **Xcode CLT**：缺失时自动 `xcode-select --install`，30min 非致命超时（不阻塞安装）
- **Node.js**：优先 fnm，fallback `brew install node@20`；keg-only formula 的 bin 路径显式注入 PATH
- **pnpm**：corepack → npm fallback；安装后无条件 `persist_user_bin` + 当前 session PATH 注入
- **Redis**：`brew install redis` + `brew services start redis`（启动失败非致命，install 是关键）
- **AI CLI 工具**：
  - Claude Code: `brew install --cask claude-code`（macOS）/ `npm install -g @anthropic-ai/claude-code`（Linux）
  - Codex: `brew install --cask codex`（macOS）/ `npm install -g @openai/codex`（Linux）
  - Gemini: `npm install -g @google/gemini-cli`（无 brew formula）
- **npm global bin PATH 发现**：`npm config get prefix` 解析 + 当前 session 注入 + `persist_user_bin` 到 `~/.local/bin`
- **PATH 持久化**：写入 `~/.zprofile` + `~/.bash_profile`（或 `~/.profile`），覆盖 zsh 和 bash 用户
- **bash 3.2 兼容**：macOS 自带 bash 在 `set -u` 下空数组遍历用 `${arr[@]+"${arr[@]}"}` 规避 unbound variable
- **root 拒绝**：macOS 上 `EUID == 0` 直接拒绝（Homebrew 不支持 root）
- **测试覆盖**：20+ 平台测试（`install-script-platform.test.js`），含 keg 路径注入、prefix 降级防护、cask token 精确断言

### Phase C: Windows 一键安装 ✅

`scripts/install.ps1` — 原生 PowerShell 安装器（非 WSL 前置），检测/安装 Node.js、pnpm、Redis、AI CLI 工具。

- 2026-03-19：已吸收 `clowder-ai#113` 的 Windows 一键部署与 CLI spawn 修复（cat-cafe PR #572），manual-port 时保留家里 runtime 口径（`3003/3004/6399`），并锁定开源出口口径为 `Frontend 3003 / API 3004 / Redis 6399`
- 2026-03-19：outbound sync follow-up（cat-cafe PR #573）已合入，补齐 Windows deploy 脚本导出 allowlist，并修正 sync parser 对 YAML `#` 的处理，避免公开仓同步时误删脚本或截断合法路径

### Phase D: 跨平台目录选择器 ✅

用 web-based 目录浏览器替代 macOS `osascript` 原生文件夹选择。前端主路径已切换到 `DirectoryPickerModal`，旧 native picker 路由（`/api/projects/pick-directory`）仍保留兼容接口。

- **后端**: 基于现有 `browse` API 的跨平台目录列表
- **前端**: `DirectoryPickerModal` 内嵌目录浏览器面板（面包屑导航 + 目录列表 + 路径输入）
- **设计稿**: `designs/f113-cross-platform-directory-picker.pen`（已完成，Design Gate 通过）

UX 要点：
1. 面包屑导航 — Home > projects > relay-station，每层可点击跳转
2. 目录列表 — 只显示文件夹，当前项目高亮
3. 手动路径输入 — 底部保留输入框（高级用户 / 系统路径）
4. 全平台统一体验 — macOS/Windows/Linux 完全一致

### Phase E: 目录创建 + 项目初始化引导 ✅（PR #299）

> **归属拆分**：PR #299 含两个 feature 的改动。ProjectSetupCard + governance 端点归属 **F070**（Portable Governance UX 增强，见 F070 doc Post-Closure Gap Fixes）。DirectoryBrowser 新建文件夹功能归属本 F113。

F113 增量（DirectoryBrowser）：
- **后端**: `POST /api/projects/mkdir` — 新建子目录端点（path traversal 防护 + disallowed chars 黑名单）
- **前端**: DirectoryPickerModal 内的"新建文件夹"按钮 + 内联输入

F070 增量（ProjectSetupCard，详见 F070 doc）：
- `ProjectSetupCard` 三栏卡片设计 + `useGovernanceStatus` hook + `POST /api/projects/setup` + `GET /api/governance/status`

设计决策：
- **三栏卡片 vs 多步向导**：选择一屏展示三个选项（clone/init/skip）而非多步向导，因为选项少且互斥，一屏更快
- **`key={threadId}` 强制重挂载 vs `useEffect` 重置**：选 key 方案，因为组件内部状态较多（state + cloneUrl + errorMsg），逐个重置易遗漏
- **PNG 插画 vs SVG**：选 PNG（Gemini 生成），因为动漫风格手绘感 SVG 无法表达

状态机：`idle` → `processing` → `done` | `error`（error 可重试回 `idle`）

API 契约：
- `POST /api/projects/setup` body: `{ projectPath, mode: 'clone'|'init'|'skip', gitCloneUrl? }`
- 成功: `200 { ok: true }`
- 失败: `4xx/5xx { error, errorKind? }` errorKind 枚举: auth_failed / network_error / not_found / not_empty / timeout / git_unavailable / unknown

交付行为：
1. 空目录打开 → 展示三栏初始化卡片（clone/init/skip）
2. 用户选择后 → 展示 Working 猫猫动画（最少 1.2s）→ Done 猫猫
3. 切换 thread → 卡片状态正确重置（`key={threadId}` 强制重挂载）
4. 猫猫插画为 Gemini 生成的动漫风格透明底 PNG

已知 tradeoff / 风险：
- `<img>` 标签未用 Next.js `<Image />`（Biome 有 warning），当前图片仅 3 张且小，影响可忽略
- 猫猫 PNG 通过阈值去白（RGB > 240 → 透明），非精确抠图，极浅色边缘可能有半透明 artifact
- `Promise.all` 最小展示时间（1.2s）是固定值，未做用户偏好配置

脚本通用原则：幂等性（重复运行不报错）、版本检测（已安装不重装）、清晰的进度提示。

## Acceptance Criteria

### Phase A（Linux 一键安装）✅
- [x] AC-A1: Linux 用户在 repo root 执行 `bash scripts/install.sh` 可完成依赖安装、构建、配置，并能直接启动
- [x] AC-A2: 支持 Debian/Ubuntu 和 CentOS/RHEL/Fedora 发行版

### Phase B（macOS 一键安装）— PR #174 已合入 main
- [x] AC-B1: macOS 用户执行同一条 `bash scripts/install.sh`，且不需要 `sudo`
- [x] AC-B2: 非 login shell 下也能发现或安装 Homebrew，覆盖 Apple Silicon / Intel
- [x] AC-B3: 安装结束后，当前 shell 立即可用 `pnpm`/`claude`/`codex`/`gemini`，新终端也可用
- [x] AC-B4: 兼容 macOS 自带 bash 3.2 / `set -u` / 空数组迭代
- [x] AC-B5: 重跑安装不破坏 profile，不重复写坏 PATH，不因 profile 无 trailing newline 破坏 shell
- [ ] AC-B6: 铲屎官在 macOS 真机上完成端到端验收（安装→启动→使用）

### Phase C（Windows 一键安装）✅
- [x] AC-C1: Windows 用户通过 `.\scripts\install.ps1` 完成安装并能启动，不以 WSL 为前提

### Phase D（跨平台目录选择器）✅
- [x] AC-D1: 目录选择器前端主路径不依赖任何 OS 特定 API（无 osascript / zenity / PowerShell；保留 `/api/projects/pick-directory` 兼容路由）
- [x] AC-D2: 面包屑导航可在任意层级间跳转
- [x] AC-D3: 手动输入路径可直接跳转到目标目录
- [x] AC-D4: 现有功能不退化（项目列表、CWD 推荐、路径校验）

### Phase E（目录创建 + 项目初始化引导）✅
- [x] AC-E1: 新项目打开时展示初始化引导卡片（clone/init/skip）
- [x] AC-E2: 切换 thread 后卡片状态正确重置
- [x] AC-E3: 快速操作（init/skip）不因过快完成导致 UI 闪烁
- [x] AC-E4: 猫猫插画与卡片背景自然融合（透明底）

### 通用
- [x] AC-X1: 安装脚本具备幂等性和清晰进度提示

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | Linux/macOS 共用 `scripts/install.sh`，不分叉两个脚本 | 两份真相源会漂移，用 `$DISTRO_FAMILY` 分支即可 | 2026-03-31 |
| KD-2 | macOS 上 Claude/Codex 用 `brew install --cask`，不用 `curl claude.ai/install.sh` | `claude.ai/install.sh` 在中国等地区被地域限制，返回 HTML 导致安装失败 | 2026-04-03 |
| KD-3 | Claude CLI 的 brew cask 是 `claude-code`，不是 `claude` | `brew install claude` 安装的是桌面 App（`Claude.app`），不提供 CLI；`claude-code` 才是 "Terminal-based AI coding assistant" | 2026-04-03 |
| KD-4 | macOS 不用 sudo，用户态 `~/.local/bin` 替代 `/usr/local/bin` | Apple Silicon 上 `/usr/local/bin` 常需 sudo，而 Homebrew 拒绝 root 运行 | 2026-03-31 |
| KD-5 | npm global bin 安装后无条件 `persist_user_bin` + PATH 注入 | npm prefix 因 fnm/homebrew/自定义配置差异大，global bin 可能不在 PATH 里 | 2026-04-03 |

## Risk

| 风险 | 缓解 |
|------|------|
| 无 macOS CI runner — PR #174 只有 Linux CI + Windows Smoke，无原生 macOS smoke | 铲屎官真机验收（AC-B6）+ 20+ 平台测试静态断言 |
| 依赖上游 brew cask token 稳定性（`claude-code`/`codex`） | 测试精确断言 cask token，上游改名时 CI 立即失败 |
| macOS bash 3.2 兼容性 | 空数组用 `${arr[@]+"${arr[@]}"}`，已有测试覆盖 |

## Post-QG Delta (Phase E, 2026-03-31)

QG 通过后追加的改动（均已 push 到 clowder-ai PR #299）：

| Commit | 改动 | 原因 |
|--------|------|------|
| `424269e` | SVG → Gemini 动漫风格 PNG 插画 + Bug 1 修复（`govRefetch`） | team lead要求动漫猫猫风格；切换 thread 后治理状态不刷新 |
| `770712a` | 去除 PNG 白色背景（PIL 阈值抠图） | 白底与卡片背景色不融合 |
| `f1742a2` | `items-center` 对齐 + 1.2s 最小展示时间 | 图文错落；init/skip 闪烁 |
| `70a69a1` | `key={threadId}` 强制重挂载 | Bug 1 复现：组件内部 state 残留 |

增量 QG 结论：
- Biome: 0 error, 8 warning（均为 `<img>` vs `<Image />`，可接受）
- TypeScript: 0 error
- Tests: 252/254 pass（2 failures 为 pre-existing `BACKLOG.md` vs `ROADMAP.md` 路径不一致，非 F113-E 引入）
- UX 手测：team lead确认对齐、融合、闪烁均已修复

## Post-Review Delta (Phase B, 2026-04-03)

PR #174（已 rebase 到最新 main，CI 状态以 GitHub PR 页面为准）review 期间追加的修复：

| Commit | 改动 | 来源 |
|--------|------|------|
| `395070b2` | macOS Claude/Codex 改为 brew 安装，Linux Claude 改为 npm | 铲屎官报告 `claude.ai/install.sh` 在中国被地域限制 |
| `f8f8432a` | Claude cask 从 `claude` 改为 `claude-code` + `--cask` flag | @gpt52 review P1：`claude` 是桌面 App |
| `7f94683a` | `set -u` 空数组 guard（bash <4.4 兼容） | 铲屎官报告 macOS 安装到 [8/9] 步骤崩溃 |
| `61f0a663` | pnpm 安装后无条件 `persist_user_bin` + profile 写入 | 铲屎官报告安装后 `pnpm: command not found` |
| `ff7e7eb6` | `~/.local/bin` 加入当前 session PATH（缺失时） | 同上 — 当前终端也需要立即可用 |
| `12411fa5` | npm global bin PATH 发现 + `persist_user_bin` | 铲屎官报告 Gemini 安装成功但 `command -v` 失败 |
| `90581a2f` | Biome 格式修复 | CI Lint 失败 |

## Dependencies

- **Evolved from**: clowder-ai #14（社区用户反馈安装门槛高）
- **Related**: F115（Runtime 启动链优化）、F070（Portable Governance）

## Notes

- clowder-ai #12（`buildClaudeEnvOverrides` bug）已于 2026-03-14 关闭，不再阻塞。
