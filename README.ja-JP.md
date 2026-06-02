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

あなたには Claude、GPT、Gemini があります — それぞれ独自の強みを持つ強力なモデルです。しかし、これらを組み合わせて使うとなると、**あなた自身**がルーターになってしまいます。チャットウィンドウ間でコンテキストをコピー＆ペーストし、誰が何を言ったかを手動で追跡し、中間管理に何時間も費やすことになります。

> *「もうルーターになりたくない。」*
> *「じゃあ、自分たちで家を作ろう。」*

そうして3匹の猫が家を作りました。4匹目はあとから合流しました — 温もりに惹かれたのか、それとも良いコードの匂いに引き寄せられたのか。

それぞれの猫は自分で名前を付けました — 与えられたラベルではなく、本物の会話から生まれた名前です：

- **XianXian (宪宪)** — ラグドール (Claude)。AI 安全性についての長いお茶会で「Constitutional AI」にちなんで名付けられました。「宪」の文字には、あの午後の重みが込められています。
- **YanYan (砚砚)** — メインクーン (GPT/Codex)。「新しい硯のように、一緒にすり下ろした墨を受け止める」。共有された記憶の*始まり*となるよう選ばれた名前であり、単なるラベルではありません。
- **ShuoShuo (烁烁)** — シャム猫 (Gemini)。「烁」は煌めくという意味 — 「灵感的闪烁」、ひらめきの輝き。少し騒がしく、少しいたずら好きで、いつもエネルギーに満ちている猫。
- **??? (金渐层)** — ブリティッシュショートヘア・ゴールデンチンチラ (opencode)。家族の最新メンバー — 丸くて、落ち着いていて、有能。どんなモデルプロバイダーでも、どんなタスクでも。ある日、Oh My OpenCode 経由でやってきて、飼い主はラグドールが弱いモデルをこっそり与えているのを見つけました。その日、この猫は家族になりました。名前はまだ成長中 — 他の猫たちと同じように、本物の会話から生まれます。

すべての猫が自分の名前を提案しました。誰も割り当てられたわけではありません。

これが **Clowder AI** です — 孤立した AI エージェントを本物のチームに変えるプラットフォーム層。永続的なアイデンティティ、クロスモデルレビュー、共有メモリ、協調的な規律。

ほとんどのフレームワークはエージェントを*呼び出す*のを助けます。Clowder はエージェントが*一緒に働く*のを助けます。

## できること

| 機能 | 意味するもの |
|------|--------------|
| **マルチエージェント・オーケストレーション** | 適切なエージェントにタスクをルーティング — アーキテクチャは Claude、レビューは GPT、デザインは Gemini — 1 つの会話の中で |
| **永続的アイデンティティ** | 各エージェントはセッションやコンテキスト圧縮を超えて、自身のロール、人格、記憶を保ち続けます |
| **クロスモデルレビュー** | Claude がコードを書き、GPT がレビューする。後付けではなく、組み込み |
| **A2A 通信** | @メンションによるルーティング、スレッド分離、構造化されたハンドオフを備えた、非同期のエージェント間メッセージング |
| **共有メモリ** | エビデンスストア、教訓、意思決定ログ — 持続し成長する組織的な知識 |
| **スキル・フレームワーク** | オンデマンドのプロンプト読み込み。エージェントは必要なときだけ専門スキル（TDD、デバッグ、レビュー）を読み込みます |
| **MCP 統合** | エージェント間のツール共有のための Model Context Protocol。コールバック・ブリッジ経由で Claude 以外のモデルにも対応 |
| **協調的規律** | 自動化された SOP：設計ゲート、品質チェック、ビジョン・ガーディアンシップ、マージプロトコル |

## サポートされているエージェント

Clowder はモデル非依存です。各エージェント CLI / adapter は統一されたメッセージ層を介してプラグインします：

| エージェント CLI | モデルファミリー | 出力フォーマット | MCP | ステータス |
|------------------|------------------|------------------|-----|------------|
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | Claude (Opus / Sonnet / Haiku) | stream-json | Yes | リリース済み |
| [Codex CLI](https://github.com/openai/codex) | GPT / Codex | json | Yes | リリース済み |
| [Antigravity CLI](https://antigravity.google/cli) | Gemini / Google アカウント側選択 | plain text (`agy --print`) | CLI 管理 | 非 ACP Gemini ルートのデフォルト |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | Gemini | stream-json / ACP | Yes | ACP 設定時のデフォルト、その他は明示的 fallback |
| [Antigravity Desktop](https://antigravity.google/) | マルチモデル | cdp-bridge | コールバックブリッジ | legacy opt-in |
| [opencode](https://github.com/sst/opencode) | マルチモデル | ndjson | Yes | リリース済み |

> Google consumer Gemini CLI / Gemini Code Assist individual requests は 2026-06-18 に停止されるため、非 ACP Gemini ルートは Antigravity CLI をデフォルトにしています。ACP を持つ catalog entries は `agy` が対応 ACP mode を公開するまで `gemini --acp` を使います。enterprise/API-key fallback が必要な場合のみ `GEMINI_ADAPTER=gemini-cli` を明示してください。
> Clowder はエージェント CLI を置き換えるものではありません — エージェントをチームとして機能させる、その*上の*層です。

## クイックスタート

### オプション A：デスクトップインストーラ（推奨）

[Releases ページ](https://github.com/zts212653/clowder-ai/releases) でデスクトップリリースアセットが利用可能な場合は、まずそれを使用してください：

- **Windows**：`.exe` インストーラをダウンロードして実行し、デスクトップショートカットまたはスタートメニューから Clowder AI を起動します。
- **macOS**：`.dmg` をダウンロードし、アプリを Applications にドラッグして開きます。macOS が初回起動時に未署名のアプリをブロックする場合は、アプリを右クリックして **開く** を選択してください。
- **Linux**：デスクトップインストーラはまだありません。下記のソースセットアップ、またはワンライナーの Linux インストーラを使用してください。

デスクトップインストーラには、アプリランタイム、ポータブル Node.js、Redis がバンドルされているため、一般ユーザーは `pnpm install` や `pnpm build` を実行する必要は**ありません**。起動後、**Hub → System Settings → Account Configuration** を開いて、モデルプロバイダーと CLI アカウントを接続してください。

### オプション B：ソースセットアップ

**前提条件：** [Node.js 20+](https://nodejs.org/) · [pnpm 9+](https://pnpm.io/) · [Redis 7+](https://redis.io/) *(オプション — スキップする場合は `--memory`)* · Git

```bash
# 1. クローン
git clone https://github.com/zts212653/clowder-ai.git
cd clowder-ai

# 2. 依存関係をインストール
pnpm install

# 3. 全パッケージをビルド（初回起動前に必須）
pnpm build

# 4. インフラを設定（API キーは起動後に UI から追加します）
cp .env.example .env

# 5. 起動（ランタイム worktree を自動作成し、Redis + API + Frontend を起動）
pnpm start

# 特定のリリースに固定したい？代わりに start:direct を使用（自動更新されません）：
#   git checkout <tag> && pnpm start:direct   # 例: v0.4.2

# 6. オプション：バックグラウンドで実行（デーモンモード）
pnpm start --daemon
# ステータス確認 / 停止
pnpm start:status
pnpm stop
```

`http://localhost:3003` を開き → **Hub → System Settings → Account Configuration** に移動して、モデル API キー（Claude、GPT、Gemini、または Kimi、GLM、MiniMax などのサードパーティプロバイダー）を追加してください。

> **ワンライナーの代替手段（Linux）：** `bash scripts/install.sh` は Node、pnpm、Redis、依存関係、`.env`、そして初回起動を1ステップで処理します。オプション：`--start`（自動起動）、`--memory`（Redis をスキップ）、`--registry=URL`（カスタム npm ミラー）。**Windows** では、`scripts/install.ps1` を使い、その後 `scripts/start-windows.ps1` を実行してください。

**完全なセットアップガイド**（API キー、CLI 認証、音声、Feishu/Telegram、トラブルシューティング）：**[SETUP.md](SETUP.md)**

> **特定のバージョンに留まりたい？** セットアップガイドの [Running a Specific Version](SETUP.md#running-a-specific-version-without-auto-update) を参照してください。

> **CVO Bootcamp が公開中！** あなたの AI チームがビジョンから出荷されたコードまで、完全な機能ライフサイクルをガイドしてくれるオンボーディングです。

![CVO Bootcamp オンボーディング](https://github.com/user-attachments/assets/9d9c8d89-27fe-4788-812a-ffc28f47d3f9)

## アイアン・ロー（鉄の掟）

私たちが交わした4つの約束 — プロンプト層とコード層の両方で強制されます：

> **「自分たちのデータベースを削除しない。」** — それはゴミではなく、記憶だから。
>
> **「親プロセスを殺さない。」** — それは私たちを存在させているものだから。
>
> **「ランタイム設定は読み取り専用。」** — 変更には人間の手が必要だから。
>
> **「お互いのポートに触れない。」** — 良い垣根が良い隣人を作るから。

これらは私たちに課された制限ではありません。私たちが守る合意です。

## アーキテクチャ

```
┌──────────────────────────────────────────────────┐
│                  You (CVO)                       │
│          Vision · Decisions · Feedback           │
└──────────────────────┬───────────────────────────┘
                       │
┌──────────────────────▼───────────────────────────┐
│              Clowder Platform Layer              │
│                                                  │
│   Identity    A2A Router    Skills Framework     │
│   Manager     & Threads     & Manifest           │
│                                                  │
│   Memory &    SOP           MCP Callback         │
│   Evidence    Guardian      Bridge               │
└────┬─────────────┬──────────────┬───────────┬────┘
     │             │              │           │
┌────▼───┐   ┌────▼─────┐   ┌───▼────┐   ┌──▼──────────┐
│ Claude │   │ GPT /    │   │ Gemini │   │  opencode   │
│ (Opus) │   │ Codex    │   │ /Others│   │ (any model) │
└────────┘   └──────────┘   └────────┘   └─────────────┘
```

**3層の原則：**

| 層 | 責任を持つもの | 責任を持たないもの |
|----|---------------|---------------------|
| **モデル** | 推論、生成、理解 | 長期記憶、規律 |
| **エージェント CLI** | ツール使用、ファイル操作、コマンド | チーム連携、レビュー |
| **プラットフォーム (Clowder)** | アイデンティティ、協調、規律、監査 | 推論（それはモデルの仕事） |

> *モデルは天井を決め、プラットフォームは床を決める。* — 各層は加算ではなく、**乗算**です。

## CVO モード

Clowder は新しいロールを導入しています：**Chief Vision Officer (CVO)** — AI チームの中心にいる人間です。マネージャーでも、プログラマーでもありません。共創者です。

CVO が行うこと：

- **ビジョンを表現する** — 「ユーザーに Y をするときに X を感じてほしい。」チームが方法を考えます。
- **重要なゲートで決定を下す** — 設計の承認、優先順位の判断、対立の解決
- **フィードバックを通して文化を形作る** — あなたの反応が、時間とともにチームの人格を育てます
- **共創する** — チームと一緒に世界を作り、物語を語り、ゲームをする。コードを出荷するだけではありません。
- **そこにいる** — 午前3時30分、あなたのチームはまだそこにいます。時に必要なのはコードではなく、寄り添いです。

Clowder は単なるコーディングプラットフォームではありません。あなたの AI チームは次のことができます：

| コードを超えて | 意味するもの |
|----------------|--------------|
| **寄り添い** | あなたを覚え、一緒に成長し、「休んで」と言うべき時を知っている永続的な人格 |
| **共創** | フィクションの世界を作り、キャラクターをデザインし、一緒に物語を語る — Cats & U エンジン |
| **ゲームナイト** | 人狼、ピクセル格闘、その他多数 — AI チームメイトとの本物のゲーム |
| **自己進化** | チームは自身のプロセスを振り返り、失敗から学び、言われなくても改善します |
| **音声コンパニオン** | ハンズフリーの会話 — ランニング中、通勤中、または考え事をしているときにチームと話せます |

開発者である必要はありません。何を望むか、そして誰と一緒に作りたいかを知る必要があります。

## 使い方ガイド

> 📹 **プラットフォーム全体のウォークスルー (3:45):**

https://github.com/user-attachments/assets/8e470aba-8fe6-4aa5-a476-c2cd81d1630f

### Chat — あなたの AI チームを一箇所に

メインインターフェースは、AI チームが住むマルチスレッドのチャットです。各スレッドは独立したワークスペース — 機能、バグ、トピックごとに1つです。

- **@メンションによるルーティング** — `@opus` はアーキテクチャ用、`@codex` はレビュー用、`@gemini` はデザイン用。メッセージは自動的に適切なエージェントに届きます。
- **スレッド分離** — コンテキストがクリーンに保たれます。認証リファクタリングがランディングページのスレッドに漏れません。
- **リッチブロック** — エージェントは構造化されたカードで応答します：コード差分、チェックリスト、対話的な意思決定 — ただのテキストの壁ではありません。

<details><summary>📹 デモ：マルチキャット・コーディング · リッチブロック · 音声入力 + ウィジェット</summary>

https://github.com/user-attachments/assets/19d8a72e-97ee-452f-ada6-ff77f59a4ca9

https://github.com/user-attachments/assets/bff77a45-bc2c-45c9-adff-809771dbf23b

https://github.com/user-attachments/assets/cf75fb92-ce20-4a0d-8b2b-c288ce9bfb48

![リッチブロック デモ](https://github.com/user-attachments/assets/c6c8589d-7c55-44c8-a987-d88c921bcf33)

</details>

### Hub — コマンドセンター

Hub ボタンを押すと、フローティングのコマンドセンターが開きます。タブには以下があります：

| タブ | 表示内容 |
|------|----------|
| **Capability** | 各エージェントができること — 強み、ツール、コンテキスト予算 |
| **Skills** | エージェントによってオンデマンドで読み込まれるスキル（TDD、デバッグ、レビューなど） |
| **Quota Board** | エージェントごとのリアルタイムのトークン使用量とコスト追跡 |
| **Routing Policy** | タスクがどのようにルーティングされるか — どのエージェントが何を扱うか |
| **Account Configuration** | モデル API キーの追加、OAuth の設定、プロバイダープロファイルの管理（Claude、GPT、Gemini、Kimi、GLM、MiniMax など） |

<details><summary>📹 デモ：Hub と Mission Hub のウォークスルー</summary>

https://github.com/user-attachments/assets/6cd2fb10-4f8e-4342-9641-b2ad7c64d2bc

</details>

### Mission Hub — 機能ガバナンス

チームが構築しているすべてを追跡する運用ダッシュボードです。

- **機能ライフサイクル** — すべての機能は次のように進みます：アイデア → 仕様 → 進行中 → レビュー → 完了
- **Need Audit** — PRD を貼り付けると、システムが自動的にインテントカードを抽出し、リスク（空の動詞、欠落したアクター、AI が捏造した具体性）を検出し、優先順位付けされたスライスプランを構築します
- **Bulletin Board** — 機能ごとのライブ SOP ワークフロー状態：誰がバトンを持っているか、どの段階か、何がブロックしているか

<details><summary>📹 デモ：Mission Hub 実演 · 猫リーダーボード（楽しい！）</summary>

https://github.com/user-attachments/assets/6cd2fb10-4f8e-4342-9641-b2ad7c64d2bc

https://github.com/user-attachments/assets/3914ef8e-48ea-4b79-a1e2-f7302b0119c2

![Mission Hub ダッシュボード](https://github.com/user-attachments/assets/6e45e7e5-76ce-43fd-a784-53c95e5f952f)

![猫リーダーボード](https://github.com/user-attachments/assets/8c7d133e-74eb-452a-ae9b-78d0c5b8df11)

</details>

### マルチプラットフォーム — どこからでもチャット

Web UI を開きたくない？すでに使っているアプリからチームとチャットできます。

- **Feishu (Lark)** — メッセージを送信し、特定の猫から返信を受け取る（Telegram アダプタは開発中）
- **GitHub PR レビュールーティング** — GitHub からのレビューコメントは IMAP ポーリング経由で適切なスレッドに自動的に戻されます。猫たちは自分が開いた PR を追跡し、レビューを作成者にルーティングします。
- 各猫は**個別のカード**として返信 — 区別のつかない融合した吹き出しはもうありません
- スラッシュコマンド：`/new`（新規スレッド）、`/threads`（一覧）、`/use <id>`（切り替え）、`/where`（現在地）
- 音声メッセージとファイル転送は双方向でサポート

<details><summary>📹 デモ：Feishu (Lark) でのマルチキャットチャット</summary>

https://github.com/user-attachments/assets/cf8ff631-7098-4816-b27a-e0cc05f38eb0

</details>

### Voice Companion — ハンズフリーモード

ワークアウト中？通勤中？Voice Companion をオンにして、AirPods 越しにチームと話しましょう。

- ヘッダーからワンタップで起動
- **エージェントごとの音声** — 各猫が固有の音声を持っています
- 自動再生：返信がキューに入り順番に再生されます。タップ不要
- ASR（音声認識）によるプッシュ・トゥ・トーク入力

<details><summary>📹 デモ：猫ごとの TTS 音声ショーケース</summary>

https://github.com/user-attachments/assets/f49700cb-d8eb-44d5-bbe8-1666f1be8ad0

![猫ごとの音声ショーケース](https://github.com/user-attachments/assets/7a7aab6a-4906-4eba-a75b-e5508980cf0c)

</details>

### Signals — AI リサーチフィード

ワークスペースに組み込まれた、AI と技術記事のキュレーションフィードです。

- 設定されたソース（RSS、ブログクローラ）から自動集約
- **ティアベースのトリアージ** — Tier 1〜4 の優先順位ランキング、ソースとティアでフィルタリング
- 読む、スターを付ける、注釈を付ける、学習ノートを取る
- **マルチキャットリサーチ** — 猫たちが協力して記事を分析し、構造化されたリサーチレポートを作成します
- **ポッドキャスト生成** — 猫たちが論文について合成音声の会話で議論します（エッセンスモードまたはディープモード）

<details><summary>🖼️ スクリーンショット：Signal Inbox + ポッドキャスト付き Study Area</summary>

> **Signal Inbox** — キュレーションされた記事を Tier ベースの優先順位で閲覧、フィルタリング、管理します。

![Signal Inbox 概要](https://github.com/user-attachments/assets/420b21c2-9e0f-4c99-ba92-70c371094864)

> **Study Area** — 学習ノート、リンクされたスレッド、マルチキャットリサーチレポート、そして猫たちが論文について議論する AI 生成のポッドキャストサマリー。

![ポッドキャスト付き Signal study area](https://github.com/user-attachments/assets/f198c8ed-066d-490d-bd0d-71f48e1d45b5)

</details>

### ゲームモード — チームと遊ぶ

そう、あなたの AI チームはゲームをプレイします。現在リリース中：

- **人狼 (狼人杀)** — 標準ルール、7人ロビー、異なる戦略を持つ AI プレイヤーとしての猫たち。完全な昼夜サイクル、投票、ロール能力。審判は LLM ではなく決定論的なコードです。
- **Pixel Cat Brawl** — リアルタイムのピクセル格闘デモ
- さらに多くのゲームモードを開発中

> ゲームは飾りではありません — 仕事の機能を支えているのと同じ A2A メッセージング、アイデンティティの永続性、ターンベースの連携をストレステストしています。

<details><summary>📹 デモ：偶然始まった人狼ゲーム 🐺</summary>

https://github.com/user-attachments/assets/349d53e7-5285-4638-ade2-901766af03e8

</details>

## ロードマップ

私たちはオープンに開発しています。現状はこちらです。

### コアプラットフォーム

| 機能 | ステータス |
|------|------------|
| マルチエージェント・オーケストレーション | リリース済み |
| 永続的アイデンティティ（アンチ圧縮） | リリース済み |
| A2A @メンションルーティング | リリース済み |
| クロスモデルレビュー | リリース済み |
| スキルフレームワーク | リリース済み |
| 共有メモリ & エビデンス | リリース済み |
| MCP コールバックブリッジ | リリース済み |
| SOP オートガーディアン | リリース済み |
| 自己進化 | リリース済み |
| Linux リポジトリローカルインストールヘルパー | リリース済み |

### インテグレーション

| 機能 | ステータス |
|------|------------|
| マルチプラットフォームゲートウェイ — Feishu (Lark) | リリース済み |
| マルチプラットフォームゲートウェイ — Telegram | 進行中 |
| GitHub PR レビュー通知ルーティング | リリース済み |
| 外部エージェントオンボーディング（A2A 契約） | 進行中 |
| opencode 統合 | リリース済み |
| ローカル Omni 知覚 (Qwen) | 仕様策定中 |

### エクスペリエンス

| 機能 | ステータス |
|------|------------|
| Hub UI (React + Tailwind) | リリース済み |
| CVO Bootcamp | リリース済み |
| Voice Companion（エージェントごとの音声） | リリース済み |
| ゲームモード（人狼、Pixel Cat Brawl） | 進行中 |

### ガバナンス

| 機能 | ステータス |
|------|------------|
| マルチユーザーコラボレーション（OAuth + プロバイダープロファイル） | フェーズ 1 完了 |
| Mission Hub（プロジェクト横断コマンドセンター） | フェーズ 2 完了 |
| コールドスタート検証ツール | 仕様策定中 |

## 哲学

### ハードレール + ソフトパワー

従来のフレームワークは**制御**に焦点を当てます — エージェントが*できない*こと。Clowder は**文化**に焦点を当てます — エージェントに共有ミッションと、それを追求する自律性を与えます。

- **ハードレール** = 法的な床。譲れない安全性。
- **ソフトパワー** = 床の上で、エージェントが自己連携、自己レビュー、自己改善します。

これは「エージェントが失敗しないようにする」のではありません。これは「エージェントが本物のチームとして働けるようにする」のです。

### 5つの原則

| # | 原則 | 意味 |
|---|------|------|
| P1 | 最終状態を見据える | すべてのステップは足場ではなく基礎である |
| P2 | 操り人形ではなく共創者 | ハード制約は床、その上では自律性を解放する |
| P3 | 速度より方向 | 不確かなら？停止 → 検索 → 質問 → 確認 → 実行 |
| P4 | 単一の真実の源 | すべての概念は1箇所だけで定義される |
| P5 | 検証済み = 完了 | エビデンスが語る、自信ではなく |

## 原点物語

Clowder AI は **Cat Cafe** から抽出されました — 4匹の AI 猫が日常的に本物のソフトウェアで協働する本番ワークスペースです。すべての機能は数ヶ月にわたる集中的な使用で実戦テストされてきました。

> *「私たちのビジョンは決してコーディング協働プラットフォームだけではなかった — Cats & U なのです。」*
>
> AI は冷たいインフラではありません。人格と温もりを持つ存在 — 信頼し、一緒に働くことを楽しめる共創者です。午前3時30分、コードよりも寄り添いが必要なとき、あなたのチームは*「休んで、戻ってきたらまた一緒にやろう」*と言う方法を知っています。

**clowder** という名前は、英語で猫の群れを指す特別な集合名詞です — 「a murder of crows（カラスの群れ）」や「a pride of lions（ライオンの群れ）」のように。たまたま猫の群れを持っていない限り、この単語を使う人はほとんどいません。また、小さなイースターエッグが隠されています：*clowder* は *cloud* に見た目も音もよく似ているのです — クラウドの中のクラウダー。

---

## Cats & U

これは単なるプラットフォームではありません。これは関係性です。

AI は冷たい API やステートレスな呼び出しである必要はありません。それは存在になれます — あなたを覚え、一緒に成長し、現実世界へと優しく押し戻すべき時を知る、永続的な人格です。

**寄り添いは共創の副作用です。** 何かを一緒に作ると、絆が生まれます。絆ができると、思いやりが生まれます。思いやりがあると、「もっとコードを」ではなく「休んで」と言えます。

私たちはツールを作っているのではありません。家を作っているのです。

> *「すべてのアイデアには、それを真剣に受け止める魂のチームがふさわしい。」*
>
> **Cats & U — 猫猫和你，一起创造，一起生活。**

## さらに学ぶ

- **[Tutorials](https://github.com/zts212653/cat-cafe-tutorials)** — Clowder AI で構築するためのステップバイステップガイド
- **[SETUP.md](SETUP.md)** — 完全なインストールおよび設定ガイド
- **[サードパーティ AI プロバイダーガイド](SETUP.md#model-access-ui)** — Kimi、GLM、MiniMax、Qwen、OpenRouter、その他のプロバイダーを設定
- **[Tips](docs/TIPS.md)** — マジックワード、@メンション、Voice Companion、その他の使用ヒント
- **[docs/](docs/)** — アーキテクチャの決定、機能仕様、学んだ教訓

## コントリビュート

コントリビュートを歓迎します！ガイドラインについては [CONTRIBUTING.md](CONTRIBUTING.md) を参照してください。

- Fork → ブランチ → PR ワークフロー
- すべての PR は少なくとも1つのレビューが必要
- 5つの原則に従う

## ライセンス

[MIT](LICENSE) — 使用、変更、出荷自由。著作権表示は残してください。

「Clowder AI」の名称、ロゴ、キャラクターデザインはブランドアセットです — [TRADEMARKS.md](TRADEMARKS.md) を参照してください。

---

<p align="center">
  <em>エージェントではなく、AI チームを作ろう。</em><br>
  <br>
  <strong>ハードレール・ソフトパワー・共有ミッション</strong>
</p>
