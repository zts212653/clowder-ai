---
feature_ids: [F172]
related_features: [F060, F061, F088]
topics: [image-generation, rich-block, uploads, artifact, archive, antigravity, skills]
doc_kind: spec
created: 2026-04-22
---

# F172: Generated Image Publication — 内建生图产物归档与富块发布

> **Status**: done (Phase H merged 2026-04-24) | **Owner**: Ragdoll/opus | **Priority**: P1
>
> **Phase G alpha smoke 通过 (2026-04-23 23:59)**: team lead前端直接看到 antig-opus 生图 + F5 刷新还在 = R9 闭环 ✅
>
> **Phase H reopen (2026-04-23 23:59)**: 同次 alpha smoke 暴露副作用 — 第一次 @antig-opus 报错 `Antigravity returned no text response`（empty_response），第二次才成功。根因是 `AntigravityAgentService.ts:763` 的 `if (!hasText && !fatalSeen)` 判断在 Phase G 之前没考虑"image-only response 也是 valid user-visible output"。一行 condition fix。
>
> **诊断历程（务必读完，KD-8 元教训）**：
>
> 1. **Phase C 实施 (2026-04-23 早)**: 假设 `toolResult.output` 含路径，写 `extractAbsoluteImagePaths`。16 单测全绿但**真实 cascade 从未抓到**——fixture 用 `"Saved /tmp/a.png"` 简化 shape，错过真实 edge case。
> 2. **Phase F reopen (2026-04-23 中)**: 第一次怀疑 spec 设计 bug，方向锁定 brain scanner——但 @antig-opus 提供 IDE-side sample (`"Generated image is saved at <abs_path>."`) 后撤回，改为 5 行 trailing-punctuation regex 修复。
> 3. **Phase G reopen (2026-04-23 晚)**: 真正的 alpha smoke 还是失败——team lead前端无图。**第三次定位用 runtime log 直接证据**：Antigravity `generate_image` 走专属 step type `CORTEX_STEP_TYPE_GENERATE_IMAGE`，runtime log 实测 `"unknown step type"`。这种 step **没有 `toolResult.output` 字段**。Phase F 的 regex 对真实 cascade 完全没用——**根本没字符串可 extract**。
>
> 真路径来自 `step.generateImage.imageName + cascadeId`，文件落在 `~/.gemini/antigravity/brain/<cascadeId>/<imageName>_<unixMs>.<ext>`。Phase G 真正实现 brain 目录 scanner（Phase F 撤回 brain scanner 是错的——第一次诊断方向对，被 IDE-side sample 误导回到 regex 路径）。Phase F 的 trailing-punctuation 修复保留作 future-proof（万一未来 antigravity 真在 toolResult 写路径），但**不再是主路径**。
>
> **元教训（KD-8）**：spec / IDE-side sample 都是间接证据，**runtime log 才是唯一真相源**。三轮诊断都跳过 `grep runtime log`，错三次。下次类似 provider 集成 bug 必须**先 grep runtime trajectory step shape**，再做任何假设。

## Why

目前猫用 built-in `image_gen` 生成图片时，文件默认落在 `~/.codex/generated_images/...`。图片本身能生成，但**没有自动晋升为 Cat Cafe 的一等产物**：

1. 前端 rich block / message content 的真资源链路以 `/uploads/...` 为准，`.codex` 路径不在当前 runtime 服务范围内。
2. 猫如果想展示这张图，只能靠手工把本地文件搬进当前 `uploadDir`，再自己发 `media_gallery` rich block。
3. 孟加拉猫/Antigravity 虽然本来就有图片生成能力，但其 provider 输出同样还没有接到 Cat Cafe 的统一图片 artifact 发布链路上。
4. `image-generation` / `rich-messaging` 等家里 skill 现在仍在教猫“手工搬图 + 手工写 `/uploads/...`”，这说明契约还停留在人工约定，没有下沉成基础设施。
5. jsonl / thread artifact / connector outbound 缺少统一的“生成图已发布”记录，导致“生成成功但没有归档/展示”的前端感知断裂。

team lead已经明确拍板方向：不要把这件事留在 skill 约定层，而要收敛成基础设施能力。

## What

### Phase A: 共享发布内核（Publication Contract）

定义统一的“生成图片发布”母线，不论图片最初来自哪里，最终都要走同一个 promotion contract：

- 输入：本地图片文件路径 + 最小 provenance（tool/provider/prompt 等）
- 输出：发布到**当前 active runtime** 的 `uploadDir`，获得稳定 `/uploads/...` URL
- 副产物：可持久化 rich block / archive / outbound 所需元数据

这层是 F172 的核心，不归属某一只猫，也不绑定某一个 provider。

核心要求：
- 发布目标必须跟随当前 runtime 的 `UPLOAD_DIR` / `getDefaultUploadDir()`，不能假设源码树里的固定目录。
- 保留原始生成路径作为 provenance，但 thread / rich block / outbound 一律消费发布后的 `/uploads/...` 路径。
- 发布是显式 artifact promotion，不覆盖已有同名文件，默认生成唯一文件名。
- 发布动作必须具备幂等性：同一张已生成图片在 provider replay / recovery / retry 下再次进入 publication contract 时，应返回同一个 published artifact，而不是重复拷贝或重复发块。

### Phase B: Codex built-in `image_gen` 接入

把 OpenAI/Codex 的 built-in `image_gen` 输出，接到 Phase A 的共享发布内核上。

目标不是只“让 Codex 能显示图”，而是让它生成的图片从一开始就是 Cat Cafe 的正式 artifact。

### Phase C: Antigravity 图片输出接入

把孟加拉猫/Antigravity 的图片生成结果，接到同一条共享发布内核上。

注意边界：
- F061 继续拥有 Antigravity provider/bridge/step taxonomy 本身
- F172 只拥有“当 Antigravity 已经生成出图片后，如何发布成 Cat Cafe artifact 并呈现”这条后半段

### Phase D: Skill 契约与使用路径收口

把家里和图片生成/展示相关的 skill 说明收口到新契约上：

- `cat-cafe-skills/image-generation`：不再把“下载到本地后手工 cp”当成终态
- `cat-cafe-skills/rich-messaging` / `refs/rich-blocks.md`：从“手工搬运指南”升级为“共享发布内核的消费规则”
- 对猫的最终使用体验是：不管走 Codex built-in、Antigravity，还是浏览器自动化生成，只要产物要进 thread，就统一晋升为 `/uploads/...` + `media_gallery`

### Phase F: extractAbsoluteImagePaths trailing punctuation 修复（reopen — 修 Phase C regex bug）

5 行 regex 修复 + regression 测试：

- `extractAbsoluteImagePaths`：split 出 token 后，先 `replace(/[.,;:!?]+$/, '')` strip trailing sentence punctuation，再做 `startsWith('/')` + 扩展名校验
- 新增 2 个测试 fixture：（1）verbatim antigravity output shape with trailing period；（2）混合 trailing punctuation `. , ; !`
- 保留原有 16 个 antigravity tests + 8 image-storage + 6 codex-scanner + 7 publication contract = 39 tests baseline

明确**不做**：brain 目录 scanner、新 provider 接入、scope 扩张。

### Phase G: GENERATE_IMAGE step + brain dir scanner（reopen 二次 — 修 Phase C/F 都没击中的真根因）

Antigravity built-in `generate_image` 的真实交付链路：

- Step type: `CORTEX_STEP_TYPE_GENERATE_IMAGE`（专属，不走 tool_call/tool_result）
- Step status: `CORTEX_STEP_STATUS_DONE` 时 metadata 完整
- 关键字段: `step.generateImage.imageName`（如 `"bengal_cat_alpha_smoke"`）+ `step.generateImage.generatedMedia.mimeType`
- 文件落点: `~/.gemini/antigravity/brain/<cascadeId>/<imageName>_<unixMs>.<ext>`
- **没有** `step.toolResult.output` 字段——Phase F 的 trailing-punctuation regex 在这里完全无用

实施：
- 新增 `collectGenerateImageSteps(steps): GenerateImageStepInfo[]` — 从 trajectory steps 提取 done generate_image step 的 imageName + mimeHint
- 新增 `scanAndPublishAntigravityBrainImages({steps, cascadeId, brainHome, uploadDir, maxAgeMs})` — 用 cascadeId 拼 brain 子目录，按 `<imageName>_*` 前缀匹配文件，调 `publishGeneratedImage`
- `AntigravityAgentService` 在 batch loop 累积 done generate_image steps，invocation 结束前 yield brain scanner 产物（与 Codex `system_info` rich_block 对齐）
- `antigravity-event-transformer.classifyStep`: `CORTEX_STEP_TYPE_GENERATE_IMAGE` 归到 `checkpoint`（不再触发 "unknown step type" 日志噪音）
- Phase F 的 `extractAbsoluteImagePaths` / `publishAntigravityImages` 路径**保留作 future-proof 兜底**，但不再是主路径

### Phase E: 富块联动 + 归档真相源

发布完成后，统一生成可持久化的展示与记录：

- 自动附加 `media_gallery` rich block，指向发布后的 `/uploads/...`
- 将 prompt、source tool、original path、published path、mime/size 等最小 provenance 写入消息/事件归档
- 后续 connector outbound、历史重放、前端刷新都以发布后的 URL 为唯一真相源

### 非目标

- 不在本 feature 内讨论图片审美、prompt 优化、批量选图工作流
- 不改动现有 MCP `output_image` → `media_gallery` 的 F060 路径
- 不接管 F061 的 bridge 稳定性、resume、capacity retry、tool parity 等 provider 主线能力
- 不引入新的 rich block kind；继续复用 `media_gallery`

## Acceptance Criteria

### Phase A（共享发布内核）
- [x] AC-A1: 系统提供统一的 generated-image publication contract，可接收“本地图片路径 + provenance”并发布到当前 runtime 的 `uploadDir`
- [x] AC-A2: 发布结果产出稳定 `/uploads/...` URL，而不是暴露原始本地路径
- [x] AC-A3: 发布路径遵循当前 runtime 的 `UPLOAD_DIR` 解析，不依赖固定 cwd 或源码目录
- [x] AC-A4: 文件命名避免覆盖已有资源，默认生成唯一文件名
- [x] AC-A5: 相同图片在 replay / retry / recovery 场景下重复进入 publication contract 时，能幂等返回同一个 `/uploads/...` URL，且不产生重复文件或重复 rich block

#### Phase A 实施证据（2026-04-23）

- 共享图片落盘原语已抽取：`packages/api/src/utils/image-storage.ts`
- multipart 上传路径已复用共享原语：`packages/api/src/routes/image-upload.ts`
- generated-image publication contract 已落地：`packages/api/src/domains/cats/services/agents/providers/generated-image-publication.ts`
- 新增测试：
  - `packages/api/test/image-storage.test.js`
  - `packages/api/test/generated-image-publication.test.js`
- 回归测试命令（已通过）：
  - `pnpm run build`
  - `CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT=1 bash ./scripts/with-test-home.sh node --test test/generated-image-publication.test.js test/image-storage.test.js test/image-upload.test.js`

### Phase B（Codex built-in 接入）
- [x] AC-B1: built-in `image_gen` 成功后，产物自动接入 Phase A 的 publication contract
- [x] AC-B2: Codex 生图消息不再停留在 `~/.codex/generated_images/...` 孤岛路径

#### Phase B 实施证据（2026-04-23）

- Codex image scanner：`packages/api/src/domains/cats/services/agents/providers/codex-image-scanner.ts`
- CodexAgentService 接线：post-invocation scan → yield `system_info` rich block before `done`
- 新增测试：
  - `packages/api/test/codex-image-scanner.test.js`（6 tests）
  - `packages/api/test/codex-agent-service.test.js` integration test（F172 case）
- 回归：42/42 codex-agent-service tests + 6/6 scanner tests all GREEN

### Phase C（Antigravity 接入）
- [x] AC-C1: Antigravity 图片生成完成后，产物可接入同一个 publication contract
- [x] AC-C2: 孟加拉猫生成的图片与 Codex 生图在 thread 中采用同一种 `/uploads/...` + `media_gallery` 呈现方式

#### Phase C 实施证据（2026-04-23）

- Antigravity image publisher：`packages/api/src/domains/cats/services/agents/providers/antigravity/antigravity-image-publisher.ts`
- AntigravityAgentService 接线：collect image paths from image-gen `toolResult` steps → publish pre-done
- Path scraping gated on `IMAGE_GEN_TOOL_NAMES` allowlist（cloud review P1 fix）; `metadata.toolCall.name` fallback（cloud review P2 fix）
- 新增测试：`packages/api/test/antigravity-image-publisher.test.js`（16 tests）
- 回归：all GREEN

### Phase D（Skill 契约收口）
- [x] AC-D1: `cat-cafe-skills/image-generation` 明确改为消费共享发布内核，不再把手工复制文件当终态
- [x] AC-D2: `cat-cafe-skills/rich-messaging` / `refs/rich-blocks.md` 更新为新的图片发布约定

#### Phase D 实施证据（2026-04-23）

- `cat-cafe-skills/image-generation/SKILL.md`：manual `cp` → `publishGeneratedImage()` auto-publish
- `cat-cafe-skills/rich-messaging/SKILL.md`：manual uploadDir copy → F172 contract
- `cat-cafe-skills/refs/rich-blocks.md`：manual copy instructions → auto-publish explanation

### Phase E（富块联动 + 归档）
- [x] AC-E1: 发布成功后，消息中自动生成 `media_gallery` rich block，展示该 `/uploads/...` 图片
- [x] AC-E2: 消息持久化 / jsonl / thread replay 使用发布后的 URL，可刷新后继续显示
- [x] AC-E3: 归档中保留最小 provenance：provider/tool、prompt、originalPath、publishedPath
- [x] AC-E4: connector outbound 在遇到该图片消息时，走现有 `/uploads/...` 媒体投递链路，无需额外特判 provider 私有路径
- [x] AC-E5: 发布后的图片默认仅以 `media_gallery` rich block 作为 canonical 呈现路径；不为同一张图再额外复制一份 image `contentBlocks` 造成上下文和存储重复

#### Phase E 实施证据（2026-04-23）

- AC-E1: Phase B/C 的 `system_info` yield 自动生成 `media_gallery` rich block
- AC-E2: `route-serial.ts` 既有管线 — `streamRichBlocks[]` → `allRichBlocks` → `extra.rich.blocks[]` 持久化
- AC-E3: provenance 对象（provider/toolName/prompt/originalPath/publishedPath）嵌入 `system_info` content
- AC-E4: `persistenceContext.richBlocks` 传递给 connector outbound（F088）
- AC-E5: 仅 `media_gallery` rich block，无重复 contentBlocks

### Phase F（regex trailing punctuation 修复 — reopen）
- [x] AC-F1: `extractAbsoluteImagePaths` 在 token split 后 strip trailing sentence punctuation (`.,;:!?`)，再做扩展名校验
- [x] AC-F2: 新增 verbatim 真实 antigravity output shape regression 测试（trailing period case）
- [x] AC-F3: 新增混合 trailing punctuation 测试（`. , ; !` 各一例）
- [x] AC-F4: 39/39 F172 tests GREEN（image-storage + codex-scanner + publication + antigravity-publisher 全部）
- [ ] AC-F5: Alpha smoke — antig-opus 真实 `generate_image` 一张图，team lead前端直接看到 + F5 刷新后还在 ⚠️ Phase F merged 后实测仍失败，根因转 Phase G

### Phase G（GENERATE_IMAGE step + brain dir scanner — reopen 二次）
- [x] AC-G1: 实现 `collectGenerateImageSteps(steps): GenerateImageStepInfo[]` — 从 trajectory steps 提取 done generate_image step 的 imageName + mimeHint
- [x] AC-G2: 实现 `scanAndPublishAntigravityBrainImages({steps, cascadeId, brainHome, uploadDir, maxAgeMs})` — 扫 `~/.gemini/antigravity/brain/<cascadeId>/<imageName>_*.<ext>`，调 `publishGeneratedImage`
- [x] AC-G3: `AntigravityAgentService` 累积 done generate_image steps + invocation 结束前调 brain scanner，yield `system_info` rich_block
- [x] AC-G4: `antigravity-event-transformer.classifyStep`: `CORTEX_STEP_TYPE_GENERATE_IMAGE` 归 `checkpoint`（消除 "unknown step type" 日志噪音）
- [x] AC-G5: Alpha smoke — antig-opus 真生一张图，team lead前端**直接看到** + F5 刷新还在（2026-04-23 23:59 验证通过，team experience"我看到了！！看到了！！"）

### Phase H（empty_response false-positive 修复 — Phase G 副作用兜底）
- [x] AC-H1: image-only response 不再误报 `Antigravity returned no text response` — `hasText` 判断需识别 GENERATE_IMAGE step 也算 valid user-visible output
- [x] AC-H2: 回归测试 — 单 GENERATE_IMAGE step + 0 plannerResponse text 的 invocation 不应 yield empty_response error
- [x] AC-H3: Alpha smoke — antig-opus 单纯生图（无文字回复）能正常完成 invocation，无 error 气泡（2026-04-24 01:18 验证通过，team experience"ok了！验证通过了！看到图片了！"）

## 需求点 Checklist

| ID | 需求点（team experience/转述） | AC 编号 | 验证方式 | 状态 |
|----|---------------------------|---------|----------|------|
| R1 | “生成的图片我记得位置是在 user 下面的 .codex 并没有归档的” | AC-A1, AC-A2, AC-B2 | manual + test | [x] |
| R2 | “基础设置帮你生成的图片自动放过来” | AC-A1, AC-A3, AC-A4 | test | [x] |
| R3 | “包括孟加拉他的图片生成我估计也得对接到你这套基础设施” | AC-C1, AC-C2 | integration test | [x] |
| R4 | “这样你们生成完成之后 两只猫都能够直接呈现给我” | AC-B1, AC-C2, AC-E1 | manual + integration test | [x] |
| R5 | “图片生成 skills 也得挂在 F172 这里进行优化” | AC-D1, AC-D2 | doc + skill test | [x] |
| R6 | 能自动把你产出的图片归档 + 用富文本呈现 | AC-E2, AC-E3 | test + manual | [x] |
| R7 | 既有 rich block / connector 媒体链路继续复用 | AC-E4 | integration test | [x] |
| R8 | provider 恢复 / replay 时不应重复堆积图片文件或重复发块 | AC-A5, AC-E5 | integration test | [x] |
| R9 | Antigravity 真实生图必须能在 alpha 上直接呈现给team lead | AC-F1~F5（Phase F 部分修复，alpha 仍失败）, AC-G1~G5（Phase G 真根因修复 + alpha smoke 通过） | alpha smoke + integration test | [x] |
| R10 | image-only response 不应误报 empty_response（Phase G 副作用） | AC-H1, AC-H2, AC-H3 | unit test + alpha smoke | [x] |

### 覆盖检查
- [x] 每个需求点都能映射到至少一个 AC
- [x] 每个 AC 都有验证方式
- [x] 前端需求已准备需求→证据映射表（若适用）

## Dependencies

- **Evolved from**: F060（已解决 MCP `output_image` 自动转 `media_gallery`，但未覆盖多 provider 的生成图 artifact publication）
- **Related**: F061（孟加拉猫 provider 本身继续拥有图片生成能力与 bridge 主线；F172 只接它的图片发布后半段）
- **Related**: F088（`/uploads/...` 是 connector outbound 的媒体真相源）

## Risk

| 风险 | 缓解 |
|------|------|
| 发布到了错误的 uploadDir，前端仍然裂图 | 统一走 `getDefaultUploadDir()` / runtime `UPLOAD_DIR`，并增加验证测试 |
| 把 provider 主线能力和 artifact 发布层搅混，scope 失控 | 明确 F172 只管图片生成后的 publication contract，F061/F088 继续拥有各自主线 |
| 只解决前端展示，没解决历史归档/重放 | Phase B 明确要求持久化 published URL + provenance |
| provider replay / recovery 造成重复拷贝、重复 rich block、文件堆积 | publication contract 以原始路径 + provider step signature / provenance 做幂等键，重复命中直接返回已发布结果 |
| prompt / 原始路径等元数据泄露过多 | provenance 只保留最小必要字段，不回流敏感上下文 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 新开 F172，不回填到 F060 | F060 已闭环且边界明确为 MCP `output_image` 自动渲染；本需求新增 artifact publication / archive / outbound 语义，scope 更大 | 2026-04-22 |
| KD-2 | 继续复用 `media_gallery`，不新增图片块类型 | 现有前端与 outbound 已围绕 `/uploads/...` + `media_gallery` 打通，新增类型只会制造第二套链路 | 2026-04-22 |
| KD-3 | F172 覆盖 Codex built-in、Antigravity、repo-local skills 三个入口，但只统一“生成完成后的图片发布链路” | team lead明确要求两只猫都能直接呈现；真正共享的不是各自的生图方式，而是 artifact publication contract | 2026-04-22 |
| KD-4 | 发布后的图片默认只写 `media_gallery` rich block，不重复写 image `contentBlocks` | rich block 已足以覆盖前端展示、history replay 与 F088 outbound；重复写 contentBlocks 只会制造上下文与存储重复 | 2026-04-22 |
| KD-5 | ~~Phase F 改用「brain 目录 scanner」~~ **撤回**——后续 sample 验证 OQ-2 假设是对的（output 含绝对路径），真问题是 regex token 处理 bug | 二次诊断更正：Antigravity `generate_image` 实际 output 是 `"Generated image is saved at <abs_path>."`，路径**确实**在里面，不需要 fs scanner | 2026-04-23 (撤回) |
| KD-6 | 单测的 toolResult.output fixture 必须以**真实 cascade 抓回的样本**为准，不允许用想象 shape | Phase C 单测的 `"Saved /tmp/a.png"` 太简化，错过了 trailing period edge case，导致 16 个测试全绿但真实 cascade 失败——典型的「测的是想象 shape 不是真实 shape」反模式。后续 provider-related 单测必须至少有一条 verbatim 真实 sample | 2026-04-23 |
| KD-7 | ~~修复优先尝试最小变更（5 行 regex）~~ **撤回** | KD-7 基于"toolResult.output 含路径"假设，但真实 step 没有 toolResult。Phase G 实测发现真根因后这个决策本身错位 | 2026-04-23 (撤回) |
| KD-8 | **诊断 provider 集成 bug 必须先 grep runtime log 真实 step shape，再做任何假设** | F172 三轮诊断 (Phase C→F→G) 都跳过 runtime log 直接证据，依赖 spec / IDE-side sample / 单测 fixture 这些间接证据，结果错三次。runtime log 是唯一真相源——具体到这个 cascade，第一次 grep `"unknown step type"` 就能定位真根因 | 2026-04-23 (晚) |
| KD-9 | Antigravity 专属 step type (`CORTEX_STEP_TYPE_GENERATE_IMAGE`) 必须在 transformer 显式分类（即便归 checkpoint），不能依赖 "unknown" 兜底 | "unknown step type" 日志会持续刷屏，被人误以为是问题信号；显式归类后日志干净，未来真正的 unknown 才有信号价值 | 2026-04-23 (晚) |

## Review Gate

- Phase A: 重点 review publication contract 形状、uploadDir 解析、路径安全、唯一文件名策略
- Phase B/C: 重点 review 两个 provider 接入是否都真正走到同一条 shared contract
- Phase D/E: 重点 review skill 文档是否与运行时契约一致，以及 rich block 持久化 / history replay / connector outbound 回归
