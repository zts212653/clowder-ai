---
feature_ids: [F063, F113, F232, F273]
topics: [desktop, redis, workspace, uploads]
doc_kind: design-discussion
created: 2026-11-06
---

# #1789 历史资源接续诊断与恢复方案

现场的 Windows 桌面版可以列出旧会话和作品，图片在解析旧工作区 ID 时返回 404，上传文档在当前 uploads 根下返回 404。目标是让用户辨认每处断点，并在明确选择后用同一实例上下文访问原件。原始报告基于已安装的 `5d04c944`，本文的隔离证据基于 `next@471b56a4bbe45f331902adeb6c03ca99d19bb30c`。[原 Issue](https://github.com/zts212653/clowder-ai/issues/1789)

维护者在 #1789 的首次回复中允许先围绕一致性诊断和可回退方案收敛。#1869 的方向结论仅将独立只读目录诊断纳入正式审查。S2 要求对既有或无标记 Redis 只读探测。归属标记只能由应用为自己新启动、已绑定专属目录的实例写入。Redis 采用、迁移、同目录双写防护和冲突时的启动体验仍需维护者确定。[#1789 triage](https://github.com/zts212653/clowder-ai/issues/1789#issuecomment-6594828392) · [#1459 S2](https://github.com/zts212653/clowder-ai/issues/1459#issuecomment-5658770842) · [#1869 方向结论](https://github.com/zts212653/clowder-ai/pull/1869#issuecomment-6665038009)

## 关联变更对账

| 路径 | 已有机制与状态 | #1789 的缺口 |
| --- | --- | --- |
| 实例数据面 | #961 仍跟踪源码运行态与源码树分离。Open #1452 在 `main` 上试验 Redis marker、私有端口与采用，留作参考。Draft #1553/#1554 拆出构建正确性与 loopback。#1227 已合入桌面更新与安装恢复，Closed #769 试验过目录统一与迁移。 | 先交付目录证据。沿 S2 的评审结果决定采用或迁移，现有 #1452 不作为已批准实现。 |
| 旧工作区 ID | `next` 已有持久 root connection、canonical ID、已有 `legacyAliases` 和经验证的 scoped alias。#1816 仍跟踪已授权额外目录被裸 ID 读错的问题，维护者要求沿现有根身份处理。#1112 已合入目录标签显示。 | 非 Git cwd 下，历史裸 worktree ID 仍缺可验证的映射。连接目录后 canonical ID 已可读，旧 URL 还需要单独决策。 |
| 上传目录 | API 复用 `getDefaultUploadDir` 选一个明确根。#1799 已合入文件操作菜单的 Windows 支持，涉及上传文件操作的现有路径仍读取选中的上传根。#769 中迁移提案已关闭。 | 指向旧目录的接续契约尚缺。上传文件定位与 Git worktree 发现无关。 |
| Windows 路径 | #1782 已合入 Host outbound media 的根边界修复，Closed #413 属工作区绝对路径识别。 | 文件根查找先于词法校验和解码。Redis 8.10.3 的 Cygwin 路径拼写只在诊断比较边界处理。 |
| PR 预览和作品 | #1815 已合入会话范围 PR reader。#1847/#1866 的 Host 变更已合入，复用作品投影与按线程读取，#1621 仍讨论 artifact 身份和版本。 | 已投影作品的原件读取仍要依赖有效的工作区或 uploads 根，沿现有投影验证。 |

检索范围包括上游各状态及相关 fork 的 PR 和分支。按 `1789`、`1459`、`1816`、`linked-roots`、`Redis ownership`、`uploads` 及 desktop/workspace 主题筛选，再核对命中 PR 的文件和当前 `next` 调用点。核了 `whutzefengxie-ops` 与 `mindfn` 的相关分支，未发现可直接复用的 #1789 接续补丁。新近的 Draft #1722、Draft #1849、Draft #1855 和 Open #1853 分别落在运行包体积、桌面插件窗口同步、执行恢复、Windows 签名缓存。跨 fork 搜索遇到一次限流，后续以相关仓的定向查询和 Git refs 补查，结论限于查到的候选。[#961](https://github.com/zts212653/clowder-ai/issues/961) · [#1621](https://github.com/zts212653/clowder-ai/issues/1621) · [#1452](https://github.com/zts212653/clowder-ai/pull/1452) · [#769](https://github.com/zts212653/clowder-ai/pull/769) · [#1816](https://github.com/zts212653/clowder-ai/issues/1816) · [#1782](https://github.com/zts212653/clowder-ai/pull/1782) · [#1815](https://github.com/zts212653/clowder-ai/pull/1815) · [#1866](https://github.com/zts212653/clowder-ai/pull/1866)

## 实际路径和现有授权

1. **桌面启动。** `runtime-config.js` 读取显式隔离实例或安装标记。普通启动由 `resolveUserDataDir()` 取平台 AppData 根。当前 `ServiceManager._startRedis()` 在普通模式对已监听端口发 PING，成功便返回，API 随后从 `REDIS_URL` 接入该端口。自启 Redis 的预期目录是 `<userData>/data/redis`。隔离模式有不同根和端口，并拒绝占用的端口。[启动代码](https://github.com/zts212653/clowder-ai/blob/471b56a4bbe45f331902adeb6c03ca99d19bb30c/desktop/service-manager.js#L469)
2. **配置和文件根。** 桌面用 `<userData>/project` 作为 API cwd，并设置 `UPLOAD_DIR=<userData>/uploads`、`EVIDENCE_DB`、transcripts 等。普通模式尊重显式 `CAT_CAFE_WORKSPACE_ROOT`，API 的活动配置根经 `CAT_CAFE_CONFIG_ROOT`、模板、cwd 解析。隔离模式还显式绑定配置、全局配置、workspace 和 data。源码运行可用已有 `CAT_CAFE_DATA_DIR`、`CAT_CAFE_CONFIG_ROOT`、`CAT_CAFE_WORKSPACE_ROOT`、`UPLOAD_DIR` 及各自的运行配置。打包桌面会覆盖 uploads，给桌面进程加同名环境变量无法验证接续成功。[桌面 API 环境](https://github.com/zts212653/clowder-ai/blob/471b56a4bbe45f331902adeb6c03ca99d19bb30c/desktop/service-manager.js#L371)
3. **工作区。** 原始 raw URL 只携带 `worktreeId` 和相对文件路径，`getWorktreeRoot` 查当前 Git cwd、持久链接、兼容的临时 UI registry 或经验证的 scoped alias。当前配置工作区的授权清单和用户明确连接的 canonical root 可用于恢复；客户端传入的 `repoRoot`、历史 `thread.projectPath` 和 basename 只能提供定位线索。现有 root connection 依靠 direct-human 身份、服务端 proof 和 epoch 持久化 `f063_root_v1_…`。它在 `CAT_CAFE_DATA_DIR/workspace/linked-roots.json` 保存状态，未指定 data 时用活动项目下的 `.cat-cafe/workspace/linked-roots.json`，兼容读取 cwd 下旧文件。通过现有断开操作撤销，避免旧文件重新生效。文件读取继续复用词法及 realpath 包含检查和敏感路径拒绝规则。[工作区解析](https://github.com/zts212653/clowder-ai/blob/471b56a4bbe45f331902adeb6c03ca99d19bb30c/packages/api/src/domains/workspace/workspace-security.ts#L163) · [持久连接](https://github.com/zts212653/clowder-ai/blob/471b56a4bbe45f331902adeb6c03ca99d19bb30c/packages/api/src/routes/workspace-root-connection-routes.ts#L56)
4. **两个入口。** 首页 `HomeWorksSummary` 使用 `/api/artifacts?view=recent-works&limit=3` 的作品投影，聊天 `/api/messages?threadId=…` 回读原消息 rich blocks。旧图片在两个入口都保留原 `/api/workspace/file/raw` 引用，文档都保留原 `/uploads/` URL。raw 先定位根，再读文件字节。uploads 由 API 根据启动时解析的 `uploadDir` 注册静态路由。图片拿到 HTTP 200 后由消费端解码，根未连接的 404、已连接但文件缺失的 404、字节无法解码是三类结果。[首页后端](https://github.com/zts212653/clowder-ai/blob/471b56a4bbe45f331902adeb6c03ca99d19bb30c/packages/api/src/routes/threads.ts#L1796) · [原会话后端](https://github.com/zts212653/clowder-ai/blob/471b56a4bbe45f331902adeb6c03ca99d19bb30c/packages/api/src/routes/messages.ts#L991) · [上传注册](https://github.com/zts212653/clowder-ai/blob/471b56a4bbe45f331902adeb6c03ca99d19bb30c/packages/api/src/routes/uploads.ts#L18)

## 本次可运行的诊断

从源码仓运行下列命令。第一个参数是该桌面启动实际使用的 `userData`，端口以该实例启动证据为准。使用支持 JSON 输出的 Redis CLI，可将可信的 `redis-cli.exe` 完整路径作为第三个参数传入。

```text
node desktop/redis-directory-diagnostic.js <absolute-user-data-directory> <port> [redis-cli]
```

命令只向 IPv4 loopback 发送 `CONFIG GET dir`，输出端口和一个结果，无路径或凭据输出。它不读取键、改变 Redis 配置、写标记或启动 API。它在可验证时比较两端实际目录，支持该 Windows Redis 构建的 `/cygdrive/<drive>/…` 写法。

- `directory_mismatch` 记录端口与预期 Redis 目录分离。分别核对桌面启动中的配置、工作区和 uploads 根，保留受影响的原始 URL。
- `directory_matches` 记录 Redis 目录匹配。仍须分别核对配置和文件面，匹配结果只作为诊断证据。
- `directory_unknown` 记录本次无法比较。端口未监听、ACL 拒绝、CLI 不可用、目录不可访问或格式不支持均可导致此结果。保留未知状态，避免依据不完整证据推断归属。

诊断的最小文件面是桌面预期 Redis 目录、返回的 Redis 目录和单条受影响资源的现有 URL。安装支持可进一步从现有配置和日志查对实际根，逐项显示检查结论。当前命令与启动解耦，操作者多执行一步，避免在恢复策略未确定时改变启动可用性或每次启动引入额外 Redis 探测。

## 恢复切片，待契约批准

以下三条是候选路径，用于评估授权、持久化、部分失败和回退。正式实现范围由维护者决策确定。

### 选择实例数据面

1. 在拟接续的旧实例和当前实例之间选择一套权威上下文。先从安装标记、实例台账、实际进程和显式配置确认 Redis 目录、数据库、配置、uploads、工作区连接文件及 SQLite/日志根，显示来源和冲突。旧目录、进程、密码或原件有任何未知时保留未知，等待确认。仅凭 PING 或目录比对不得采用。
2. 维护者应先决定复用同一套已授权数据面还是迁移副本，以及启动遇到外部监听时如何提示。只有获准的迁移才基于备份副本验证 Redis 版本、原写入者与新写入者的交接和读写兼容。一个候选是复用现有 Electron 数据面或显式 `CAT_CAFE_DATA_DIR`，沿已有实例配置持久化选择。现有 Redis 的只读诊断和任何采用操作应由不同入口承接。
3. 切换前记录旧、新生效配置及备份位置和哈希。启动前确认目录、端口与唯一写入者。启动后验证历史、原会话、两类文件和重启时的有效配置。任一根配置不可用时报告具体断点，回到上一个已验证配置。恢复配置选择时保留两套原件和数据库，避免跨实例覆盖或双写。

### 只接续工作区原件

1. 从用户选中的作品或原消息定位 `threadId`、`sourceMessageId`、旧 ID、相对路径。服务器回读已授权原消息验证坐标。用户通过现有受信目录选择连接最小的候选根，再查该 canonical root 及目标文件，保留 proof/epoch。必要时只对已授权 Git 根执行 `git worktree list` 验证仓与工作区对应关系。
2. 优先使用现有 canonical ID 和授权 resolver。验证当前配置中确实存在旧映射时复用 `legacyAliases`。对历史裸 alias，只有在能证明来源与授权根唯一对应时才考虑用现有持久连接保存兼容坐标。若同名、跨仓、撤权、路径改变或来源无法验证，则保持旧引用不可用，给用户选择原件或根的入口。禁止给裸 alias 全局补一个猜测映射或用 PR reader 兜底。无法在现有连接模型下证明唯一性时，先由维护者确定旧引用的确认契约，再选择实现。
3. 在首页和原会话走同一授权读取契约。重启只重新读取既有连接，撤销后立即停止旧引用读取。未连接、同名歧义或解码失败分别报告。允许单件恢复成功，其他作品维持可诊断状态。回退走现有断开入口，保留原消息与文件。

### 只接续 uploads 原件

1. 读取选中消息保存的上传 URL，只验证该文件名及明确授权的旧 uploads 根。校验根内相对路径、链接边界和目标存在性。先比较同名目标内容与大小，区别缺失、冲突和可直接读的原件。
2. 若用户选择接续整个旧实例，随其选中的实例配置读取唯一 `UPLOAD_DIR`。若用户保留当前实例，建议仅在获准的迁移契约下把选中的原件复制到现有 uploads 根，保留原文件名并逐文件校验哈希。仅对新目标做原子提交，同名同内容可重试，冲突不覆盖。部分失败逐件显示，可在核对目标仍是本操作写入的版本后将本次新副本移到可恢复归档。文件修改和操作记录都限制在选中范围。
3. 重启后使用同一正式 uploads 路由回读。已授权但原件缺失、目标冲突、目录不可达分别保留结果。整根切换回退只恢复已有配置选择。路径列表来自明确授权的恢复请求，不扫描磁盘、旧会话全库或另建上传索引。

## 验证与回退

- 初次 Windows 复现用基线的 `_startRedis` 观察到 PING 复用。提交的 fixture 直接接入测试 Redis 和不同归属的文件根，复现同一种状态。它用生产 Fastify 路由和 Redis store 观察首页与聊天返回原引用、非 Git cwd 下别名 404 及只更改 uploads 根后的回读。用实际 root-connection handler 验证伪造 proof 拒绝、有效 proof 写入 canonical ID。旧别名和旧上传根的正例均由 fixture 显式预置。独立进程读回映射，重建 Fastify 后使用原 URL 回读两类原件。产品恢复入口与现场验收留待恢复切片。
- API fixture 接一套合成 Redis，覆盖目录不匹配、无根、根内缺文件、原字节读取及解码失败。目录匹配和诊断命令边界另由桌面测试覆盖。Windows 隔离脚本用两套合成 Redis 对照实际命令的匹配、不匹配及第二套测试库为空。恢复合同中剩余的同名根、撤权、跨盘/链接逸出、完整重启和首装验收在实际恢复候选上补齐。
- 本地检查命令为 `node --test desktop/redis-directory-diagnostic.test.js`、`pnpm --filter @cat-cafe/api build` 和 `pnpm biome check desktop/redis-directory-diagnostic.js desktop/redis-directory-diagnostic.test.js packages/api/test/issue1789-instance-continuity-redis.test.js`。支持 Redis runner 的环境用 `pnpm --filter @cat-cafe/api test:redis -- node --import ./test/helpers/setup-cat-registry.js --test test/issue1789-instance-continuity-redis.test.js`。Windows 证据使用独立 loopback 端口和测试 HOME，未使用现场 Redis、SQLite、会话、配置或认证。
- 当前交付是诊断命令、计划与测试。回退 PR 提交即可，无运行配置或数据回退步骤。真实已安装 Windows 桌面、现场文件接续和恢复策略的产品入口属于后续验收。

## 启动冲突弹窗候选，待确认

目标是在新桌面版接入另一实例的 Redis 之前提示用户。沿用现有固定端口和启动失败弹窗。端口空闲时照常启动，且只在端口已被占用时额外探测。预期目录取本次桌面启动实际要用的目录。安装包无法进行只读探测时，归入无法比较。

| 启动时观察到的情况 | 候选行为 |
| --- | --- |
| 端口占用，只确认收到 PING 回应 | 只能确认对方是 Redis。继续只读核对它报告的目录和桌面预期目录。 |
| 两端目录都可验证，规范化后明确不同 | 判定为数据目录冲突。在 API 接入前停下，提示用户回到原实例继续工作，或确认占用方并正常退出后重试。 |
| 目录一致，或 ACL、超时等导致无法比较 | 归属仍待核实。目录一致不能授予接入权限，查不清也不能声称是另一实例。此分支的启动行为需要单独确认。 |

正常重启和升级尤其要覆盖同一实例还在退出、旧版 Redis 无标记和目录经 Windows 路径别名指向同一位置的情况。有现成证据表明本实例正在退出时，候选方案沿现有退出流程等待端口释放后复查。验收至少走一次干净首启、正常重启、从仍有历史的旧版升级，以及明确的另一目录占用。重启和升级检查历史仍可见，新增的目录冲突提示只用于已证实的不匹配。

请维护者确认两个点：目录明确不匹配是否足以触发这个弹窗，以及目录一致但未证明归属、目录无法比较时如何处理。后者直接影响仍在使用旧版数据的用户，须结合 S2 选定行为并验证后再接入启动流程。此候选处理启动冲突，恢复旧文件和映射仍沿前述候选路径。

Architecture cell: desktop runtime / workspace / works reads。Map delta: none。诊断采用现有桌面目录约定，fixture 使用现有 API 和持久授权。当前增量没有第二套数据根、索引或迁移器。
