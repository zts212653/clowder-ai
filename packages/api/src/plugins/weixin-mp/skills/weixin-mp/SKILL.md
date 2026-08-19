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

通过 Limb 体系三步调用操作微信公众号：
1. `limb_list_available` — 发现在线节点
2. `limb_list_tools` — 查询工具 schema
3. `limb_invoke_tool` — 调用具体工具

## 使用前检查

先调用 `limb_list_available({ capability: "content_publish" })` 确认 `weixin-mp` 节点在线。
如果节点不在线或不存在，提示用户在 **设置 → 插件集成** 中启用并配置微信公众号插件。

## 接口发现

`limb_list_available()` 返回当前在线节点的 capability、command 和 authLevel；这是可调用命令白名单。
调用 `limb_list_tools({ nodeId: "weixin-mp" })` 获取每个工具的参数 schema。
详细参数以本 skill 的"核心能力"说明为准。当前列表中没有的命令不要猜测调用；如果缺少预期命令，提示用户重新启用或同步微信公众号插件。

## 核心能力

- **检查连接** — `limb_invoke_tool({ nodeId: "weixin-mp", command: "weixin_mp.check_status" })`
  确认公众号是否配置并可连接。

- **Markdown 转 HTML** — `limb_invoke_tool({ nodeId: "weixin-mp", command: "weixin_mp.convert_markdown", params: { markdown } })`
  将 Markdown 转为微信兼容内联样式 HTML，写入系统临时目录并返回 `{ filePath }`。发文前必须调用。支持 `markdownFilePath` 替代 `markdown` 读取本地文件（必须在系统临时目录下，上限 2 MB）。

- **上传正文图片** — `limb_invoke_tool({ nodeId: "weixin-mp", command: "weixin_mp.upload_image", params: { fileLocation } })`
  上传图片到微信 CDN，返回可在文章正文中使用的 `{ url }`。`fileLocation` 支持 HTTP/HTTPS URL 或 OS 临时目录下的本地路径（如 `/tmp/photo.png`）。本地文件必须在系统临时目录下，其他路径会被拒绝。格式：jpg/png/gif/bmp，上限 10 MB。

- **上传封面素材** — `limb_invoke_tool({ nodeId: "weixin-mp", command: "weixin_mp.upload_material", params: { fileLocation } })`
  上传永久图片素材，返回 `{ mediaId, url }`。用作封面图的 `thumbMediaId`。同 `upload_image`，本地路径限系统临时目录，上限 10 MB。

- **创建草稿** — `limb_invoke_tool({ nodeId: "weixin-mp", command: "weixin_mp.create_draft", params: { title, content, thumbMediaId, author?, digest? } })`
  创建草稿箱文章。`content` 须是微信 HTML（先调 `convert_markdown`），`thumbMediaId` 是封面 media_id（先调 `upload_material`）。支持 `contentFilePath` 替代 `content` 传入大段内容（必须在系统临时目录下，上限 2 MB）。

- **更新草稿** — `limb_invoke_tool({ nodeId: "weixin-mp", command: "weixin_mp.update_draft", params: { mediaId, title?, content?, thumbMediaId?, author?, digest? } })`
  更新草稿箱文章，仅传需要修改的字段。支持 `contentFilePath` 替代 `content`（同上，限系统临时目录）。

- **删除草稿** — `limb_invoke_tool({ nodeId: "weixin-mp", command: "weixin_mp.delete_draft", params: { mediaId } })`
  删除草稿箱中的指定草稿。

- **发布草稿** — `limb_invoke_tool({ nodeId: "weixin-mp", command: "weixin_mp.submit_publish", params: { mediaId } })`
  将草稿发布。`mediaId` 是 `create_draft` 返回的 `media_id`。

- **查看草稿** — `limb_invoke_tool({ nodeId: "weixin-mp", command: "weixin_mp.list_drafts", params: { offset?, count? } })`
  列出草稿箱中的文章及其 media_id。

- **发布状态** — `limb_invoke_tool({ nodeId: "weixin-mp", command: "weixin_mp.publish_status", params: { publishId } })`
  查询发布任务的处理状态和文章链接。

- **素材管理** — `list_material`、`get_material_count`、`delete_material` 管理永久素材。

- **已发布文章** — `list_articles`、`delete_article` 管理已发布文章。

## 发文流程（编排示例）

发布一篇 Markdown 文章的标准步骤：

1. **冻结编辑真相源** — 从原稿提取并逐项保留：主标题、显式副标题/deck、系列名与序号、作者、摘要定位、既有封面风格。已有原稿的发布转换不能静默改题、丢副标题或抹掉系列身份。
   - 微信没有独立副标题字段：若“主标题 + 副标题”不超过标题上限，可完整写入标题；否则主标题进入 `title`，副标题必须作为正文第一屏的显式 heading/deck 保留。
   - 封面先对照同系列既有样张，再围绕本文唯一核心冲突生成。正文信息图、其他文章封面或仅仅“主题沾边”的素材不能作为静默 fallback。
2. `convert_markdown` — Markdown → 微信 HTML（返回 filePath）
3. 正文中的外部图片 → 逐个 `upload_image` → 替换为微信 CDN URL
4. `upload_material` — 上传封面图 → 得到 `thumbMediaId`
5. `create_draft` / `update_draft` — 新文章创建草稿；已有草稿原位更新，避免制造重复稿
6. `list_drafts` 回读 — 核对 media_id、完整标题、作者、摘要和封面 media_id；正文另检查系列标识与副标题仍在第一屏
7. 可选：`submit_publish` — 仅在用户明确授权正式发表时发布草稿

## 常见错误

- 忘记先调 `convert_markdown` 就直接传 Markdown 给 `create_draft`
- 文章正文中使用外部图片链接（必须先 `upload_image` 到微信 CDN）
- 混淆草稿 media_id 和发布 publishId
- 把频道转换误当成重新命题，擅自缩短原题、丢副标题或系列序号
- 生图失败后拿无关正文信息图充封面，导致封面既不聚焦本文主题、也脱离既有系列视觉
- 已有草稿仍调用 `create_draft`，留下两个近似版本；应使用 `update_draft`
- 使用旧工具名 `limb_invoke`（已更名为 `limb_invoke_tool`，需配合 `limb_list_tools` 查 schema）

## 限制

- 微信 HTML 不支持外部 CSS/JS，所有样式内联处理
- access_token 2h 过期，系统自动刷新，无需手动管理
- **本地文件限制**：所有本地文件路径（`fileLocation`、`markdownFilePath`、`contentFilePath`）必须在 OS 系统临时目录下（如 `/tmp/`）。文本文件上限 2 MB，图片文件上限 10 MB。需要上传工作区文件时，先复制到临时目录再传入路径
