---
name: organize-threads
description: >
  猫猫辅助整理未分类 thread，分析标题和元数据，建议合适的标签。
  Use when: 用户说"帮我整理"、"分类 thread"、点击整理按钮。
  Not for: 删除/编辑标签本身。
  Output: 按 thread 的标签建议列表。
triggers:
  - "帮我整理"
  - "整理 thread"
  - "organize threads"
  - "分类建议"
---

# Organize Threads

用户请求整理未分类 thread 时加载此 skill。分析 thread 标题和元数据，对照可用标签建议分类。

## 流程

```
1. 获取数据
   - 用 cat_cafe_list_labels 获取可用标签列表（id + name + color）
   - 用 cat_cafe_list_threads 获取 thread 列表
   - 如果用户触发消息中已附带标签和 thread 数据，优先使用（减少工具调用）
   - 筛选出未分类 thread（labels 为空或不存在的）

2. 分析 thread
   - 逐个分析 thread 标题
   - 语义匹配：标题含义和标签含义的对应（不是简单 substring）
   - 一个 thread 可匹配 0-N 个标签
   - 无法判断的 thread 不强行分类

3. 输出建议
   - 按 thread 逐条列出建议的标签
   - 简要说明匹配理由（一句话）
   - 附带机器可读 JSON 块（供前端 modal 预填充）
   - 不自动应用——等用户在 modal 中确认
```

## 输出格式

### 有标签时（标准格式）

当触发消息列出了可用标签，使用标签 ID：

```
## 分类建议

| Thread | 建议标签 | 理由 |
|--------|----------|------|
| {title} | {label names} | {一句话说明} |

<!-- SUGGESTIONS_JSON:{"threadId1":["labelId1","labelId2"],"threadId2":["labelId3"]} -->
```

key = threadId，value = labelId 数组。必须使用 id 而非 name。

### 无标签时（扩展格式）

当触发消息说明"当前没有任何标签"，先建议标签体系再分类：

```
## 建议标签体系

| 标签名 | 颜色 | 说明 |
|--------|------|------|
| {name} | {color} | {一句话说明用途} |

## 分类建议

| Thread | 建议标签 | 理由 |
|--------|----------|------|
| {title} | {label names} | {一句话说明} |

<!-- SUGGESTIONS_JSON:{"newLabels":[{"name":"标签名","color":"#hex"}],"assignments":{"threadId1":["标签名"]}} -->
```

newLabels = 建议创建的标签（名称+颜色），assignments = 每个 thread 建议的标签名数组（用名称不用 ID，因为标签尚未创建）。前端会在用户确认后自动创建标签并应用。

## 注意事项

- 有标签时只用已有标签，不发明新标签
- 无标签时建议 3-8 个标签，颜色用十六进制，名称简短
- 标题信息不足时，跳过该 thread（宁缺勿滥）
- 最多处理 50 个 thread（避免消息过长）
