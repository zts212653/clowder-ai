---
feature_ids: []
topics: [plugins, acp, performance]
doc_kind: plan
created: 2026-11-02
---

# #1750：成员目录读取已登记元数据

来源：[原 issue](https://github.com/zts212653/clowder-ai/issues/1750)、[PR 设计 P2](https://github.com/zts212653/clowder-ai/pull/1779#issuecomment-6574128151)。保留请求取消修复，消除成员列表查询时的归档准备。

1. 安装/更新在已有已验证包准入内提取声明的显示元数据，随 packageDigest 存入现有 inventory；不新增缓存或执行权限。新安装/更新先按统一能力准入拒绝无效声明；无声明为 null，旧记录缺字段代表尚未登记，旧记录恢复遇到无效声明保留明确错误。
2. 旧安装在 Host 启动恢复中一次补齐；已登记包不再扫描。失败不伪造“无声明”，目录报告未准备，普通手动/原生接入仍独立。重新安装/更新可替换声明，启动恢复可重试此前未登记的包。
3. GET 只读当前 inventory、非 secret 配置及执行 registry。目录与执行共享原始已存配置端口，默认值由消费端应用；不能从已补默认值的 action input 推断 owner 已保存。禁用/卸载依赖既有生命周期撤销 registry、过滤 retired instance；重启读回持久元数据。声明不代替激活/执行的完整准入。
4. 回归先证明当前 GET 扫描 16 次/正向完整暂存 2 次，再验证查询零归档 I/O、安装/更新/禁用/卸载、配置新鲜度、重启恢复、坏包仍拒绝执行、无插件手动接入及前端取消。
5. 固定客户端按声明 id 区分，登记默认启动字段并返回 configurationMode=single、defaultClient 和原有配置键，兼容 next 的固定客户端编辑表单；多客户端目录才解析配置数组。固定客户端覆盖值和执行端复用同一纯形状解析，执行端另做已验证包路径准入。共享配置读取同时保留值是否由 owner 保存的信息，继续拒绝插件声明或默认值自行开启 auto_allow。模型发现 POST 保留其独立的完整归档准入，目录 GET 不调用该入口。

代价：每个包增加少量有界显示元数据；旧安装首次升级启动多一次登记，无新增服务/进程。执行仍支付原有校验成本，成员页面不支付归档准备成本。回退旧 Host 时执行契约不变；旧 writer 丢弃新增可选字段后，恢复新 Host 可重新登记。

Architecture cell：插件库存/包准入与成员目录；Map delta：现有 inventory 增加可选包元数据，GET 撤除 package locator 依赖。Canonical source：安装/更新的已验证归档、现有配置 owner、SessionImplementationRegistry。Claim guard：真实目录集成中安装完成后 locator 的静态读取和完整暂存调用均为 0；原实现应失败。格式使用 `pnpm exec biome check --write <changed files>`，验证用 API 构建、定向 Node/tsx 与 Web 回归，不改在线配置或历史。
