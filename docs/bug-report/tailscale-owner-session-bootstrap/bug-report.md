---
feature_ids: [F156]
topics: [security, session, tailscale, cache]
doc_kind: bug-report
created: 2026-08-12
updated: 2026-08-12
tips_exempt:
  reason: Restores the existing opt-in private-network access path; it adds no new user action or discoverable capability.
---

# Tailscale 直连只显示空猫咖或旧前端报错

## 报告人

co-creator 于 2026-08-10 至 2026-08-11 使用手机、华为平板通过 Tailscale IPv4 直连 `:3003` 时发现。

## Bug 诊断胶囊

| 栏位 | 内容 |
|------|------|
| **1. 现象** | 手机和平板访问 `Tailscale-IP:3003` 时先出现客户端 `Application error`；清缓存后页面可打开，但只剩猫咖背景，没有历史会话。无痕窗口一度可打开。 |
| **2. 证据** | 端口、Tailscale 和静态资源均可达；Chrome 114 远端渲染无客户端异常，但 `/api/session` 给远端请求签发 `unpaired-user`，loopback 请求则签发 owner 且可读取 104 个历史 thread。根文档响应曾携带一年级共享缓存策略，旧 HTML 可继续引用已淘汰的构建资源。 |
| **3. 根因** | `ffa73bb8f` 将 owner session bootstrap 收紧为 direct-loopback-only，却没有给已显式启用的可信私网访问保留配对路径，导致 Tailscale 客户端稳定进入空白访客身份；同时 chat 入口仍被静态化，PWA 还把 `/` 当静态 start URL 预缓存，令旧 HTML 跨构建存活。 |
| **4. 诊断策略** | 分别验证网络可达性、浏览器兼容性、session 身份、thread 数据真相和 HTML/service-worker 缓存策略；以远端与 loopback 的同接口差分定位身份回归。 |
| **5. 超时策略** | 若真实设备仍失败，先采集 `/api/session` 返回身份、根文档 `Cache-Control` 和浏览器首个异常，不再通过清缓存或重启服务猜测。 |
| **6. 预警策略** | 任何收紧本机信任边界的改动，都必须覆盖 loopback、显式可信私网、公共地址、CGNAT 边界和代理转发请求；任何 build-specific HTML shell 都不得进入跨构建 precache。 |
| **7. 用户可见交互修正** | 在 operator 已显式打开 `CORS_ALLOW_PRIVATE_NETWORK=true` 时，直连 RFC1918/Tailscale IPv4 的手机和平板恢复 owner 会话与历史 thread；访问方式仍是 `http://<Tailscale-IP>:3003`。 |
| **8. 验收** | 红测先证明可信私网拿不到 owner 且入口仍静态缓存；绿测覆盖可信/不可信地址与代理头边界。生产构建后根页及 thread 页必须返回禁止持久缓存的响应头，PWA 产物不得跨构建预缓存根文档。 |

## 根因链

1. `CORS_ALLOW_PRIVATE_NETWORK=true` 已允许可信私网 Origin 与实时通道进入服务，但 `/api/session` 仍只认 direct loopback 为 owner bootstrap。
2. 手机通过 Tailscale 直连时，请求的真实 peer 地址是 `100.64.0.0/10`，因此被签为 `unpaired-user`（自定义 owner 配置时回退为 `default-user`），历史数据实际未丢失。
3. 旧 chat HTML 被长期缓存后继续引用上一构建的 chunk，先表现为客户端异常；清理缓存只移除了旧 shell，没有修复错误的会话身份，所以随后变成“只有背景”。

## 修复方案

- 复用既有的显式安全开关：只有 `CORS_ALLOW_PRIVATE_NETWORK=true` 时，直接连接的 RFC1918 与 Tailscale IPv4 peer 才能 bootstrap owner session。
- 只看 Fastify 的真实 peer IP，且拒绝任何带标准代理转发头的请求；公网、loopback proxy、`100.64.0.0/10` 边界外地址继续保持非 owner。
- 将 `/` 与 `/thread/[threadId]` 标记为动态文档，并开启 PWA dynamic start URL，避免旧 HTML shell 跨构建复用。

## 验证证据

- `packages/api/test/infrastructure/session-auth.test.js`：RFC1918、Tailscale、IPv4-mapped Tailscale 正向覆盖；公网、CGNAT 边界外、loopback/private proxy 负向覆盖。
- `packages/api/test/auto-dream-index-wiring.test.js`：生产启动必须把现有私网显式开关传给 session route。
- `packages/web/test/chat-route-cache-policy.test.cjs`：两个 chat 入口都必须 `force-dynamic`。
- `packages/web/test/next-config.test.cjs`：PWA 根入口必须走 dynamic start URL。
- 隔离 production build：`/` 与 `/thread/[threadId]` 均为 dynamic route；两者实际响应均为 `Cache-Control: private, no-cache, no-store, max-age=0, must-revalidate`；生成的 `sw.js` precache manifest 不包含 `/`。
