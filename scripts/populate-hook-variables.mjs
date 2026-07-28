#!/usr/bin/env node
/**
 * Populate/merge hook.yaml `variables` metadata from the runtime TEMPLATE_FILES
 * template (the same source the Console uses). Preserves original file
 * content/comments by replacing/inserting only the variables block.
 * Run from repo root after building packages/api.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const hooksDir = join(root, 'assets', 'prompt-hooks');

const { TEMPLATE_FILES, getTemplateRawContent } = await import(
  join(root, 'packages', 'api', 'dist', 'domains', 'cats', 'services', 'context', 'prompt-template-loader.js')
);

const knownDescriptions = {
  CALLABLE_MENTIONS: '当前可 @ 的队友句柄列表',
  EXAMPLE_TARGET: '一个具体队友句柄示例，用于展示正确/错误 @ 格式',
  DUPLICATE_NAMES_HINT: '当出现同名队友时的额外提示（可为空）',
  RICH_BLOCK_SHORT: '富消息块短标签示例',
  SKILL_NAME: '被触发 skill 的名称',
  ACTIVE_LABEL: '当前活跃参与者标签',
  ROUTING_PARTS: '路由策略组成部分',
  TEMPLATE_VARIANT: '模板变体标识（如 D7_solo / D15_on）',
  GUIDE_PROMPT_LINES: '引导候选提示文本行',
  CONSTITUTIONAL_DOCS: '宪法知识文档块',
  SIGNAL_ARTICLES_BLOCK: '信号文章块',
  CC_MENTION: 'co-creator 的 @ 句柄',
  CHAIN_INDEX: '串行链中的当前猫序号',
  CHAIN_TOTAL: '串行链中的猫总数',
  DISPLAY_NAME: '当前猫的显示名',
  NICKNAME_PART: '当前猫昵称后缀（如 /小狸）',
  CAT_ID: '当前猫的稳定 ID',
  RUNTIME_MODEL: '当前运行模型',
  NAME_LABEL: '当前猫的完整名称',
  PROVIDER_LABEL: '模型提供商标签',
  NICKNAME_ORIGIN: '昵称由来说明',
  ROLE_DESCRIPTION: '角色描述',
  PERSONALITY: '性格描述',
  FROM_VARIANT: '消息发送方变体名',
  FROM_MODEL: '消息发送方模型',
  SELF_VARIANT: '当前猫变体名',
  SELF_MODEL: '当前猫模型',
  MISSION: '当前任务名称',
  WORK_ITEM: '当前工作项',
  PHASE: '当前阶段',
  DONE_WHEN_BLOCK: '完成条件块',
  LINKS_BLOCK: '相关链接块',
  THREAD_PART: 'thread 信息片段',
  LEAD_CAT_PART: '主导猫信息片段',
  TASK_PART: '任务信息片段',
  MEMBERS_PART: '成员信息片段',
  OTHER_LABEL: '对方标签',
  STREAK_COUNT: '连续互相 @ 轮数',
  FEATURE_ID: '功能 ID',
  STAGE: 'SOP 阶段',
  SUGGESTED_SKILL: '建议加载的 skill',
  SOURCE_PART: '来源信息片段',
  WORLD_NAME: '世界名称',
  WORLD_STATUS: '世界状态',
  CONSTITUTION_LINE: '宪法声明行',
  SCENE_NAME: '场景名称',
  SCENE_STATUS: '场景状态',
  CHARACTERS_BLOCK: '角色信息块',
  CANON_BLOCK: '正典信息块',
  RECENT_EVENTS_BLOCK: '近期事件块',
  CARE_HINT_LINE: '关怀提示行',
  CC_NAME: 'co-creator 显示名',
  CC_HANDLES: 'co-creator 句柄列表',
  EXAMPLE_HANDLE: '句柄示例',
  RESTRICTIONS_TEXT: '限制说明文本',
  SOURCE_THREAD: '来源 thread ID',
  SENDER_CAT: '发送猫 ID',
  EFFECT_LABEL: '跨线程回复效果标签',
  CONSTRAINT_TEXT: '跨线程约束文本',
  FROM_LABEL: '发送方标签',
  ROSTER_CONTENT: '队友名册内容',
  INNER_CONTENT: '导航内部内容',
  PACK_DEFAULTS_BLOCK: 'pack 默认行为块',
  PACK_WORKFLOWS_BLOCK: 'pack 工作流块',
  PACK_GUARDRAILS_BLOCK: 'pack 护栏块',
  PACK_MASKS_BLOCK: 'pack 能力覆盖块',
  GOVERNANCE_DIGEST: '治理摘要块',
  WORLD_DRIVER_SUMMARY: '世界驱动摘要',
  TRANSCRIPT_PATH: '会议转录文件路径',
  LATEST_RANGE_LINE: '最新时间范围行',
  PARTICIPANTS_LINE: '参会者行',
  TEAMMATES_LIST: '队友列表',
  UNROUTED_MENTIONS: '未路由的 @ 提及',
  CONTENT: '完整内容块（直接传递）',
};

function extractPlaceholders(content) {
  const names = new Set();
  for (const m of content.matchAll(/\{\{(\w+)\}\}/g)) {
    names.add(m[1]);
  }
  return [...names];
}

function extractVarComments(content) {
  const map = new Map();
  for (const line of content.split('\n')) {
    const m = line.match(/<!--\s*Variable:\s*\{\{(\w+)\}\}\s*[-—]\s*(.+?)\s*-->/i);
    if (m) {
      map.set(m[1], m[2].trim());
    }
  }
  return map;
}

function buildVariablesBlock(placeholders, comments, existingDefs) {
  const defs = new Map(existingDefs.map((v) => [v.name, v]));
  const lines = ['', '# Variable metadata (canonical source for Console editor)', 'variables:'];
  for (const name of placeholders) {
    const fromExisting = defs.get(name);
    const description = fromExisting?.description ?? comments.get(name) ?? knownDescriptions[name] ?? '';
    const placeholder = fromExisting?.placeholder ?? '';
    lines.push(`  - name: ${name}`);
    lines.push(`    description: ${description}`);
    lines.push(`    placeholder: "${placeholder}"`);
  }
  return `${lines.join('\n')}\n`;
}

const variablesBlockPattern =
  /\n# Variable metadata \(canonical source for Console editor\)\nvariables:\n(?: {2}- name:[^\n]*\n(?: {4}[^\n]*\n)*)*/s;

async function main() {
  const entries = await readdir(hooksDir);
  for (const entry of entries) {
    const hookDir = join(hooksDir, entry);
    const yamlPath = join(hookDir, 'hook.yaml');
    let original;
    try {
      original = await readFile(yamlPath, 'utf8');
    } catch {
      continue;
    }

    let yaml;
    try {
      yaml = YAML.parse(original);
    } catch {
      continue;
    }
    const id = yaml.id;
    if (!id || !TEMPLATE_FILES[id]) continue;

    const raw = getTemplateRawContent(id, false);
    if (!raw) {
      console.warn(`No runtime template for ${id}`);
      continue;
    }

    const placeholders = extractPlaceholders(raw);
    if (placeholders.length === 0) continue;

    const comments = extractVarComments(raw);
    const block = buildVariablesBlock(placeholders, comments, yaml.variables ?? []);

    let updated;
    if (variablesBlockPattern.test(original)) {
      updated = original.replace(variablesBlockPattern, block);
    } else if (original.includes('\n# Override constraints\n')) {
      updated = original.replace('\n# Override constraints\n', `${block}# Override constraints\n`);
    } else if (original.includes('\ndisableable:')) {
      updated = original.replace('\ndisableable:', `${block}disableable:`);
    } else {
      console.warn(`Could not find insertion point for ${id}`);
      continue;
    }

    if (updated === original) {
      console.log(`Skipped ${id}: already synced`);
      continue;
    }

    await writeFile(yamlPath, updated);
    console.log(`Updated ${id}: ${placeholders.length} variables`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
