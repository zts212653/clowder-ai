#!/usr/bin/env node
/**
 * F138 AC-1g: Video project scaffold
 *
 * Creates a new video project directory with template files:
 *   voice-script.md, asset-markers.md, video-spec.json, brief.md, assets/
 *
 * Usage:
 *   node scripts/video-forge/new-project.mjs <slug> [--type <type>] [--style <style>] [--base-dir <dir>]
 *   pnpm video:new <slug> [--type <type>] [--style <style>]
 *
 * Options:
 *   <slug>         Project identifier (e.g., "my-tutorial", "showcase-v2")
 *   --type <type>  Video type: general (default), knowledge-explainer, showcase, tutorial, intro
 *   --style <style> Visual style name (reserved for style-recipes, AC-1i)
 *   --base-dir <dir> Override base directory (default: docs/videos/)
 *
 * Design decisions (KD-15):
 *   - Templates mirror existing showcase-60s structure (voice-script + asset-markers + video-spec)
 *   - video-spec.json starts as editorial (schema enum), pipeline.sh upgrades to render-ready
 *   - Global audio paradigm (KD-12): no per-step TTS splitting
 *   - Forced alignment (KD-10): timestamps come from FA, not TTS native
 */

import { access, mkdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';

// --- Argument parsing ---

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    type: { type: 'string', default: 'general' },
    style: { type: 'string', default: '' },
    'base-dir': { type: 'string', default: '' },
  },
});

const slug = positionals[0];
if (!slug || slug.startsWith('--')) {
  console.error('Usage: node new-project.mjs <slug> [--type <type>] [--style <style>] [--base-dir <dir>]');
  process.exit(1);
}

// P1-2 fix: slug must be a safe identifier, no path traversal
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/i;
if (!SLUG_RE.test(slug)) {
  console.error(
    `Error: Invalid slug "${slug}". Must match ${SLUG_RE} (letters, digits, hyphens; no slashes, dots, or path components).`,
  );
  process.exit(1);
}

const videoType = values.type;
const style = values.style;
const baseDir = values['base-dir'] ? resolve(values['base-dir']) : resolve(import.meta.dirname, '../../docs/videos');
const projectDir = join(baseDir, slug);

// Belt-and-suspenders: resolved path must still be inside baseDir
if (!resolve(projectDir).startsWith(resolve(baseDir))) {
  console.error(`Error: Invalid slug "${slug}" — resolved path escapes base directory.`);
  process.exit(1);
}

// P2 fix: use relative path for in-repo projects (they go into git),
// absolute path only for out-of-repo projects (--base-dir /tmp/...)
const repoRoot = resolve(import.meta.dirname, '../..');
const resolvedProjectDir = resolve(projectDir);
const displayPath = resolvedProjectDir.startsWith(resolve(repoRoot))
  ? relative(repoRoot, resolvedProjectDir)
  : resolvedProjectDir;

// --- Idempotency guard ---

try {
  await access(projectDir);
  console.error(`Error: Project directory already exists: ${projectDir}`);
  process.exit(1);
} catch {
  // Directory doesn't exist — good, proceed
}

// --- Template generators ---

const today = new Date().toISOString().slice(0, 10);

function generateVoiceScript() {
  return `---
feature_ids: [F138]
topics: [video, ${slug}, voice-script, tts]
doc_kind: voice-script
created: ${today}
status: draft
speaker: opus
estimated_duration_sec: 60
char_count_target: 270
---

# ${slug} — 配音剧本

> **TTS 规则**：CosyVoice 全局一次性读完，不分段（KD-12）。句间停顿靠标点自然断。
> **语速**：~4.5 字/秒（中文 + 少量英文混合）

---

## 完整剧本（一口气读完）

<!-- 在这里写完整的配音文稿 -->
<!-- 写完后请大声念一遍，检查节奏是否顺畅 -->

---

## 分段对照表（供 video-spec 对齐用）

| 段 | 分镜 | 配音文本（含标点） | 预估秒数 |
|----|------|------------------|---------|
| 1 | | | |

**总计**: ~60s

---

## 须知

1. **请大声念一遍**，看节奏是否顺畅、有没有拗口的地方
2. 可以改任何词——但尽量保持每段字数在预估范围内（影响 retiming）
3. 确认后把 status 改为 \`frozen\`，然后走 \`pipeline.sh\` 流水线
4. 英文词 CosyVoice 会自动切英文发音
`;
}

function generateAssetMarkers() {
  return `---
feature_ids: [F138]
topics: [video, ${slug}, assets, markers]
doc_kind: asset-manifest
created: ${today}
status: draft
---

# ${slug} — 素材标注表

> **用法**：co-creator录完每段素材后，在对应段落填写时间标注。
> 格式：\`起始时间-结束时间 画面内容描述\`
> 不需要精确到毫秒，粗标就行（如 \`1:20\` 或 \`50s\`）。

## 素材存放位置

\`\`\`
${displayPath}/assets/
\`\`\`

素材文件不进 git（.gitignore 已排除 *.mov），仅本地保留。

---

## 1. [段落名称]

**文件**: \`assets/1-xxx.mov\`
**内容**: [描述]

| 时间 | 画面内容 |
|------|---------|
| 0:00 - | |

**剪辑笔记**：
- 最佳片段：
- 加速段：
- 可删段：

---

## 素材压缩指南（录完后来压）

\`\`\`bash
# 推荐压缩命令（保留音频）
ffmpeg -i input.mov -c:v libx264 -crf 23 -c:a aac -b:a 128k output.mp4
\`\`\`
`;
}

function generateVideoSpec() {
  const spec = {
    id: slug,
    version: 1,
    status: 'editorial',
    meta: {
      title: `Clowder AI ${slug}`,
      type: videoType,
      ...(style && { style }),
      target_duration_ms: 60000,
      fps: 30,
      resolution: { width: 1920, height: 1080 },
    },
    global_audio: {
      script_text: '',
      speaker_id: 'opus',
      audio_uri: 'assets/global-narration.wav',
      word_timestamps: [],
    },
    segments: [],
  };
  return `${JSON.stringify(spec, null, 2)}\n`;
}

function generateBrief() {
  const typeLabel =
    {
      'knowledge-explainer': '知识讲解',
      showcase: '功能展示',
      tutorial: '教程',
      intro: '介绍',
      general: '通用',
    }[videoType] || videoType;

  return `---
feature_ids: [F138]
topics: [video, ${slug}, brief]
doc_kind: brief
created: ${today}
---

# ${slug} — 视频创意简报

**类型**: ${typeLabel} (${videoType})
${style ? `**风格**: ${style}\n` : ''}
## 核心信息

<!-- 这支视频要传达什么？一句话概括 -->

## 目标观众

<!-- 谁会看这支视频？他们关心什么？ -->

## 关键卖点

1. <!-- 第一个必须展示的亮点 -->
2. <!-- 第二个 -->
3. <!-- 第三个 -->

## 素材计划

<!-- 需要录什么素材？哪些是已有的？ -->

## 参考

<!-- 参考视频/风格/灵感 -->

## 时长预估

~60 秒

## 下一步

1. 填写本 brief，确认方向
2. 编写 \`voice-script.md\` 配音稿
3. 录制/收集素材，填写 \`asset-markers.md\`
4. 运行 \`scripts/video-forge/pipeline.sh ${displayPath}\`
`;
}

// --- Create project ---

await mkdir(join(projectDir, 'assets'), { recursive: true });
await writeFile(join(projectDir, 'assets', '.gitkeep'), '');

await Promise.all([
  writeFile(join(projectDir, 'voice-script.md'), generateVoiceScript()),
  writeFile(join(projectDir, 'asset-markers.md'), generateAssetMarkers()),
  writeFile(join(projectDir, 'video-spec.json'), generateVideoSpec()),
  writeFile(join(projectDir, 'brief.md'), generateBrief()),
]);

// --- Success output ---

console.log(`✅ Video project created: ${displayPath}`);
console.log('');
console.log('Files:');
console.log(`  📋 brief.md            — 创意简报（先填这个）`);
console.log(`  🎙️  voice-script.md     — 配音剧本`);
console.log(`  📸 asset-markers.md    — 素材标注表`);
console.log(`  🎬 video-spec.json     — 视频规格（draft）`);
console.log(`  📁 assets/             — 素材目录`);
console.log('');
console.log('Next steps:');
console.log(`  1. Fill brief.md with your video concept`);
console.log(`  2. Write voice-script.md (read it aloud to check rhythm)`);
console.log(`  3. Record assets, mark timestamps in asset-markers.md`);
console.log(`  4. Run: scripts/video-forge/pipeline.sh ${displayPath}`);
