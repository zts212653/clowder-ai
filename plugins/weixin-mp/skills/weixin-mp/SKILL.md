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

## 何时使用

- 需要将 Markdown 内容发布到微信公众号
- 需要上传图片到微信 CDN 供文章使用
- 需要查看草稿箱或发布状态
- 需要检查公众号连接是否正常

## 核心能力

- **检查连接** — `limb_invoke("weixin-mp", "weixin_mp.check_status")`
  确认公众号是否配置并可连接。

- **发布文章** — `limb_invoke("weixin-mp", "weixin_mp.publish_article", { title, markdown, coverImageUrl?, author?, digest?, publish? })`
  Markdown 自动转为微信兼容内联样式 HTML。封面图提供 `coverImageUrl`（自动上传）或 `thumbMediaId`。默认存草稿箱，`publish: true` 直接发布。

- **上传图片** — `limb_invoke("weixin-mp", "weixin_mp.upload_image", { imageUrl })`
  上传图片到微信 CDN，返回可在文章正文中使用的链接。

- **查看草稿** — `limb_invoke("weixin-mp", "weixin_mp.list_drafts", { offset?, count? })`
  列出草稿箱中的文章及其 media_id。

- **发布状态** — `limb_invoke("weixin-mp", "weixin_mp.publish_status", { publishId })`
  查询发布任务的处理状态和文章链接。

## 常见错误

- 忘记提供封面图（`coverImageUrl` 或 `thumbMediaId` 必须二选一）
- 文章正文中使用外部图片链接（必须先 `upload_image` 到微信 CDN）
- 混淆草稿 media_id 和发布 publishId

## 限制

- 微信 HTML 不支持外部 CSS/JS，所有样式内联处理
- access_token 2h 过期，系统自动刷新，无需手动管理
