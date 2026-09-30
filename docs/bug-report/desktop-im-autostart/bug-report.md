---
feature_ids: [F088, F240]
topics: [desktop, connectors, debugging]
doc_kind: note
created: 2026-09-14
---

# 桌面 IM 扫码后断连 / Telegram 无新 thread

## 报告与复现

报告人：co-creator，thread `thread_mu059rg4wu3zig90`。
原始现象：微信扫码授权后无法保持连接；Telegram 测试连接成功，但发送消息没有新 session。
本次可验证的入站终点是 Hub thread 创建；未宣称真实 agent session 已验收。

诊断胶囊：

- 现象：微信先启动轮询、约 500ms 后停止；Telegram 保存 token 后没有入站轮询。
- 证据：桌面 API 日志、实际监听进程、发行包代码、远端 main，以及隔离回归测试。
- 根因：桌面启动器没有向 API 传递已有的 IM 生命周期授权开关。
- 策略：比较桌面与官方 Windows 启动入口，再用真实 Hub routes + 配置存储 + 网关重载验证。
- 超时：集成测试每条 5 秒；超时视为失败，不以任意 sleep 代替重载完成信号。
- 预警：外网 fetch 意外调用直接失败；未改线上配置或重启当前进程。
- 用户交互：本次不改变 Hub 的状态文案；连接成功后的真实入站能力由测试验证。
- 验收：扫码后 token 经重载恢复并再次启动轮询；Telegram 保存后启动入站，模拟 DM 建立 thread；显式关闭策略保留。

## 独立核验

运行时 preflight（2026-09-14，北京时间）：

```text
PORT=3004
PID=34664
START_TIME=2026-09-14 02:24:54 +08:00
HEAD=unavailable (installed desktop distribution, not a Git checkout)
TARGET_COMMIT=6b6fbbaa863ced704081f0ddc718d797b619f8c2 (origin/main)
PROCESS_AFTER_TARGET=yes by timestamp; does not prove whole-package commit identity
LOG_EVIDENCE=3155 matching PID lines at inspection time
```

实际进程启动发行包的 `packages/api/dist/index.js`。发行包中的
`desktop-dist/resources/app/service-manager.js` 和网关 bootstrap 源码与目标 main 的 Git blob 完全相同：

- `desktop/service-manager.js`: `554956255c18bf90a20678352203c571a887755d`
- `packages/api/src/infrastructure/connectors/connector-gateway-bootstrap.ts`: `40926d3fd6f802592914800a7ec94cd87602cb7e`

日志 `api.2026-09-14.1.log` 中，17:20、17:40、18:07 UTC 均出现
`QR confirmed → Long polling started → reload → Long polling stopped → awaiting QR login`。
18:19 UTC 保存 Telegram 配置后仍为 `Telegram not configured`。
当前 PID 于 18:24:59 UTC 明确记录 `disabled-credentials-suppressed`。
早期扫码记录属于前两个 API PID，不能说成当前 PID 的扫码记录。

## 根因与修复选择

`resolveInitialPluginEnv()` 在缺少显式授权时抑制启动凭据；Hub 写配置触发
`ConnectorReloadSubscriber`，随后 `restartConnectorGateway()` 停旧网关并重新应用启动策略。
这解释了已激活的微信为什么被拆掉，以及 Telegram 为什么只有配置测试成功。

官方 `scripts/start-windows.ps1` 的受管运行模式默认传递
`CONNECTOR_GATEWAY_AUTOSTART=1`，并保留启动进程的显式覆盖。
桌面的 `_buildApiEnv()` 缺少同一授权。因此修复只在桌面 API 环境中补齐该开关，
保留 `0`、`false` 等非空显式值，不修改父进程环境、不改变 direct/dev 默认策略。

隔离实验确认：开启策略后，整网关重建仍会 stop/start，但新 adapter 会读取已保存的凭据，
微信恢复 polling；Telegram config PUT 也会通过现有 reload 链启动入站。
所以本案无需额外在 PUT 路由再调用 activate，也无需取消凭据抑制或设计第二套生命周期。
显式关闭模式下手动激活后的重载语义未改变；本修复限定桌面默认入口。

## 验证与边界

- RED：桌面环境测试 `undefined !== '1'`；微信重载后 `hasBotToken=false`；Telegram 没有 adapter。
- GREEN：`node --test desktop/service-manager.test.js packages/api/test/desktop-connector-reload.test.js`，7/7。
- 策略回归：`node --test --test-name-pattern='autostart|suppresses|distinguishes' packages/api/test/connector-gateway-bootstrap.test.js`，4/4。
- 代码格式和 `git diff --check` 通过；Biome 报告 5 条原有复杂度 warning，均在未修改函数。
- 集成测试仅替换平台网络传输和进程级 audit sink；使用临时配置目录与内存 stores，未连接 Redis 或真实平台。
- API 集成验证使用复制到 feature checkout 的已安装发行包 `dist` 和已安装依赖；本次未修改 API 实现，未执行全仓重建或 full gate。
- 尚未在更新后的桌面发行包进行真实扫码、真实 Telegram 消息或 agent session 验收；当前在线安装未修改。

并行工作核对：公开 PR #1452 和 #1170 也修改 `desktop/service-manager.js`，
本次只涉及 `_buildApiEnv()` 的 IM 开关；#1452 diff 未出现该开关。
本机 thread 标题检索未找到 #1452 的归属坐标，不凭邻近 thread 猜测 owner。

Architecture cell: connector / desktop startup；Map delta: none。
风险：恢复桌面受管运行的预期入站行为；无存储迁移、鉴权规则、外部 API 契约或安装文件变更。
独立审查重点：默认启动授权是否符合桌面入口、显式 opt-out 保留、测试隔离，以及与在飞桌面 PR 的兼容性。
