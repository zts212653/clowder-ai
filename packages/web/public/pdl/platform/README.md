# platform/ — 平台适配

平台能力（剪贴板、下载、选文件、通知、窗口、主题包 YAML 的读写）接到引擎的平台口（`engine/platform.js` 的 `platformProvide`）。现在只有网页（`web.js`）；安装包只换这一层。
