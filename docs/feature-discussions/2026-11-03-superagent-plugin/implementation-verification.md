---
feature_ids: []
topics: [superagent, plugins, acceptance]
doc_kind: verification-record
created: 2026-11-04
status: awaiting-independent-review
---

# 实现验证记录

原任务：`task:work:0001793720663272-000609-8bfe63c4`。范围与体验批准来源见 [README.md](README.md)。不将下列脚本化判断等同真实模型验收。

| 材料 | 当前证据 |
| --- | --- |
| 独立插件 | `feat/superagent-plugin-20261104@195aa1ba65a6e78b5828e41f08970bd6c47591fc`，插件仓 `packages/superagent/` |
| 编排行为 | 15 项测试通过；含两事项、跨会话续接、暂停重启、回执丢失、含糊请求、仅人验收、失败显现和显式重试、报告回声去重、并发设置，以及工具 schema 与实际校验的一致性、协调交付的待验收提示 |
| Host | API 构建、Web 类型检查通过；入口/资源/发布 19 项、终态发布 8 项；前端入口与归档安装 9 项、既有侧栏 16 项通过 |
| 打包接线 | 候选 10 的 TGZ 经真实 Manager 安装、设置 operation、订阅、Redis 持久化与普通 Queue，通过脚本化旅程，并覆盖真实 Host 终态失败回流；回执 `artifacts/superagent-installed-91b1a63f5a4f4240b7c2ab1ac7b813a3/installed-host-probe.json` |
| 页面 | 从真实插件页上传安装、启用候选 7、保存责任、选择真实成员与两个来源、确认开始；通用顶部入口在 classic/v2 均导航至同一长期主对话。回执 `artifacts/superagent-live/browser-navigation.json`，截图 `top-entry-classic.png` / `top-entry-v2.png` |
| 真实执行 | 原 Queue 路径缺少订阅发布，调用 `415b25da-0566-4268-a731-d6d9a616f36b` 读不到 inbox；已以 Queue.send→markDelivered 路径复现并修复。显式重试后，真实协调成员创建两个 canonical Work，两个独立原生会话分别写入并读回 greeting.txt（17 字节）和 notes.md（15 字节），均保持 closure=open。第二份结果由协调成员读到普通终态回复后回原处。 |
| 跨会话与接受 | 候选 9 经真实页面替换并回读 SHA-512，与源码包一致；暂停/恢复保留同一主对话与两个 Work。浏览器从另一已选来源反馈，澄清后协调成员关闭已接受的 greeting Work、续接原 notes Work/原生会话；原执行成员读回修订文件并报告，协调成员依据明确人类消息关闭 notes Work。恰好两个原 Work 均 satisfied，badge=0。`artifacts/superagent-live/native-continuation-result.json`、`browser-lifecycle.json` 和原始 native JSONL 为证。 |
| 还未通过 | macOS、独立审查、合并后的验收；未发布 npm/目录、未部署当前 runtime |

插件包保存在父工作区 `artifacts/superagent-plugin-20261104/` 的各候选子目录。仅最新经确认候选可作为交付；原失败或旧候选保留用于本轮定位，不称为发布包。插件尚未发布到 npm 或插件目录。

当前包：`installed-candidate-10/clowder-ai-superagent-0.1.0-alpha.1.tgz`，SHA-256 `866c27199c0d12e9bc720a6247df0c6284dd4d45e0d5a140809867f3e9384069`。Host 通用入口和 Queue 发布修正是运行前提。Host 已获独立批准，插件失败关联的修正与真实包 RED/GREEN 见 [review-resolution.md](review-resolution.md)，修正后的独立复审尚待完成。

## 真实旅程中发现并处理的问题

- Queue 的原子准入与 `markDelivered` 绕过订阅发布；以真实 Queue 路径先红后绿修复。所有未投递用户输入和 whisper 保持不可发布，重复 delivery 保留一个事件，公开 notice 不暴露 private Queue payload。
- 实际模型使用公开 schema 允许、内部 strict schema 拒绝的字段；工具 schema 现与运行时 Zod 定义逐项相等校验。补充插件工具发现入口，避免执行成员到 shell 查找不存在的同名命令。
- 协调成员从普通终态回复代为交付时未显示待验收数；已先红后绿补齐，明确人类接受才清除。
- Windows 解包超过默认 30 秒，页面报超时而后台实际已安装；归档安装复用现有 `mutationTimeoutMs=120000`，7 项组件测试通过，实际安装状态以 digest 回读确认，未盲目重复安装。
- 验收来源原先没有选择真实成员，浏览器输入又遇到 hydration/持久草稿合并；探针补齐首选成员、等待真实线程读取、逐字输入并核对实际 POST 内容。一次混入 `test draft only` 的反馈保留，Bot 请求澄清；随后明确回复续接同一 Work，没有另建事项。第二份验收输入早于本次工作线程回报，实际闭合发生在回报之后；未来探针已收紧为读取新的“等待用户验收”回执后再发送接受，未为刷新证据重复付费调用。

旧候选的 `superagent-live.model.mjs` 因待验收数未齐而失败，不能单独称其通过；当前交付依据是修正后的 TGZ、续接原 Work 的实际 native 轨迹和最终回读。媒体回归 15 项中 4 项失败，改动前 `bca48985` 的发布器同样复现这 4 项；本次终态发布 8 项全过，媒体问题未伪报绿色。当前 checkout 无 `check:architecture-ownership` 命令，架构归属以实施文档和实际 diff 提交审查。

## Windows 实例与隔离

当前完整 Host：API 3219、Web 5220、Redis 6427；程序为本 feature 工位，数据、配置、原生 HOME、SQLite 全在本工位 `artifacts/superagent-live/`。实际 PID、包信息及路径以该目录 `instance.json` 为准。首次只复制 Codex `auth.json` 至专用 HOME，重启保留该 HOME；没有将原生会话、索引或 SQLite 指向原客户端目录。

feature checkout 默认禁止隐式写全局能力配置。首次真实请求因此在实际 Queue 等待缺失的注册文件；验收启动器现使用已有能力编排器，在专属 config 根显式准备核心能力。沿原排队消息继续，没有重发用户请求来制造另一轮执行。

旧设计预览 5214、临时完整 Host 3214/3215/3217 和 Web 5216/5218 均已停止，端口已核对释放。Windows managed stop 返回 cleanup unsettled，原管理记录和日志保留，未手改记录冒充清理成功。当前仅一套交互验收环境。

独立 TGZ 组合测试另有短时 Redis 6417，其进程由 PowerShell 探针核对 PID/监听/数据目录后启动并关闭；AOF/RDB、原始记录保留。标准 Redis runner 使用 Unix `ps` 身份协议，Windows 上无法发出有效 lease，因此此探针用原生 CIM/TCP 回执核对独立实例，没有伪造 runner lease。

## 验收隔离事故与修正

最初两次完整 Host 启动继承了调用宿主的 `EVIDENCE_DB`，使 SQLite 未隔离。发现旧定时任务登记后已停止两个测试 API 及 Redis。只读审计看到原唤醒于 17:30:42.760 UTC 正常投递，测试进程于同一秒留下 `RUN_FAILED / Queue admission has no valid target`；没有前快照，不能排除其他启动、缓存或账本写入。未对共享数据库做删除、恢复或回滚操作。

修正后的启动器显式绑定 EVIDENCE_DB、EVENT_MEMORY_DB、其他数据和原生状态路径，独立设置附属端口；新增污染环境回归测试通过，重新启动后的独立 SQLite 中没有旧 hold 记录。审计原件和原进程日志哈希保存在 `artifacts/superagent-live/isolation-incident.json`。该事故不能算成测试隔离成功；保留于交付审查材料。
