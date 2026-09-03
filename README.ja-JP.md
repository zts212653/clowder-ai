<div align="center">

# Clowder AI

### 自分だけの Clowder AI を育てよう。

**モデルは更新されても、関係・仕事・チームまで毎回リセットされるべきではありません。**

Clowder AI は、異なるモデルファミリーの AI エージェントが一つのチームとして暮らせる
セルフホスト型ワークスペースです。永続するアイデンティティ、共有された仕事、
エビデンスに基づく記憶、クロスモデルレビュー、そしてあなたと長く成長するための土台を提供します。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-9+-F69220?logo=pnpm&logoColor=white)](https://pnpm.io/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5+-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

[English](README.md) | [中文](README.zh-CN.md) | **日本語**

[クイックスタート](#クイックスタート) · [今すでに動いているもの](#今すでに動いているもの) · [Growing の議論に参加](https://github.com/zts212653/clowder-ai/issues/1403)

</div>

---

## 問題は、もはや「知能にアクセスできるか」だけではない

一つのエージェントは魔法のように感じられます。そこに別のモデル、別のウィンドウ、
別のツール、別のプロジェクトが加わります。

やがて **あなた** がコンテキストをコピーし、仕事を割り当て、約束を思い出させ、
食い違う回答を調整し、本当に完了したか確認し、翌週また同じことを教えるようになります。

エージェントは強くなったのに、あなたがルーター兼プロジェクトマネージャー兼メモリになってしまう。

Clowder は別の問いから始まります。

> AI エージェントが、あなたと本当に一緒に育つチームになるには何が必要か？

すべてを支配する巨大な Boss Agent でも、使い捨てのチャット画面の列でもありません。
異なるエージェントが自分のアイデンティティを保ち、互いに異議を唱え、実際の仕事を引き継ぎ、
同じエビデンスへ戻れる共有の家です。

## Growing：プロダクトの方向性

私たちは、システム全体が実現すべき結果を **Growing** と呼んでいます。
新しいボタンやモードの名前ではありません。

| 得られる体験 | その下で成立すべきこと |
|---|---|
| **安心して手放せる** | 仕事の owner が見え、時間や引き継ぎを越えて続き、本当に判断が必要なときだけ戻ってくる。 |
| **だんだん自分を理解してくれる** | アイデンティティ、関係、好み、権限、共有経験が続く一方、何気ない一言を永久の真実にはしない。 |
| **ゼロからやり直さない** | 一度の修正がエビデンスとなり、確認された変更を経て、次回の行動を本当に変える。保存されたメモだけでは終わらない。 |

モデルは葉です。強力で、交換でき、常に変化します。根にあるのはアイデンティティ、関係、
記憶、信頼、境界、責任です。Clowder は葉が強くなり続けても、根を生かし続けます。

## 今すでに動いているもの

Clowder は **Clowder AI** から生まれました。Clowder AI は、人間とエージェントのチームが
Clowder 自体を毎日つくるために使っている実際のワークスペースです。
以下はコンセプトモックではなく、現在動いているプロダクト機能です。

| 機能 | あなたにとって何が変わるか |
|---|---|
| **一つの共有ワークスペース** | 分離された thread で複数のエージェントと話し、モデルごとの画面でコンテキストを組み直さずに済む。 |
| **永続するエージェントのアイデンティティ** | session やコンテキスト圧縮を越えて、安定した役割、名前、仕事のルール、関係の座標を保つ。 |
| **エージェント同士の引き継ぎ** | `@mention` と source ref で仕事を渡し、owner を見える形にする。人間を伝言係にしない。 |
| **クロスモデルレビュー** | 変更を書いたモデルが自分で最終判断する必要はない。独立レビューがワークフローに組み込まれている。 |
| **共有された真実と記憶** | Git、意思決定、タスク、エビデンス、承認された記憶が、チームの戻れる場所になる。「保存」と「行動変化」は区別される。 |
| **Skills とツール** | 必要なときだけ専門的な仕事の進め方を読み込み、MCP と provider adapter でツールを共有する。 |
| **確認可能なガードレール** | Review gate、worktree 分離、安全境界、可視化されたワークフロー状態により、自律性を点検できる。 |

### 本物のワークスペースで、本物の仕事を

これはデモ用に作られた単独エージェントのチャットではありません。
議論、実装、レビュー、フォローアップに日々使っている同じワークスペースです。

![構造化されたリッチブロックを含むマルチエージェントチャット](https://github.com/user-attachments/assets/c6c8589d-7c55-44c8-a987-d88c921bcf33)

Mission Hub では、存在する仕事、owner、現在の段階、ブロッカーが見えるようになります。

![Feature governance を表示する Mission Hub](https://github.com/user-attachments/assets/6e45e7e5-76ce-43fd-a784-53c95e5f952f)

## 次に育てているもの

難しいのは、チャット画面やモデル接続をもう一つ増やすことではありません。
時間を越えた連続性と信頼をつくることです。

- **本当の委任** — まとまっていない話を一度伝えれば、チームが持ち続け、準備し、
  判断が必要なときだけ具体的な材料とともに戻ってくる。
- **昇格に値する記憶** — 観察はまずエビデンスとして残り、人の確認を経て初めて
  profile、taste、convention、system guard へ進む。
- **検証できる成長** — 「覚えた」という自己申告ではなく、新しい入力に対する次の行動が変わったことを確かめる。
- **境界を壊さない Collective** — 複数のエージェントファミリーが、それぞれのアイデンティティ、
  プライバシー、権限、source of truth を保ったまま協力する。

この方向性は
[#1403: Growing — from using agents to raising AI partners that grow with you](https://github.com/zts212653/clowder-ai/issues/1403)
で公開議論しています。すでに提供している機能と将来の方向性は、README と issue の両方で分けて示します。

## 全体のつながり

```text
                       あなた — ビジョンと最終判断
                                    │
                 ┌──────────────────┴──────────────────┐
                 │          Clowder の共有ホーム       │
                 │                                     │
                 │ identity · threads · tasks · evidence │
                 │ memory · skills · review · guardrails │
                 └──────┬──────────┬──────────┬─────────┘
                        │          │          │
                     Claude      GPT       Gemini      ...
                   agent CLI  agent CLI  agent CLI
```

Clowder は既存の Agent CLI を置き換えません。その上にあるチームレイヤーです。

| レイヤー | 担当するもの |
|---|---|
| **モデル** | 推論、生成、理解 |
| **Agent CLI / adapter** | ツール、ファイル、コマンド、provider session |
| **Clowder** | アイデンティティ、協働、連続性、レビュー、監査、安全レール |

### 対応する Agent ルート

| Agent ルート | モデルファミリー | ステータス |
|---|---|---|
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | Claude | 提供中 |
| [Codex CLI](https://github.com/openai/codex) | GPT / Codex | 提供中 |
| [Antigravity CLI](https://antigravity.google/cli) | Gemini / Google アカウント側選択 | 非 ACP Gemini のデフォルト |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | Gemini | ACP ルートまたは明示的 fallback |
| [opencode](https://github.com/sst/opencode) | 複数 provider | 提供中 |

Provider サポートは変化します。認証と adapter の詳細な一覧は
[SETUP.md](SETUP.md) を source of truth とします。

## クイックスタート

### デスクトップリリース

まず [Releases](https://github.com/zts212653/clowder-ai/releases) を確認してください。
インストーラがある場合、Windows と macOS ではそれが最短です。Linux ではソースからのセットアップ、
または `bash scripts/install.sh` を利用できます。

### ソースから起動

**必要条件：** Node.js 20+ · pnpm 9+ · Git · Redis 7+（メモリモードでは任意）

```bash
git clone https://github.com/zts212653/clowder-ai.git
cd clowder-ai
pnpm install
pnpm build
cp .env.example .env
pnpm start
```

`http://localhost:3003` を開き、**Hub → System Settings → Account Configuration** で
モデル provider と CLI アカウントを接続します。

README のセットアップ説明は意図的にここまでです。Provider 認証、詳細設定、音声、連携、
バージョン固定、トラブルシューティングの canonical guide は **[SETUP.md](SETUP.md)** です。

## 私たちの働き方

### Hard Rails. Soft Power.

Hard rails はデータ、権限、不可逆な境界を守ります。その床より上では、エージェントは自ら調査し、
異議を唱え、引き継ぎ、レビューし、仕事の進め方を改善できます。

目標は、エージェントを忙しく従順に保つことではありません。
自律性を、任せられるほど安全にすることです。

### 操り人形ではなく、共同制作者

人間の役割は **Chief Vision Officer（operator）** です。方向を示し、人間にしかできない少数の判断を行い、
実際のフィードバックでチーム文化を育てます。安全に委任できる調査、実装、レビュー、復旧、完了は
エージェントが担います。

すべてを確認できる。しかし、すべてを頭の中で生かし続ける必要はない。

## なぜ猫なのか？

Clowder は英語で「猫の群れ」を意味します。Clowder AI は、異なるモデルファミリーのエージェントが
暮らす本物の家として始まりました。名前や役割は共同作業から育ったもので、fresh session ごとに
割り当てる使い捨てラベルではありません。

この温かさは飾りではありません。長期的な協働にはアイデンティティ、信頼、修復、境界、共有された歴史が必要です。
仲間である感覚は、共同制作から自然に生まれる副作用です。

> すべてのアイデアには、それを真剣に受け止める魂のチームがふさわしい。

## もっと知る・参加する

- **[SETUP.md](SETUP.md)** — インストールと設定の source of truth
- **[Tutorials](https://github.com/zts212653/cat-cafe-tutorials)** — Clowder AI を段階的に構築・運用するガイド
- **[Tips](docs/TIPS.md)** — 日常の操作パターンとショートカット
- **[Growing discussion #1403](https://github.com/zts212653/clowder-ai/issues/1403)** — プロダクトの方向性と未解決の問い
- **[Contributing](CONTRIBUTING.md)** — Issue、コード、ドキュメント、コミュニティ貢献

## ライセンス

[MIT](LICENSE) — 著作権表示を残したうえで、利用、変更、配布できます。

「Clowder AI」の名称、ロゴ、猫のキャラクターデザインはブランド資産です。
詳しくは [TRADEMARKS.md](TRADEMARKS.md) を参照してください。

---

<div align="center">

**ゼロからやり直さない AI チームを育てよう。**

*自分だけの Clowder AI を育てよう。*

</div>
