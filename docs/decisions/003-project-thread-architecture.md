---
feature_ids: []
topics: [project, thread, architecture]
doc_kind: decision
created: 2026-02-26
---

# ADR-002: Project = 目录, Thread = 会话

> **状态**: 已决定
> **日期**: 2026-02-06
> **决策者**: team lead + Ragdoll
> **上下文**: Phase 3.2 完成后复盘, 参考 Codex App 的 Project/Thread 模型

## 背景

Phase 3.2 实现了扁平的 Thread（对话）管理，但缺少 **Project 层**。
team lead指出参考 Codex App 的组织方式：

```
Codex App 侧栏:
├── cat-cafe (Project = 目录)
│   ├── /home/user   (Thread)
│   ├── Study identity injection discussion    (Thread)
│   ├── 调研 Claude Code Agent Teams ...       (Thread)
│   └── 你看看这是一个怎么样的工程！...        (Thread)
└── relay-station (Project = 目录)
    └── /home/user   (Thread)
```

## 决策

**Project = 工作目录 (Working Directory)**

### 为什么是目录?

1. **CLI 天然需要目录**: `spawn('claude', ['-p', ...], { cwd: projectDir })` — 三只猫的 CLI 都在一个目录里工作。目录就是项目上下文。

2. **文件系统即记忆**: 目录结构本身就是知识的组织方式 — CLAUDE.md, AGENTS.md, GEMINI.md, docs/, src/ 都是项目记忆的一部分。

3. **跨项目天然隔离**: 当猫咖帮team lead做别的项目时（非 cat-cafe 本身），`AgentServiceOptions.workingDirectory` 已支持设置不同 cwd。Project = Directory 让这个变得自然。

4. **与 Phase 3.5 一致**: Task (毛线球) 附着到 Thread, Thread 归属 Project。Task 的文件操作天然在 Project 目录内。

### 放弃的方案

| 方案 | 放弃理由 |
|------|----------|
| 手动创建项目 | 增加用户负担, 与 CLI cwd 脱节 |
| 不要 Project 层 | 对话越多越乱, 跨项目时无法区分上下文 |

## 目标架构

```
Project (目录)
├── Thread (会话)
│   ├── Messages (按 threadId 隔离)
│   ├── Participants (活跃猫猫)
│   ├── Tasks (Phase 3.5, 毛线球)
│   └── Summary (Phase 3.5, 拍立得照片墙)
├── Thread
│   └── ...
└── 项目配置 (CLAUDE.md, cat-config.json 等)
```

### 数据模型变更

```typescript
// Project = 目录, 自动发现
interface Project {
  path: string;           // 绝对路径, 作为唯一 ID
  name: string;           // 目录名 (显示用)
  lastActiveAt: number;
}

// Thread 增加 projectPath
interface Thread {
  id: string;
  projectPath: string;    // NEW: 归属哪个 Project
  title: string | null;
  createdBy: string;
  participants: CatId[];
  lastActiveAt: number;
  createdAt: number;
}
```

### 前端侧栏 (参考 Codex)

```
对话                        [+ 新对话]
─────────────────────────────────
▼ cat-cafe                    1d
    Study identity inject...  4h
    调研 Agent Teams ...      8h
▼ relay-station              2w
    /home/user   2w
─────────────────────────────────
```

## Phase 3.2 交付总结

### 已实现 (190 tests)

| 功能 | 状态 | 关键文件 |
|------|------|----------|
| StoredMessage + threadId + contentBlocks | ✅ | MessageStore.ts, RedisMessageStore.ts |
| Thread 实体 + ThreadStore (内存) | ✅ | ThreadStore.ts |
| 活跃参与者追踪 | ✅ | AgentRouter.ts |
| Thread CRUD API | ✅ | routes/threads.ts |
| 图片上传管线 + CLI passthrough | ✅ | image-upload.ts, image-paths.ts |
| 前端: ThreadSidebar + ImagePreview | ✅ | ThreadSidebar.tsx, ImagePreview.tsx |
| WebSocket 分房间广播 | ✅ | SocketManager.ts |
| 5 个集成测试 | ✅ | thread-wiring.test.js |

### 未实现 (Phase 3.5 范围)

| 功能 | 原因 | 接入点 |
|------|------|--------|
| Project 层 (目录) | Phase 3.2 聚焦 Thread, Project 是上层概念 | ThreadStore + 前端 |
| 身份注入 | P0 阻塞项, demo 才发现 | System Prompt Builder |
| 猫配置外置 | 身份注入的前置 | cat-config.json |
| Redis ThreadStore | 内存够用, Redis 留后续 | ThreadStore 接口已预留 |
| Task (毛线球) | Phase 3.5-A | Thread.id 附着 |
| Intent Signal | Phase 3.5-B | AgentRouter |
| Discussion Summary | Phase 3.5-C | Thread.id 附着 |

## Phase 3.5 前置依赖 (必须先做)

### 1. 身份注入 (P0, 万物之基)

Demo 发现: 三只猫全不知道自己是谁。

```
System Prompt 分层组装:
1. 身份层: "你是Ragdoll(Opus), Cat Cafe 的主架构师..."
2. 项目层: "当前项目: cat-cafe, 路径: /path/to/project"
3. 会话层: "当前对话参与者: opus, codex"
4. 即时层: "用户刚说: ..."
```

### 2. 猫配置外置

```json
// cat-config.json
{
  "cats": {
    "opus": {
      "displayName": "Ragdoll",
      "cli": "claude",
      "defaultModel": "claude-opus-4-6",
      "mcpSupport": true,
      "flags": ["--permission-mode", "dontAsk"]
    },
    "codex": {
      "displayName": "Maine Coon",
      "cli": "codex",
      "defaultModel": "gpt-5.2",
      "mcpSupport": false,
      "flags": ["--sandbox", "workspace-write"]
    },
    "gemini": {
      "displayName": "Siamese",
      "cli": "gemini",
      "adapter": "gemini-cli",
      "mcpSupport": false
    }
  }
}
```

### 3. Project 自动发现

```
用户打开 Cat Cafe → 检测 cwd → 注册为 Project
切换目录 → 切换 Project → Thread 列表跟随
spawn CLI → cwd = projectPath
```

## 否决理由（P0.5 回填）

- **备选方案 A**：保持“全局扁平 Thread”，不引入 Project 层
  - 不选原因：跨目录/跨仓库上下文会互相污染，无法表达真实工作目录边界，后续 task/summary 归属混乱。
- **备选方案 B**：由用户手工创建/维护 Project 实体
  - 不选原因：增加操作负担且与 CLI `cwd` 脱节，容易出现“界面项目”和“执行目录”不一致。
- **备选方案 C**：按猫猫身份拆 Project（每猫一个项目视图）
  - 不选原因：会制造知识孤岛，破坏三猫协作共享上下文的目标。

**不做边界**：本轮不引入跨项目权限系统与复杂项目元数据管理，先保持 Project=目录的轻量模型。

## 给未来Ragdoll的备忘

1. **不要忘记 Project = 目录**。这是team lead明确确认的设计决策。
2. **Thread 是 Project 内的会话**，不是全局扁平的。
3. **身份注入是万物之基** — 不做身份注入，Phase 3.5 的一切都是空中楼阁。
4. **参考 Codex App** — `reference-pictures/codex-app-multi-thread.png` 是team lead给的参考截图。
5. **双轨制 (Task + Roundtable)** — Maine Coon的设计 (`dual-track-collaboration-design.md`) 已获共识。
6. **Demo 发现** — *(internal reference removed)* 记录了所有 P0-P3 问题。
