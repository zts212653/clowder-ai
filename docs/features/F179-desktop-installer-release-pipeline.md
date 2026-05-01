---
feature_ids: [F179]
related_features: [F124, F133, F140, F168]
topics: [desktop, electron, installer, nsis, dmg, github-actions, release-pipeline, opensource-ops]
doc_kind: spec
created: 2026-04-28
---

# F179: Desktop Installer Release Pipeline — 自动化产出 Win/Mac 安装包并附 release

> **Status**: in-progress | **Owner**: Ragdoll（Opus-47/Ragdoll） | **Reviewer**: Maine Coon（GPT-5.5/Maine Coon） | **Priority**: P1
>
> **Phase A done (2026-04-28, PR #1445 merged at b25b73034)**: 基础设施搭建完成。Maine Coon六轮 review 抓 5 个 P1 + 1 个 P2 全部 0 误报，每条都不在 diff 内的依赖闭包问题（permissions / sync-manifest workflow / rerun semantics / desktop 闭包 / regex \b 边界 / extraResources cross-platform 漂移 / darwin leak regex slash+dest path）。Phase B 待 v0.9.1 release 触发后实测验证。

## Why

**社区反馈触发**：v0.9.0 release notes 写了 "Windows NSIS installer + macOS DMG packaging pipeline"（卖点之一），但 [release page](https://github.com/zts212653/clowder-ai/releases/tag/v0.9.0) 0 个 assets。社区小伙伴提问「release 里好像没看到 exe 安装包，是我看漏了吗」——他没看漏，是我们写得超前于交付。

**team experience（2026-04-28）**：
> 「也就是我们的开源社区管理 skills 里要新增一个发版本要发安装包？exe 和 mac 的？两个？」
>
> 「那我们先搭建基础设施吧？skills 写了 然后 github 的 action 先配置？先把基础设施做了再发包？」
>
> 「我建议基础设施完成之后直接发 v0.9.1 有安装包的就行了啊」

**为什么现在做**：
- v0.9.0 已经把 Electron Desktop Shell 写成 release notes 卖点（intake clowder-ai#540），用户期待已经形成
- 当前 `desktop/package.json` win target 是 `dir`（出文件夹），不是 `nsis`（出 .exe 安装包），实际产物配置错位
- 没有任何 GitHub Actions workflow 触发跨平台 build，pipeline 只是声明
- 历史所有 release（v0.5/v0.6/v0.7/v0.8/v0.9）都是 zero assets，这个缺口拖到 v0.10.0 才补会进一步累积期待

## What

> Phase A 先做基础设施，Phase B 用 v0.9.1 验证。Phase A 完成 + B 通过 = feat done。

### Phase A: Pipeline 基础设施

**实情核查（2026-04-28 推 worktree 时发现）**：win pipeline 实际不是 NSIS，是 **Inno Setup**（`desktop/installer/cat-cafe.iss`）。`desktop/scripts/build-desktop.ps1` 已经是完整的 Win build 脚本：electron-builder `--win --dir` 产 `desktop-dist/win-unpacked/` → Inno Setup `iscc.exe cat-cafe.iss` 产 `dist/CatCafe-Setup-X.Y.Z.exe`。`desktop/scripts/build-mac.sh` 同理已经做完 mac dmg pipeline。**所以 build 脚本已经齐全，只缺 CI workflow + 版本号同步。**

v0.9.0 release notes 写 "Windows NSIS installer" 是术语写错了——实际是 Inno Setup。无需切换格式（Inno Setup 配置完整且能跑）。

**A1. 版本号同步机制**
- `desktop/installer/cat-cafe.iss` 当前 hardcode `MyAppVersion 0.2.0`
- `desktop/package.json` 当前 `version: "0.2.0"`
- release 触发时需要通过 `iscc /D` 参数或 sed 动态注入版本号，避免每次手动改两个地方
- 实现：build 脚本接受 `CATCAFE_VERSION` 环境变量，CI workflow 从 release tag 推导（`v0.9.1` → `0.9.1`）注入

**A2. GitHub Actions release workflow**
- 文件：`.github/workflows/release-desktop.yml`
- 触发条件：`on.release.types = [published]`（GitHub release 创建后触发）
- 双 job（不用 matrix——win/mac build 步骤完全不同）：
  - `build-mac` runs-on `macos-latest`：跑 `desktop/scripts/build-mac.sh` → 产 dmg arm64 + x64
  - `build-windows` runs-on `windows-latest`：先 `choco install innosetup -y` → 跑 `desktop/scripts/build-desktop.ps1` → 产 `CatCafe-Setup-X.Y.Z.exe`
- Upload：`softprops/action-gh-release@v2` 把 `dist/*.dmg` / `dist/*.exe` attach 到触发本次 workflow 的 release
- 签名暂跳过：`identity: null` (mac) / 不配 win cert —— 在 release notes 注明"unsigned, manual approve on first launch"

**A3. opensource-ops skill 加 Release Asset Gate**
- 在 `cat-cafe-skills/refs/opensource-ops-outbound-sync.md` 加章节：发 release 前必须确认 assets workflow 已触发并完成；release publish 后 watch 一次 workflow run 状态

**A4. Self-build 临时止血**
- 在 v0.9.0 release notes 末尾加一行 forward pointer：`> Installer assets coming in v0.9.1.`
- clowder-ai 开 pinned issue《Self-build desktop installer until v0.9.1》给完整本地 build 步骤

### Phase B: v0.9.1 验证

**B1. 触发 v0.9.1 release**
- cat-cafe 起 chore PR 升 desktop/package.json version（0.2.0 → 0.9.1 对齐 release tag），sync 到 clowder-ai
- 在 clowder-ai 创建 v0.9.1 release（empty payload，主要是验证 pipeline）
- workflow 自动触发 → upload assets

**B2. 验收**
- v0.9.1 release page assets 列表包含：
  - `CatCafe-0.9.1-arm64.dmg`（mac arm64）
  - `CatCafe-0.9.1-x64.dmg`（mac intel）
  - `CatCafe-0.9.1-x64.exe`（win x64）
- 至少一只猫（非作者 + 非 reviewer）下载 dmg/exe 在自己机器上能装能跑

## Acceptance Criteria

### Phase A
- [x] AC-A1: 版本号同步机制——build 脚本接受 `CATCAFE_VERSION` 环境变量并注入到 `cat-cafe.iss` + `desktop/package.json`（cat-cafe.iss 用 `#ifndef MyAppVersion` + iscc /D 注入）
- [ ] AC-A2: 本地（Mac）跑 `desktop/scripts/build-mac.sh` 能产 `CatCafe-X.Y.Z-arm64.dmg` + `CatCafe-X.Y.Z-x64.dmg`（留 Phase B 实测）
- [x] AC-A3: `.github/workflows/release-desktop.yml` 存在，触发条件 `on.release.types = [published]` + 顶层 `permissions: contents: write`
- [ ] AC-A4: workflow 双 job（macos-latest + windows-latest）build 成功（留 Phase B 实测）
- [x] AC-A5: build artifacts 自动 upload 到触发 workflow 的 release（softprops/action-gh-release@v2，release event 才 upload，dispatch event 走 artifact）
- [x] AC-A6: `cat-cafe-skills/refs/opensource-ops-outbound-sync.md` 加 "Release Asset Gate" 章节（Step 11）
- [x] AC-A7: v0.9.0 release notes 加 forward pointer ✅；clowder-ai pinned self-build issue 留 Phase B 完成时给准确命令

**Phase A 额外完成的修复（Maine Coon review 推动）：**
- `desktop/installer/cat-cafe.iss`: MyAppURL 通过 sanitizer 自动改写为 clowder-ai 公开仓 URL
- `sync-manifest.yaml`: `managed_roots` 加 `desktop` —— 19 files sync 到 clowder-ai
- `scripts/_sanitize-rules.pl`: cat-cafe → clowder-ai URL sanitizer，用 `(?![\w-])` negative lookahead 避免 over-match `cat-cafe-tutorials/-skills`
- `desktop/package.json`: 拆 `extraResources`，darwin node/redis 移到 `mac.extraResources`，避免 Win build 吃 mac-only path
- `desktop/scripts/build-desktop.ps1`: 加 win-build 防回归断言（separator-agnostic regex 抓 source folder + destination path）

### Phase B
- [ ] AC-B1: v0.9.1 release 创建后，workflow 触发成功
- [ ] AC-B2: v0.9.1 release page 含 mac dmg (arm64+x64) + win exe (x64) 共 3 个 assets
- [ ] AC-B3: 跨猫验证（非作者非 reviewer）能下载并启动安装包

## Dependencies

- 无强依赖。`bundled/deploy/{api,web,mcp-server}` 是 desktop dist 的 extraResources 来源，需要 release workflow 在 desktop dist 之前 build 出来
