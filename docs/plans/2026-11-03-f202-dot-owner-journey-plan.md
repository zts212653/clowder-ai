# F202 Dot 自助接入与通用能力令牌实施计划

状态：待非作者复核；本轮只定稿方案，尚未实施、发包或恢复公网验收。

来源：

- 原 Task `0001792564577431-004187-d5628b99`，owner `codex`，thread `thread_mvgmbqy65mk8bnox`。
- 共创者消息 `0001793756885463-004217-abdd0e14` 至 `0001793760491077-004490-89223f9d`：Dot 页面必须自己给出 endpoint、ChatGPT 配置与配对步骤；Host 只提供通用插件转发和安装级签名能力；外部 token 最长 180 天，签名密钥每 180 天轮换，最多当前与上一代两组验签材料。
- reviewer `0001793760556249-004495-860b47fe`：冻结两代 keyring 的安全删除规则；native token 绑定本次 Host boot；external token 绑定安装实例并继续经过实时 inventory fence；明确刷新、撤销与旧凭据迁移。
- reviewer `0001793761260529-004546-187d0807`：冻结 Dot `current + pending` 凭据切换及证据归属；给 native 短期 token 一条用户无感的续用路径；把临时入口的 runner、发行闭包和停止句柄落实到具体产品实物。
- reviewer `0001793761945886-004587-7fafe1d2`：临时隧道不得直接公开 Host 主 API origin；Dot runner 必须在到达 Host 前提供 strict forward-only listener，并补 hostile path/method/header/upgrade 证据；同 boot 的旧 activation 也必须有独立 identity fence。
- 当前源码基线：Host `dc076eeedd8f028c5d43e67325b7ed319021cd3a`；已批准但产品旅程被本计划替代的 Dot alpha.10 SHA256 `cf9db717452d985dc18a3acc26cb5412771e9a3023a333f940cc03be8635634b`。

本计划取代原文件中“复用 Host shared principal/binding/proposal 作为 Dot 正常路径”的设计。既有 shared MCP 能力可为其他场景保留，但不再是 Dot 安装后的主旅程。

## 1. 结果、范围与删掉的人类劳动

### 一句话结果

主人安装并启用 Dot 后，只在 Dot 页面内选择长期公网地址或临时入口、复制页面生成的 ChatGPT Server URL、完成配对与往返测试；不问猫、不执行终端命令、不创建 cloud member，也不理解 Host 的内部 token 或 shared binding。

### Before / After

```text
Before: 安装 Dot → 页面假定已有“猫咖云端连接” → 缺 endpoint 时去问猫 →
        主人执行命令、等待人工写 endpoint → 回 ChatGPT 粘贴 → 再回来猜配对步骤。

After:  打开 Dot → 选择长期公网或临时入口 → Dot 请求 Host 通用 capability token 并生成 Server URL →
        页面验证 ChatGPT 已发现工具 → 页面引导配对/订阅 → 往返测试 → 明确显示可用。
```

主人保留的判断：

- 长期使用自己已有的 HTTPS 公网地址，还是创建有明确到期时间的临时入口。
- 外部 token 的有效期（不超过 180 天）及何时主动更新。
- 哪个 ChatGPT personal plugin / Work 对话与 Dot 配对。
- 是否断开、重新配对或替换外部凭据。

普通用户不再承担：

- 终端命令、cloud principal、AgentKey、gateway supervisor、手工 token 文件或 Host 重启。
- 先询问 Agent 再知道 endpoint 在哪里。
- 从“已启用”“云端连接”或 raw JSON 猜测 endpoint、ChatGPT 配置、配对和往返是否分别完成。

### Non-goals

- 不让 Host 理解 Dot、ChatGPT、临时隧道、配对、订阅或 endpoint TTL。
- 不把临时验收 carrier、cloud member 初始化或 shared proposal/binding 包装成产品流程。
- 不顺带重构 AgentKey、callback turn authority、共享 MCP 或其他认证体系。
- 不建立每实例裸 token 表、全局 token 撤销平台或长期双轨认证。
- 不声明签发新 token 会在 Host 层自动撤销旧 token；是否接受旧 `jti` 属于插件私有状态。
- 不在本轮方案阶段读取、删除或改写真实 `.cat-cafe` 凭据与运行配置。

Architecture cell：`Host generic capability-token issuer/verifier + generic plugin forwarding`；Dot 拥有 endpoint、外部凭据采用策略和 ChatGPT 业务旅程。

Map delta：有。删除 Dot 正常路径对 `host.external.shared` 的依赖；将当前持久每实例裸 token 的 `PluginExternalAccessStore` 收敛为安装级 keyring + 自包含 token；SDK 新增调用者绑定的签发/检查接口；Dot Settings 改为状态驱动的三阶段自助旅程。

Why：现有实现同时存在 process-lifetime native action token、持久 `external-access.json` 和 shared principal/binding 三套相邻认证路径，导致 Host 承担 Dot 产品状态、用户依赖人工配置、页面无法诚实说明下一步。

## 2. Ownership 与 authority

| 角色 | 拥有 | 不拥有 |
|---|---|---|
| Host keyring | 安装级签名私钥、公钥轮换、固定算法/issuer、token 签发与验签 | 每个插件要保存哪个 token、endpoint 类型、ChatGPT 状态 |
| Host inventory/runtime | 当前调用插件实例、安装/启用/runtime/capability grant 的实时权威 | Dot 配对、订阅、临时入口时长 |
| 通用 forwarding | 从已验签 token 取 instance/capability，检查实时 authority，调用该插件 handler | Dot method 字符串、ChatGPT 用户旅程 |
| Plugin SDK | 从 authenticated plugin call context 调用签发/检查；不接受 caller 自报 instanceId/audience | 任意实例 token 查询、签名私钥、越权 capability |
| Dot | 长期/临时 endpoint、`current + pending` credential slots、ChatGPT discovery、pairing/subscription/roundtrip | Host 私钥、其他插件实例、Host 路由真相 |
| operator | endpoint 模式、有效期、目标 ChatGPT 对话与最终确认 | 执行内部命令、判断隐藏服务或搬运 Host secret |

关键调用规则：

1. 插件调用 SDK 时不传 `instanceId`、`audience`、issuer 或任意 grant。Host 从当前 `PluginCallContext` 和已安装 manifest 填入。
2. token 的 `sub=pluginInstanceId` 是签名声明，不是调用者身份输入。检查接口将 token `sub` 与当前调用上下文实例比较；不一致直接拒绝。
3. Host 只允许当前插件检查自己的 token；没有“按 instanceId 查询任意 token”的接口。
4. 外部请求没有插件调用上下文，因此以验签后的 `sub` 定位实例，再与实时 installed/enabled/runtime/grant 相交。
5. token 验签永远不能替代 lifecycle authority。停用、runtime 停止、grant 撤销或卸载必须即时拒绝。

## 3. 真相源矩阵

| 数据 | 真相源（写） | 消费方（读） | 派生与级联 |
|---|---|---|---|
| 安装级 keyring | Host keyring service，文件位于 Host plugin state 根下 | issuer/verifier | 首次缺失时原子创建；损坏显式失败；轮换事务成功后才使用新 key |
| Host boot identity | Host 进程内随机 `bootId` | native issuer/verifier | 每次 Host 启动重新生成，不落盘；旧 native token 跨重启立即无效 |
| plugin instance/grant/live | Host inventory/runtime supervisor | issuer、inspect、external request route | 每次签发、检查、调用都读实时 authority，不从 token 猜当前状态 |
| signed token | Host issuer | Host verifier；Dot 只保存自己的 external bearer | token 自包含 `kid/iss/aud/sub/cap/iat/exp/jti`；Host 不存每 token 记录 |
| Dot credential slot | Dot private store | Dot settings 与 external handler | 精确保存一个 `current` 和至多一个 signed `pending`；current identity 是 signed `jti` 或 legacy record ref，pending 含 token/`jti`/expiresAt/candidateId/revision；只有 CAS promotion 改写 current |
| endpoint mode/config | Dot private store | Dot journey projection | `absent / long-lived / temporary-active / temporary-expired / invalid`；Host 不持久化 Dot endpoint TTL |
| temporary endpoint lease | Dot activation 内的 `TemporaryEndpointController` + Dot private lease record | Dot journey projection | activation 持有唯一 forward-only listener、tunnel child、abort/expiry 句柄；进程退出、TTL、disable/stop/uninstall 原子收口全部资源；Host 不解释 TTL |
| ChatGPT discovery | Dot handler 对真实 `initialize/tools/list` 等入站证据的记录 | Dot journey projection | 每条证据写入 Host 已验证的 credential `jti`；endpoint 存在不等于 ChatGPT 已配置，且旧 current 的活动不能推进 pending candidate |
| pairing/subscription | Dot connection store | Dot RPC 与 journey projection | 只由显式 pairing、订阅/撤销事件改变 |
| roundtrip evidence | Dot dispatch/read/reply records | Dot journey projection | credential candidate、pairing attempt、test event、read 与 nonce reply 都冻结同一 expected `jti`；只有全链同 credential 才能推进 |
| journey stage | 纯投影 | Dot Settings | 不另存 ready 布尔值；任一真相变化后只读重算 |
| legacy raw credential | 既有 `external-access.json`，仅迁移期只读/窄写 | legacy adapter 与迁移 UI | 成功切换并验证新 signed token 后按实例退出；不进入新主路径 |

## 4. 安装级 keyring 与 token 契约

### 4.1 Keyring

- 逻辑位置：`<plugin-host-state>/capability-keyring.json`，由既有 plugin-host layout 解析；不硬编码 repo 路径，不属于用户配置。
- 目录权限 `0700`、文件权限 `0600`；临时文件 + fsync/rename 原子提交。并发首次启动以 exclusive create / 单写队列决定唯一赢家，失败方重读。
- 固定算法：Ed25519 / JWS `alg=EdDSA`；verifier 不接受 token 自报的其他算法。固定 issuer：`clowder-plugin-host`。
- current 保存私钥与公钥；previous 只保存公钥。旧私钥在新 keyring 持久化成功后删除。
- 文件不存在时自动生成；存在但 schema、权限或 key material 损坏时 fail closed，不静默重生并使现有 token 无声失效。

两代轮换固定为：

- `rotateAfter = 180 days` 是轮换目标；实际轮换还要求即将淘汰的 previous 已到 `safeDeleteAt`。若需要容差则延后轮换，绝不提前删除，也不引入第三代。
- `plugin-external maximumTTL = 180 days`。
- current 签名；previous 只验签。current 降为 previous 时冻结 `safeDeleteAt = stoppedSigningAt + maximumTTL + clockSkewAllowance`。
- token `exp <= now + requestedTTL`，且签发与轮换使用同一 Host 时钟；verifier 对 `exp` 的允许容差不得越过该 key 的 `safeDeleteAt`。
- 轮换与签发由同一事务/互斥锁串行：满足 rotateAfter 且 previous 可安全删除时，先持久化新 current，再签发；若 previous 尚未到 `safeDeleteAt`，延后本次轮换而不是产生第三代或提前淘汰。
- 第二次轮换只在 two-generations-old 公钥已不可能验证仍可接受 token 时删除它；持久化失败继续使用原 current/previous，不出现半轮换状态。

示例：K0 第 0–180 天签发；第 180 天 K1=current、K0=previous；K0 最晚 token 在第 360 天到期。第 360 天加容差后才能创建 K2、删除 K0；keyring 始终只有 K2=current 与 K1=previous。

### 4.2 Token profiles

共同 claims：

```ts
type PluginCapabilityClaims = {
  iss: 'clowder-plugin-host';
  aud: 'plugin-native' | 'plugin-external';
  sub: string;       // Host-authenticated pluginInstanceId
  cap: string;       // manifest-declared capability/contribution id
  iat: number;
  exp: number;
  jti: string;
  kid: string;
  boot?: string;     // required only for plugin-native
  act?: string;      // required only for plugin-native; current activation binding identity
};
```

`plugin-native`：

- `boot` 必须等于当前 Host 内存 `bootId`；`act` 必须等于当前 in-memory activation binding 的随机 identity。重启后即使签名和 exp 仍有效也拒绝；同一 boot 内 disable/re-enable 产生新 `act`，旧 activation token 也拒绝。
- 只为当前 active contribution 签发，`exp` 使用短期上限；无论 `exp` 是否到达，`boot` 不匹配都是硬拒绝。deactivate 仍由实时 binding/inventory fence 即时拒绝。
- native transport 不把首次 token 值冻结在持久 config 或长寿命 child env。Host 在 boot-scoped `0700` runtime directory 中为每个 active contribution 创建 activation-scoped、`0600` 的 native credential file；durable MCP config 只保存 Host 管理的路径引用。SDK native action client 在每次请求前读取该文件中的当前 token。新 boot 只在 canonical managed directory 内清理旧 boot 文件；该文件不是跨 boot token registry。
- `NativePluginActions` 在 token 的 `refreshRecommendedAt` 前，以同一 `boot/act/sub/cap` 和当前 activation authority 续签并原子替换文件；签名 key 轮换也走同一路径。Binding 在内存只保存 current native `jti` 与一个有界 swap-grace previous `jti`，让 rename 前后已开始的本地请求收尾；新请求必须命中 current/grace slot 和 exact activation object。更新失败时保留尚未过期的旧文件并有界重试，过期后 fail closed，不要求主人、Dot 或 MCP 重启。
- deactivate/stop/uninstall 删除该 activation 的 credential file、取消续签 timer，并使旧 token 由 activation + boot fence 立即失效；Host restart 生成新 `bootId` 和新 activation file，旧文件/token 即使残留也不能通过验证。
- native 与 external 只共用 codec/keyring，不共用 token bytes、audience 或权限判断。

`plugin-external`：

- 不含 `boot`，也不绑定普通 restart/runtime generation；合法 token 可跨 Host 重启和停启保留。
- `sub` 绑定不可变安装实例；卸载重装得到新 instanceId，旧 token 拒绝。
- 每次调用仍检查 installed、enabled、runtime available 和 manifest/grant 中的 exact `cap`。停用期间拒绝；恢复运行后未过期 token 可再次工作。
- requested TTL 由插件在 SDK 允许范围内选择，Host clamp 到 180 天；Dot 页面展示 expiresAt/remaining/refresh recommendation。

### 4.3 SDK surface

语义固定，最终命名以 contract 风格为准：

```ts
host.capability.issueExternal({ capabilityId, ttlSeconds })
  -> {
       token, tokenId, issuedAt, expiresAt, refreshRecommendedAt,
       forwarding: { upstreamLoopbackOrigin, relativePath, method: 'POST' }
     }

host.capability.inspectExternal({ token, capabilityId })
  -> { usable, reason, expiresAt?, remainingSeconds?, refreshRecommended }
```

- 两个接口都从当前 authenticated plugin call context 取得 instanceId；请求参数没有 instanceId/audience/issuer。
- `forwarding` 是 Host 当前通用 external route 的只读**上游**坐标：插件不能自报 origin/path/method，也不能借它选择其他实例。`upstreamLoopbackOrigin` 可以是 Host 主 API 的 loopback origin，因此绝不是可公开的 tunnel target。长期模式只把主人已有的受控 public base 与 `relativePath` 组合；临时模式必须先经过 Dot 自己的 forward-only listener。
- `capabilityId` 必须是调用实例 manifest 已声明并获准的 external capability；插件不能签发未声明能力。
- inspect 固定验证算法、issuer、aud、sub、cap、时间与当前 lifecycle。token 属于其他实例时返回不可用/拒绝，不泄露对方状态。
- status 不返回裸 token、私钥或其他实例资料；token、Authorization header 和完整凭据 URL 不进入普通日志、rows、receipt。
- external handler 收到 Host 已验证的 bounded credential metadata（`sub/cap/jti/iat/exp`），不收到 Host 私钥；Dot 用它与 private store 的 exact `current/pending` slots 比较。

### 4.4 更新与撤销语义

- “签发新 token”本身不在 Host 层撤销旧 token；无 per-token denylist，`jti` 也不会自动撤销。
- Dot private store 固定为一个 `current` 和至多一个 `pending`，不使用可容纳多个候选的模糊集合：
  - 首次签发：`current=null`，新 signed credential 写入 `pending`。
  - signed refresh：原 signed credential 留在 `current`，新 credential 写入 `pending`。
  - legacy → signed：legacy credential 留在 `current`，新 signed credential 写入 `pending`。
- `pending` 不是普通业务凭据。Dot handler 只允许它进入 candidate lane：真实 MCP discovery，以及 candidate-scoped 的 pairing（仅首次签发需要）、测试 source read 和 nonce reply；普通 summon、任意 source/reply/image 等业务动作在 promotion 前拒绝。`current` 在整个准备期继续承载普通业务，但其任何 discovery/read/reply 都不能推进 pending。
- 创建 candidate 时冻结 `{ candidateId, revision, pendingJti, pairingAttemptId?, verificationAttemptId? }`。所有入站 evidence 记录 Host 已验证的 credential `jti`；verification test 在 delivery 前持久绑定 candidateId + pendingJti，read 与 nonce reply 必须来自同一 pendingJti、同一 test event 和同一 attempt。旧 current 即使完成同样方法或历史 nonce，也不满足 candidate fence。
- promotion 是单次 CAS：仅当 exact pending credential 的 discovery 与 candidate-scoped roundtrip（以及首次接入所需 pairing/subscription）都成立，才把 `pending` 变为 `current` 并清空 pending。CAS 失败重读，不以迟到 evidence 覆盖新 candidate。
- 取消、超时或验证失败只清除 exact pending（证据保留供诊断），current 与 legacy record 原样保留。promotion 后旧 current `jti` 立即不再被 Dot handler 接受；旧 signed token 即使 Host 签名仍有效也只得到业务拒绝。
- 若产品动作明确叫“立即撤销”，Dot 可立刻清空 exact current/pending slots；Host 不为此恢复裸 token 表。其他插件可按自己的业务设计私有 credential state，但不能把它变成 Host 的每-token registry。
- disable/uninstall/grant revoke 由 Host inventory fence 处理，不依赖 Dot credential slots。

## 5. Dot 页面旅程

### 阶段一：建立外部入口

页面先只读检查 runtime、Dot endpoint 配置和自身 credential：

1. **长期公网**：主人输入/选择本部署已有的 HTTPS public base；Dot 从 Host SDK 获取通用 forwarding path 与 external token，生成精确 ChatGPT Server URL。Host 不把该 base 解释为 Dot 配置，也不声明其可达。
2. **临时入口**：当前支持平台采用 Dot 自有 `TemporaryEndpointController`，不是新增 Host provider 平台：
   - Dot packed artifact 随包携带固定 `temporary-endpoint-runner.mjs` 与按平台/架构固定版本、固定 SHA256 的 Cloudflare Quick Tunnel client；发布脚本从 canonical producer materialize 它们，Host archive admission 与 fresh-consumer test 检查 exact bytes、许可清单、可执行位和无 symlink/越界成员。当前首个受支持闭包为已验收的 macOS Apple Silicon；其他平台页面诚实显示“此平台暂不支持临时入口”，仍可使用长期公网，不回退到系统 `cloudflared` 或 shell。
   - 主人选择不超过 24 小时的 lease；Dot action 取得 Host-authenticated `forwarding.upstreamLoopbackOrigin/relativePath/method`，activation 中的 controller 以固定 argv 启动随包 runner。runner 只接受这一 Host-issued upstream coordinate、固定 bundled binary 和绝对 deadline，不接受 manifest/user 自报命令、URL 或目标实例。
   - runner 先在 `127.0.0.1:0` 绑定 private forward-only HTTP listener，再让 bundled Quick Tunnel client 只指向该随机 listener；绝不把 `upstreamLoopbackOrigin` 交给 tunnel client。listener 对 raw request target 在任何 URL normalization 前做 byte-exact path comparison，只允许 Host 声明的 `POST + relativePath`；absolute-form target、其他 method/path、双斜杠、dot segment、percent-encoded path separator/segment、Upgrade、WebSocket 与 CONNECT 均在发起 upstream request 前拒绝。
   - 允许转发的请求由 runner 自己构造固定 `upstreamLoopbackOrigin + relativePath`，禁用 redirect，设置本地 Host header，并施加不大于 Host handler 的 body/time limit。只从显式 allowlist 复制 MCP 所需的 content-type、accept、authorization、protocol/session headers；丢弃 cookie、owner/callback credentials、proxy authorization、forwarded headers、caller Host、connection/upgrade 等 hop-by-hop 或 Host 身份头。caller 的 path、host 或 header 永远不能改变 upstream target。
   - JWT 及 installed/enabled/runtime/grant/capability 校验仍由现有通用 Host external handler 执行；forward-only listener 只是网络暴露面，不成为第二套认证或 Host Dot branch。有效 token 也只能到达其 token `sub/cap` 对应的 fixed handler。
   - runner 启动 tunnel client 后解析唯一 public base；Dot 对完整 external Server URL 做不携带 credential 的外部探测并要求 forward-only listener/Host 返回预期 auth rejection，因此只证明可达而不会写 ChatGPT discovery。成功后才原子写 `temporary-active` lease 并在 owner-only 结果中显示/复制精确 URL。验收 carrier 与机器上已安装 `/opt/homebrew/bin/cloudflared` 都不进入产品依赖。
   - controller 在 activation closure 中持有 exact listener、runner/tunnel child process-group、AbortController、deadline timer 和 lease generation。TTL、用户停止、binary/runner 退出、Dot disable/stop/uninstall 都先撤销发布状态并停止 accept，再关闭 stdin/TERM、等待有界退出，最后 KILL 仍存活的 owned group；迟到 request/stdout/URL 受 generation fence 拒绝，不能在 stop 后访问 upstream 或重新发布。
   - Host restart 后旧 quick-tunnel URL 不可恢复；Dot 把未完成旧 lease 投影为 `interrupted`，不自动生成不同 URL 冒充恢复。主人在页面点“重新创建临时入口”后获得新 URL并重新完成 ChatGPT discovery。

页面必须实际探测生成入口；“URL 已配置”与“外部可达”分别显示。失败给“检查地址/重新创建临时入口”产品动作，不给 shell。

### 阶段二：配置 ChatGPT

- 页面在 owner-authenticated Settings action result 中显示可复制的完整 Server URL 和当前 ChatGPT UI 所需的准确认证方式；这是 INV-11 的显式 secret-presentation 例外，不依赖剪贴板作为唯一交付，不进入普通 rows/status/log/receipt。
- 页面明确说明在 ChatGPT 添加/更新 personal plugin/MCP server，并进入等待状态。
- 只有真实外部 discovery 到达并携带当前 `current` 或 exact `pending` 的 `jti`，才显示对应 credential 的“ChatGPT 已识别”；pending discovery 只推进该 candidate，URL 生成、本地探测和旧 current 活动都不能冒充该事实。
- token 临近到期时页面显示剩余时间和“更新外部凭据”，不要求 Agent 介入。

### 阶段三：配对、订阅与往返

- ChatGPT discovery 成功后才允许生成 pairing 说明。
- Dot 显示/复制配对说明，等待目标对话订阅 `dot.summoned`；有效旧 pairing/subscription 不自动旋转。
- 页面用有界只读观察推进订阅和 roundtrip；hidden/unmount/epoch change 停止请求，迟到响应不能覆盖新状态。
- 当前 pairing attempt 的 source read + nonce-bound reply 完成后才显示 ready。

### 页面状态表

| 阶段 | 唯一主动作 | 禁止 |
|---|---|---|
| runtime unavailable | 启用/恢复 Dot | endpoint/token/pairing |
| endpoint absent | 选择长期公网或临时入口 | 终端命令、shared binding |
| endpoint invalid/unreachable | 修正地址或重建临时入口 | 宣称 ChatGPT 可用 |
| credential absent/expired | 生成/更新外部凭据 | Agent 人工写 token |
| waiting ChatGPT discovery | 复制 Server URL / 检查状态 | pairing、ready |
| pairing not started | 生成配对说明 | 自动旋转旧 pairing |
| waiting subscription | 显示/复制说明 | 宣称 connected |
| verification required/pending | 发起/检查往返 | 用历史 attempt 冒充 ready |
| ready | 可选重新测试/更新凭据 | 把 enabled 当业务可用 |
| recovery required | 与原因匹配的一个恢复动作 | 自动扩权、自动新 endpoint |

## 6. 核心不变量

- **INV-1：调用者身份不来自参数。** SDK issue/inspect 的 instanceId 与 audience 只能来自 Host authenticated plugin context。
- **INV-2：两代 keyring 可证明安全。** max external TTL 不大于轮换间隔；签发截止、verifyUntil、容差和删除时刻由测试锁定。
- **INV-3：native 跨 boot/activation 必拒绝。** persistent key signature 不能让旧 native token 跨 Host 重启可用；同 boot disable/re-enable 的新 activation 也不能接受旧 `act/jti`。
- **INV-4：external 跨正常重启保留。** external token 不绑定 boot/runtime generation；只要未过期、同一安装实例且实时 authority 恢复，就可继续使用。
- **INV-5：验签不是授权终点。** installed/enabled/runtime/grant/capability 任一不成立都拒绝调用。
- **INV-6：新实例不继承旧 token。** uninstall/reinstall 的 instanceId 不同，旧 external token 不得路由到新实例。
- **INV-7：Host 无 per-token secret truth。** 新主路径只持久化 keyring；token 与 current/pending credential slots 属于插件 private state。
- **INV-8：刷新不冒充撤销。** issue 不自动撤销；只有 Dot exact credential-slot CAS/清除或 Host lifecycle fence 使旧 token 不可用。
- **INV-9：endpoint、ChatGPT discovery、pairing、subscription、roundtrip 正交。** 任一阶段不能用前一阶段事实冒充完成。
- **INV-10：普通流程零终端、零问猫。** 所有设置、诊断、更新与恢复都在 Dot 页面。
- **INV-11：secret 只在 owner-scoped 交付面出现。** token/header/private key 不进入普通 status rows、日志、错误、归档或 Task；完整 Server URL 仅可由 owner-authenticated、显式生成/显示/copy action 返回，并在离开该受控呈现后不被通用 renderer 持久化。
- **INV-12：旧凭据迁移有终点。** legacy adapter 仅服务已存在记录，不能创建新的 legacy token；成功切换后按实例退出，最终删除双轨代码。
- **INV-13：native 续用不依赖用户重启。** activation credential file 在 token 到期和签名 key 轮换前原子更新；同一 boot + exact activation 的持续 MCP transport 读取新值，旧 boot/activation 永远拒绝。
- **INV-14：candidate evidence 不串线。** current/legacy 活动、旧 candidate、旧 pairing 或历史 nonce 不能 promote 当前 pending；promotion 只消费 exact pendingJti + candidate/attempt revision。
- **INV-15：临时入口是 packed lifecycle closure。** fresh consumer 不依赖全局 binary；Dot activation 持有唯一 stop 句柄，disable/uninstall/TTL/失败后无 listener、tunnel child 或可复制 URL 残留。
- **INV-16：临时入口不公开 Host origin。** Quick Tunnel 只连接 Dot forward-only listener；任意非 exact method/raw path、encoded variant、upgrade 或 Host 身份头在 upstream 前拒绝，Host 其他 API/WebSocket 永不可达。

## 7. 旧凭据迁移

当前 `FilePluginExternalAccessStore` / `external-access.json` 和 `adopt()` 支撑旧安装 credential，不能直接删文件或入口。

迁移规则：

1. 新版本不再向 raw store 创建/rotate 新记录；仅 legacy adapter 可解析既有记录。
2. 已有 legacy credential 的同一 current instance 保持可用，Dot 页面显示“旧凭据，建议更新”，而不是静默断开。
3. 主人点更新时，legacy credential 进入 `current`，signed external token 进入 `pending`；旧 credential 继续工作，但其活动不能给 pending 提供验证证据。
4. signed pending 以自己的 `jti` 完成真实 ChatGPT discovery 和 candidate-scoped roundtrip 后，Dot 用 exact candidate revision CAS promotion；迁移服务只在同一事务成功后按 exact instance/CAS 标记完成并移除该实例 legacy 记录。失败/取消保留旧连接与 raw record。
5. legacy raw token 仍必须经过 current installed/enabled/runtime fence；卸载重装不得 adopt 到新实例。
6. 退出条件：所有可迁移实例均完成或被主人显式断开，packed reinstall/migration 矩阵证明无 consumer 后，后续版本删除 legacy resolver、`adopt()` 和空 store 文件支持。不得保留无期限双轨。

方案阶段与测试不得读取或删除当前真实 store；使用隔离 fixture。

## 8. 关键行为矩阵

| 场景 | 预期 |
|---|---|
| K0 签发窗口最后时刻签 180 天 token | K0 的 `safeDeleteAt` 冻结为停止签发时刻 + 180 天 + 容差；到达前不做下一次轮换 |
| 轮换与并发签发 | 同锁串行；到期后没有 K0 新 token；新 key 未持久化不得签发 |
| keyring 首次缺失/并发启动 | 仅一份 current；调用者重读同一 `kid` |
| keyring 损坏或权限错误 | Host 明确 fail closed；不自动覆盖 |
| native token + Host 重启 | 签名可能正确，但 `boot` 不同，拒绝 |
| native token + 同 boot disable/re-enable | 新 activation `act` 与 current native `jti` 不同；旧 token 拒绝，不因 sub/cap 相同复活 |
| native transport 连续活跃跨 token exp / key rotation | Host 在到期前原子替换 activation credential file；SDK 下一次调用读取新 token，不重启 Host/plugin/MCP；旧 boot 仍拒绝 |
| external token + Host 重启 | 同实例、未过期、authority 恢复后继续有效 |
| Dot disabled/stopped | Host 即时拒绝；恢复后未过期 external token 可继续 |
| uninstall/reinstall | 新 instance 拒绝旧 token |
| 插件 A 检查插件 B token | `sub` 与 authenticated caller 不同，拒绝且不泄露 B 状态 |
| 插件请求未声明 capability | 签发与检查都拒绝 |
| token aud/iss/alg 错误 | 固定 verifier 拒绝，不回退尝试其他算法/用途 |
| 首次签发、current 为空 | signed token 进入 pending；仅 candidate lane 可用；其 discovery + pairing/subscription + exact-jti roundtrip 后 CAS 为 current |
| signed refresh、尚未切换 | Host 可验两枚；Dot current 继续普通业务，pending 仅 candidate lane；旧 current 活动不能证明 pending 可用 |
| pending discovery 后旧 current 完成 nonce | evidence 的 `jti` 不匹配 pendingJti，candidate 不 promotion |
| pending exact-jti discovery/roundtrip 成功 | Dot CAS pending→current 并清 pending；旧 current bearer 此后被 Dot 业务拒绝 |
| pending 取消/超时/失败 | exact pending 清除，诊断证据保留，current/legacy credential 不变 |
| legacy 更新失败/取消 | 旧连接保留，不删除 raw record |
| legacy 更新成功 | 新 signed token 生效，exact legacy record 收口；不影响其他实例 |
| endpoint 有 URL 但外部不可达 | 页面显示 configured-but-unreachable，不进入 ChatGPT configured |
| fresh install 无系统 cloudflared | 支持平台使用 packed verified binary 自动创建 URL；不支持平台给页面恢复说明，不输出安装命令 |
| 临时域名请求 exact POST external path | forward-only listener 转发一次到固定 Host handler；Host 继续验 JWT 与实时 instance/grant |
| 临时域名改为 `/api/session`、`/api/cats` 或 WebSocket/CONNECT | listener 在 upstream 前拒绝；fake Host upstream 访问计数为零 |
| 双斜杠、dot segment、percent-encoded separator/segment 或 absolute-form target | raw target 不等于 exact relativePath，upstream 访问计数为零，不经 normalization 改写目标 |
| caller 带 cookie/owner/callback/forwarded/Host/upgrade headers | 非 allowlist headers 被删除或整请求拒绝；Host owner/session authority不进入临时面 |
| 临时入口 TTL/disable/uninstall/runner crash | controller 撤销 URL 并终止 exact owned process group；迟到输出不得重新发布 |
| ChatGPT discovery 到达但 pairing 未完成 | 进入 pairing-not-started，不显示 ready |

## 9. 实施工作单元

### W1：通用 keyring 与 capability token（RED → GREEN）

改动位置：

- 新增 `packages/api/src/domains/plugin/capability-token/`（keyring、claims、issuer/verifier）。
- `packages/api/src/domains/plugin/host-inventory/plugin-host-layout.ts` 增加 canonical keyring path。
- `packages/api/src/domains/plugin/declared/native-plugin-actions.ts` 改用共同 codec，增加 activation credential-file owner、续签 timer 和原子替换，并保留现有 active binding/currentness fence。
- declared MCP materialization、`plugin-mcp-environment.ts` 与 Plugin SDK native action client 改为传递/读取 credential-file reference，不把首次 token 固定进持续 transport。
- 对应 contract/SDK 类型。

可观察结果：无 raw token registry 也能签发/验证；两代轮换、fixed alg/iss/aud、caller-owned issue/inspect、native boot + activation fence 全部有精确测试；连续 transport 跨 token exp/key rotation 仍工作且无需重启，deactivate/re-enable/old boot 立即拒绝。

### W2：通用 external forwarding 与 legacy seam（RED → GREEN）

改动位置：

- `packages/api/src/domains/plugin/external-access/plugin-external-access.ts`。
- `packages/api/src/routes/plugin/plugin-external-request-routes.ts`。
- `packages/api/src/domains/plugin/builtin-runtime/carriers/module-plugin-settings.ts`。
- existing migration coordinator/invoker 与 tests。

可观察结果：新请求从 signed claims 定位 current instance/capability；route 继续执行 installed/enabled/runtime fence；legacy store 只读既有记录且有逐实例退出条件，不再生成 raw token。

### W3：Dot endpoint/credential 与三阶段 journey（RED → GREEN）

改动位置：Dot package 的 `plugin-entrypoint.ts`、`connection.ts`、journey projection、private store、`temporary-endpoint.ts`、`temporary-endpoint-runner.mjs`（含 strict forward-only listener）、packed platform asset manifest、publish script、manifest/steps 与测试。

可观察结果：页面可在长期/临时模式生成 endpoint；支持平台的 fresh consumer 只用 exact packed runner/binary 自动给出 URL，公开域名只能到 exact fixed handler，所有 Host sibling API/path variant/upgrade 均在 upstream 前拒绝，controller 在 stop/TTL/uninstall 后无 survivor；credential 固定 current+pending，首次/refresh/legacy 迁移均以 exact-jti 证据 CAS；不调用 `host.external.shared`，不要求 shell/cloud member/Agent。

### W4：通用 Settings 呈现与恢复（RED → GREEN）

改动位置：`OperationRowsRenderer`、通用 text/copy/expiry presentation、Plugin Manager operation tests。

可观察结果：每阶段只有一个主动作；完整 Server URL 有显式 copy，不以剪贴板作为唯一来源；secret 不进入普通日志；hidden/unmount/旧 epoch 请求不覆盖当前状态。

### W5：packed migration、fresh consumer 与真实体验

顺序：

1. 两仓定向测试、typecheck、format/diff check。
2. 最终 tgz 空缓存安装；exact archive 经 Host 既有 admission（32 MiB compressed / 64 MiB expanded）且不为 Dot 增加例外或放宽 guard。
3. fixture 中从 legacy raw credential 更新到 signed token，真实 install/enable/restart/reinstall/uninstall 矩阵。
4. 非作者 exact-HEAD / exact-archive review。
5. operator 择时启动 feature 实例；页面走长期公网与临时入口至少各一条真实路径；临时路径从删除 PATH 中的系统 `cloudflared` 的 fresh consumer 启动，随后以公开域名验证 exact path 可达、Host sibling API/WebSocket/encoded variants 不可达及 TTL/disable/uninstall 清理。
6. ChatGPT 真实 discovery → pairing → subscription → read/reply/image → credential refresh；并证明旧 current 持续活动不能 promote pending、新 credential exact-jti roundtrip 可以。
7. 共创者明确确认后才进入 fork 集成与 soak；full gate、cloud/human/soak 各自如实记录。

## 10. 验证边界

永久测试至少覆盖第 8 节全部矩阵，重点命令以实现时真实 package scripts 为准：

```sh
node packages/api/scripts/with-test-home.mjs \
  node --import tsx --test --test-concurrency=1 \
  test/f202-plugin-capability-token.test.ts \
  test/f202-plugin-external-access.test.ts \
  test/f202-dot-migration-package-integration.test.ts

pnpm --dir packages/web exec vitest run \
  src/components/settings/primitives/__tests__/OperationRowsRenderer.test.tsx \
  src/components/settings/__tests__/PluginManagerOperations.test.tsx

pnpm biome check . --diagnostic-level=error
git diff --check
```

插件仓继续运行其 test/typecheck/build/packed fresh-consumer 检查；最终命令在实现开始前从该仓 `package.json` 回读，不凭旧计划猜测。

定向 green 不等于 full gate、真实 ChatGPT 体验或 soak 完成。不得自动停启 Host、修改运行配置/密钥或恢复公网 carrier。

## 11. 验收清单

- [ ] 安装后 Dot 页面自己给出 endpoint 设置第一步；无 endpoint 时不要求终端或问猫。
- [ ] Host keyring 自动创建、0600、fixed algorithm，最多 current + previous 公钥且只有 current 私钥。
- [ ] 180 天轮换/180 天 maximum TTL 在边界并发和 clock skew 下不会提前淘汰有效 token。
- [ ] issue/inspect 不接受 instanceId/audience；caller context 与 token `sub` 不一致即拒绝。
- [ ] native token 跨 Host restart 拒绝；external token 在同一安装实例正常 restart 后保留。
- [ ] 同 boot disable/re-enable 生成新 activation identity；旧 native token 即使 sub/cap/签名/exp 正确也拒绝。
- [ ] native transport 连续活跃跨 token 到期和签名 key 轮换仍可用，且不要求用户重启；old boot/activation 立即拒绝。
- [ ] disabled/stopped/grant revoked/uninstalled 均由实时 Host fence 拒绝。
- [ ] Host 不持久化新 per-instance raw token；Dot 拥有 external token、current/pending credential slots 和更新 UX。
- [ ] 签发、更新、立即撤销的语义分别诚实；不把 `jti` 误称为 Host denylist。
- [ ] 长期公网与临时入口均由 Dot 页面管理，Host 无 Dot 专属 TTL/branch。
- [ ] 临时入口 runner 与 tunnel client 是 exact packed、按平台校验的 Dot 发行闭包；fresh consumer 不依赖系统 cloudflared，TTL/disable/uninstall 无 survivor。
- [ ] 最终 exact archive 通过既有 32 MiB compressed / 64 MiB expanded admission；不为 Dot 放宽包体、链接或路径安全 guard。
- [ ] 临时 tunnel 只连接 Dot forward-only listener，不公开 Host API origin；Host sibling API、WebSocket、CONNECT、encoded/path variants 的 fake upstream 访问计数均为零。
- [ ] current + pending 唯一状态机覆盖首次签发、signed refresh、legacy 迁移；旧 credential 的 discovery/nonce 不能 promote pending。
- [ ] URL configured、external reachable、ChatGPT discovered、paired/subscribed、roundtrip ready 分开显示。
- [ ] 旧 credential 不被无声破坏；更新成功后逐实例退出，失败时保留，最终有删除双轨的明确门槛。
- [ ] token/private key/header 不进入普通日志、UI rows、归档或测试回执。
- [ ] 最终 packed archive、Host exact HEAD、真实页面/ChatGPT 旅程和非作者 review 指向同一候选。
- [ ] 共创者体验与 fork soak 完成前，Task 保持 doing。

## 12. 本轮复审问题

1. 180/180 两代 keyring 的签发、验证与安全删除是否闭合，且没有升级为多代 keyring。
2. `plugin-native` 的 boot fence 与 `plugin-external` 的 stable-instance + live authority fence 是否正确分离。
3. SDK 是否完全使用 authenticated caller context，未开放 instance/audience 自报或跨实例 introspection。
4. 新 token 更新、Dot current/pending credential slots 和 legacy raw credential 的迁移是否诚实且有终点。
5. native credential file 续签是否让同一 boot 的长寿命 MCP transport 跨 exp/key rotation 无感继续，同时保持 old boot 硬拒绝。
6. Dot packed temporary runner 是否给 fresh consumer 真正提供零命令入口，并在 TTL/disable/uninstall 后由 activation-owned 句柄完整清理。
7. 临时 runner 是否只公开 exact fixed handler，且 hostile method/path/header/upgrade 无法触达 Host 主 API origin。
8. 正常用户是否能在 Dot 页面独立完成 endpoint → ChatGPT discovery → pairing/subscription → roundtrip，且 Host 没有 Dot/cloud 专属逻辑。

复审通过前不实施、不发布新 alpha、不恢复临时公网入口，也不要求主人执行命令或重启。


> 2026-11-09 范围收敛：本文 W1/native 文件刷新和通用共享授权建设已被最终迁移方案取代；现行范围见 `2026-11-09-f202-participant-response-and-auto-verification.md` 的 alpha.41 节。历史论证保留，不代表当前发布要求。
