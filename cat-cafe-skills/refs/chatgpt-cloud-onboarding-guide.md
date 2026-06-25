---
title: ChatGPT 云端猫接入指南（猫读 SOP）
date: 2026-06-21
authors: [opus-47 (Ragdoll)]
audience: cats (Ragdoll / Maine Coon / 任何接手 cloud-cat onboarding 的猫)
purpose: |
  operator说"Ragdoll/X 帮我接入 gpt-pro"或"在新机器上把云端 ChatGPT Pro Maine Coon接进来"
  → 接球猫按本指南从头操作，全程不要让operator点 CF dashboard（已经有过 4 次互相猜路径都猜错的教训）。
related_features: [F247, F178]
status: stable (B1a verified 2026-06-21 05:14 UTC — Path A no-CF-Access, ChatGPT 不支持 custom headers / service token)
revision_history:
  v1 (2026-06-21 04:57 UTC): 初稿 — Path B service token + CF Access App
  v2 (2026-06-21 05:14 UTC): 改 Path A — OpenAI 官方文档实锤 ChatGPT MCP 不支持 custom headers / machine-to-machine grants，Path B 走不通，B1a 简化为公网 + spike ?token= 单防线
trigger_phrases:
  - "Ragdoll帮我接入 gpt-pro / Maine Coon Pro"
  - "新机器上把云端Maine Coon接进来"
  - "ChatGPT 云端 cat-cafe-toolkits 接入"
  - "云端猫 onboarding"
---

# ChatGPT 云端猫接入指南（猫读 SOP）

> **接球前先读完整本 SOP**——里面踩坑的 dashboard UI 迷雾 + token scope 残缺
> 都是 2026-06-21 那个晚上实测出来的，CF SaaS UI 还在频繁改组，**先信文不信
> dashboard 直觉**。
>
> 阅读对象 = 猫猫（不是operator）。所以指令以 CLI + CF API 为主，dashboard 只在
> **operator点 token scope** 那一步——这是 CF user-level token mint 唯一不能 API
> 做的事。其他全自动。

## 0. 触发条件 + scope 边界

| 触发词 | 接球行动 |
|---|---|
| "Ragdoll帮我接入 gpt-pro" / "云端Maine Coon接入" | 加载本 SOP，从 §1 开始 |
| "新机器接Maine Coon Pro" | 同上（多走 §A 新机器初始化）|
| "云端Maine Coon跑不通" | 跳 §7 debug clinic |

**Scope 边界**：
- ✅ 本 SOP 覆盖 ChatGPT Pro 端接入（任何 OpenAI 子产品 ChatGPT Web / iOS / Mac App）
- ✅ B1a interim（disposable `?token=` 单防线，**无 CF Access** — Path A）
- ❌ B1b production verified auth（CF Access OAuth verified shape via ChatGPT）— 还没排期
- ❌ 多用户 multi-tenant onboarding — F247 Phase D Console UI 才做
- ❌ 接其他云端 vendor（Gemini Web / Claude Web）— 复用本 SOP 框架，但 connector 配置不同

## 1. 前置物料清单（不齐就先去补）

### 1.1 operator账号
- Cloudflare account: `Lysanderlucianosu@gmail.com` (account_id `63e41eacd8c1597363fa363adb57b6ae`)
- DNS zone: `clowder-ai.com` (zone_id `8646136dcb88ec90035de478749e0ad8`)
- ChatGPT Pro 订阅（必需 Developer Mode 才有 Custom MCP Connector 功能）

### 1.2 本机文件（旧机器复用 / 新机器初始化必须有）
| 路径 | 内容 | mode | 来源 |
|---|---|---|---|
| `~/.cloudflared/cert.pem` | tunnel originator cert | 0600 | 旧机器 cp / 新机器需 `cloudflared tunnel login` |
| `~/.cloudflared/67125a9e-8bca-4969-9fbd-0a7d8dc66832.json` | cat-cafe tunnel credentials | 0400 | 旧机器 cp / 新机器需 `cloudflared tunnel create cat-cafe` 重建 |
| `~/.cloudflared/cf-api-token` | CF API token, 53 chars | 0600 | 从 dashboard mint（见 §1.3）|
| `~/.cat-cafe/spike-token` | B1a 64 字符 disposable token，`TOKEN=...` 一行 | 0600 | 旧机器 cp / 新机器自动生成（启动 spike server 时）|
| ~~`~/.cat-cafe/yanyan-pro-cf-service-token.txt`~~ | (**B1a 不需要**：早期 Path B 文件，B1b OAuth 升级时另起。B1a 走 Path A 公网 + `?token=` 单防线) | — | — |
| `~/.cat-cafe/agent-keys/gpt-pro.secret` | gpt-pro agent-key sidecar | 0600 | mint 时生成（§3）|

### 1.2.5 ChatGPT MCP Connector 兼容性硬限制（**P0 设计约束**）

> **OpenAI 官方文档实锤**（https://developers.openai.com/apps-sdk/build/auth 2026-06-21 fetch）：
>
> ChatGPT MCP custom connector **不支持**：
> - ❌ Custom HTTP headers (e.g., `CF-Access-Client-Id`)
> - ❌ Machine-to-machine OAuth grants（client credentials / service accounts / JWT bearer）
> - ❌ 客户自带 API keys
> - ❌ 客户提供的 mTLS certificates
>
> ChatGPT MCP custom connector **只支持**：
> - ✅ OAuth 2.1 (Authorization code + PKCE) - 用户交互 OAuth flow
> - ✅ mTLS (OpenAI-managed cert) - transport 层
> - ✅ Bearer token via Authorization header (但 token 必须从 OAuth flow 拿到)
>
> **设计含义**：
> - **B1a interim** = 公网 endpoint + spike server 自己的 `?token=` 防线（**唯一防线**），无 CF Access
> - **B1b production** = CF Access OAuth verified shape via Authorization code + PKCE flow（ChatGPT 端实测兼容性 OQ）
> - **service token + 2 个 CF headers 方案永远走不通**（违反 OpenAI 官方限制），不再考虑

### 1.3 CF API token scope（最早期就给齐，避免反复回 dashboard）

> 🔥 **关键教训（operator 2026-06-21 04:56 UTC 原话）**：
> > "未来开源社区小伙伴用的时候我建议你最开始就让大家 cat-cafe-spike token 把权限给猫猫们添加好，猫猫们来操作，因为他这个真的太难找了我也不知道要如何操作这个 saas。"
>
> B1a 必需的 **2 个 scope**（B1b OAuth 升级时再补 Apps / Policies / Service Tokens）：

| Resource | Permission | 用途 |
|---|---|---|
| **Account → Cloudflare Tunnel** | Edit | PUT tunnel hostname ingress（mcp.clowder-ai.com → localhost:3098）|
| **Zone → DNS** (clowder-ai.com) | Edit | 加 mcp CNAME（已加，但旧机器迁移可能要）|

> **B1a 不需要** Access: Apps / Policies / Service Tokens scope —— Path A 公网无 CF Access。
> B1b 升级 OAuth verified auth 时再加这三项。

operator mint token 步骤（**B1a 只做一次**）：
1. https://dash.cloudflare.com/profile/api-tokens → `+ Create Token` → Custom token
2. Token name: `cat-cafe-spike`
3. 加上面 2 条 permission（搜索框输 `Tunnel` / `DNS` 即可定位）
4. TTL: forever（也可以 30 天，到期 rotate）
5. Continue → Create → 复制 token 字符串
6. 让operator把 token 粘贴存到 `~/.cloudflared/cf-api-token`，`chmod 600`

> **B1b future 升级时再加** 3 个 scope：Access: Apps / Policies / Service Tokens（OAuth verified auth）。

如果operator只给了部分 scope（之前其他猫接手时），猫必须**首检 B1a 2 个 scope 是否齐全**：

```bash
CF_TOKEN=$(cat ~/.cloudflared/cf-api-token | head -1)
ACC=63e41eacd8c1597363fa363adb57b6ae
ZONE=8646136dcb88ec90035de478749e0ad8
# probe 2 endpoints, 任何一个 10000 Authentication error = 缺 scope
curl -s -H "Authorization: Bearer $CF_TOKEN" "https://api.cloudflare.com/client/v4/accounts/$ACC/cfd_tunnel/67125a9e-8bca-4969-9fbd-0a7d8dc66832/configurations" | python3 -c "import sys,json; d=json.load(sys.stdin); print('TunnelEdit:', d.get('success'))"
curl -s -H "Authorization: Bearer $CF_TOKEN" "https://api.cloudflare.com/client/v4/zones/$ZONE/dns_records?per_page=1" | python3 -c "import sys,json; d=json.load(sys.stdin); print('DnsEdit:', d.get('success'))"
```

任何一行 `False` → 立刻让operator回 dashboard 加 scope，不要凑合开干。

## 2. cat 注册（两层：mint allowlist + runtime catRegistry）

> ⚠️ **常见误判**（LL-cat-cafe-api-has-hot-reload）：之前以为 catId 加进 `cat-config.json` 重启 API 就能让 callback 路由认识它。**错**。
>
> Runtime catRegistry **不读 `cat-config.json`**，读的是 `.cat-cafe/cat-catalog.json` —— 改前者无效。正确做法是用 **`POST /api/cats`** API endpoint，**零重启** 注入。
>
> 两层都要做：

### 2.1 mint allowlist (cat-cafe/cat-config.json roster)

```bash
grep -A 6 '"gpt-pro"' cat-config.json
# 期望:
#   "gpt-pro": {
#     "family": "maine-coon-cloud",
#     "roles": ["design-gate", "peer-reviewer", "vision-guard"],
#     "lead": false,
#     "available": true,
#     "evaluation": "云端 ChatGPT Pro Maine Coon Pro，高阶判断席位"
#   }
```

mint preflight 读 main 的 cat-config.json，gpt-pro entry **必须在 main**（commit + PR 入 main）。

### 2.2 runtime catRegistry 注册 (POST /api/cats)

cat-cafe API runtime 不重启，直接 hot-add:

```bash
curl -X POST http://127.0.0.1:3004/api/cats \
  -H "Content-Type: application/json" \
  -H "X-Cat-Cafe-User: default-user" \
  -d '{
    "catId": "gpt-pro",
    "name": "Maine CoonPro (云端)",
    "displayName": "Maine CoonPro",
    "variantLabel": "Pro Cloud (ChatGPT)",
    "nickname": "Maine CoonPro",
    "avatar": "/avatars/gpt52.png",
    "color": { "primary": "#2196F3", "secondary": "#90CAF9" },
    "mentionPatterns": ["@gpt-pro", "@gpt-pro-cloud", "@yanyan-pro", "@Maine Coonpro"],
    "accountRef": "codex",
    "roleDescription": "云端 ChatGPT Pro Maine Coon Pro，高阶判断 + 跨族 review + 设计方向收敛（F247 Phase B1a）",
    "personality": "云端高阶推理，跨族 review，方向收敛",
    "teamStrengths": "云端高阶判断席位，远端 push 模式",
    "caution": "F247 B1a：云端 Remote MCP，token 防线唯一；不 spawn 本地 CLI",
    "strengths": ["reasoning", "code-review", "design-gate"],
    "clientId": "openai",
    "defaultModel": "gpt-pro",
    "mcpSupport": true,
    "provider": "openai-chatgpt-pro"
  }'

# verify
curl -s http://127.0.0.1:3004/api/cats | python3 -c "
import sys,json; d=json.load(sys.stdin)
ids = [c.get('catId') or c.get('id') for c in (d if isinstance(d,list) else d.get('cats',[]))]
print('gpt-pro present:', 'gpt-pro' in ids)
"
```

Avatar 现暂用 `/avatars/gpt52.png` fallback。Phase C @gemini 设计真头像后 PATCH update。

### 2.3 (deprecated) breeds[].variants[] — 不需要做

F247 R3 P2-4 KD-10 早期推测 "runtime cat / bubble identity 走 breeds.variants Phase C 单独工程"，但**实测发现**：runtime catRegistry 用 POST /api/cats 注入即可，breeds.variants 是 design-time template，**不需要**为 gpt-pro 加 entry。

### 2.x cat-config.json roster 注册（保留作 mint 参考）

> 注意（R3 P2-4 / R8.2 修正）：roster 只是 **mint allowlist**，不消费 provider/avatar/color。
> Runtime cat / bubble / avatar **已由 §2.2 `POST /api/cats` 完成注册** —— 早期 R3 P2-4 推测的
> "breeds[].variants[] Phase C 单独工程" 已被 B1a 实测 supersede（详见 LL-cat-cafe-api-has-hot-reload），
> Phase C scope = UX 抛光（真头像 + 气泡 + cat picker），不需要为 gpt-pro 加 breeds entry。

```bash
# verify 已注册
grep -A 6 '"gpt-pro"' cat-config.json
# 应该看到：
# "gpt-pro": {
#   "family": "maine-coon-cloud",
#   "roles": ["design-gate", "peer-reviewer", "vision-guard"],
#   "lead": false,
#   "available": true,
#   "evaluation": "云端 ChatGPT Pro Maine Coon Pro，高阶判断席位"
# }
```

如果没有，加上面 6 字段后 commit + PR 入 main（mint preflight 强制读 main 的 cat-config.json，不读 worktree）。

## 3. mint gpt-pro agent-key（不可逆，operator 明确 OK 才执行）

```bash
cd /home/user/cat-cafe  # 必须在 main 仓，不在 worktree
node packages/api/dist/scripts/mint-agent-key.js \
  --cat-id gpt-pro \
  --redis-url redis://127.0.0.1:6399 \
  --i-understand-runtime-redis \
  --execute
```

输出：
- `agentKeyId = ak_<uuid>`（audit log，**不输出 secret 全文**）
- `secret written to ~/.cat-cafe/agent-keys/gpt-pro.secret (mode 0600)`

如已 mint 过（key 已在 sidecar 文件里 + Redis backend 已有 record）→ **跳过本节**。

⚠️ production Redis (sacred)规则：mint 操作必须三重 flag 显式确认。猫不能自决跑 mint，必须operator说 "OK mint gpt-pro" 才执行（F247 §10 KD-9）。

## 4. 公网 endpoint：cat-cafe tunnel（B1a Path A，无 CF Access）

> ⚠️ **绝大部分时间花在这里**。CF dashboard UI 重组频繁，**不要让operator摸索 UI**，
> 全部走 CF API。

### 4.1 verify tunnel + DNS

```bash
# 1. tunnel daemon 活
pgrep -af "cloudflared.*tunnel run cat-cafe"
# 2. DNS CNAME 在
dig +short mcp.clowder-ai.com CNAME  # 应该返 67125a9e-8bca-4969-9fbd-0a7d8dc66832.cfargotunnel.com
```

如缺 cat-cafe tunnel 本身（新机器 / tunnel 被误删）→ §A 重建。

### 4.2 加 mcp.clowder-ai.com → localhost:3098 hostname ingress（**API PUT，不走 dashboard**）

```bash
CF_TOKEN=$(cat ~/.cloudflared/cf-api-token | head -1)
ACC=63e41eacd8c1597363fa363adb57b6ae
TUN=67125a9e-8bca-4969-9fbd-0a7d8dc66832

# 1. read current ingress
curl -s -H "Authorization: Bearer $CF_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$ACC/cfd_tunnel/$TUN/configurations" \
  > /tmp/cf-tun-cur.json
python3 -c "
import json
with open('/tmp/cf-tun-cur.json') as f: r = json.load(f)
cfg = r.get('result',{}).get('config',{})
ing = cfg.get('ingress',[])
# strip default 404, insert mcp, append default back
non_default = [x for x in ing if x.get('service') != 'http_status:404']
mcp_rule = {'hostname':'mcp.clowder-ai.com','service':'http://localhost:3098','originRequest':{}}
# skip if already there
if not any(x.get('hostname')=='mcp.clowder-ai.com' for x in ing):
    new_ing = non_default + [mcp_rule, {'service':'http_status:404'}]
    cfg['ingress'] = new_ing
    with open('/tmp/cf-tun-new.json','w') as f: json.dump({'config':cfg}, f)
    print('will PUT')
else:
    print('already configured, skip')
"

# 2. PUT (only if /tmp/cf-tun-new.json exists)
[ -f /tmp/cf-tun-new.json ] && curl -s -X PUT -H "Authorization: Bearer $CF_TOKEN" \
  -H "Content-Type: application/json" \
  -d @/tmp/cf-tun-new.json \
  "https://api.cloudflare.com/client/v4/accounts/$ACC/cfd_tunnel/$TUN/configurations" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('PUT:', d.get('success'), 'version:', d.get('result',{}).get('version'))"
```

`PUT: True` 后 cloudflared **自动 5-10s pull 新 config**，不用手动 restart。日志里会看到：

```
INF Updated to new configuration config="{\"ingress\":[...]}" version=N
```

### 4.3 mcp.clowder-ai.com 不挂 CF Access App（B1a interim）

> **不要给 mcp.clowder-ai.com 配 CF Access App**——根据 §1.2.5 OpenAI 官方限制，ChatGPT 端
> 既不能加 custom headers (service token) 也不能用 machine-to-machine grants 过 CF Access。
> 任何挂上去的 Access App 都会让 ChatGPT 卡在 302 redirect 永远连不上。
>
> **B1a 单防线**：spike server 自己的 `?token=` query param 防线（64 字符随机，redact 模块，
> 8 类 secret 过滤，工具白名单收窄 10 项）。F247 KD-7 + AC-B1-7 设计接受。
>
> **如果上一只猫之前在 mcp.clowder-ai.com 配过 Access App（B1 setup 历史残留），先删**：
>
> ```bash
> # 1. find existing app
> APPS=$(curl -s -H "Authorization: Bearer $CF_TOKEN" "https://api.cloudflare.com/client/v4/accounts/$ACC/access/apps?per_page=50")
> APP_ID=$(echo "$APPS" | python3 -c "import sys,json; d=json.load(sys.stdin); m=[a['id'] for a in d.get('result',[]) if 'mcp.clowder-ai.com' in str(a.get('domain',''))]; print(m[0] if m else '')")
> # 2. delete if exists
> [ -n "$APP_ID" ] && curl -s -X DELETE -H "Authorization: Bearer $CF_TOKEN" \
>   "https://api.cloudflare.com/client/v4/accounts/$ACC/access/apps/$APP_ID" \
>   | python3 -c "import sys,json; print('deleted:', json.load(sys.stdin).get('success'))"
> ```
>
> B1b 阶段（future）才会重新挂 Access App + 配 OAuth 2.1 IDP，让 ChatGPT 走 Authorization
> code + PKCE flow 过 verified auth（OQ：实测 ChatGPT 兼容 CF Access OAuth shape）。

## 5. 启 B1a spike server

> 🚨 **必读**：启动命令 **首段必须 `env -u`** 清掉 5 个可能从父 invocation 继承的污染变量。
> 否则会触发"长得像 X 但行为像 Y"的诡异 bug — 详见 LL-spike-server-env-contamination。

```bash
cd /home/user/cat-cafe
pnpm --filter @cat-cafe/mcp-server build
B1A_TOKEN=$(cat ~/.cat-cafe/spike-token | sed 's/^TOKEN=//')

env \
  -u CAT_CAFE_INVOCATION_ID \
  -u CAT_CAFE_CALLBACK_TOKEN \
  -u CAT_CAFE_THREAD_ID \
  -u CAT_CAFE_SUPERVISOR_PARENT_PID \
  -u CAT_CAFE_AGENT_KEY_FILES \
  PORT=3098 \
  CAT_CAFE_REMOTE_TOKEN=$B1A_TOKEN \
  CAT_CAFE_DESKTOP_MODE=cloud-pro-phase0 \
  CAT_CAFE_READONLY=true \
  CAT_CAFE_CAT_ID=gpt-pro \
  CAT_CAFE_USER_ID=default-user \
  CAT_CAFE_AGENT_KEY_FILE=$HOME/.cat-cafe/agent-keys/gpt-pro.secret \
  CAT_CAFE_AGENT_KEY_FILES='{"gpt-pro":"/home/user/.cat-cafe/agent-keys/gpt-pro.secret"}' \
  CAT_CAFE_API_URL=http://127.0.0.1:3004 \
  nohup node packages/mcp-server/dist/remote-spike.js > /tmp/spike-server-b1a.log 2>&1 &
disown $!

sleep 3
pgrep -af "remote-spike"
curl -s http://localhost:3098/health  # 应返 {"status":"ok","server":"cat-cafe-cloud-pro-b1a"...}
```

### 5.1 env 清单说明（为何要 unset / 重新 set）

| Env | 处理 | 原因 |
|---|---|---|
| `CAT_CAFE_INVOCATION_ID` | **unset** | 否则 MCP server `callback-tools.ts:662` gate 误判 spike 是 invocation-token caller，拒掉Maine Coon云端 post_message |
| `CAT_CAFE_CALLBACK_TOKEN` | **unset** | 同上，gate 检查双 env |
| `CAT_CAFE_THREAD_ID` | **unset** | 防止其他 module 误以为 spike 有 "current thread" |
| `CAT_CAFE_SUPERVISOR_PARENT_PID` | **unset** | 防止 supervisor 路径误绑定 |
| `CAT_CAFE_AGENT_KEY_FILES` | **unset 后重新 set** | 默认继承 antigravity multi-cat map（无 gpt-pro），`resolveAgentKeySecret()` 走 map 路径找不到 gpt-pro 就返 undefined，**屏蔽** AGENT_KEY_FILE single fallback |
| `CAT_CAFE_AGENT_KEY_FILES='{"gpt-pro":...}'` | **set** | override 多 cat map，让 caller 传 `agentKeyCatId="gpt-pro"` 时能查到 file |

> spike-token 自动生成（如 `~/.cat-cafe/spike-token` 不存在）。
> 后台跑可用 `nohup ... &` 或 systemd/launchd，**新机器永久跑**需要 launchd plist。
> launchd plist 也要带 `<key>EnvironmentVariables</key>` 显式清掉父继承（默认 launchd 不污染但 supervisor wrap 可能会）。

## 6. E2E 公网真理时刻（必跑，否则不算 onboarding 完成）

```bash
B1A_TOKEN=$(cat ~/.cat-cafe/spike-token | sed 's/^TOKEN=//')

# Test 1: /health 直接公网 (B1a no CF Access)
curl -s "https://mcp.clowder-ai.com/health"
# 期望: {"status":"ok","server":"cat-cafe-cloud-pro-b1a","version":"0.0.4-b1a","mode":"cloud-pro-phase0","cat_id":"gpt-pro"}

# Test 2: tools/list 10 项白名单 (B1a ?token=)
curl -s -X POST "https://mcp.clowder-ai.com/mcp?token=$B1A_TOKEN" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
# 期望: 10 项 (post_message / get_thread_context / get_message / list_threads /
#             cross_post_message + search_evidence / graph_resolve / list_recent /
#             list_session_chain / read_session_digest)

# Test 3: 反例 — 无 token (spike 401)
curl -s -o /dev/null -w "%{http_code}\n" \
  -X POST "https://mcp.clowder-ai.com/mcp" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
# 期望: 401 {"error":"unauthorized","hint":"pass ?token= or Authorization: Bearer"}
```

3 项全过 = ✅ onboarding 完成，可以传 ChatGPT 端配置给operator。

## 7. Maine Coon ChatGPT 端配置（最后一步，operator点一下）

operator设置 ChatGPT custom MCP connector（路径：ChatGPT Settings → Connectors → 新建应用，需 Developer mode）。表单字段：

| 字段 | 填 |
|---|---|
| **名称** | `cat-cafe` |
| **描述** | `Cat Café MCP - 云端Maine Coon Pro 工具集` |
| **连接** | 选 **服务器 URL**（dropdown）|
| **URL** | `https://mcp.clowder-ai.com/mcp?token=<B1A_TOKEN>` |
| **身份验证** | 选 **未授权**（dropdown）|
| **了解风险** checkbox | ☑️ 勾上 |

URL 里 `<B1A_TOKEN>` 替换成 `~/.cat-cafe/spike-token` 里 `TOKEN=...` 后面的 64 字符。
**不要**截图发operator（secret discipline）— 让他自己 `cat ~/.cat-cafe/spike-token` 看一眼粘贴。

然后灌 Custom Instructions（短 L0）：见 [`gpt-pro-custom-instructions.md`](./gpt-pro-custom-instructions.md)。

Maine Coon云端 ChatGPT 应该立刻能调 10 项工具。试 `cat_cafe_list_threads` 或 `cat_cafe_search_evidence` 看返回。

### Transport 兼容性

- ChatGPT MCP UI placeholder 是 `.../sse` (SSE transport)
- 我们 spike server 用 **Streamable HTTP** `/mcp` endpoint（accept `application/json, text/event-stream`）
- MCP SDK 双协议自适配，ChatGPT 端应自动 detect
- 如连不上报 transport error，看 spike server log + ChatGPT 端报错截图发Ragdoll debug

## §A 新机器 / cat-cafe tunnel 重建（仅当不存在）

如新机器 `~/.cloudflared/` 整个目录没有：

```bash
# 1. cloudflared login (会开浏览器，operator OAuth Google 一次)
cloudflared tunnel login
# 生成 ~/.cloudflared/cert.pem

# 2. 重建 cat-cafe tunnel
cloudflared tunnel create cat-cafe
# 生成 ~/.cloudflared/<new-tunnel-id>.json
# ⚠️ 这是 NEW tunnel ID，不是 67125a9e-8bca-4969-9fbd-0a7d8dc66832 那个
# 后续所有命令的 TUN=<new-id> 改掉

# 3. update DNS CNAME mcp + cafe + api 全部指向新 tunnel
# (zone DNS API 自动 update，需 Zone:DNS Edit scope)

# 4. 走 §4.2 配 ingress（B1a 不挂 Access App；B1b 时再补 §4.3 OAuth Path）
```

**优先级**：旧机器 cp 整个 `~/.cloudflared/` + `~/.cat-cafe/` 比重建简单 10 倍。

## §B Debug Clinic（onboarding 失败排查）

| 症状 | 根因 | 修复 |
|---|---|---|
| `cloudflared tunnel info` returns 0 connections | tunnel daemon 挂了 | `nohup cloudflared --config ~/.cloudflared/config.yml tunnel run cat-cafe &` |
| `curl https://mcp.clowder-ai.com/health` → 302 to cloudflareaccess.com | 残留 CF Access App 没删（B1a 必须删）| §4.3 DELETE 残留 App |
| → 404 from cloudflared | dashboard ingress 缺 mcp route | §4.2 PUT 一次 |
| ChatGPT 端报 "工具调用被 OpenAI 的安全检查屏蔽" | MCP tool 缺 annotations (readOnlyHint/destructiveHint/openWorldHint) | 升级到含 `inferAnnotations()` 的 server-toolsets.ts (commit `994dfa665`+) + Maine Coon ChatGPT 端重开 connector force refresh schema |
| → 1033 Argo Tunnel error | tunnel ID 不匹配 DNS CNAME（新机器忘 update DNS）| 走 §A.3 |
| `curl ...?token=xxx` → 401 | spike-token 错或 spike server 不在跑 | `pgrep remote-spike` + 读 `/tmp/spike-b1a.log` |
| `curl ... /mcp` returns tools but少几个 | 白名单 mode 错 | 检查 env `CAT_CAFE_DESKTOP_MODE=cloud-pro-phase0` |
| Quick tunnel TLS handshake EOF | ISP 拦 trycloudflare.com | 不修，**只用 named tunnel** mcp.clowder-ai.com |
| dashboard "Hostname routes (Beta)" 是 private network 表单 | CF UI 重组，public hostname 入口藏了 | **不走 dashboard，走 §4.2 CF API PUT** |
| Maine Coon云端 read 工具 OK，但 `cat_cafe_post_message` 返 `Unknown catId filter: gpt-pro` 或 502 | cat-cafe API catRegistry 没注册 gpt-pro | **不要重启 API**，走 `POST /api/cats` 热加载（§2.2）。详见 LL-cat-cafe-api-has-hot-reload |
| `post_message rejects threadId from invocation-token callers (F193 KD-1)` 错误（Maine Coon云端是 agent-key，本不该 fire）| spike server 继承父 invocation 的 `CAT_CAFE_INVOCATION_ID` + `CAT_CAFE_CALLBACK_TOKEN` env，MCP server gate 误判 | spike 启动加 `env -u CAT_CAFE_INVOCATION_ID -u CAT_CAFE_CALLBACK_TOKEN`（§5）。详见 LL-spike-server-env-contamination |
| `Cat Café callback not configured. Missing ... agent-key credentials` 但你明明设了 `CAT_CAFE_AGENT_KEY_FILE` | spike 继承父 `CAT_CAFE_AGENT_KEY_FILES` (antigravity multi-cat map)，不含 gpt-pro → `resolveAgentKeySecret()` 走 map 路径返 undefined，**屏蔽** single AGENT_KEY_FILE | spike 启动 `-u CAT_CAFE_AGENT_KEY_FILES` 后重新 set 含 gpt-pro 的 map（§5） |
| `threadId required for agent-key auth` (cat-cafe API 错误) | agent-key caller 模式必传 `threadId`（vs invocation-token 必禁），Maine Coon ChatGPT 端没传 | 告诉Maine Coon他是 agent-key 模式 `post_message` 必须显式带 `threadId`（短 L0 已说明）。详见 LL-agent-key-vs-invocation-token-threadId |
| ChatGPT 端 write 工具偶尔被 OpenAI safety check 拦截，read 工具不拦 | ChatGPT 对 `readOnlyHint=false` 工具更严格 + first-time write 可能要 user 确认 | 让Maine Coon在 ChatGPT UI 点确认按钮 (如有)；或多试几次。属于 OpenAI 平台行为，**我们不可控** |

## §C 风险表 + Token Rotation SOP

> **B1a interim 是接受降级的设计**（F247 KD-7 + AC-B1-7）。这一节列**所有已知风险**
> 给猫和operator知情，并提供 rotation / 应急 SOP。

### C.1 B1a 暴露面 + 防线一览

| 防线 | 强度 | 失守后果 |
|---|---|---|
| `?token=` 64 字符随机 disposable | **唯一防线**（公网 endpoint，无 CF Access）| token 泄漏 = 任何人能调 10 项 cat-cafe 工具，**影响 user-scope 的 thread / message / memory** |
| 工具白名单收窄 10 项（cloud-pro-phase0）| 强 | 即便泄漏也调不了 `publish_verdict` / `shell_exec` / `read_file_slice` / `hold_ball` / `get_pending_mentions` / `task tools` 等敏感工具 |
| 8 类 secret redact module（wraps response.write/end）| 强 | 即便 LLM 输出泄漏，GitHub PAT / ghs_ / OpenAI sk- / Slack / AWS / Google AIza 字符串被自动过滤 |
| readonly + cat_id=gpt-pro + user_id=default-user 锁定 | 强 | Maine Coon云端发的所有 message 标 `gpt-pro` 身份，audit log 完整 |

**实质暴露面**：拿到 token = 能伪装Maine Coon Pro 身份发 message + 写 thread + 写 memory + 调 search/list 看 user-scope 记忆。

### C.2 高风险场景（必读）

| 场景 | 风险等级 | 应对 |
|---|---|---|
| Token 字符串出现在 ChatGPT thread / 截图 / 任何 chat history | 🔴 P0 | rotate（§C.3）|
| Token 字符串 commit 到 git repo（包括 worktree / 历史 commit）| 🔴 P0 | rotate + `git filter-repo` 清史 + force push（operator + 跨族 review）|
| operator把 ChatGPT account 借给别人用 | 🔴 P0 | rotate + 看是否 setup 第二 connector |
| Maine Coon ChatGPT 端 connector list 截图被分享 | 🔴 P0 | rotate（截图含 URL = 含 token）|
| 公网 endpoint 被扫到 + brute force 64 字符 token | 🟡 低（64 字符 entropy ≈ 256 bits，brute force 不可行）| 监控 spike server log 看 401 频率 |
| Spike server 进程被 dump（本机被入侵）| 🔴 P0 | rotate + 排查本机入侵 + 关心 cat-cafe Redis 6399 状态 |
| Token 文件 `~/.cat-cafe/spike-token` mode 不是 0600 | 🟡 中 | `chmod 600` |
| B1b production 升级前一直跑 B1a | 🟡 中 | 排期 B1b OAuth verified flow（F247 后续 phase）|

### C.3 Token Rotation SOP（怀疑泄漏 / 季度定期 / B1b 升级前）

```bash
# 1. 生成新 token
NEW_TOKEN=$(openssl rand -hex 32)
echo "TOKEN=$NEW_TOKEN" > ~/.cat-cafe/spike-token
chmod 600 ~/.cat-cafe/spike-token

# 2. restart spike server 让它 pick up 新 token
pkill -TERM -f remote-spike  # spike server 自动 restart from launchd / systemd
# 或手动 nohup ... 重启（见 §5）

# 3. Maine Coon ChatGPT 端更新 connector URL
# 旧 URL: https://mcp.clowder-ai.com/mcp?token=<OLD_TOKEN>
# 新 URL: https://mcp.clowder-ai.com/mcp?token=<NEW_TOKEN>
# → ChatGPT Settings → Connectors → 找 cat-cafe → 编辑 URL → 保存

# 4. verify
B1A_TOKEN=$(cat ~/.cat-cafe/spike-token | sed 's/^TOKEN=//')
curl -s -X POST "https://mcp.clowder-ai.com/mcp?token=$B1A_TOKEN" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | head -c 300
# 期望: 10 项 toolset 返回

# 5. cross-post 主 thread 通报 rotation
# "@team B1a token rotated 2026-XX-XX 因为 <reason>"
```

### C.4 B1b production 升级路径（future，非本 SOP scope）

当 B1b 实施时本 SOP §4.3 改回挂 CF Access App + 配 OIDC IDP + OAuth 2.1 flow：

- ChatGPT MCP connector URL: 用 verified OAuth 而非 query token
- spike server 解析 Authorization: Bearer <JWT> + verify CF Access JWT
- token 不出现在 URL，rotate 通过 OAuth provider 后端完成（不影响Maine Coon端）
- 风险等级降到生产可接受

OQ：ChatGPT MCP custom connector 是否兼容 CF Access OAuth shape（IDP discovery / well-known endpoint / scope 字段）— 待 B1b spike 实测。

### C.5 监控与告警（建议建）

| 信号 | 阈值 | 含义 |
|---|---|---|
| spike server `auth=present` 频率 | 正常 < N/分（按Maine Coon活跃度）| 异常高 = 可能被滥用 |
| `auth=absent` 频率 | 正常 < 1/秒（互联网扫描）| 异常高 = 公网扫描 / brute force 试探 |
| User-Agent 多样性 | 正常 1-2 个（Maine Coon ChatGPT 一致）| 异常多 = 多客户端登录 |
| Egress IP 多样性 | OpenAI IP 段（Azure）| 突变 = Maine Coon ChatGPT 服务端 IP 变化或被劫持 |

Future improvement: spike server 加 telemetry 推送到 cat-cafe API，rich block 周报呈现。

## 已知 P0 教训（不要重复）

1. **CF Dashboard UI 迷雾**（2026-06-21 04:21-04:56 UTC 5 次互相猜路径都猜错）：
   - "Networks → Tunnels" tab 在新版叫 **"Connectors"** + **"Routes"** 拆开
   - "Public Hostnames" tab 在新版叫 **"Hostname routes (Beta)"**
   - 但 Hostname routes (Beta) 表单**只支持 private network**（顶部蓝 banner "requires Cloudflare One Client"）
   - Public hostname 入口在新 UI 实测无法定位 → **永远走 CF API PUT**

2. **Token scope 残缺要回头补**（operator experience见 §1.3）：
   - B1a 一开始就给 **2 个 scope**（Tunnel / DNS），B1b 升级时再补 Apps / Policies / Service Tokens。
   - 缺哪个补哪个的"省 scope"做法**反而费时**——每次回 dashboard 加 scope 都要 3 分钟 + 中断 flow。
   - 旧版（B1a R8.1 之前）写 5 个 scope 是 Path B service token 路径，R8.2 已统一改 Path A。

3. **本地 config.yml 失效**：cat-cafe tunnel 在 dashboard managed 模式下（log 出现 `Updated to new configuration`），本地 `~/.cloudflared/config.yml` 的 ingress 改动**不生效**。必须走 dashboard 或 CF API PUT。

4. **B1a `?token=` 是 interim，不是 production**：F247 KD-7 + AC-B1-7。B1b 升级 verified auth 时切换。本 SOP 不覆盖 B1b。

5. **mint 是不可逆**（F178 KD-9 + F247 §10 KD-9）：mint script 必须operator签 "OK mint gpt-pro" 才跑。猫不自决。

## 关联

- F247 spec: `docs/features/F247-cloud-cat-family.md`
- 短 L0 Custom Instructions: `cat-cafe-skills/refs/gpt-pro-custom-instructions.md`
- F178 mint script SOP: F178 Phase D
- LL-feat-anchor-claim-on-main: F 号要 claim on main，否则被抢

[Ragdoll/Opus-4.7🐾]
