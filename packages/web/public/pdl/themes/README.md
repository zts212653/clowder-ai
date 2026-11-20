# themes/ — 内置主题包

每个子目录是一个主题包，和用户导入的包是同一种格式：`theme.yaml`（身份、`pdl`、素材说明 `assets`）、`i18n/<语言>/*.json`、`assets/<素材 id>.<扩展名>`、`components/<组件包 id>/*.js|css`。

宿主用同一套规则读两个地方：这里（内置，随代码发布，不能导入覆盖或卸载）和项目的 `.cat-cafe/console-themes/`（用户导入的）。`default` 是底包，界面先读它，再读当前选用的包。
