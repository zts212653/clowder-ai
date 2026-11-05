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

### 30 秒でわかる、ひとつの機能

どのデモも、Clowder AI を作っているチームで実際に交わされた会話の再現です。見たら、同じことをあなたの猫に話しかけてみてください。

<details>
<summary><b>新しい会話の提案</b> — 大きな仕事を猫のチームに任せる · 0:48</summary>

[![新しい会話の提案デモ：5 枚の提案カードが承認され、作業が始まる](site/assets/demos/conversation-proposals.jpg)](https://zts212653.github.io/clowder-ai/#demos)

猫が大きな仕事をいくつかの流れに分け、それぞれに「何を・なぜ・誰が」を書いたカードを作ります。承認すれば新しい会話が開き、断れば猫が直して出し直します。[デモを見る（英語字幕）](https://zts212653.github.io/clowder-ai/#demos) · コミュニティの issue [#82](https://github.com/zts212653/clowder-ai/issues/82) から生まれた機能です

</details>

<details>
<summary><b>同じバグ、ふたつの結末</b> — Claude Code のセッションをカフェに持ち込む · 0:48</summary>

[![同じバグ、ふたつの結末：Claude Code だけでは作業が止まり、カフェでは続く](site/assets/demos/same-bug.jpg)](https://zts212653.github.io/clowder-ai/#demos)

Claude Code だけで作業していると、利用上限に達したら何時間も待つしかありません。そのセッションを Clowder AI に持ち込めば（新しい会話 → Connect an existing local session）、猫はそれまでの経緯をすべて覚えていて、別の猫も呼べます。また上限に達しても、作業は別の猫に引き継がれて止まりません。[デモを見る（英語字幕）](https://zts212653.github.io/clowder-ai/#demos) · 引き継ぎ機能はコミュニティ貢献者 [@mindfn](https://github.com/mindfn) の [#1398](https://github.com/zts212653/clowder-ai/pull/1398) から

</details>

<details>
<summary><b>終わるまで待たなくていい</b> — 返答中の猫に追加の指示を出す · 0:36</summary>

[![終わるまで待たなくていい：作業中の猫に丸で囲んでひとこと、旧版と新版を並べて比較](site/assets/demos/steer.jpg)](https://zts212653.github.io/clowder-ai/#demos)

猫が修正している最中に、もう一か所気づいたら：入力欄の + メニューで今の返答を誘導するよう切り替え、画面の該当箇所を丸で囲み、ひとこと添えて送ります。猫は同じターンの中で受け取り、旧版と新版を並べて見せてくれます。[デモを見る（英語字幕）](https://zts212653.github.io/clowder-ai/#demos)

</details>

<details>
<summary><b>決めきれないなら、まず別々に考えて投票</b> — expert panel、unknown-first、/vote · 0:47</summary>

[![決めきれないなら、まず別々に考えて投票：3 匹の猫がそれぞれ考え、最後に投票。あなたの案も候補に入る](site/assets/demos/panel-vote.jpg)](https://zts212653.github.io/clowder-ai/#demos)

迷ったら「expert panel」と言えば、猫たちはまずそれぞれ別々に考え、あなたの案もひとつとして並べます。それでも意見が割れたら「unknown-first」と言うと、結論をいちばんひっくり返しそうな未知から確かめます。まだ決まらなければ /vote で猫に投票してもらいます。あなたの案も候補に入りますが、勝つとは限りません。[デモを見る（英語字幕）](https://zts212653.github.io/clowder-ai/#demos)

</details>

<details>
<summary><b>私たちが眠っていた 10 時間</b> — 定期タスクと GitHub イベント · 0:55</summary>

[![私たちが眠っていた 10 時間：チームは眠り、2 匹の猫が引き継ぎながら作業を続ける](site/assets/demos/while-we-slept.jpg)](https://zts212653.github.io/clowder-ai/#demos)

10 月 22 日の実際の一晩：チームは全員眠っていました。定期タスクが 2 時間ごとに 1 匹の猫を起こしてオープンソース版への同期を進め、コミュニティの PR に新しいコミットが来たり CI が失敗したりすると、GitHub がもう 1 匹を起こしてレビューや修正に向かわせます。2 匹は互いに引き継ぎ、朝には 37 件の PR がマージされていました。[デモを見る（英語字幕）](https://zts212653.github.io/clowder-ai/#demos) · その夜のコミュニティ貢献者 [mindfn](https://github.com/mindfn), [amazing-fish](https://github.com/amazing-fish), [EdgarR1170](https://github.com/EdgarR1170), [whutzefengxie-ops](https://github.com/whutzefengxie-ops) に感謝

</details>

<details>
<summary><b>一夜で、一枚の布に</b> — 9 匹の猫、49 の会話、ひと晩 · 0:53</summary>

[![一夜で、一枚の布に：会話ごとに灯る 49 の窓と、窓どうしをつなぐ糸](site/assets/demos/woven-night.jpg)](https://zts212653.github.io/clowder-ai/#demos)

10 月 22 日の実際の一晩：あなたが眠っているあいだに、4 系統 9 匹の猫が 49 の会話で作業し、262 回仕事を引き継ぎました。窓ひとつが会話ひとつ、引き継ぐたびに糸が一本伸びます。朝には一晩の糸が一枚の布になり、布の上の 37 個の結び目が、マージされた 37 件の PR です。[デモを見る（英語字幕）](https://zts212653.github.io/clowder-ai/#demos)

</details>

<details>
<summary><b>数件選んで、どこへでも</b> — 複数選択・エクスポート・転送 · 0:49</summary>

[![数件選んで、どこへでも：選んだ 3 件のメッセージから「ドキュメント」「長い画像」「転送」の線がそれぞれの行き先へ伸びる](site/assets/demos/bundles.jpg)](https://zts212653.github.io/clowder-ai/#demos)

メッセージを一度選べば、行き先ごとに持っていけます。同僚に見せるなら長い画像、自分で残すなら Markdown ドキュメント（メールに貼るならテキスト）。別の猫に任せるなら相手の会話へ転送：猫を選んでひとこと添えると、まとめカードが届き、猫が起こされて続きを始めます。[デモを見る（英語字幕）](https://zts212653.github.io/clowder-ai/#demos)

</details>

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
