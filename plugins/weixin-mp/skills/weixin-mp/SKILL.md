# 微信公众号发文

通过 Limb 体系 (`limb_invoke`) 操作微信公众号。需要 `.env` 配置 `WEIXIN_MP_APP_ID` + `WEIXIN_MP_APP_SECRET`。

## 核心能力

- **检查连接** — `limb_invoke("weixin-mp", "weixin_mp.check_status")`
  确认公众号是否配置并可连接。

- **发布文章** — `limb_invoke("weixin-mp", "weixin_mp.publish_article", { title, markdown, coverImageUrl?, author?, digest?, publish? })`
  Markdown 自动转为微信兼容内联样式 HTML。封面图提供 `coverImageUrl`（自动上传）或 `thumbMediaId`。默认存草稿箱，`publish: true` 直接发布。

- **上传图片** — `limb_invoke("weixin-mp", "weixin_mp.upload_image", { imageUrl })`
  上传图片到微信 CDN，返回可在文章正文中使用的链接。文章内嵌图片必须在微信 CDN 上。

- **查看草稿** — `limb_invoke("weixin-mp", "weixin_mp.list_drafts", { offset?, count? })`
  列出草稿箱中的文章及其 media_id。

- **发布状态** — `limb_invoke("weixin-mp", "weixin_mp.publish_status", { publishId })`
  查询发布任务的处理状态和文章链接。

## 限制

- 封面图必须提供 `coverImageUrl` 或 `thumbMediaId`，否则报错
- 微信 HTML 不支持外部 CSS/JS，所有样式内联处理
- 文章正文中的图片必须先通过 `upload_image` 上传到微信 CDN
- access_token 2h 过期，系统自动刷新，无需手动管理
