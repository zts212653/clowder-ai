/**
 * Rules & Prompts Route
 * GET /api/rules — shared rules + provider guides for console transparency
 * GET /api/rules/skill/:name — SKILL.md content preview (allowlisted paths only)
 * GET /api/prompt-injection/manifest — moved to prompt-injection-manifest.ts (F237 Phase 2)
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CatCafeConfig } from '@cat-cafe/shared';
import type { FastifyPluginAsync } from 'fastify';
import { readCapabilitiesConfig } from '../config/capabilities/capability-orchestrator.js';
import { getRoster, loadCatConfig, toAllCatConfigs } from '../config/cat-config-loader.js';
import { resolvePersistentProjectPath } from '../utils/persistent-project-path.js';
import { getDefaultRootsForPlatform, isPathUnderRoots } from '../utils/project-path.js';
import { resolveUserId } from '../utils/request-identity.js';

function findProjectRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}

export type PromptConsumptionKind = 'actual-prompt' | 'harness-injected' | 'reference' | 'skill-on-demand';

export interface PromptConsumptionInfo {
  kind: PromptConsumptionKind;
  label: string;
  detail: string;
  consumers: string[];
}

export interface RuleFileResponse {
  path: string;
  content: string;
  exists: boolean;
  consumption: PromptConsumptionInfo;
}

const CONSUMPTION = {
  actualPrompt: (detail: string, consumers: string[]): PromptConsumptionInfo => ({
    kind: 'actual-prompt',
    label: '实际进 prompt',
    detail,
    consumers,
  }),
  reference: (detail: string, consumers: string[] = []): PromptConsumptionInfo => ({
    kind: 'reference',
    label: '只是参考',
    detail,
    consumers,
  }),
  harnessInjected: (detail: string, consumers: string[] = []): PromptConsumptionInfo => ({
    kind: 'harness-injected',
    label: 'harness 注入',
    detail,
    consumers,
  }),
  skillOnDemand: (detail: string, consumers: string[] = []): PromptConsumptionInfo => ({
    kind: 'skill-on-demand',
    label: 'skill 按需加载',
    detail,
    consumers,
  }),
} as const;

async function readRuleFile(
  root: string,
  relativePath: string,
  consumption: PromptConsumptionInfo,
): Promise<RuleFileResponse> {
  const fullPath = join(root, relativePath);
  if (!existsSync(fullPath)) return { path: relativePath, content: '', exists: false, consumption };
  try {
    const content = await readFile(fullPath, 'utf-8');
    return { path: relativePath, content, exists: true, consumption };
  } catch {
    return { path: relativePath, content: '', exists: false, consumption };
  }
}

/** Session hook source visibility retained under the existing response key. */
export interface L0CompiledForCat {
  catId: string;
  displayName: string;
  compiled: string;
  error: string | null;
  consumption: PromptConsumptionInfo;
}

export interface L0PromptsBlock {
  template: RuleFileResponse;
  compiledByCat: L0CompiledForCat[];
  customization: { templatePath: string; compileScript: string; verifyCommand: string };
}

export interface ReadL0PromptsOptions {
  /** Retained for API compatibility; per-cat previews live in prompt-injection. */
  includeCompiledByCat?: false;
}

const SESSION_HOOKS_RELPATH = 'assets/prompt-hooks/README.md';
const SESSION_HOOKS_VERIFY_COMMAND = 'pnpm gate + isolated native-carrier invocation';

export async function readL0Prompts(root: string, _opts: ReadL0PromptsOptions = {}): Promise<L0PromptsBlock> {
  const template = await readRuleFile(
    root,
    SESSION_HOOKS_RELPATH,
    CONSUMPTION.actualPrompt('Session hooks are assembled once by HookPipeline and delivered by each carrier.', [
      'HookPipeline',
      'SystemPromptBuilder',
    ]),
  );
  return {
    template,
    compiledByCat: [],
    customization: {
      templatePath: SESSION_HOOKS_RELPATH,
      compileScript: '',
      verifyCommand: SESSION_HOOKS_VERIFY_COMMAND,
    },
  };
}

/**
 * Resolve enabled cats from the runtime loader's merged template+catalog
 * source (no-arg `loadCatConfig()` per KD-13 / SystemPromptBuilder pattern).
 * Hardcoding the catalog file silently returned [] on bootstrap-empty —
 * cloud P1 R1 on PR #1717. The bare try/catch then swallowed real config
 * errors (malformed template / schema regression) → silent 0 cats masked
 * operator-actionable bugs — cloud P2 R2. The no-arg loader handles the
 * one expected "catalog absent" case internally (template defaults), so
 * any error from it is a real configuration failure that MUST propagate.
 * `loaderFn` is injectable for tests.
 */
export function loadAvailableCatsForL0(
  loaderFn: () => CatCafeConfig = loadCatConfig,
): Array<{ catId: string; displayName: string }> {
  const config = loaderFn();
  const allCats = toAllCatConfigs(config);
  const roster = getRoster(config);
  return Object.entries(allCats)
    .filter(([catId]) => roster[catId]?.available !== false)
    .map(([catId, c]) => ({ catId, displayName: c.displayName ?? catId }));
}

export interface RulesPayload {
  sharedRules: RuleFileResponse[];
  providerGuides: Array<RuleFileResponse & { provider: string }>;
  l0Prompts: L0PromptsBlock;
}

export async function readRulesPayload(root: string, opts: ReadL0PromptsOptions = {}): Promise<RulesPayload> {
  const [sharedRules, providerGuides, l0Prompts] = await Promise.all([
    Promise.all(SHARED_RULE_FILES.map((f) => readRuleFile(root, f.path, f.consumption))),
    Promise.all(
      Object.entries(PROVIDER_GUIDE_FILES).map(async ([provider, file]) => ({
        provider,
        ...(await readRuleFile(root, file.path, file.consumption)),
      })),
    ),
    readL0Prompts(root, opts),
  ]);
  return { sharedRules, providerGuides, l0Prompts };
}

const SHARED_RULE_FILES: Array<{ path: string; consumption: PromptConsumptionInfo }> = [
  {
    path: 'cat-cafe-skills/refs/shared-rules.md',
    consumption: CONSUMPTION.actualPrompt('shared-rules.md → session hook pipeline → provider prompt transport.', [
      'HookPipeline',
      'SystemPromptBuilder',
    ]),
  },
  {
    path: 'docs/SOP.md',
    consumption: CONSUMPTION.reference('Reference workflow document; not injected into every prompt.'),
  },
];

const PROVIDER_GUIDE_FILES: Record<string, { path: string; consumption: PromptConsumptionInfo }> = {
  claude: {
    path: 'CLAUDE.md',
    consumption: CONSUMPTION.harnessInjected(
      'Claude Code reads project CLAUDE.md into model context; it is not the session hook source.',
      ['Claude Code project-doc loader'],
    ),
  },
  codex: {
    path: 'AGENTS.md',
    consumption: CONSUMPTION.harnessInjected(
      'Codex CLI reads project AGENTS.md into model context; session hooks arrive through developer_instructions.',
      ['Codex CLI project-doc loader'],
    ),
  },
  gemini: {
    path: 'GEMINI.md',
    consumption: CONSUMPTION.harnessInjected(
      'Gemini project guide is provider-level prompt context; it is separate from the session hook pipeline.',
      ['Gemini CLI project-doc loader'],
    ),
  },
};

export function isLegacySkillProjectPath(absPath: string, roots: string[] = getDefaultRootsForPlatform()): boolean {
  return isPathUnderRoots(
    resolve(absPath),
    roots.map((root) => resolve(root)),
  );
}

async function findSkillPath(root: string, name: string, projectPath?: string): Promise<string | null> {
  const home = homedir();
  const validatedProject = projectPath ? await resolvePersistentProjectPath(projectPath) : null;
  const projectRoot = validatedProject && isLegacySkillProjectPath(validatedProject) ? validatedProject : root;
  const candidateDirs = [
    join(root, 'cat-cafe-skills'),
    join(projectRoot, '.claude', 'skills'),
    join(home, '.claude', 'skills'),
    join(projectRoot, '.codex', 'skills'),
    join(home, '.codex', 'skills'),
    join(projectRoot, '.gemini', 'skills'),
    join(home, '.gemini', 'skills'),
    join(projectRoot, '.kimi', 'skills'),
    join(home, '.kimi', 'skills'),
  ];
  for (const dir of candidateDirs) {
    const candidate = join(dir, name, 'SKILL.md');
    if (existsSync(candidate)) return candidate;
  }
  // Fallback: check plugin skill source directories from capabilities config.
  // Plugin skillsSource is relative to the Clowder AI instance root (where plugin
  // code lives). For preview, try instance root first, then project root as
  // fallback (for project-local plugins in non-startup projects).
  try {
    const config = await readCapabilitiesConfig(projectRoot);
    if (config) {
      for (const cap of config.capabilities) {
        if (cap.type === 'skill' && cap.pluginId && cap.id === name && cap.skillsSource) {
          const roots = isAbsolute(cap.skillsSource)
            ? [cap.skillsSource]
            : [join(root, cap.skillsSource), join(projectRoot, cap.skillsSource)];
          for (const resolvedSource of roots) {
            const pluginCandidate = join(resolvedSource, name, 'SKILL.md');
            if (existsSync(pluginCandidate)) return pluginCandidate;
          }
        }
      }
    }
  } catch {
    // capabilities read failure is non-critical for preview
  }
  return null;
}

export const rulesRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/rules', async (request, reply) => {
    if (!resolveUserId(request)) {
      reply.status(401);
      return { error: 'Authentication required' };
    }
    const root = findProjectRoot();
    return readRulesPayload(root);
  });

  app.get<{ Params: { name: string }; Querystring: { projectPath?: string } }>(
    '/api/rules/skill/:name',
    async (request, reply) => {
      if (!resolveUserId(request)) {
        reply.status(401);
        return { error: 'Authentication required' };
      }
      const { name } = request.params;
      if (!/^[a-z][a-z0-9-]*$/i.test(name)) {
        reply.status(400);
        return { error: 'Invalid skill name' };
      }
      const root = findProjectRoot();
      const skillPath = await findSkillPath(root, name, request.query.projectPath);
      if (!skillPath) {
        reply.status(404);
        return { error: `Skill "${name}" not found` };
      }
      try {
        const content = await readFile(skillPath, 'utf-8');
        return {
          name,
          content,
          path: skillPath,
          consumption: CONSUMPTION.skillOnDemand('SKILL.md is loaded only when that skill is selected or invoked.'),
        };
      } catch {
        reply.status(500);
        return { error: 'Failed to read skill content' };
      }
    },
  );
};
