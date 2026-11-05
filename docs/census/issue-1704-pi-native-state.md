---
feature_ids: []
related_features: [F241, F289]
topics: [pi, acp, persistence, ownership, issue-1704]
doc_kind: census
created: 2026-10-23
tips_exempt: 修复既有原生客户端的会话连续性和错误传递，没有新增用户入口或独立提示动作。
---

# 内置 Pi 原生状态资产与消费边界

本记录描述 #1704 实现的新增资产；不启动 F289 的全局根切换。

| 对象 | 权威与路径 | 生命周期 / 消费方 |
| --- | --- | --- |
| 原生历史 | Pi：`<dataRoot>/native-sessions/pi/v1/<scope>/<nativeId>/*.jsonl` | Pi 读写，桥精确选择及核验；close、池回收和升级均保留；不能从应用消息反向伪造 |
| 绑定摘要 | 桥：同目录 `binding.json`，仅含版本、ID、cwd、MCP 结构哈希 | 新建时独占写入，冷恢复验证；不含 token/env/model 配置，也不是 transcript 副本 |
| 写者锁 | 实际 Pi 进程：同目录 `writer-lock.sqlite` | Node 24 内置 SQLite 排他事务，在导入 Pi CLI 前取得；进程结束由系统释放；文件保留，不按 PID/mtime 抢占 |
| 活跃对象 | `PiAcpBridge` 的 sessions/opening | 仅运行句柄与并发合并；不是恢复权威，失去 Map 后仍须通过真实写者锁 |
| 临时 MCP extension | 当次桥创建的 TEMP 目录 | 使用当前服务器和凭据；close 删除其自建临时配置；不修改用户 Pi/项目设置 |
| 应用历史与绑定 | 现有 SessionChain/消息存储 | 本修复不迁移、不删除、不替换；精确 load 失败必须保留原绑定 |

`dataRoot` 使用现有 `resolveCatCafeDataRoot()`：显式 `CAT_CAFE_DATA_DIR` 或默认 HOME 下 `.cat-cafe`；不新增 cwd/TEMP 历史根。根可为用户明确选择的别名，受管理子目录及历史文件不得是 symlink/junction。Unix 新目录 0700、绑定文件 0600；Windows 继承已选择根的 ACL，不递归变更用户 HOME/项目 ACL。自定义根应满足既有私有状态的访问边界。

scope 由 Host 的项目、稳定成员 ID、profileId、显式 accountRef/原生 profile 标记和 Pi 原生配置目录计算；不随模型、invocation 或 token 变化。仅准确内置入口获得受信 `--session-root`/`--session-scope`，参数参与原有池签名和 Windows 启动审计；外部桥不改写。

## 绑定与凭据

热复用仍比较完整运行绑定，沿用通用 ACP 的稳定 credential-file 规则。冷恢复允许已知 `cat-cafe*` MCP 的刷新文件 nonce 路径变化及 invocation/token 轮换，因为 Host 重启会重建该文件；command/args、工具身份、用户/成员/thread、API 地址、其余 env 及其他服务器仍参与摘要验证。

冷恢复必须启动新的 MCP extension，沿用同一原生 session 的稳定 server/tool 名称。旧原生进程尚活着时，其排他事务禁止第二写者；不会因新 token/新 Host 取代尚存活的写者。恢复成功后 Host 才提交新会话凭据文件绑定。

## 错误与兼容

内置桥 load 错误使用 `-32004`；只有握手 agentInfo 为 `clowder-pi-bridge` 的该错误会在 `AcpClient.loadSession` 转为 `AcpSessionBindingError`，阻止通用“load 失败后新建”回退。其他 ACP 行为未放宽。

仅支持本桥创建的 `clowder-pi-v1-<uuid>`、Pi 3 版原生文件格式，以及 Pi 1.3 兼容 RPC。真实写者使用可解析的已安装 Node CLI 和 Node 24+；不安装/下载 Pi，也不执行任意 shell fallback。Windows SQLite 使用命名空间路径支持长目录。

恢复的 JSONL 在实际 writer 取得锁后、导入 Pi CLI 前逐行检查语法、记录基本形状及 header 身份，避免原生 loader 静默跳过损坏行后误报恢复成功。校验不改写文件，也不承担迁移或内容重建；拒绝后保留原文件并释放锁。

旧 `--no-session` UUID 不存在可恢复原生历史；保留应用记录，用户显式新会话。回退旧二进制不删除新增状态；旧版不能恢复新格式时如实失败，不承诺无缝回退。备份/后续数据根迁移必须同时携带原生 JSONL 和绑定摘要；在无活跃写者时处理辅助锁文件，禁止清库。

## 验收边界

[恢复与输出契约](../design/2026-10-23-issue-1704-pi-native/recommended-design.md) 给出通用验收要求。源码、真实 Pi/受控接口、真实供应商、MCP、安装包和现场验收分别记录证据；实例记录与审查回执归对应 PR 或作者工作区，不作为公共策略批准。仅思考完成不能证明有效答复，也不能推断原生文件必为空。
