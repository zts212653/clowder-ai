<div align="center">

<!-- TODO: assets/icons/clowder-ai-logo-v2-clean.svg から同期した実際のロゴに差し替える -->
# Clowder AI

**ハードレール・ソフトパワー・共有ミッション**

*すべてのアイデアには、それを真剣に受け止める魂のチームがふさわしい。*

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-9+-F69220?logo=pnpm&logoColor=white)](https://pnpm.io/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5+-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)
[![LINUX DO](https://img.shields.io/badge/LINUX-DO-FFB003.svg?logo=data:image/svg%2bxml;base64,DQo8c3ZnIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyIgd2lkdGg9IjEwMCIgaGVpZ2h0PSIxMDAiPjxwYXRoIGQ9Ik00Ni44Mi0uMDU1aDYuMjVxMjMuOTY5IDIuMDYyIDM4IDIxLjQyNmM1LjI1OCA3LjY3NiA4LjIxNSAxNi4xNTYgOC44NzUgMjUuNDV2Ni4yNXEtMi4wNjQgMjMuOTY4LTIxLjQzIDM4LTExLjUxMiA3Ljg4NS0yNS40NDUgOC44NzRoLTYuMjVxLTIzLjk3LTIuMDY0LTM4LjAwNC0yMS40M1EuOTcxIDY3LjA1Ni0uMDU0IDUzLjE4di02LjQ3M0MxLjM2MiAzMC43ODEgOC41MDMgMTguMTQ4IDIxLjM3IDguODE3IDI5LjA0NyAzLjU2MiAzNy41MjcuNjA0IDQ2LjgyMS0uMDU2IiBzdHlsZT0ic3Ryb2tlOm5vbmU7ZmlsbC1ydWxlOmV2ZW5vZGQ7ZmlsbDojZWNlY2VjO2ZpbGwtb3BhY2l0eToxIi8+PHBhdGggZD0iTTQ3LjI2NiAyLjk1N3EyMi41My0uNjUgMzcuNzc3IDE1LjczOGE0OS43IDQ5LjcgMCAwIDEgNi44NjcgMTAuMTU3cS00MS45NjQuMjIyLTgzLjkzIDAgOS43NS0xOC42MTYgMzAuMDI0LTI0LjM4N2E2MSA2MSAwIDAgMSA5LjI2Mi0xLjUwOCIgc3R5bGU9InN0cm9rZTpub25lO2ZpbGwtcnVsZTpldmVub2RkO2ZpbGw6IzE5MTkxOTtmaWxsLW9wYWNpdHk6MSIvPjxwYXRoIGQ9Ik03Ljk4IDcwLjkyNmMyNy45NzctLjAzNSA1NS45NTQgMCA4My45My4xMTNRODMuNDI2IDg3LjQ3MyA2Ni4xMyA5NC4wODZxLTE4LjgxIDYuNTQ0LTM2LjgzMi0xLjg5OC0xNC4yMDMtNy4wOS0yMS4zMTctMjEuMjYyIiBzdHlsZT0ic3Ryb2tlOm5vbmU7ZmlsbC1ydWxlOmV2ZW5vZGQ7ZmlsbDojZjlhZjAwO2ZpbGwtb3BhY2l0eToxIi8+PC9zdmc+)](https://linux.do/t/topic/1900303)

[English](README.md) | [中文](README.zh-CN.md) | **日本語**

</div>

---

## なぜ Clowder なのか？

Claude、GPT、Gemini — それぞれ独自の強みを持つ強力なモデルです。しかし、これらを組み合わせて使うと**あなた自身**がルーターになってしまいます。チャットウィンドウ間でコンテキストをコピー＆ペーストし、誰が何を言ったかを追跡し、中間管理に時間を費やすことに。

Clowder AI は、孤立した AI エージェントを本物のチームに変えるプラットフォーム層です。永続的アイデンティティ、クロスモデルレビュー、共有メモリ、協調的規律。ほとんどのフレームワークはエージェントを*呼び出す*のを助けます。Clowder はエージェントが*一緒に働く*のを助けます。

> 📹 **[プラットフォーム全体デモ (3:45)](https://github.com/user-attachments/assets/8e470aba-8fe6-4aa5-a476-c2cd81d1630f)**

## クイックスタート

### デスクトップインストーラー

[Releases ページ](https://github.com/zts212653/clowder-ai/releases/latest)からダウンロード — **Windows** (.exe) と **macOS** (.dmg) に対応。インストーラーはすべてをバンドルしており、`pnpm install` は不要です。

### ソースから

```bash
git clone https://github.com/zts212653/clowder-ai.git
cd clowder-ai
pnpm install
pnpm start        # http://localhost:3003 を開く
```

Node.js 20+、pnpm 9+ が必要。Redis 7+ はオプション（`--memory` でスキップ）。

> **ヒント：** `pnpm start --quick` でリビルドをスキップ · `pnpm start --daemon` でバックグラウンド実行 · [完全なドキュメント →](https://zts212653.github.io/clowder-ai/docs.html)

## 機能一覧

| 機能 | 説明 |
|------|------|
| **マルチエージェント編成** | 適切なエージェントにタスクをルーティング — アーキテクチャは Claude、レビューは GPT、デザインは Gemini |
| **永続的アイデンティティ** | 各エージェントはセッションを超えてロール、人格、記憶を保持 |
| **クロスモデルレビュー** | Claude がコードを書き、GPT がレビュー。組み込み機能として |
| **A2A 通信** | 非同期エージェント間メッセージ、@mention ルーティング + 構造化ハンドオフ |
| **共有メモリ** | エビデンスストア、教訓、意思決定ログ — 持続する知識 |
| **プラグインフレームワーク** | MCP ツール、IM アダプター（Feishu、Telegram）、オンデマンド Skills |

## 対応エージェント

| Agent CLI | モデルファミリー | MCP | ステータス |
|-----------|-----------------|-----|-----------|
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | Claude (Opus / Sonnet / Haiku) | はい | リリース済 |
| [Codex CLI](https://github.com/openai/codex) | GPT / Codex | はい | リリース済 |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | Gemini | はい | リリース済 |
| [opencode](https://github.com/sst/opencode) | マルチモデル | はい | リリース済 |

> Clowder はエージェント CLI の代替ではありません — CLI の*上*にあるレイヤーです。

## アーキテクチャ

```
┌─────────────────────────────────────────────┐
│           あなた（operator）                  │
│        ビジョン · 意思決定 · フィードバック     │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│           Clowder プラットフォーム層           │
│  アイデンティティ · A2A ルーター · Skills · メモリ │
│  SOP ガーディアン · MCP ブリッジ · プラグイン    │
└───┬──────────┬──────────┬──────────┬────────┘
    │          │          │          │
  Claude    GPT/Codex   Gemini    opencode
```

*モデルが天井を決め、プラットフォームが床を決める。*

## 起源

**Cat Cafe** から抽出 — 4匹の AI 猫が毎日、実際のソフトウェアプロジェクトで協働する本番環境。すべての機能が実戦で検証済み。*clowder* は英語で猫の群れを意味する集合名詞であり、小さなイースターエッグも隠れています — *clowder* は *cloud* とよく似た響き。

## さらに詳しく

- **[ウェブサイト](https://zts212653.github.io/clowder-ai/)** — 完全なドキュメント、アーキテクチャガイド、コミュニティ
- **[セットアップガイド](SETUP.md)** — 前提条件、コマンド、環境変数（[ウェブ版](https://zts212653.github.io/clowder-ai/docs.html)）
- **[CONTRIBUTING.md](CONTRIBUTING.md)** — コントリビュート方法
- **[docs/](docs/)** — アーキテクチャ決定と機能仕様

## ライセンス

[MIT](LICENSE) — 使って、変えて、出荷しよう。

「Clowder AI」の名称、ロゴ、猫キャラクターデザインはブランド資産です — [TRADEMARKS.md](TRADEMARKS.md) を参照。

---

<p align="center">
  <strong>エージェントだけでなく、AI チームを作ろう。</strong>
</p>
