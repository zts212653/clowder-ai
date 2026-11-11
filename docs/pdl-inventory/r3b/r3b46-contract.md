# r3b46–r3b47：原始数据契约对齐

差集逐项结果、绑定文件、动作、文案建议及复制层缺口见 [r3b46-contract-diff.json](r3b46-contract-diff.json)。75 条 VM 记录（74 条有字段变化）、32 个新增动作和 64 个登记变化均已核对；pcfCatalog 不绑定，mkOpenUi / wsFlag 不模拟写入。
## 按层改动

- 引擎／组件／主题 PDL：0 改动；runtime.ts 只使用复制的 load-order.json；后端与依赖：0 改动。
- 应用：chat/sidebar/inbox、工作台、设置／成员／账号／规则／插件各 owner 输出原始状态、数字、时间、身份、路径和 Markdown；旧显示字段、MENU_FNS／DIALOGS 显示构造移交给已复制声明。
- 文案：删除 pdl-app/copy/ 的八份文件及 runtime 登记；tc 只用于 toast／字段错误；产品专有文案键列在 JSON，未写回应用文字。
- 正文：chat.js 按 mid + Markdown 缓存 library.msgMd 的结果，主题读取 HTML；没有第二个 Markdown renderer。
- 动作：capRestart → settingsPluginRestart → 原有 repair 接口，保留 expectedRevision；撤掉 capRepair。新增表单动作传原始 args、等待真实 writer，保留进行中、拒绝原因和重试草稿。
- 宿主：保留 push／held snapshot 与按投影读取；草稿通过局部 composer 路径恢复；新对话不再用 cwd 隐式选项目；删除 cafeHistComplete 的死分支。
- 身份：所有者 lead 按原型给 {name,color:primaryHex}，修改别名保留原 primary / secondary；头像色没有宿主 CSS。
- 两个入口：cafeAutoClassify 打开审核弹层再调用现有 clSuggest；cafeAttach 把真实选中文件交给现有 attach 口。
## 看得见的变化与 r3b45 复核

| 区域 | 结果 |
|---|---|
| 消息正文／执行 | whole_body_replaced 的完整回复回到正文；真实工具输入、结果、resultMeta 保留在执行记录。 |
| 中间折叠 | 给 bodyLength / relayed，折叠形状与实际行高由主题／组件决定。 |
| 草稿 | 恢复文字、图片、引用，侧栏 draft 标记；普通打字仍不渲染消息流。 |
| 新对话项目 | 未选择时保持未选；已保存的显式项目恢复；chip 用项目名，pathCopy 用绝对路径。 |
| 图片 | 用户图片和 gallery 均给 cards.items[].src，让同一图片组件生成 preview；未量测 3013 的自然高度，不能宣称像素留白已验收。 |
| 插件详情 | 给原始多语言描述、README、contributions/tools、need/update 状态；重启使用原 revision guard。 |
| 表单／菜单 | 按新主题真实入口测试，不再读取旧 MENU_FNS 和 DIALOGS；文件权限、审阅坐标、选择块 id、writer 拒绝行为仍受测试。 |
## 测试断言的变化（未删除真实行为）

| 之前 | 现在 |
|---|---|
| 拼接状态／时间／tone 字符串 | 原始 status/count/timestamp/error；真实写入与复制后结果继续断言。 |
| 直接调用旧菜单／对话框构造器 | 从复制声明的触发器打开，校验 items/args、等待与拒绝后重试。 |
| rich/media 的旧 pick 对象 | 原始 canPick/project/screening/annotationId，原 writer 和 CAS 不变。 |
| 字典箭头、候选通知等显示文字 | a/b、materialized/status 原始回执及撤销 writer。 |
| 成员深拷贝嵌套对象按引用算 dirty | 比较字段值；修改两处仍严格断言 dirty=2。 |
| 修改别名不能覆盖所有者颜色 | 保留原断言，按原型的身份结构给 lead；保存仍为原 primary / secondary。 |
| 正文／重启缺少本轮行为验证 | 新增 msgMd 一次缓存、capRestart revision、真实内容和草稿恢复、分类／附件入口验证。 |
## 复制层尚缺的声明／组件

1. glyph / 插件 who 只接 icon key，没有原始 package image 的铺满头像口；旧组件使用同源 img 覆盖容器。当前仍经一个 SVG image 登记，不声称已修复白边或失载；没有另写头像或 CSS。
2. 真正的产品表单缺 dlg.fileOverwrite / queueRecallAppend / nativeReviewTarget / routingPreferenceRetire；应用只给 kind/args，没有自造 fields。
3. 成员 select 的 cxSandbox/cxApproval/vLang/speed/agyPerm 仍含翻译后的 option value；应用保留真实 enum。DSH provider.error 没有读取它的主题元素。
4. sources.fetchRes 主题仍按字符串画，但真实接口给结构化计数；pushDiag.result 仍读 label/value/tone，应用给原始 kind/message（拒绝原因仍走 dialog.error）。
5. 插件权限文案键已在主题里，但 pcf label 不解 t: 键；真实贡献种类、拉取汇总和上述确认文字的建议键、zh、位置在 JSON。
6. mkOpenUi 在原型是空动作，主题在 manual_ui 安装方案仍画按钮；未登记假安装。wsFlag 后端只读，选项 locked，不登记写动作；pcfCatalog 是组件目录演示，无产品入口。
## 检查原文

tsc --noEmit --incremental false：无输出，退出 0。原 65 条失败现为 0；检查原文：
```text
 Test Files  67 passed (67)
      Tests  645 passed (645)
Checked 78 files in 778ms. No fixes applied.
Found 2536 warnings.
Found 302 infos.
Biome exit: 0
Project public runtime privacy-grep: 0
Copied layer changed files: 0
pdl-app/copy files: 0
```

未提交／push，未修改 .env，未启停服务，未读取 .cat-cafe 或 *.local.js。未跟踪的本报告与差集 JSON 是交付文件，留给本轮一起提交。
