---
feature_ids: []
topics: [windows, desktop, startup, redirectionguard]
doc_kind: design
created: 2026-10-23
---

# PR #1701：关键资源不依赖用户创建的 junction

## 约定与范围

现场安装源可读，但七次真实 Node consumer 都无法读取三份项目镜像，返回 UNKNOWN/-4094/open。相同模式已在一次性 Windows 进程中开启 RedirectionGuard 后复现：非管理员创建的 junction 被拒，普通目录可读。该实验证明一种机制，不能唯一归因现场的 EDR 产品。

公共实现以公开 main d4b18b480b2cf9c00825be5fb8236c0c21b86baf 为基线；不引入 feat/intranet-windows-codeagent 的定制配置、身份或权限策略。用户自行把通用提交回灌内网分支。保留当前只读探针、完整 consumer 诊断、鉴权及 ACP 语义；不修改 ACL、系统策略、配置和历史。无需用户配置新变量。

内网发行版合入 main 时保留已有的异步 worker、journal、取消和回收链，沿用同一组普通目录、完整校验、用户内容保留及失败恢复契约；不会并存第二套同步物化器。下文第 7 条的同步执行方式描述公共实现，内网执行接线见 [内网运维说明](../ops/windows-project-mirror-recovery.md)。

## 实现契约

1. Windows 的 docs、cat-cafe-skills、assets、guides 在原 project 相对路径使用普通目录，包含整个资源树。这样探针和后续规则、技能、提示词、引导读取路径一致。其他便利镜像沿用现有逻辑；API 启动环境用现有 CAT_CAFE_RUNTIME_ROOT 指向安装根，并配套 CAT_CAFE_WORKSPACE_ROOT 指向用户可写 project（普通部署已有显式工作区时保留），不写配置文件。这样 MCP 二进制独立于 project/packages，持久化路径重定向仍能正确工作。
2. 配置、角色、认证及历史仍在原可写用户目录。既有真实资源目录没有受管理标记时视为用户所有，不采用、不覆盖；缺少探针仍拒绝启动。旧 junction 只移除入口，不访问或删除其目标。
3. 物化前全量读取安装源，逐文件 SHA256，并展开安装根内的资源链接；拒绝越界链接、环和特殊文件。副本不得含链接，写完再次全量实读和比对。保留原来的源与镜像就绪检查及真实 Node consumer 检查，不以 exists/stat、进程启动或零退出码替代实读。
4. 普通目录内的 .clowder-bundled-resource.json 只记录该副本的目录/文件摘要。它不是配置权威，也不决定源是否可信。每次启动重新读取源与副本的所有受管理文件；内容相同不重写，版本变化仅替换仍匹配旧摘要、且没有用户新增内容的副本。用户修改受管理文件、非法标记或副本内链接均保留并明确失败。docs 下新增的评测结果等用户内容只清点、不读取内容、不删除、不阻止正常重启；若该目录同时需要升级，则保留原目录、记录 refresh deferred，沿用真实目录的保留策略，由用户合并资源变更，不自动迁移业务数据。
5. 发布先完成同卷 .clowder-resource-<name>.next，再把旧副本移到 .previous，最后 rename 新副本。第二次 rename 失败时恢复旧副本；若进程在两次 rename 间退出，下次启动先验证并恢复 .previous，再重试。只有完整验证为未改动的静态备份才可先原子改名退出 previous 槽位，再清理。清理中断只留下独立 retired 留存，不阻断健康副本和下次重试；最多保留一个正常回退副本。
6. 中断的 .next 有合法所属标记时改名保留为 .interrupted-<uuid> 并重试，日志给出路径；无标记则保留并失败。中断留存不自动删除用户可能补入的内容。读写失败不使旧链接/副本提前失效。
7. 物化为同步的首启准备，调用方为已经持有 Desktop 单实例锁的 ServiceManager；不允许后台服务并发更新同一 project。每个目录日志记录条目数和耗时。服务只有在全部准备及就绪检查成功后才能启动。暂存、回退都是静态资源，不承载用户配置或业务数据。

## 验证

- 原行为 RED：普通目录及非探针资源、旧链接迁移、升级保护三个断言失败。
- 回归：真实目录保护、安装源缺失、用户修改、链接越界、环、复制中断、发布回滚、下次启动恢复、consumer 超时/取消及全量诊断。
- Windows 原生：降权至 Medium/非管理员创建四个旧 junction；一次性进程开启 EnforceRedirectionTrust 并验证子进程继承。先观察旧路径和三份镜像在真实 consumer 中失败，再走生产准备/就绪路径，验证全量关键路径、非探针下游读取与二次启动。
- API 已构建时，原生用例同时调用真实 design-gate、custody、governance、prompt-template、L0 及 ACP MCP resolver；使用真实 ACP 夹具进程交换 NDJSON 回合，MCP 构建存在时启动真实 collab 服务完成握手和工具发现。测试夹具不能作为真实企业 CodeAgent 的运行证据。
- ServiceManager 实际启动接线、MCP 安装根路径、打包 main-process require 闭包、配置与历史字节保留。
- 原生 CodeAgent 企业客户端仅在用户内网可用，本机不伪称完成该客户端验收；内网回灌后由用户最终验收。
