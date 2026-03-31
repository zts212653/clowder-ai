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

### Phase D: 跨平台目录选择器（当前实施）

用 web-based 目录浏览器替代 macOS `osascript` 原生文件夹选择：

- **后端**: 将 `execPickDirectory()`（osascript）替换为基于现有 `browse` API 的跨平台目录列表
- **前端**: `DirectoryPickerModal` 内嵌目录浏览器面板（面包屑导航 + 目录列表 + 路径输入）
- **设计稿**: `designs/f113-cross-platform-directory-picker.pen`（已完成，Design Gate 通过）

UX 要点：
1. 面包屑导航 — Home > projects > relay-station，每层可点击跳转
2. 目录列表 — 只显示文件夹，当前项目高亮
3. 手动路径输入 — 底部保留输入框（高级用户 / 系统路径）
4. 全平台统一体验 — macOS/Windows/Linux 完全一致

### Phase E: 目录创建 + 项目初始化引导（PR #299）

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

### Phase A–C: 一键部署脚本（后续）

- **Phase A**: Linux（`install.sh`）—— 自动检测发行版、安装依赖、配置环境变量、启动服务
  - 2026-03-19：已吸收 `clowder-ai#128` 的 Linux TTY/install/runtime 修复（cat-cafe PR #565），保留内部 runtime 语义并补齐回归测试
  - 2026-03-19：post-review follow-up（cat-cafe PR #566）已合入，补齐 `/workspace` provider-profile sharing 边界，并修正 installer completion banner 的家里端口口径
- **Phase B**: macOS（`install-mac.sh`）—— Homebrew 前置检测 + 依赖安装
- **Phase C**: Windows（`install.ps1` / WSL 引导）—— PowerShell 脚本或引导用 WSL
  - 2026-03-19：已吸收 `clowder-ai#113` 的 Windows 一键部署与 CLI spawn 修复（cat-cafe PR #572），manual-port 时保留家里 runtime 口径（`3003/3004/6399`），并锁定开源出口口径为 `Frontend 3003 / API 3004 / Redis 6399`
  - 2026-03-19：outbound sync follow-up（cat-cafe PR #573）已合入，补齐 Windows deploy 脚本导出 allowlist，并修正 sync parser 对 YAML `#` 的处理，避免公开仓同步时误删脚本或截断合法路径

脚本应具备：幂等性（重复运行不报错）、版本检测（已安装不重装）、清晰的进度提示。

## Acceptance Criteria

- [x] AC-D1: 目录选择器不依赖任何 OS 特定 API（无 osascript / zenity / PowerShell）
- [x] AC-D2: 面包屑导航可在任意层级间跳转
- [x] AC-D3: 手动输入路径可直接跳转到目标目录
- [x] AC-D4: 现有功能不退化（项目列表、CWD 推荐、路径校验）
- [x] AC-E1: 新项目打开时展示初始化引导卡片（clone/init/skip）
- [x] AC-E2: 切换 thread 后卡片状态正确重置
- [x] AC-E3: 快速操作（init/skip）不因过快完成导致 UI 闪烁
- [x] AC-E4: 猫猫插画与卡片背景自然融合（透明底）
- [ ] AC-1: Linux 用户执行单条命令完成全部安装并能启动服务
- [ ] AC-2: macOS 用户同上
- [x] AC-3: Windows 用户有明确引导（脚本或 WSL 说明）
- [ ] AC-4: 脚本幂等，重复运行不破坏已有安装

## Post-QG Delta (Phase E, 2026-03-31)

QG 通过后追加的改动（均已 push 到 PR #299）：

| Commit | 改动 | 原因 |
|--------|------|------|
| `424269e` | SVG → Gemini 动漫风格 PNG 插画 + Bug 1 修复（`govRefetch`） | 铲屎官要求动漫猫猫风格；切换 thread 后治理状态不刷新 |
| `770712a` | 去除 PNG 白色背景（PIL 阈值抠图） | 白底与卡片背景色不融合 |
| `f1742a2` | `items-center` 对齐 + 1.2s 最小展示时间 | 图文错落；init/skip 闪烁 |
| `70a69a1` | `key={threadId}` 强制重挂载 | Bug 1 复现：组件内部 state 残留 |

增量 QG 结论：
- Biome: 0 error, 8 warning（均为 `<img>` vs `<Image />`，可接受）
- TypeScript: 0 error
- Tests: 252/254 pass（2 failures 为 pre-existing `BACKLOG.md` vs `ROADMAP.md`，非 F113-E）
- UX 手测：铲屎官确认对齐、融合、闪烁均已修复

## Notes

clowder-ai #12 (`buildClaudeEnvOverrides` bug) 应先修，否则 Windows 平台安装成功也无法正常使用。
