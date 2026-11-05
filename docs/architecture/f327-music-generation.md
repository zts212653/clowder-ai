---
feature_ids: [F327, F202]
topics: [music, plugins, project-output, action-plane]
doc_kind: architecture
created: 2026-10-26
updated: 2026-10-29
---

# F327 Cloud music plugin

Status: integrated and verified in Alpha, then installed and enabled on the formal Host.
operator `private-source-id` adopted bounded project delivery. The music package
`0.1.0-alpha.1` remains unpublished to npm/catalog; this is distribution status, not a thread restriction.
Contract 0.3 uses the declared output and current installation/caller authority; no separate
`project.output.create` API grant table is restored.
The old built-in `cat_cafe_generate_music`, callback route, shared music schema and Host
Google business implementation have been removed from this candidate. Existing code approvals
for those earlier revisions remain historical evidence only.

## Accepted outcome and authority

The original Flow / Flow Music Chrome journey remains separate and undelivered. After the
F314 incident report, operator `private-source-id` permitted API work;
`private-source-id` selected Google Cloud and refused AI Studio prepayment;
`private-source-id` requires background operation without taking the screen.
operator `private-source-id` required the current F202 plugin setup journey,
and `private-source-id` directed continued delivery. These later permissions
do not retroactively validate the earlier misreading of webpage OAuth.

The deliverable is an installable plugin, explicit Manager connection and enablement, an
authenticated native invocation, and a new MP3 plus durable provenance in the calling project.
A cache, attachment, source directory or service-level sample alone does not satisfy that outcome.

## Ownership

- The public `packages/music-generation` module owns Google Cloud OAuth, project and billing
  checks, the single Lyria request, and retained provider media. It uses the published SDK
  `0.2.0-beta.24`; its locked dependencies must materialize outside the workspace.
- Host owns installation, current caller/thread/project authorization, the operation
  journal, exclusive target reservation, existing media ledger, and final file delivery.
- The paired Contract `0.3.1-candidate.0` declares the bounded output action. SDK
  `0.3.0-beta.2-candidate.0` documents the separately injected operation context. Both
  previews were published and their bytes verified; the music package retains its own locked SDK dependency.
- Google owns model execution, quota and billing. List-price estimates do not establish an
  actual charge or Ultra credit deduction.

Architecture cell: plugin. Map delta: integrated; the paired boundary is recorded in
`docs/architecture/ownership/cells/plugin.md`. Why: Host owns local output authorization and
delivery while the plugin owns provider generation. The Host extension is vendor neutral; no Google service or credential
parser is added to Host. A caller supplies `{requestId, outputPath, parameters}` to the plugin's
native `generate_music`. The Host reads authenticated call context, never body-supplied user,
thread, project root, grant, or operation credentials. V1 accepts authenticated native MCP
entrypoints only; settings and direct-tool actions cannot enter this output path.

Canonical implementation: Host `domains/plugin/outputs/project-output-actions.ts`,
`output-dispatch.ts`, `project-output-files.ts`, and `file-output-operations.ts`; public plugin
`settings.ts`, `oauth-helper.ts`, `oauth-receiver.ts`, `music-jobs.ts`, and `google-cloud.ts`.

## User setup and recovery

Installation starts disabled. The owner selects the billing/quota Cloud project and may explicitly
confirm reuse of an existing private, owner-held standard authorized-user ADC grant. Only that
confirmed settings operation reads ADC, and the project must match. The installed plugin then uses
its Host-managed secret; it never silently borrows ambient ADC, AGY tokens or browser storage.

For a new connection the owner supplies their own Desktop OAuth application's client details.
An isolated background helper presents an HTTPS authorization link on the Manager card; it does
not open a browser. It binds a loopback callback, validates state and PKCE, requires Cloud scope,
and persists the completed grant privately. A later current owner operation adopts that result
through Host configuration targets. No request-scoped Host client is retained by the helper.
Reopening the card recovers the pending link or outcome; cancellation, expiry, disablement and
uninstall close pending helpers without deleting generated music. Read-only connection tests do
not generate, enable an API, recharge or imply a verified credit deduction. Enablement is explicit.

## 给片子和游戏配乐

正式 Host 已安装并启用 Google Cloud 配乐插件，其他线程已用它交付六条配乐。
同一 Host 的猫先用 `plugin_get` 核对已有状态，再发现原生 MCP 的 `generate_music`，
不需要为每个线程重新安装或登录。告诉猫音乐风格、情绪、配器和项目内新的相对 MP3
路径，例如 `score/cafe.mp3`；Host 自动交付音频与来源 JSON。Clip 默认，结果未知不自动
重付费。完整示例、权限边界和同请求恢复见音乐插件使用指南 (internal)。

## Generation and project delivery

Before producer dispatch, Host checks installation, enablement, configuration, declared output
ownership, strict current caller ownership and the thread's trusted project. It exclusively reserves
both the audio and `<outputPath>.provenance.json`. Paths are relative new MP3 names; existing files,
symlink parents and paths outside the authorized project are refused. The operation and dispatch
intent persist before any provider work. Concurrent operations contend on actual target files.

The plugin receives generation parameters and a separate Host operation identifier, not the
project root or a filesystem writer. Its immutable claim precedes a single Cloud request. Pending
calls return promptly; subsequent calls with the same request ID and exact parameters only query
that operation or finish delivery. Different parameters conflict. An unknown provider result never
causes another paid request. There is no end-to-end exactly-once claim.

Completed audio is durable in the plugin's retained instance data before an owned media-source
reference is returned. Host imports it through the existing media ledger, verifies instance/source,
MIME, size and digest, and durably records the receipt. Delivery rechecks current permissions and
reserved inode/parent identities. A changed target is not overwritten. Interruption between the two
file writes reports incomplete delivery; the same operation resumes only its own empty or matching
partial files. Two file writes are not a single atomic commit.

If the plugin persisted complete audio but lost its result record, it can reconstruct a marked
recovery receipt from the immutable request and audio. Missing provider response identifiers are
omitted, not invented. Disabling or uninstalling the plugin does not discard accepted user media.

## Google and cost boundaries

Token refresh goes only to `https://oauth2.googleapis.com/token`; Lyria goes only to
`https://aiplatform.googleapis.com/v1beta1/projects/{quotaProject}/locations/global/interactions`
with `store:false`, Bearer and quota-project headers, and refused redirects. Clip is default;
Pro is explicit. The result must contain one completed, valid base64 MP3. No key fallback,
AI Studio top-up, automatic generation retry, or model/format substitution is allowed.

Provenance records model, prompt, request time, quota project, audio size/digest and dated list-price
sources. Requested BPM/duration are intent, not measured output. Clip/Pro list estimates are
$0.04/$0.08; `actualChargedUsd:null` and `creditDeductionVerified:false` remain honest until billing
evidence exists. OAuth credentials and raw upstream error bodies never enter output receipts.

## Verification boundary

- Source tests cover connection state, OAuth callback scope/state/cancel, private-file reads,
  fixed Google destinations, no retry, provider errors, durable jobs and crash recovery.
- A fresh packed consumer installs locked published dependencies, imports the module and speaks
  native MCP discovery without a workspace symlink or any Cloud credentials.
- The paired Host archive journey exercises disabled installation, owner-confirmed reuse,
  explicit enablement, native action authorization, one injected provider result, media-ledger
  import, project delivery, disablement and retained files after uninstall. This is a fixture
  journey, not a paid Cloud or actual cat-runtime MCP acceptance.
- File tests cover cross-instance CAS, competing target reservations, symlink changes, foreign
  mutations, delivery recovery, and current-owner rejection.
- Earlier real Clip samples prove only the historical service path. The final installed plugin's
  real native Cloud invocation, final scope/review gates and actual billing deduction remain open.

Historical one-hand references, checked 2026-10-26: [Cloud music](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/music/generate-music),
[Interactions](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/interactions-api),
[Cloud pricing](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing),
[developer credits](https://developers.google.com/profile/help/benefits#google-cloud-credits).
