import { accessSync, existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { collectRosterFamilyLabels, formatRosterLabel } from './cat-display-name.js';
import { resolvePromptTemplateVariables } from './deployment-defaults.js';
import { getDossierL0Pronouns, loadDossierProfiles } from './dossier/index.js';
import { freezeL0Input, L0_COMPILER_VERSION } from './l0-input.js';
import { resolveMemberIdentity } from './member-identity.js';
import {
  CURRENT_CORPUS_PROFILE_URI,
  CURRENT_RELATIONSHIP_PROFILE_URI,
  profileCapsuleReadRelativePath,
  profileCorpusRelativePath,
  relationshipPrimerRelativePath,
  renderUserCapsuleSection,
} from './profile-contract.js';
import type { CatConfig } from './types/cat.js';
import type { CoCreatorConfig } from './types/cat-breed.js';

export const L0_SECTION_TEMPLATES = {
  L1_CONTENT: 'l1-parallel-world.md',
  L2_CONTENT: 'l2-carry-over.md',
  L3_CONTENT: 'l3-routing-rules.md',
  L4_CONTENT: 'l4-iron-laws.md',
  L5_CONTENT: 'l5-mcp-tools-index.md',
  L6_CONTENT: 'l6-capability-wakeup.md',
  L7_CONTENT: 'l7-collaboration-philosophy.md',
};
const provenanceTrigger = '- MG provenance override：外部finding修完后等PR truth，不@旧reviewer。';
const familyBreeds = { 布偶猫: 'ragdoll', 缅因猫: 'maine-coon', 暹罗猫: 'siamese' };

/** Workflow overlays belong to the Host workspace, independently of a task's repository. */
export function resolveL0OverlayRoot(start = process.cwd()) {
  let directory = resolve(start);
  while (directory !== dirname(directory)) {
    if (existsSync(resolve(directory, 'pnpm-workspace.yaml'))) return directory;
    directory = dirname(directory);
  }
  return resolve(start);
}

function withoutAnnotations(text: string) {
  return text
    .split('\n')
    .filter((line) => !line.trim().startsWith('<!--') && !/^── \[[A-Z]\d+] .+──$/.test(line.trim()))
    .join('\n');
}

export function resolveRelationshipKey(config: Pick<CatConfig, 'relationshipKey'>, catId: string) {
  if (!config.relationshipKey)
    throw new Error(`No relationshipKey configured for catId "${catId}"; refusing breed/model inference`);
  return config.relationshipKey;
}

export function resolveUserCapsule(profileDir: string, relationshipKey: string) {
  const entries = [
    [
      relationshipPrimerRelativePath(relationshipKey),
      `关系轨迹: ${CURRENT_RELATIONSHIP_PROFILE_URI}（cat_cafe_read_profile 按需读）`,
    ],
    [
      profileCorpusRelativePath(),
      `共享事实: ${CURRENT_CORPUS_PROFILE_URI}（cat_cafe_read_profile layer=corpus 按需读）`,
    ],
  ].flatMap(([path, entry]) => {
    try {
      accessSync(resolve(profileDir, path!));
      return [entry!];
    } catch {
      return [];
    }
  });
  const pointers = entries.length
    ? [...entries, '读源走本轮绑定的 Clowder AI 连接；勿用独立 App 的同名工具替代。'].join('\n')
    : '';
  let raw: string;
  try {
    raw = readFileSync(
      resolve(
        profileDir,
        profileCapsuleReadRelativePath((path) => existsSync(resolve(profileDir, path))),
      ),
      'utf8',
    );
  } catch {
    return pointers;
  }
  const section = renderUserCapsuleSection(raw);
  return [section, pointers].filter(Boolean).join('\n\n');
}

function workflowTriggers(templates: string, projectRoot: string, variables: Readonly<Record<string, string>>) {
  const base = resolve(templates, 'workflow-triggers.yaml');
  const local = resolve(projectRoot, '.cat-cafe/prompt-overlays/workflow-triggers.local.yaml');
  const effective = existsSync(local) ? local : base;
  const parse = (path: string) => {
    const result = z.record(z.unknown()).safeParse(YAML.parse(readFileSync(path, 'utf8')));
    if (!result.success) return {};
    return Object.fromEntries(
      Object.entries(result.data).flatMap(([key, value]) => {
        if (typeof value !== 'string') return [];
        const text = value
          .trimEnd()
          .replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
            Object.hasOwn(variables, name) ? variables[name]! : match,
          );
        return [
          [
            key,
            text.includes('MG provenance override') && text.includes('外部finding修完后等PR truth')
              ? text
              : `${text}\n${provenanceTrigger}`,
          ],
        ];
      }),
    );
  };
  if (!existsSync(effective)) return {};
  try {
    return parse(effective);
  } catch (error) {
    console.warn(`[compile-l0] malformed YAML in ${effective}: ${error}`);
    if (effective !== base && existsSync(base)) {
      try {
        return parse(base);
      } catch {
        console.warn('[compile-l0] base workflow-triggers.yaml also malformed');
      }
    }
    return {};
  }
}

/** The admission owner supplies resolved members/models and governance from the same captured revision set. */
export function captureFrozenL0Input(
  input: {
    catId: string;
    installRoot: string;
  } & (
    | { projection: 'public' }
    | {
        member: CatConfig;
        model: string;
        teammates: readonly { catId: string; config: CatConfig; model: string }[];
        coCreator: Pick<CoCreatorConfig, 'name' | 'mentionPatterns'>;
        overlayRoot: string;
        dossierRoot?: string;
        profileDir?: string;
        governanceText?: string;
        projection: 'owner';
      }
  ),
) {
  const { catId, projection } = input;
  const templates = resolve(input.installRoot, 'assets/prompt-templates');
  if (projection === 'public')
    return freezeL0Input({
      schemaVersion: 1,
      compilerVersion: L0_COMPILER_VERSION,
      catId,
      projection,
      template: withoutAnnotations(readFileSync(resolve(templates, 'l0-public-participation.md'), 'utf8')),
      sections: {},
      variables: { PUBLIC_IDENTITY_BLOCK: `Identity constant: \`@${catId}\`` },
    });
  if (!input.profileDir || input.governanceText === undefined)
    throw new Error('Owner L0 profile/governance sources are required');
  const config = input.member;
  const dossierRoot = input.dossierRoot ?? input.installRoot;
  const dossier = loadDossierProfiles(dossierRoot);
  const identity = resolveMemberIdentity(config, dossier.get(catId));
  const nameLabel = config.nickname
    ? `${config.displayName}/${config.nickname}（${config.name}）`
    : `${config.displayName}（${config.name}）`;
  const identityLines = [
    `你是 ${nameLabel}。`,
    ...(config.nickname ? [`昵称 "${config.nickname}" 的由来见 \`docs/stories/cat-names/\`。`] : []),
    ...(identity.selfDescription
      ? [`角色与自我校准：${identity.selfDescription}`]
      : [`角色：${identity.roleDescription}`, `性格：${identity.personality}`]),
    ...(input.model ? [`Identity constant: \`@${catId}\` model=${input.model}`] : []),
    ...(config.restrictions?.length
      ? ['', `**硬限制**：${config.restrictions.join('、')}。被 @ 做这类任务时请 push back 或退回给 @ 你的猫。`]
      : []),
  ];
  const teammates = input.teammates.filter((entry) => entry.catId !== catId);
  const labels = collectRosterFamilyLabels(teammates.map((entry) => entry.config));
  const rows = teammates.map(({ catId: id, config: cfg, model }) => {
    const mention = cfg.mentionPatterns?.[0] ?? `@${id}`;
    const pronoun = getDossierL0Pronouns(id, dossierRoot)?.split('/')[0]?.trim();
    const baseLabel = formatRosterLabel(cfg, labels);
    const label = pronoun ? `${cfg.nickname ?? baseLabel}（${pronoun}）` : baseLabel;
    const restrictions = cfg.restrictions?.length ? `**硬限制**：${cfg.restrictions.join('、')}` : null;
    const note = resolveMemberIdentity(cfg, dossier.get(id)).routingNote;
    const route = [note, restrictions].filter(Boolean).join('；') || '—';
    return `| ${label} | ${model ? `${mention} · ${model}` : mention} | ${route} |`;
  });
  const edition = resolvePromptTemplateVariables();
  const triggers = workflowTriggers(templates, input.overlayRoot, edition);
  const family = Object.entries(familyBreeds).find(([label]) => config.displayName?.startsWith(label))?.[1];
  const workflow =
    triggers[config.breedId ?? ''] ??
    triggers[catId] ??
    (family ? triggers[family] : undefined) ??
    '## 工作流\n（无 per-breed 触发点配置）';
  const name = input.coCreator.name;
  const handles = (input.coCreator.mentionPatterns ?? []).map((p) => `\`${p}\``).join(' / ');
  return freezeL0Input({
    schemaVersion: 1,
    compilerVersion: L0_COMPILER_VERSION,
    catId,
    projection,
    template: withoutAnnotations(
      readFileSync(resolve(input.installRoot, 'assets/system-prompts/system-prompt-l0.md'), 'utf8'),
    ),
    sections: Object.fromEntries(
      Object.entries(L0_SECTION_TEMPLATES).map(([key, file]) => [
        key,
        withoutAnnotations(readFileSync(resolve(templates, file), 'utf8')).trim(),
      ]),
    ),
    variables: {
      ...edition,
      IDENTITY_BLOCK: identityLines.join('\n'),
      USER_CAPSULE: resolveUserCapsule(input.profileDir, resolveRelationshipKey(config, catId)),
      TEAMMATE_ROSTER: rows.length
        ? ['## 队友名册', '| 猫猫 | @mention · 当前模型 | 路由边界 |', '|------|---------|------|', ...rows].join('\n')
        : '（无其他可用队友）',
      GOVERNANCE_L0: input.governanceText,
      WORKFLOW_TRIGGERS: workflow,
      CVO_REF: `${name}（co-creator/operator）。重要决策由${name}拍板。需要关注时行首写 ${handles}。`,
    },
  });
}
