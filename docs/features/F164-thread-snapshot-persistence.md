---
feature_ids: [F164]
related_features: [F069, F048, F080, F081]
topics: [frontend, persistence, offline, resilience]
doc_kind: spec
created: 2026-04-15
---

# F164: Thread Snapshot Persistence — 刷新不失忆

> **Status**: done | **Owner**: Ragdoll | **Priority**: P1

**Completed: 2026-04-16**

## Why

team lead发现断网后按 F5，前端页面完全空白——thread 列表、聊天内容全部消失。原因是前端 `chatStore` 零持久化：`messages: []`、`threads: []` 是冷启动态，`threadStates`（thread 级缓存）纯内存 F5 即死，PWA 对 `/api/*` 是 NetworkOnly。我们从来没设计过离线恢复路径。

team experience："断网了，我按 F5 我们的前端页面都刷不出来，就是有多少 thread 啊我们的聊天内容啊就都没了"

F080 当时明确写了"不做前端本地缓存"，当时的决策是合理的。但现在team lead作为日常用户遇到了实际痛点，需要重新审视。

## What

### Phase A: IndexedDB 快照 + Cache-First Hydration

核心：给 `threadStates` 加 IndexedDB 镜像，冷启动先读快照立刻渲染，再后台拉 API 增量替换。

**技术方案**：
- 引入 `idb` 库（~1.2KB gzip），创建 `cat-cafe-offline` IndexedDB database
- 两个 object store：`threads`（thread 摘要 + unread）、`messages`（per-thread 最近 50 条）
- **Write-through**：`setThreads()`/`replaceMessages()`/`pushMessage()` 成功后异步写 IndexedDB，不阻塞主线程
- **Cold-start read**：`ThreadSidebar` mount 时先 `await idb.getAll('threads')` 立刻渲染；`useChatHistory` 先读 IndexedDB 快照再 kick off API fetch
- **Hydration 策略**：API 成功 → 替换快照；API 失败 → 保留快照 + 显示离线标记
- **不持久化**：`activeInvocations`、`catStatuses`、streaming draft、queue、`isStreaming` 占位气泡（实时态，存了反而有害——PR #1261 修复了 `isStreaming` 渗入 IDB 导致 F5 双气泡的 bug）

**改动范围**：
- `packages/web/src/stores/chatStore.ts`：threadStates write-through 逻辑
- `packages/web/src/components/ThreadSidebar/ThreadSidebar.tsx`：cache-first 加载
- `packages/web/src/hooks/useChatHistory.ts`：cache-first 加载
- 新增：`packages/web/src/utils/offline-store.ts`（IndexedDB 封装）

### Phase B: 连接状态指示 + 体验打磨

- 三态连接指示器：本地 API / 实时 Socket / 外部上游（已有 `/health`、`/ready` API 支撑）
- 离线模式下发送降级为"排队草稿"或只读提示
- CDN 资源自托管（jsDelivr VAD wasm、Google Fonts、unpkg esbuild.wasm）
- 离线视觉模式（Siamese出设计，Phase A 先用简单 badge）

## Acceptance Criteria

### Phase A（IndexedDB 快照 + Cache-First Hydration）✅
- [x] AC-A1: F5 后断网环境下，thread 列表能从 IndexedDB 快照恢复显示
- [x] AC-A2: F5 后断网环境下，当前 thread 的最近消息能从 IndexedDB 快照恢复显示
- [x] AC-A3: 联网状态下 F5，先显示快照再异步替换为最新数据，用户无感
- [x] AC-A4: 离线快照数据显示时有明确的"离线快照"标记，用户知道看到的不是最新数据
- [x] AC-A5: 实时态（activeInvocations、streaming draft、queue）不被持久化，不会恢复出过期中间态
- [x] AC-A6: IndexedDB 写入异步执行，不阻塞消息渲染主路径（write-through 延迟 < 50ms p99）

### Phase B（连接状态 + 体验打磨）✅
- [x] AC-B1: UI 能区分并显示三种连接状态：本地 API 可达 / Socket 连接 / 上游模型可达
- [x] AC-B2: 离线模式下发送操作有明确降级提示（只读或排队草稿）
- [x] AC-B3: VAD wasm、字体、esbuild.wasm 等关键路径资源自托管，断网不影响功能渲染

## Dependencies

- **Evolved from**: F069（Thread Read State — 从未读态管理自然延伸到客户端快照）
- **Related**: F048（Restart Recovery — 后端进程恢复，与前端快照正交互补）
- **Related**: F080（Streaming Draft Persistence — 当时明确"不做前端本地缓存"，F164 重新审视此决策）
- **Related**: F081（相关前端状态恢复讨论）

## Risk

| 风险 | 缓解 |
|------|------|
| IndexedDB 快照与服务端数据不一致（消息被删/编辑） | API 成功后完全替换快照；快照显示时标注"离线副本" |
| IndexedDB 存储空间不足或被浏览器清理 | 降级为当前行为（空白页）；不依赖快照做数据真相源 |
| write-through 性能影响主线程 | 异步写入 + 批量合并（debounce），不在消息渲染关键路径上 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 持久化 `threadStates` 而非新建 `offlineSnapshotStore` | threadStates 已是 thread 级缓存结构，少一层映射（Ragdoll提议，Maine Coon确认） | 2026-04-15 |
| KD-2 | 用 IndexedDB 不用 localStorage | 体积、性能、结构化查询，消息多了 localStorage 会炸 | 2026-04-15 |
| KD-3 | 不改 Service Worker API 缓存策略 | `/api/*` NetworkOnly 是合理的，全局缓存容易把旧会话/旧队列缓存脏（Ragdoll+Maine Coon共识） | 2026-04-15 |
| KD-4 | 不做完全离线聊天 | 核心价值是猫猫回复，离线发消息没意义，scope 控制 | 2026-04-15 |

## Review Gate

- Phase A: 跨 family review（Maine Coon review Ragdoll代码）
- Phase B: 前端 UX 需Siamese设计确认 + Maine Coon review

## 需求点 Checklist

| ID | 需求点（team experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | "断网了，我按 F5 我们的前端页面都刷不出来" | AC-A1, AC-A2 | 断网 + F5 手动测试 | [x] |
| R2 | "就是有多少 thread 啊我们的聊天内容啊就都没了" | AC-A1, AC-A2 | 断网 + F5 验证 thread 列表和消息可见 | [x] |
| R3 | 联网时 F5 体验无退化 | AC-A3 | 联网 F5 测试，确认先显示再替换 | [x] |
| R4 | 用户能区分离线快照和实时数据 | AC-A4 | 截图验证离线标记 | [x] |
| R5 | 连接状态可区分（Maine Coon+Siamese提议） | AC-B1 | 截图验证三态指示器 | [x] |

### 覆盖检查
- [x] 每个需求点都能映射到至少一个 AC
- [x] 每个 AC 都有验证方式
- [x] 前端需求已准备需求→证据映射表（若适用）
