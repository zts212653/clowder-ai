# F292 Case Study — 从“能运行”到“operator友好”

本 reference 只在需要真实 failure history、审查新插件方案或解释 skill 规则来源时加载。产品真相源仍是 `docs/features/F292-feishu-meeting-intake-plugin.md`；这里保留可迁移的方法，不复制当前发布状态。

## 原始摩擦

线程 `[thread-id]` 的来源消息 `0001786246964071-000653-374c7712` 描述了完整人工链：

```text
打开飞书纪要 → 下载 TXT → 找文件路径 → 找猫 thread → 解释路径与背景 → 请求整理
```

因此 F292 的产品 claim 不是“我们会总结会议”，而是让 transport/routing 消失，只保留说话人映射、缺失背景、去向和产物类型等机器不能可靠决定的判断。

## 五次撞墙

### 1. 先想了一个内部 `event_source`

旧 Host 模型让“新增一种资源类型”看起来最直接，但公共 `clowder-ai-plugins` 架构已经预留 C-2 `input-source`、`signals.provides[]`、`events.publish()` 和 Host-owned wake route。若继续内部实现，会产生第二份 contract 和下一次迁移。

反制：设计前同时读公共 contract、相邻 feature、ownership map 和已有长期集成。GitHub watcher 是行为 oracle，不是复制私有 schema 的理由。

### 2. monorepo 里的入口能跑，发布包却活了约 168 ms

Host 安装器只解包 npm tarball，不替插件安装运行依赖。开发仓向上解析到的 SDK/CLI 让测试通过；真实 Host 启动后，插件需要的 `@larksuite/cli` 不在物理运行闭包里，进程随即退出。

反制：从 packed tarball 创建空白 consumer，检查物理成员与 symlink，安装/解包后从发布入口启动，并验证关键依赖只能从 artifact closure 解析。PR #31 的 fresh-consumer test 与 packer 修复由此产生。

### 3. `enabled + stopped` 被 UI 说成“正在启动”

重启恢复保留 intent，但按契约不自动拉起外部进程；更早的 crash 又被 restart normalization 压成 `stopped`。只展示 enabled 或 starting 会让用户误以为插件仍会处理新事件。

反制：artifact/config/auth/intent/live 分层；崩溃翻 `crashed`，重启 dormancy 翻 `stopped/dormant`，并给 enable/retry/regrant 等准确动作。不要从期望状态推断运行状态。

### 4. 认证与 regrant 曾准备展示终端 argv

裸命令虽然对开发者方便，却把内部 runner 路径、命令面和故障处理成本交给用户，也无法保证 URL 域名、secret custody 与进程监督。

反制：PR #3631 把设备授权放回官方插件卡片。Host 只运行 catalog runner，固定供应商域名，argv-only/no shell，child env 无 secret，device secret server-side，页面只呈现验证 URL/user code/QR；enable 再做实时 auth verify。

### 5. CI 和独立 review 都绿，真实会议仍未完成

契约、权限、打包、UI 和 runtime 分别可以全绿，但它们不能证明“录音结束后不再下载 TXT、不再找 thread”。产品效用只有一次真实会议全旅程能证明。

反制：把 claim 拆开：确定契约走 test/conformance；运行健康走 logs/typed states；不确定效用走 real dogfood，只有形成 keep/tune/sunset 决策时才用 eval。

## 可迁移的审查问题

审查任何新插件时，逐项问：

1. 它删掉了用户哪段机械劳动？人只剩什么不可替代判断？
2. 外部来源、插件、Host、猫、用户各自拥有哪份 truth 与 authority？
3. 安装、配置、授权、intent、live 是否被混成一个状态？
4. boot/restart/crash/auth expiry 后，UI 会不会说谎？
5. 修复是否回到同一产品入口和 durable record？
6. 事件是否只含 bounded metadata/source ref，还是偷塞正文/目标/secret？
7. 发布物能否在没有 monorepo、全局依赖和 symlink 帮助的空白环境运行？
8. 哪些 claim 是契约、哪些是运行健康、哪些必须由真实用户旅程证明？

## 证据锚点

- Feature truth：`docs/features/F292-feishu-meeting-intake-plugin.md`
- Public contract / official plugin：`zts212653/clowder-ai-plugins#23`
- Runtime-closure remediation：`zts212653/clowder-ai-plugins#31`
- In-card owner auth：`zts212653/cat-cafe#3631`
- Thread：`[thread-id]`
