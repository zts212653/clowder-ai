---
doc_kind: guide
created: 2026-11-08
updated: 2026-11-10
owner: codex61-sol
feature_ids: [F317]
topics: [platform-api, credentials, file-transfer]
---

# 用家里的平台账号发送完整 API 请求

在账号页保存 OpenAI Platform 或 Google API Key 后，猫把官方请求写成不含密钥的 JSON 文件，再运行：

```sh
pnpm platform:request --request /absolute/path/request.json
```

也可从任意目录使用宿主仓库的绝对入口：`node /path/to/cat-cafe/scripts/platform-request.mjs --request /absolute/path/request.json`。这是宿主后台服务的本机 CLI，不依赖日常 API/MCP 进程加载新版本。构建包含 `packages/api/dist` 和 `packages/mcp-server/dist` 后可用；未构建时按仓库原生命令 `pnpm --filter @cat-cafe/api build` 构建一次。CLI 不创建常驻代理。

CLI 只收请求文件及可选的 `--file-root DIR`、`--output-dir DIR`，不能在命令中填 key。账号解析与 Hub、Decisions 使用同一个 canonical snapshot；不带运行环境变量的开发工位按 Git common root 找到主仓账号，显式配置的根目录仍优先；名称、账号旧 `models` 列表不改变本次请求模型。裸官方主机名 `api.openai.com` 规范化成 HTTPS，网关必须已在所选账号登记为完整 HTTPS 地址，不跟随重定向。请求发往哪一家由 `accountRef` 指向的账号决定：OpenAI 账号走 OpenAI，Google 账号走 Vertex AI（见下文「Google（Vertex AI）」）。Anthropic 不走这个入口，Claude 通过成员账号绑定在 Claude Code 里使用。

## 配置与复用平台账号

在「猫猫团队 → 账户与登录」添加账号，选择 **Anthropic API**、**OpenAI Platform** 或 **Google API**，填写名称和 API Key 即可保存；地址和模型列表可留空。密钥由操作者自行填写，使用方选择本次请求的模型。

平台 API Key 账号与 Claude、Codex、Gemini 的 OAuth/订阅登录分开。添加平台账号不会发起 CLI 登录或改变已有成员绑定；编辑时密钥留空保留原密钥。保存三家的平台账号不代表本页 CLI 已提供三家的请求传输：`platform:request` 发送 OpenAI 与 Google 的 HTTP API 请求，不发送 Anthropic 请求。

## JSON 请求

`body` 是官方 API 的请求本身，未知字段、嵌套对象、数组和模型名原样发送。先读所用模型/接口的官方文档，再填写参数。

```json
{
  "accountRef": "11",
  "timeoutMs": 300000,
  "request": {
    "method": "POST",
    "path": "/v1/responses",
    "contentType": "application/json",
    "body": {
      "model": "MODEL_FROM_OFFICIAL_DOCS",
      "input": "这里填写输入和该模型需要的所有参数"
    }
  }
}
```

可选 `request.headers` 支持项目/组织选择和供应商能力开关等普通头。认证、Host、Cookie、Content-Type/Length 及连接头由宿主控制，调用者不能覆盖。`request.path` 支持官方查询参数，但不能填写别的主机或非规范路径。

## Google（Vertex AI）

家里的 Google 平台账号指 **Vertex AI**（Google Cloud，按 Cloud 结算账号计费，Google Cloud 赠金可用），不是 AI Studio 的 Gemini API。有两种账号，请求格式相同：

- **Google Cloud 登录（推荐，不用建 key）**：账号只记一个 Cloud 项目，不存任何密钥。发送时由宿主读取这台机器上主人的标准 Google Cloud 登录（`gcloud auth application-default login` 产生的 authorized-user 凭据；设置了 `GOOGLE_APPLICATION_CREDENTIALS` 时读它指向的同类文件），在 `oauth2.googleapis.com` 换一次只用于本次请求的访问令牌，再带 `x-goog-user-project` 发往 Vertex。路径必须写成 `projects/{账号的项目}/locations/{位置}/...`；位置不是 `global` 时自动发往 `{位置}-aiplatform.googleapis.com`。读模型清单 `GET /v1beta1/publishers/google/models` 不花钱，可以不带项目。登录失效时返回 `platform_account_unavailable`，请主人在终端重新运行 `gcloud auth application-default login`。猫不读这份登录凭据，也拿不到令牌。
  家里现有账号：`google-cloud-f33686a9-f9f5-4b95-8dfe-7d97c36663df`（项目 `project-ac991cb0-18d1-4ab9-91d`，与配乐插件同一项目），`accountRef` 填它即可。
  创建方式（主人同意后由猫代办或在 API 里提交）：`POST /api/accounts`，body 为 `{"displayName": "Google Cloud", "authType": "oauth", "clientId": "google", "googleCloudProjectId": "项目 ID"}`。账号 ID 以 `google-cloud-` 开头，账号页显示为「Google Cloud（Vertex AI · 项目 ID）」；不会被当成 Gemini CLI 的登录。
- **Vertex API key**：请求发往 `https://aiplatform.googleapis.com`（或账号登记的完整 HTTPS 地址，例如区域地址 `https://us-central1-aiplatform.googleapis.com`），宿主把 key 放进 `x-goog-api-key` 头，路径里带 `key=` 查询参数会被拒绝。key 要在 Google Cloud 控制台用 express mode 或绑定服务账号的方式创建；AI Studio 创建的 key 发往 Vertex 会得到 401 `API keys are not supported by this API`。

模型方法（`generateContent` 等）的模型写在路径里；Lyria 配乐的 `interactions` 按官方请求形状把 `"model"` 写在 `body` 顶层。下面是模型方法的例子：

```json
{
  "accountRef": "google-cloud-ACCOUNT_ID",
  "timeoutMs": 300000,
  "request": {
    "method": "POST",
    "path": "/v1/projects/PROJECT_ID/locations/global/publishers/google/models/MODEL_FROM_OFFICIAL_DOCS:generateContent",
    "contentType": "application/json",
    "body": {
      "contents": [{ "role": "user", "parts": [{ "text": "这里填写输入" }] }],
      "generationConfig": { "responseModalities": ["TEXT", "IMAGE"] }
    }
  }
}
```

开放的路径（版本 `v1` 或 `v1beta1`；Vertex API key 账号的 `projects/{项目}/locations/{位置}/` 前缀可有可无，Google Cloud 登录账号除读模型清单外必须带自己的项目）：

- `POST .../publishers/google/models/{model}:{方法}`，方法为 `generateContent`、`streamGenerateContent`（加 `?alt=sse`）、`countTokens`、`computeTokens`、`predict`、`predictLongRunning`、`fetchPredictOperation`；
- `GET .../publishers/google/models`、`.../publishers/google/models/{model}`；
- 带项目前缀的长任务查询 `GET projects/{项目}/locations/{位置}/[publishers/google/models/{model}/]operations/{id}`；
- Lyria 配乐的 `POST projects/{项目}/locations/{位置}/interactions` 与 `GET .../interactions/{id}`。

只在某个区域提供的模型：Google Cloud 登录账号在路径里写那个位置即可；Vertex API key 账号要在账号里登记该区域的地址。Google 请求只收 JSON `body`，不收 multipart；输入图片用官方的内联数据（base64）写进 `body`。自建 endpoint、微调、数据集、缓存、batch 作业和权限管理不在此入口。收据的 `model` 对模型方法取自路径，对 `interactions` 取自 `body` 的 `model`；`usage` 取供应商返回的 `usageMetadata`；Google 不回请求编号头，`requestId` 通常为 `null`。**本机代理会掐断大响应**：这台机器的请求默认经代理 `127.0.0.1:7897`。11-10 实测几 MB 的生图结果连续在约 12 秒时被代理从中途断开：收据为 `unconfirmed`、HTTP 200、没有 `responseFile`，Google 可能已经计费。遇到这种情况，在同一条命令前加 `env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy -u ALL_PROXY -u all_proxy` 直连重发一次（会再生成一次）。文本、模型清单和 30 秒 Lyria 经代理正常。

配乐插件另有自己受管的 Google Cloud 授权（见音乐插件指南），这个入口不读取插件保存的授权。

## 图片、音频和其他 multipart 文件

下面展示 multipart 字段和文件的传递形状。请按所用接口的官方文档填写模型名与参数；服务原样传递，不替调用者判断模型能力或账号权限。

```json
{
  "accountRef": "11",
  "timeoutMs": 300000,
  "request": {
    "method": "POST",
    "path": "/v1/images/edits",
    "contentType": "multipart/form-data",
    "fields": {
      "model": "MODEL_FROM_OFFICIAL_DOCS",
      "prompt": { "fromFile": "prompt.txt" }
    },
    "files": {
      "image": { "path": "ref.png", "contentType": "image/png" }
    }
  }
}
```

文件根默认是请求 JSON 所在目录。`fromFile` 作为 UTF-8 文本字段发送；`files` 保留文件原字节，可填 `filename`。同名字段或文件用数组表达重复项，例如 `"tag": ["a", "b"]`。文件按真实路径核验，不允许越出所选文件根，也不能上传凭据源。可以明确传 `--file-root` 扩大所选输入目录；它不改变账号坐标。

一份请求只发送一次。联调文件里的 `purpose`、`expectedResponse`、`variant` 等附注不会触发额外请求；要对比第二个模型，应另发一次明确请求。

## 结果和记账

stdout 是一行 JSON 收据，含 `callId`、账号/接口/模型、HTTP 状态、`requestId`、供应商 `usage`、响应头（不保存 `set-cookie`）、`responseFile` 和 `receiptFile`。原始响应字节在 `responseFile`，原件与收据默认保存在既有 API uploads 目录的 `platform-calls/<callId>/`，不会把几 MB 的 base64 塞回猫的上下文。账号 key 不进入命令、响应原件或日志；如果供应商回显了已配置凭据，整个响应原件被拒收并清理，收据保留未确认结果。

例如供应商返回 `data[0].b64_json`，调用方从原件 JSON 解码成 GIF；后台不另合成 GIF/SVG。音频、JSON 和 SSE 都保留原始响应。SSE 本轮保存完整事件文件，不提供实时 UI 推送。双向 Realtime/WebSocket 不属于此 HTTP 入口。

`usage` 只取供应商返回值；未提供就是 `null`。`cost` 是未知金额，不能把 token 数换算成伪精确账单，也不能写成免费。开始/结束事件进入既有 EventAuditLog，不保存提示词、输入文件内容或认证头。

退出码：0=完整 2xx 响应；2=完整非 2xx 响应（原错误正文在文件）；3=发送后结果未确认；1=未取得收据。错误中的 `status=not_sent` 表示账号/输入/存储准入阶段已失败，没有发送请求，账号问题会给出 `platform_account_unavailable`；不会指向不存在的扣费审计。`status=unconfirmed` 会携原 callId/收据引用，应先查看收据/审计，不能自动重试。服务没有自动重试或付费请求重放。

默认超时300秒，可显式调到最多900秒，覆盖发送与读取。单输入文件沿用64MiB共享载荷上限，全部输入合计128MiB；默认响应128MiB，可显式设 `maxResponseBytes`，最高512MiB。超限/取消会清理本轮未完成文件，不能把截断响应当作成功。进程被强杀时，只有开始事件或 `.partial` 表示未确认；不自动恢复付费调用。

## 接口范围与直接调用

OpenAI 开放普通 HTTP 推理族：Responses、chat/completions、completions、Decisions、images、audio、embeddings、moderations、videos，以及模型发现、推理所需的 files/uploads；Google 的范围见上文。账号/key、组织、账单、微调、batch 管理不在此入口开放。模型与各接口的参数都由官方服务裁决，不由账号模型列表裁决。

直接 curl 的认证同样按已登记账号与实际去向判断：对应 key 只在自己的认证头中发给自己的官方 HTTPS 或明确登记的网关，其他正文/文件/URL 仍检查；多目标、跟随重定向或更改实际去向的选项不走这个认证例外。该判定需要完整宿主的 canonical 账号模块；只有独立 MCP 包而没有宿主 API 的安装不获得此例外。

直接 Python 等调用遵守同一规则：密钥只在内存用于对应认证，不打印、不复制进文件或回复，发实际匹配的 HTTPS 去向，不跟随重定向。做完不用向主人报用量或费用，也不用为此去查消耗（You 11-09 更正，见防密钥外泄方案 (internal)最上节）。这里没有新增全机网络防火墙或 Python 禁令。
