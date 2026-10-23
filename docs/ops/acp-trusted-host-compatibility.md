---
feature_ids: [F241]
topics: [acp, windows, plugins, compatibility]
doc_kind: guide
created: 2026-10-22
---

# Windows ACP 内网持久配置

适用于部署者认可 Host 的本机账户与存储、接受祖先目录替换风险的环境。默认严格模式不变；内网使用持久配置覆盖默认，正常重启和升级持续沿用。

## 配置一次

在运行 Host API 的电脑、启动器实际读取的 Host 根目录 `.env` 中一次加入（不要覆盖原文件）：

```dotenv
CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE=trusted-host
CAT_CAFE_ACP_BOOTSTRAP_CONFIG_AUDIT_MODE=warn-bootstrap-root
```

然后按[Host 操作指南](./acp-client-plugin-user-guide.md)正常重启 API。以后仍用原启动方式，无需每次终端 export。源码 Windows 启动器读 Host 根 .env；API job 读取同一文件。Bash 另支持 .env.local，避免在两处放冲突策略。单独命名 .env.intranet.example 不会自动加载。

服务管理器或容器使用其既有持久环境注入；desktop 已提供自己的 AUDIT_LOG_DIR，保留该位置。插件、角色和 Hub 编辑接口不能开启上述 Host 策略。

旧 `CAT_CAFE_TRUSTED_HOST_COMPATIBILITY=1` 可以继续持久使用：只有 exact 1、对应新键未设置才映射上述受限组合。显式新值逐项优先。旧版共享开关曾允许任意插件配置在审计失败后保存；本候选已经收窄，不能把旧版说明套到新行为。

| 有效目录模式 | 请求审计模式 | Windows 的最终行为 |
| --- | --- | --- |
| strict | required 或 warn-bootstrap-root | 完整祖先检查，保存必须成功审计；请求 warning 时启动诊断说明被 strict 屏蔽 |
| trusted-host | required | 跳过祖先信任，保存必须成功审计 |
| trusted-host | warn-bootstrap-root | 跳过祖先信任；审计失败时仅可评估已有 client 的引导目录变化 |
| 非 Windows | 任意 | 不获得 C 的审计豁免 |

新键空串或拼写错误会在启动阶段给出可读错误。ACP 的 strict 与启动器 CAT_CAFE_STRICT_PROFILE_DEFAULTS 无关联。启动摘要报告有效模式、旧别名和屏蔽原因。

## 用户如何选择目录

1. 在 **Host 本机浏览器**用所有者账户进入“设置 → 插件 → ACP 客户端目录”。安装和首次添加 client 先保证正常审计可写。
2. 目标 client 的“引导目录”留空，点击“检查引导目录”；Host 返回实际选中的完整路径及严格/兼容标识。
3. 点击“使用此目录”后保存。只改变已有 client 的 root 且满足 C 全部条件时，审计失败仍可保存，并单独显示 warning；新增 client、改名称/命令/参数/MCP、混合修改都仍要求正常审计。
4. 退出重进确认路径回读，再给绑定角色发消息。失败后修复条件并明确重试；不会永久缓存旧构建失败。

也可输入一个专用绝对路径再检查，例如 `D:\ClowderACP-Private`。父目录须存在；缺少的私有末级和检查子目录可由 Host 创建，已有私有 ACL 不合格会拒绝。不要填写盘根、共享项目根、`D:` 这种盘内相对位置；不要通过 takeown 或移除盘根的 Authenticated Users 授权来处理。

检查是原生校验，会启动 Windows PowerShell，可能创建专用目录，不调用 Agent/模型。不只做路径字符串判断。即使之后保存因并发、写入或恢复失败，创建的目录仍可能保留，Host 不自动删除或修旧 ACL。

目录只是 Agent 启动引导位置；真实项目仍通过 ACP session 传入，不能用它覆盖业务 cwd。私有 owner/DACL、真实本地 NTFS、逐级非链接、SUBST 拒绝和 spawn 前复验仍保留。兼容结果接受祖先替换风险，不是“完整信任校验通过”。

插件管理仍要求直接本机：API 绑定回环、peer/Host/Origin 回环、无反代头以及正常身份策略。内网另一电脑/反代访问不会因兼容模式取得管理权限；403 应与审计 503 分开判断。

## 审计失败和恢复

`Plugin audit log is unavailable` 是实际审计追加失败，不能据此判断引导目录失败。默认位置仍是 API cwd 下 data/audit-logs。诊断报告 writer 实际绑定的位置；显式 AUDIT_LOG_DIR 不会被静默改道。

部署者应提供 Host 账户可追加的专用日志目录；修改 AUDIT_LOG_DIR 须保存到部署配置并重启 API，仅刷新 Web 不生效，Hub 不能热改。公共 Host 的自动部署准备属于独立 D 交付，不能把尚未交付的命令当成默认行为。本分支的独立内网 Windows 包已预置持久默认值，普通用户不必编辑环境变量；见[内网包指南](./intranet-windows-codeagent.md)。

- 正常审计成功：保存正常完成，无降级 warning。
- 审计失败且已有 client 仅改变 root：C 还会验证包/grant、原生目录身份、事务内旧文本和版本；成功才显示“已保存，但本次审计未写入”。
- 审计失败且不满足例外：未保存。安装、启用、新 client 和修改命令必须先恢复正常审计。
- 已写入但 runtime 刷新/恢复失败：显示部分失败，不能当成完成；刷新回读配置和插件状态后处理。
- C 的配置已写入但 inventory 落盘失败：在同一队列释放前，确认文本仍是本次写入值并补偿恢复旧原文；恢复库存后可在审计仍故障时重试同一 C 请求。不能覆盖并发编辑。若补偿自身失败，则明确报告部分保存，须恢复库存与正常审计后刷新、普通保存；配置与库存是两个文件，不能声称跨文件原子提交。
- 日志位置恢复后再次保存会重试审计；成功清除当前 warning。既有已丢失审计不自动补写或伪造成成功。

同一 inventory 的写事务使用原生 SQLite 文件锁排他，覆盖配置副作用、库存提交及失败补偿；忙锁时等待当前事务结束再明确重试。辅助 `*.writer-lock.sqlite` 不存业务数据，不删除或迁移。它不提供多 API 的 runtime 协同，部署仍应只运行一套 Host API。只停止已确认归属的重复实例，不按进程名批量结束，不删除用户存储。

## CodeAgent 和回退

入口为 `codeagent --acp`；原本已验证的 bypass 参数保留，普通模板不默认开启。客户端 bypass、Host 祖先信任与审计例外是三项不同策略。

检查、保存成功不保证 CodeAgent 自身不会在项目、HOME、认证、会话或 MCP 返回 EPERM。区分 initialize、session/new、prompt 的阶段；本机合成 ACP、原生 dsh/Claude/Pi 和报告者 CodeAgent 证据分别记录，不把一种正常输出扩大为全部 MCP/协作/续接验收。

恢复严格模式时在持久部署配置中明确设 `CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE=strict`、审计设 required，正常重启 API；显式新值会覆盖遗留旧别名。配置、角色和历史保留，严格模式会重新拒绝祖先不合格的目录。
