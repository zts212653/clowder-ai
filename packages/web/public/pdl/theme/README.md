# theme/ — 主题

每个子目录是一整套主题：token、素材、页面定义（`views*.js`：PDL_VIEWS / PDL_ROWS / PDL_NODES）、布局（`layout.js`：容器树、入口、插槽、弹窗声明、空间）、工作台面板（`panels.js`）、配色（`palettes.js`）、还没写成 PDL 的画面（`screens.js`）、页面定义用到的文字（`copy/`）。现在只有 `default/`。

引用引擎 + 组件库；应用的数据名、动作名只写成字符串（清单见 `app/features.json`）。
