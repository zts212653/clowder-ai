/** Pure filesystem planning for F302 install/undo previews. */

import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import type { BootstrapAction, BootstrapReport, GovernanceProvider, GovernanceSelection } from '@cat-cafe/shared';
import { GOVERNANCE_PACK_VERSION } from './governance-pack.js';
import { getMethodologyTemplates, type ProjectCommand } from './methodology-templates.js';

const PROVIDERS = new Set<GovernanceProvider>(['claude', 'codex', 'gemini', 'kimi']);
const THIN_ENTRYPOINTS = new Set(['claude', 'gemini']);
const PROVIDER_SKILLS_DIRS: Record<GovernanceProvider, string> = {
  claude: '.claude/skills',
  codex: '.codex/skills',
  gemini: '.gemini/skills',
  kimi: '.kimi/skills',
};
const SHARED_REFS_ALIAS = '.cat-cafe-shared-refs';
export const LEGACY_GOVERNANCE_REPORT = '.cat-cafe/governance-bootstrap-report.json';
const PACKAGE_MANAGER_DECLARATION = /^(pnpm|npm|yarn|bun)@(.+)$/;
const SEMVER_CORE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SEMVER_IDENTIFIER = /^[0-9A-Za-z-]+$/;

export function hashGovernanceContent(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function uniqueSorted<T extends string>(values: readonly T[] | undefined, allow: ReadonlySet<string>): T[] {
  return [...new Set((values ?? []).filter((value) => allow.has(value)))].sort() as T[];
}

export function normalizeGovernanceSelection(selection: GovernanceSelection = {}): GovernanceSelection {
  const thinEntrypoints = uniqueSorted(selection.projectGuide?.thinEntrypoints, THIN_ENTRYPOINTS);
  const skillIds = [...new Set(selection.projectSkills?.skillIds ?? [])]
    .filter((id) => /^[a-z0-9][a-z0-9._-]*$/.test(id))
    .sort();
  const providers = uniqueSorted(selection.projectSkills?.providers, PROVIDERS);
  return {
    ...(selection.projectGuide ? { projectGuide: { thinEntrypoints } } : {}),
    ...(selection.projectSkills ? { projectSkills: { skillIds, providers } } : {}),
    ...(selection.docsLifecycle ? { docsLifecycle: true } : {}),
  };
}

export function governancePreviewChecksum(selection: GovernanceSelection, actions: readonly BootstrapAction[]): string {
  const writeShape = actions.map(({ file, action, group, contentHash, symlinkTarget }) => ({
    file,
    action,
    group,
    contentHash,
    symlinkTarget,
  }));
  return hashGovernanceContent(JSON.stringify({ selection, actions: writeShape }));
}

export function safeGovernanceTargetPath(projectRoot: string, relativePath: string): string | null {
  const path = resolve(projectRoot, relativePath);
  const rel = relative(resolve(projectRoot), path);
  return rel === '..' || rel.startsWith(`..${sep}`) ? null : path;
}

export async function governancePathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function hasUnsafeGovernanceAncestor(projectRoot: string, targetPath: string): Promise<boolean> {
  const rel = relative(projectRoot, dirname(targetPath));
  if (!rel || rel === '.') return false;
  let cursor = projectRoot;
  for (const segment of rel.split(sep)) {
    cursor = join(cursor, segment);
    try {
      const current = await lstat(cursor);
      if (current.isSymbolicLink() || !current.isDirectory()) return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      return true;
    }
  }
  return false;
}

function isSemVerIdentifierList(value: string, forbidNumericLeadingZero: boolean): boolean {
  return (
    value.length > 0 &&
    value.split('.').every((identifier) => {
      if (!SEMVER_IDENTIFIER.test(identifier)) return false;
      return !(
        forbidNumericLeadingZero &&
        /^\d+$/.test(identifier) &&
        identifier.length > 1 &&
        identifier.startsWith('0')
      );
    })
  );
}

function isExactSemVer(value: string): boolean {
  const buildSeparator = value.indexOf('+');
  if (buildSeparator !== -1 && value.indexOf('+', buildSeparator + 1) !== -1) return false;
  const withoutBuild = buildSeparator === -1 ? value : value.slice(0, buildSeparator);
  if (buildSeparator !== -1 && !isSemVerIdentifierList(value.slice(buildSeparator + 1), false)) return false;

  const prereleaseSeparator = withoutBuild.indexOf('-');
  const core = prereleaseSeparator === -1 ? withoutBuild : withoutBuild.slice(0, prereleaseSeparator);
  if (!SEMVER_CORE.test(core)) return false;
  return prereleaseSeparator === -1 || isSemVerIdentifierList(withoutBuild.slice(prereleaseSeparator + 1), true);
}

function packageManagerRunner(value: unknown): string | undefined {
  const match = typeof value === 'string' ? PACKAGE_MANAGER_DECLARATION.exec(value) : null;
  return match && isExactSemVer(match[2]) ? match[1] : undefined;
}
const isJsonRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

async function readProjectManifest(projectRoot: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));
    return isJsonRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function detectProjectCommands(projectRoot: string): Promise<ProjectCommand[]> {
  const manifest = await readProjectManifest(projectRoot);
  if (!manifest) return [];
  const scriptsRecord = manifest.scripts;
  if (!isJsonRecord(scriptsRecord)) return [];
  const scripts = Object.keys(scriptsRecord).filter((name) => typeof scriptsRecord[name] === 'string');
  if (scripts.length === 0) return [];
  let runner: string | undefined;
  const lockfiles: Array<[string, string]> = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lock', 'bun'],
    ['bun.lockb', 'bun'],
    ['package-lock.json', 'npm'],
    ['npm-shrinkwrap.json', 'npm'],
  ];
  if (manifest.packageManager !== undefined) {
    runner = packageManagerRunner(manifest.packageManager);
  } else {
    const detected = await Promise.all(
      lockfiles.map(async ([file, candidate]) =>
        (await governancePathExists(join(projectRoot, file))) ? candidate : undefined,
      ),
    );
    const unambiguous = detected.filter((candidate): candidate is string => candidate !== undefined);
    if (unambiguous.length === 1) runner = unambiguous[0];
  }
  return scripts.sort().map((script) => ({
    script,
    command: runner ? `${runner} run ${script}` : `unknown (package.json script: ${script})`,
  }));
}

async function projectGuideContent(projectRoot: string, commands: readonly ProjectCommand[]): Promise<string> {
  let projectName = basename(projectRoot);
  const manifest = await readProjectManifest(projectRoot);
  if (typeof manifest?.name === 'string' && manifest.name.length > 0) projectName = manifest.name;
  const entries = await readdir(projectRoot).catch(() => [] as string[]);
  const readme = entries.find((entry) => /^readme(?:\.[^.]+)?$/i.test(entry));
  const commandLines =
    commands.length > 0
      ? commands.map(({ script, command }) => `- ${script}: \`${command}\``).join('\n')
      : "- unknown: inspect this repository's manifests and CI configuration before running commands.";
  return `# ${projectName} project instructions\n\n## Project truth\n\n- ${readme ? `Read \`${readme}\` for project context.` : 'No README was discovered during setup.'}\n- Treat repository files and CI configuration as authoritative.\n\n## Discovered package scripts\n\n${commandLines}\n`;
}

async function fileAction(
  projectRoot: string,
  file: string,
  content: string,
  group: BootstrapAction['group'],
  reason: string,
): Promise<BootstrapAction> {
  const target = safeGovernanceTargetPath(projectRoot, file);
  if (!target) return { file, action: 'skipped', group, reason: 'path escapes project root' };
  if (await governancePathExists(target)) return { file, action: 'skipped', group, reason: 'file already exists' };
  if (await hasUnsafeGovernanceAncestor(projectRoot, target)) {
    return { file, action: 'skipped', group, reason: 'parent path is a symlink or non-directory' };
  }
  return { file, action: 'created', group, reason, content, contentHash: hashGovernanceContent(content) };
}

async function linkAction(projectRoot: string, file: string, source: string, reason: string): Promise<BootstrapAction> {
  const target = safeGovernanceTargetPath(projectRoot, file);
  if (!target) return { file, action: 'skipped', group: 'project-skills', reason: 'path escapes project root' };
  if (await governancePathExists(target)) {
    return { file, action: 'skipped', group: 'project-skills', reason: 'path already exists' };
  }
  if (await hasUnsafeGovernanceAncestor(projectRoot, target)) {
    return { file, action: 'skipped', group: 'project-skills', reason: 'parent path is a symlink or non-directory' };
  }
  return { file, action: 'symlinked', group: 'project-skills', reason, symlinkTarget: resolve(source) };
}

async function discoverSkillNames(catCafeRoot: string): Promise<Set<string>> {
  const sourceRoot = join(catCafeRoot, 'cat-cafe-skills');
  try {
    const entries = await readdir(sourceRoot, { withFileTypes: true });
    const names = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          try {
            return (await stat(join(sourceRoot, entry.name, 'SKILL.md'))).isFile() ? entry.name : null;
          } catch {
            return null;
          }
        }),
    );
    return new Set(names.filter((name): name is string => name !== null));
  } catch {
    return new Set();
  }
}

export async function planGovernanceInstall(
  catCafeRoot: string,
  targetProject: string,
  selection: GovernanceSelection,
): Promise<BootstrapAction[]> {
  const commands = await detectProjectCommands(targetProject);
  return [
    ...(await planProjectGuide(targetProject, selection, commands)),
    ...(await planProjectSkills(catCafeRoot, targetProject, selection)),
    ...(await planLifecycleDocs(targetProject, selection, commands)),
  ];
}

async function planProjectGuide(
  targetProject: string,
  selection: GovernanceSelection,
  commands: readonly ProjectCommand[],
): Promise<BootstrapAction[]> {
  if (!selection.projectGuide) return [];
  const actions: BootstrapAction[] = [];
  actions.push(
    await fileAction(
      targetProject,
      'AGENTS.md',
      await projectGuideContent(targetProject, commands),
      'project-guide',
      'canonical project guide generated from repository truth',
    ),
  );
  for (const provider of selection.projectGuide.thinEntrypoints) {
    const file = provider === 'claude' ? 'CLAUDE.md' : 'GEMINI.md';
    actions.push({
      ...(await fileAction(targetProject, file, '@AGENTS.md\n', 'project-guide', 'thin AGENTS.md import')),
    });
  }
  return actions;
}

async function planProjectSkills(
  catCafeRoot: string,
  targetProject: string,
  selection: GovernanceSelection,
): Promise<BootstrapAction[]> {
  const chosen = selection.projectSkills;
  if (!chosen || chosen.skillIds.length === 0) return [];
  const actions: BootstrapAction[] = [];
  const available = await discoverSkillNames(catCafeRoot);
  for (const provider of chosen.providers) {
    const skillsDir = PROVIDER_SKILLS_DIRS[provider];
    actions.push(
      await linkAction(
        targetProject,
        `${skillsDir}/${SHARED_REFS_ALIAS}`,
        join(catCafeRoot, 'cat-cafe-skills', 'refs'),
        'shared refs alias',
      ),
    );
    for (const skillId of chosen.skillIds) {
      const file = `${skillsDir}/${skillId}`;
      actions.push(
        available.has(skillId)
          ? await linkAction(
              targetProject,
              file,
              join(catCafeRoot, 'cat-cafe-skills', skillId),
              `selected Skill ${skillId}`,
            )
          : {
              file,
              action: 'skipped',
              group: 'project-skills',
              reason: 'selected Skill is not installed in Clowder AI',
            },
      );
    }
  }
  return actions;
}

async function planLifecycleDocs(
  targetProject: string,
  selection: GovernanceSelection,
  commands: readonly ProjectCommand[],
): Promise<BootstrapAction[]> {
  if (!selection.docsLifecycle) return [];
  return Promise.all(
    getMethodologyTemplates(commands).map((template) =>
      fileAction(targetProject, template.relativePath, template.content, 'docs-lifecycle', 'template generated'),
    ),
  );
}

export function createGovernanceReport(
  targetProject: string,
  selection: GovernanceSelection,
  actions: BootstrapAction[],
  dryRun: boolean,
): BootstrapReport {
  return {
    projectPath: targetProject,
    timestamp: Date.now(),
    packVersion: GOVERNANCE_PACK_VERSION,
    actions,
    dryRun,
    selection,
    previewChecksum: governancePreviewChecksum(selection, actions),
  };
}

export async function readLegacyGovernanceReport(targetProject: string): Promise<BootstrapReport | undefined> {
  try {
    const raw = JSON.parse(
      await readFile(join(targetProject, LEGACY_GOVERNANCE_REPORT), 'utf8'),
    ) as Partial<BootstrapReport>;
    if (!Array.isArray(raw.actions)) return undefined;
    const selection = normalizeGovernanceSelection(raw.selection);
    return {
      projectPath: targetProject,
      timestamp: raw.timestamp ?? 0,
      packVersion: raw.packVersion ?? 'legacy',
      actions: raw.actions,
      dryRun: false,
      selection,
      previewChecksum: raw.previewChecksum ?? governancePreviewChecksum(selection, raw.actions),
    };
  } catch {
    return undefined;
  }
}
