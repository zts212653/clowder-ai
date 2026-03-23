---
topics: [backlog]
doc_kind: note
created: 2026-03-20
---

# Feature Roadmap

> **Rules**: Only active Features (idea/spec/in-progress/review). Move to done after completion.
> Details in `docs/features/Fxxx-*.md`.

| ID | Name | Status | Owner | Link |
|----|------|--------|-------|------|
| #184 | Bug: 切换会话后未发送的输入草稿丢失 | idea | — | [issue](https://github.com/zts212653/clowder-ai/issues/184) |
| #189 | Bug: 账户配置应默认全局而非项目级 | in-progress | @opus | [issue](https://github.com/zts212653/clowder-ai/issues/189) |
| #190 | Feature: Provider-Model-Member 配置架构重构 | idea | — | [issue](https://github.com/zts212653/clowder-ai/issues/190) |

## 提交顺序说明

- **#189 先行独立 PR**：将 provider-profiles 改为全局默认（`~/.cat-cafe/`），作为独立 bugfix 提交。已有项目级配置会在首次读取时自动迁移到全局路径。当前改法存在跨项目引用配置的局限（所有项目共享同一套 provider），后续由 #190 通过 provider scope 机制解决。
- **#190 依赖 #189**：provider-model-member 架构重构，按 client+model 维度管理成员，支持 provider scope（全局 vs 按项目 tag），需在 #189 合入后再开工。
