# OpenCode 2.0.28 隔离事件与正文样本

本目录随 [clowder-ai#2003](https://github.com/zts212653/clowder-ai/pull/2003) 回流；
原始捕获由该 PR 的协作者完成，家内验证使用这些公开样本做回放。

来源：clowder-ai#1991 协作调查，2026-11-16，鲸鲸运行本机 OpenCode 2.0.28，
使用独立 HOME/XDG 目录与本地 OpenAI-compatible mock provider。
mock 返回 `Hi`，reasoning 场景另返回 `thinking about it`；没有调用真实模型 provider。
砚砚从捕获的 NDJSON 和同一隔离 SQLite 只读提取本文件旁的 `captured.json`。

仅重命名了 session/message/part 标识，保留事件形状、顺序、时间、数据库 seq 和正文结构。
未包含用户会话、认证、配置或数据库文件。

原始 mock 捕获的 SHA-256（原文件为 PowerShell 重定向生成的 UTF-16LE；提交样本为 UTF-8）：

- text-first：`87daa648040d74fa8bf09e192ebde5b8fa5cb8698b3df74287a052da73ae0cdb`
- text-second：`fc52ae9a154f21c5fac9715d9620ae7d70e8d3979f746aafc58bb2adbf19161d`
- reasoning：`cf94fbadf3513e278bc2403830a824c278d9fa31ddee8cc3872a1d558ce05b04`

## 事件与数据库关联

| 运行 | 实际事件 | sessionID | part.messageID = session_message.id | seq |
| --- | --- | --- | --- | --- |
| text-first | text | ses_text | msg_text_first | 5 |
| text-second | text | ses_text | msg_text_second | 16 |
| reasoning（开启 --thinking） | reasoning, text | ses_reasoning | msg_reasoning | 5 |

三组均没有 `step_start`。前两组是同一会话连续两轮，消息 ID 不同。
每一行 `messages` 都通过该事件的 `sessionID + part.messageID` 精确读取，
并核对 `type=assistant`；没有按会话最新消息挑选。

2.0.28 的必要表结构如下，真实库中没有 `part`：

```sql
CREATE TABLE session_message (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  type TEXT NOT NULL,
  seq INTEGER NOT NULL,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL,
  data TEXT NOT NULL
  -- 原库另有 session_id -> session_v2.id 外键；测试投影省略该外键。
);
```

`data` 不含外列 `id/type`；assistant 正文位于 `data.content[]`，
只提取 `{type:"text", text:...}`，不显示 reasoning 或 tool。

## 验证边界

捕获的是正常成功流，不声称自然复现了 Windows wrapper/DeepSeek 丢文字。
服务回归中的 reasoning-only / step_finish-only 流是明确注入的丢文字场景。
其中 reasoning-only 可直接从第三组捕获中删去 `text`，数据库仍保留原助手正文。
另一次空成功 mock 输出 0 条 NDJSON；现有 `eventCount > 0` 条件不会恢复这种情况。
这次不增加重跑、export 轮询、等待后台完成或 serve 迁移。

一手源码固定在官方 tag `v2.0.28`，提交 `026b106bc5d41b679ffc413264229c340871e4d3`：

- [CLI 事件投影与 assistantMessageID](https://github.com/anomalyco/opencode/blob/026b106bc5d41b679ffc413264229c340871e4d3/packages/cli/src/run/noninteractive.ts)
- [session_message SQL 定义](https://github.com/anomalyco/opencode/blob/026b106bc5d41b679ffc413264229c340871e4d3/packages/core/src/session/sql.ts)
- [assistant content 定义](https://github.com/anomalyco/opencode/blob/026b106bc5d41b679ffc413264229c340871e4d3/packages/schema/src/session-message.ts)
