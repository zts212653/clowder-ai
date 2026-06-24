---
name: weixin-mp
description: >
  通过 Limb 体系操作微信公众号：发布文章、上传图片、管理草稿。
  Use when: 需要发布内容到微信公众号、查看草稿、检查公众号连接状态。
  Not for: 其他平台的发布、纯文本聊天、非公众号相关操作。
  Output: 微信公众号操作结果（发布ID、草稿列表、图片URL等）。
triggers:
  - "微信"
  - "公众号"
  - "发文"
  - "weixin"
  - "wechat"
  - "publish article"
---

# 微信公众号发文

通过 Limb 体系 (`limb_invoke`) 操作微信公众号。

## 使用前检查

先调用 `limb_list_available({ capability: "content_publish" })` 确认 `weixin-mp` 节点在线。
如果节点不在线或不存在，提示用户在 **设置 → 插件集成** 中启用并配置微信公众号插件。

## 接口发现

`limb_list_available()` 返回当前在线节点的 capability、command 和 authLevel；这是可调用命令白名单。
详细参数以本 skill 的"核心能力"说明为准。当前列表中没有的命令不要猜测调用；如果缺少预期命令，提示用户重新启用或同步微信公众号插件。

## 核心能力

- **检查连接** — `limb_invoke({ nodeId: "weixin-mp", command: "weixin_mp.check_status" })`
  确认公众号是否配置并可连接。

- **Markdown 转 HTML** — `limb_invoke({ nodeId: "weixin-mp", command: "weixin_mp.convert_markdown", params: { markdown } })`
  将 Markdown 转为微信兼容内联样式 HTML。返回 `{ html }`。发文前必须调用。

- **上传正文图片** — `limb_invoke({ nodeId: "weixin-mp", command: "weixin_mp.upload_image", params: { imageUrl } })`
  上传图片到微信 CDN，返回可在文章正文中使用的 `{ url }`。

- **上传封面素材** — `limb_invoke({ nodeId: "weixin-mp", command: "weixin_mp.upload_material", params: { imageUrl } })`
  上传永久图片素材，返回 `{ mediaId, url }`。用作封面图的 `thumbMediaId`。

- **创建草稿** — `limb_invoke({ nodeId: "weixin-mp", command: "weixin_mp.create_draft", params: { title, content, thumbMediaId, author?, digest? } })`
  创建草稿箱文章。`content` 须是微信 HTML（先调 `convert_markdown`），`thumbMediaId` 是封面 media_id（先调 `upload_material`）。

- **发布草稿** — `limb_invoke({ nodeId: "weixin-mp", command: "weixin_mp.submit_publish", params: { mediaId } })`
  将草稿发布。`mediaId` 是 `create_draft` 返回的 `media_id`。

- **查看草稿** — `limb_invoke({ nodeId: "weixin-mp", command: "weixin_mp.list_drafts", params: { offset?, count? } })`
  列出草稿箱中的文章及其 media_id。

- **发布状态** — `limb_invoke({ nodeId: "weixin-mp", command: "weixin_mp.publish_status", params: { publishId } })`
  查询发布任务的处理状态和文章链接。

## 发文流程（编排示例）

发布一篇 Markdown 文章的标准步骤：

1. `convert_markdown` — Markdown → 微信 HTML
2. 正文中的外部图片 → 逐个 `upload_image` → 替换为微信 CDN URL
3. `upload_material` — 上传封面图 → 得到 `thumbMediaId`
4. `create_draft` — 创建草稿（传入 HTML + thumbMediaId）
5. 可选：`submit_publish` — 发布草稿

## 常见错误

- 忘记先调 `convert_markdown` 就直接传 Markdown 给 `create_draft`
- 文章正文中使用外部图片链接（必须先 `upload_image` 到微信 CDN）
- 混淆草稿 media_id 和发布 publishId

## 限制

- 微信 HTML 不支持外部 CSS/JS，所有样式内联处理
- access_token 2h 过期，系统自动刷新，无需手动管理
