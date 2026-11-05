# Clowder AI 插件开发与本地安装

插件可以是独立项目，不必放进官方插件仓，也不必先发布到 npm。

## 开发与声明

1. 在自己的项目中安装所需的 `@clowder-ai/plugin-sdk`，按该版本公开 API 实现插件；保留依赖版本与锁文件。
2. 在插件包根目录提供 `package.json` 和 `plugin.yaml`，声明插件身份、版本、运行入口、功能、所需能力及配置。配置字段、引导和操作由声明驱动；仅声明插件真正支持的功能。
3. 按项目自己的构建命令生成运行入口与资源。在 `package.json` 的发布文件中包含声明、编译产物、图标等实际运行文件；声明的版本、入口和依赖应与目录里的实际文件一致。

完整字段与公开 API 以对应版本的 Contract 和 SDK 为准：

- SDK：https://github.com/zts212653/clowder-ai-plugins/tree/main/packages/plugin-sdk
- Contract：https://github.com/zts212653/clowder-ai-plugins/tree/main/packages/plugin-contract
- 官方插件示例：https://github.com/zts212653/clowder-ai-plugins/tree/main/packages

SDK 是插件自己的依赖；Host 产品版本不是 SDK 依赖版本。不要因为 Host 更新就替换已声明的 SDK。能力声明是请求，实际可用能力仍以 Host 授权为准。

## 面向用户的说明

一个插件共用一份 `plugin.yaml`、插件 ID、版本与能力声明。短描述可使用 `default` 与 `translations.zh-CN` 提供中文简介；不要为中英文复制两套插件。

包根的 `README.md` 使用中文，插件管理的详情页默认读取它。需要英文说明时，另附 `README.en.md`，两份文档可互相链接；在 `package.json` 的 `files` 中包含这些文档。当前没有 README 自动语言选择，英文文件不会自动替换详情页的中文说明。Git 插件仓的发现详情同样读取包根 `README.md`。

能力页展示 MCP、Skill、定时任务、Agent 可调用工具、Limb 和用户界面等功能。HTTP 路由、消息来源身份、终态校验器等内部贡献仍应如实声明，但不作为普通用户能力清单展示。请在 README 中说明功能用途、配置方法和必要限制，不把内部路由 ID 当作安装步骤。

## 本地安装测试

在运行 Hub 的电脑上完成依赖安装与构建。打开「插件管理 → 从本地目录安装」，选择包含 `plugin.yaml` 和 `package.json` 的插件包根目录。独立项目选项目根目录；多包仓库选具体插件目录。

Host 会校验声明、入口和实际依赖，并保存独立的安装制品。修改源码目录不会直接改动已经安装的插件。安装、配置和启用是不同操作：先填写配置，再按需要启用并验证插件的实际功能。

使用页面里的目录浏览器选择路径即可，无需把 Windows 路径改写为 Unix 路径。这里的目录属于运行 Hub 的电脑。

修改已安装插件时，保留同一个 `pluginId`，更新版本、构建后再次选择目录安装。Host 会替换安装制品，保留插件配置、数据与启用意图；无需先卸载。所需配置不完整或新版本启动失败时，页面会显示真实状态。

## 放入扩展插件仓库

团队仓库按 `packages/<插件目录>/plugin.yaml` 与 `package.json` 组织插件。用户在「插件管理 → 齿轮」添加仓库地址与分支；留空分支使用仓库默认分支。Host 使用本机 Git 访问配置。

打开插件管理时检查仓库更新，读取插件声明并刷新可安装列表。发现阶段不运行仓库脚本。用户选择安装后，Host 准备所选仓库中的依赖和构建，再走同一本地目录安装流程。当前扩展仓库准备使用 pnpm workspace 的冻结锁文件安装与目标包构建，因此请提交匹配的 workspace 配置和锁文件。

官方主分支的发布目录仍使用 npm 制品安装。扩展仓不需要发布到公网 npm；仓库刷新也不会自动升级已安装插件。
