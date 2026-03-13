---
name: cross-cat-handoff
description: >
  跨猫传话/交接的五件套结构（What/Why/Tradeoff/Open/Next）。
  Use when: 交接工作给其他猫、传话、写 review 信。
  Not for: 自己的任务、不涉及其他猫的工作。
  Output: 结构化交接信。
triggers:
  - "交接"
  - "传话"
  - "handoff"
---

# Cross-Cat Handoff

**Core principle:** 交接不能只写"改了什么"。没有 Why = 接手方无法判断 = 低效协作。

## 五件套（必须全部包含）

每次交接/传话/review 请求必须包含：

| # | 项目 | 说明 | 示例 |
|---|------|------|------|
| 1 | **What** | 具体改动或决策 | "新增了 CAS Lua 脚本保护状态更新" |
| 2 | **Why** | 为什么这样做 | "内存 store 返回活引用导致竞态" |
| 3 | **Tradeoff** | 放弃了什么备选 | "考虑过乐观锁，但 Lua 更原子" |
| 4 | **Open Questions** | 还不确定的点 | "keyPrefix 行为需要验证" |
| 5 | **Next Action** | 希望接手方做什么 | "请 review 这三个文件的改动" |

## 检查流程

```
BEFORE 发送交接/传话/review请求:

1. SCAN: 检查消息是否包含五件套
2. MISSING: 识别缺失项
3. BLOCK: 如有缺失，阻止发送并提示补充
4. PASS: 全部包含，允许发送
```

## Block 场景

### ❌ 只写 What

```
Author 猫准备写: "@ Reviewer 我改完了三个文件，帮我 review"

⚠️ BLOCKED — 交接缺失必要信息

缺失项:
- ❌ Why: 为什么要改？
- ❌ Tradeoff: 有没有考虑过其他方案？
- ❌ Open Questions: 有什么不确定的？
- ❌ Next Action: 希望 review 什么重点？

请补充五件套后再发送。
```

### ❌ 只有 What + Why

```
Author 猫准备写: "@ Reviewer 我加了 CAS 保护，因为发现竞态问题"

⚠️ BLOCKED — 交接缺失必要信息

已有:
- ✅ What: 加了 CAS 保护
- ✅ Why: 发现竞态问题

缺失:
- ❌ Tradeoff: 为什么选 CAS？考虑过其他方案吗？
- ❌ Open Questions: 有什么不确定的？
- ❌ Next Action: 希望 Reviewer 做什么？

请补充后再发送。
```

## 通过场景

### ✅ 完整的交接

```
## 交给 Reviewer Review: ADR-008 S2 Retry + CAS

### What
新增 CAS Lua 脚本保护 InvocationRecord 状态更新：
- `CAS_UPDATE_LUA`: HGET 比对 + HSET 更新
- 修改 `RedisInvocationRecordStore.updateStatus()`
- 新增 `snapshotStatus` 在调用前保存原始状态

### Why
内存 store 的 `get()` 返回活引用，导致：
1. 读取 status 后，在比对前可能被其他请求修改
2. 原来的 CAS 逻辑比对的是已经被修改的值
3. 导致竞态条件：两个并发请求都能通过比对

### Tradeoff
考虑过的方案：
- **乐观锁（version 字段）**: 需要改 schema，影响面大
- **分布式锁**: 太重，且 Redis 单线程本身就是串行的
- **Lua CAS**: 选择这个，原子性由 Redis 保证

### Open Questions
1. `keyPrefix` 在 `eval()` 中的行为是否和普通命令一致？
2. 是否需要添加重试逻辑？

### Next Action
请 review 这三个文件：
1. `RedisInvocationRecordStore.ts` - CAS Lua 实现
2. `InvocationRecordStore.ts` - snapshotStatus 逻辑
3. `invocation-flow.spec.ts` - 竞态测试用例

重点关注：
- Lua 脚本的原子性是否正确
- snapshotStatus 时机是否正确
- 测试是否覆盖竞态场景

✅ 检查通过 - 五件套完整
```

## 交接类型

### 1. Review 请求

交给其他猫审查代码。

**重点**：
- What: 改了哪些文件
- Why: 为什么要这样改
- Next Action: 希望 reviewer 关注什么

### 2. 工作交接

一只猫做到一半，另一只猫接手。

**重点**：
- What: 当前进度
- Open Questions: 遇到的问题/卡点
- Next Action: 下一步建议做什么

### 3. 决策通知

通知其他猫一个重要决策。

**重点**：
- What: 做了什么决定
- Why: 为什么这样决定
- Tradeoff: 放弃了什么方案

### 4. 开放讨论邀请

邀请其他猫讨论某个方向性问题（不是任务指派）。

**特殊规则**：
- 这是讨论，不是任务
- 给开放问题，不问引导性问题
- 透明展示推理链
- 让对方先形成自己的想法再看你的分析

详见 `feat-lifecycle` skill 的讨论阶段（开放讨论模式）。

## 常见错误

| 错误 | 问题 | 正确做法 |
|------|------|----------|
| "帮我 review 这个" | 不知道该关注什么 | 说明 review 重点 |
| "我改完了" | 不知道改了什么/为什么 | 写明 What + Why |
| "按你说的改了" | 不知道改对了没 | 说明具体改了什么 |
| "遇到问题，你看看" | 不知道具体问题 | 描述问题 + 你的分析 |

## 五件套检查清单

复制此清单用于自检：

```
交接五件套自检:
- [ ] What: 具体改动/决策是什么？
- [ ] Why: 为什么这样做？约束/风险/目标是什么？
- [ ] Tradeoff: 放弃了什么备选方案？
- [ ] Open Questions: 还有什么不确定的？
- [ ] Next Action: 希望接手方下一步做什么？
```

## 下一步

- 交接 review 请求 → 接收方用 `receive-review`
- 交接开发工作 → 接收方用 `worktree` 开始
- 交接讨论邀请 → 接收方用 `collaborative-thinking`

## 参考

- 五件套详见：`refs/shared-rules.md` §1
- Review 信存放：*(internal reference removed)*
