---
feature_ids: [F241]
topics: [acp, windows, plugins, compatibility]
doc_kind: plan
created: 2026-10-22
---

# Windows ACP 启动策略与受限配置恢复

Windows 企业存储可能无法满足严格祖先信任，且审计追加失败与 bootstrap 检查失败属于不同阶段。本契约将两项策略分别限定；内网配置可持久保存一次，普通启动、插件和 API 不自行改写部署文件。

## 策略边界

- B：`CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE=strict|trusted-host`，默认 strict。trusted-host 只跳过 Windows 祖先 owner/DACL；保留自身私有权限、真实本地 NTFS、逐级非 reparse/junction、SUBST 拒绝和 spawn 前复验。不修已有 ACL，接受祖先替换路径的风险，不能称完整信任校验。
- C：`CAT_CAFE_ACP_BOOTSTRAP_CONFIG_AUDIT_MODE=required|warn-bootstrap-root`，默认 required。只有 Windows + trusted-host + warn-bootstrap-root，且正常审计追加已失败，才评估已有 client 的 root-only 恢复。
- 旧 `CAT_CAFE_TRUSTED_HOST_COMPATIBILITY=1` 仅 exact 1 生效，对未设置的新键分别映射 trusted-host / warn-bootstrap-root；不再让所有平台的任意插件配置绕过审计。新键逐项优先；显式 strict 会屏蔽 C，显式 required 会关闭 C。
- 两项新键都只在启动期使用；空/非法显式值启动报错，不回退旧值。启动摘要显示请求/有效策略及屏蔽原因，旧变量输出一次弃用提示。旧别名至少保留相关两个正式版本且不少于 90 天，到期复评，不能定时静默关闭。
- 插件管理保留直接本机、owner、登录、Origin/CSRF 与受限角色边界。callback Agent 不获得 C；不新增远程管理能力。

## C 的完整准入

先尝试正常审计。失败后验证真实安装实例、包完整性、动态 ACP 声明及现有 effective config-read grant；严格解析完整新旧 JSON，只允许已有 client 的显式 bootstrapRoot 变化。名称、顺序、ID、命令、argv、bypass、MCP 白名单或其他配置同时变化均不得降级。

服务器原生复跑目录校验；本机文件系统的目录身份识别大小写/分隔符/长短名别名，不能仅按字符串声称位置改变。检查可能创建 root 和 directory-check 目录；保存失败仍保留，不自动删除、不改旧 ACL。

写入同一个 inventory.transaction 内复读原配置文本、包 digest、grant 和实例，和捕获状态比较，再消费 revision 围栏。复读至写入无 await；操作目标/状态等写者共享 canonical 队列。文件库存另由辅助 SQLite 原生锁覆盖读取最新状态、配置副作用、JSON 提交和同步补偿，最后释放；进程崩溃由 OS 释放，不查询 PID、不缓存长期连接。仅对可靠支持 SQLite 原生锁的本地存储提供事务排他，部署仍只运行一套 API，不宣称多个活 API 的 runtime 协同。辅助文件不存业务数据、不删除；只读快照使用原子 JSON。不能把进程内队列称为跨进程锁。

配置已保存的 warning 与实际错误分别返回和展示；写入未知、已写入但 refresh/恢复失败不得伪装成功。下一次明确保存重新尝试审计，不永久缓存旧失败，不伪造自动补记。

新增 client、改命令/参数、安装、升级、授权、启停、卸载、角色绑定和工具调用仍按各自正常审计准入。C 不提供豁免。

## 持久配置与交付

Host .env 或服务管理器的持久环境可一次保存策略，重启 API 生效；不要求每次 PowerShell export。AUDIT_LOG_DIR 构造时绑定且不可从 Hub 热改；现有显式路径不静默迁移，API 默认仍为其 cwd/data/audit-logs。

D 的一次性准备、模板、探针和源码部署接线单独交付，普通启动只读，不夹带安装器或 F289 数据迁移。本分支另行提供独立内网 Windows 发行版，默认配置由桌面只读注入，已有配置长期保留，见[内网包指南](../ops/intranet-windows-codeagent.md)。新 Agent 推荐单 Agent 静态插件，现有官方动态目录保持兼容；第三方动态 grant 和命令执行沙箱不在此契约内。

验收覆盖正常审计、root-only 正反例、原生身份、原始文本/digest/grant 并发、健康 refresh/stop/crashed、失败重试、本机门禁、warning 与错误、跨进程重叠事务排他及崩溃后释放；合成 ACP 与真实客户端证据分别标识。操作见[指南](../ops/acp-trusted-host-compatibility.md)。

Architecture cell：Host ACP 启动、插件保存准入、inventory 写者。Map delta：策略分域；配置/审计复用现有存储。Why：持久内网接入可用，同时限定每项权限取舍及恢复行为。
