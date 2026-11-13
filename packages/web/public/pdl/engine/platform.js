/* 边界：引擎只放机制与时机，不认任何具体名字、不为单个位置打补丁 */
/* 平台口（引擎）：引擎要用到的平台能力只经这里——网页 / 安装包（桌面）只换平台这一层（platform/）。
   平台层加载时登记自己的实现：platformProvide({ … })；没登记的能力是空操作。
     clipboard(文字)        写进剪贴板（不可用时静默）
     download(文件名, 文字或 {url}, 类型)   下载文件或生成文本文件（网页：浏览器下载）
     pickFile(accept, fn)   选一个文件（网页：文件选择器；fn(File)）
     pickFiles(accept, fn)  选多个文件（fn(File[])）
     assets.get(id) / assets.put(id, descriptor) / assets.remove(id)  本地用户素材的异步读写及删除（src 为可直接使用的短 URL）
     notify(标题, 正文)      系统通知
     richRender(kind, 源文本, inline)  正文里的公式（math）/ Mermaid 图（mermaid）画成 HTML，返回 Promise（没登记时拒绝：正文显示源文本）
     terminal(节点, 选项)    在节点里开一个终端（终端仿真由平台的终端库做），返回 Promise<终端>：write(数据) / reset() / set(选项) / fit() / onData(fn) / onResize(fn) / dispose()（没登记时拒绝）
     packRead(File) / packSave(文件名, 对象)  主题包（zip：theme.yaml + components / i18n / assets）：读成一个对象、写成 zip 下载——zip 和 YAML 只在平台层，引擎只拿到对象（没登记时拒绝 / 空操作）
     window(动作)           窗口（安装包：最小化、全屏……；网页：无）
 */
'use strict';
const PLATFORM = { clipboard: function () {}, clipboardImage: function () { return Promise.reject(); }, download: function () {}, pickFile: function () {}, pickFiles: function () {}, notify: function () {}, window: function () {}, richRender: function () { return Promise.reject(); }, terminal: function () { return Promise.reject(); }, packRead: function () { return Promise.reject(); }, packSave: function () {} };
function platformProvide(impl) { Object.assign(PLATFORM, impl); }
