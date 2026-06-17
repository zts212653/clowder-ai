---
feature_ids: [F080]
related_features: []
topics: [ux, input, terminal-style]
doc_kind: spec
created: 2026-03-07
status: done
---

# F080 Input History Completion

> **Status**: done | **Owner**: Ragdoll

## Why

Terminal 有历史补全能力（输入前缀 + Tab -> 补全历史输入），Cat Cafe Hub 没有。operator经常重复输入类似内容（如"笨蛋猫猫"），需要 terminal 风格的输入效率提升。

## What

### 核心功能

1. **历史存储**：存储用户最近 N 条输入（默认 500 条）
2. **实时建议**：输入时基于历史显示灰色建议（zsh-autosuggestions 风格）
3. **补全接受**：Tab 或 -> 键接受建议
4. **历史搜索**：Ctrl+R 弹出搜索框，模糊匹配历史

### 技术要点

- 前端 localStorage 存储输入历史
- 输入框实时匹配前缀 -> 显示灰色 ghost text
- Tab/-> 接受 ghost text
- Ctrl+R 弹出 modal 搜索历史

### 参考

- zsh-autosuggestions：灰色 ghost text + -> 接受
- fzf / Ctrl+R：模糊搜索历史
- tmux copy-mode：滚动 + 搜索

## Acceptance Criteria

- [x] AC-A1: 用户输入自动存储到历史（最近 500 条）
- [x] AC-A2: 输入时显示灰色历史建议（前缀匹配）
- [x] AC-A3: Tab 或 -> 键接受建议
- [x] AC-A4: Ctrl+R 打开历史搜索弹窗
- [x] AC-A5: 历史搜索支持模糊匹配
- [x] AC-A6: 历史全局共享（决定：全局，不按 thread 隔离）

## Key Decisions

1. 用 localStorage 存储（不跨设备同步，简单优先）
2. 默认全局历史（不按 thread 隔离）
3. ghost text 风格（不是下拉菜单）

## Dependencies

- **Related**: 无（纯前端功能）

## Risk

- 低风险：纯 UI 增强，不影响核心功能

## Review Gate

- 跨猫 review：@codex

---

## Phase 2: Path & Slash Command Completion

### Why

Terminal 的 Tab 不只是补全历史——还能补全文件路径。operator经常在聊天中提到文件路径（如 `packages/web/src/...`），手动输入又长又容易打错。

operator experience：
> "在 terminal 是不是 tab 也可以补全文件名路径什么的？我们的 f80 就暂时做不到？"

### What

在 P1 的历史补全基础上，增加**文件路径补全源**：

1. **路径检测**：输入中出现 `/`、`./`、`../`、或 `packages/` 等路径特征时，切换到路径补全模式
2. **后端 API**：`GET /api/projects/complete?prefix=packages/web/src/comp` — 返回匹配的文件/目录列表（复用现有 `project-path.ts` 安全校验）
3. **候选列表 UI**：路径补全用下拉候选列表（不用 ghost text，因为多候选）
4. **补全源优先级**：路径补全 > 历史补全（检测到路径特征时切换源）

### Technical Design

```
输入检测 → 是路径？
  ├── 是 → GET /api/projects/complete?prefix={path}&limit=10
  │        → 显示下拉候选列表（复用 ChatInputMenus 样式）
  │        → Tab/Enter 选中 → 插入完整路径
  └── 否 → 走 P1 历史补全（ghost text）
```

**后端**（`packages/api/src/routes/projects.ts`）：
- 新增 `GET /api/projects/complete` endpoint
- 复用 `project-path.ts` 的 `resolveAndValidate` 做安全校验
- 基于当前 thread 的 `projectPath` 做相对路径 glob
- 返回 `{ entries: [{ name, path, isDirectory }] }`，limit 默认 10

**前端**（`packages/web/src/components/ChatInput.tsx`）：
- 在 `handleChange` 中检测路径特征（正则：`(?:^|\s)([.~/][\w/.-]*|packages/[\w/.-]*)$`）
- 检测到路径 → fetch `/api/projects/complete?prefix={match}` (debounce 200ms)
- 显示候选下拉菜单（复用 mention menu 的 UI 模式）
- Tab/Enter 选中插入

**延迟预估**：
- 后端 glob：本地文件系统 < 50ms
- 网络 RTT：localhost ~1ms
- Debounce：200ms
- 总体用户感知延迟：~250ms（完全可接受）

### Phase 2 Acceptance Criteria

- [x] 输入中出现路径特征时，触发路径补全
- [x] 后端 `GET /api/projects/complete` 返回匹配文件/目录列表
- [x] 前端显示下拉候选列表（Tab/Enter 选中）
- [x] 路径补全有 debounce（200ms），不影响输入流畅度
- [x] 后端路径校验：不能访问 allowedRoots 之外的目录
- [x] 目录结尾自动加 `/`，继续补全子路径

### Phase 2 Dependencies

- 复用 `packages/api/src/utils/project-path.ts`（已有）
- 复用 `GET /api/projects/browse`（已有，参考实现）
- 复用 ChatInputMenus 下拉 UI 模式（已有）

### Phase 2 Risk

- 低风险：后端复用已有模块，前端复用已有 UI 模式
- 安全校验已有现成方案（project-path allowlist）
