#!/usr/bin/env node
import { Console } from 'node:console';
/** L0 CLI: diagnostics capture live inputs; invocation mode renders only the parent-owned snapshot. */
import { createHash } from 'node:crypto';
import { realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { catRegistry, resolveL0Projections } from '@cat-cafe/shared';
import { parseFrozenL0Input, renderFrozenL0Input } from '@cat-cafe/shared/l0-input';
import { captureFrozenL0Input, resolveL0OverlayRoot } from '@cat-cafe/shared/l0-input-capture';
import { DEFAULT_PROFILE_USER_ID, profileUserRelativePath } from '@cat-cafe/shared/profile-contract';

export { resolveRelationshipKey, resolveUserCapsule } from '@cat-cafe/shared/l0-input-capture';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function isCliEntrypoint(metaUrl, argv1) {
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(resolve(argv1));
  } catch {
    return false;
  }
}

export function filterAvailableTeammates(allConfigs, currentCatId, isAvailableFn) {
  return Object.entries(allConfigs).filter(([id]) => id !== currentCatId && isAvailableFn(id));
}

/** Diagnostic only. These API imports are never reached by --frozen-input. */
async function diagnosticContext() {
  const { loadCatConfig, toAllCatConfigs, isCatAvailable, getCoCreatorConfig } = await import(
    '../packages/api/dist/config/cat-config-loader.js'
  );
  const { getCatModel } = await import('../packages/api/dist/config/cat-models.js');
  const config = loadCatConfig();
  Object.entries(toAllCatConfigs(config)).forEach(([id, member]) => {
    if (!catRegistry.has(id)) catRegistry.register(id, member);
  });
  return { config, isCatAvailable, getCatModel, getCoCreatorConfig };
}

export async function getAvailableL0CatIds() {
  const context = await diagnosticContext();
  return Object.keys(catRegistry.getAllConfigs()).filter((id) => context.isCatAvailable(id, context.config));
}

async function captureDiagnosticL0(options) {
  const { catId, projection = 'owner', dossierRoot = REPO_ROOT } = options;
  if (!resolveL0Projections().includes(projection))
    throw new Error(`compileL0: unsupported projection "${projection}"`);
  const context = await diagnosticContext();
  const entry = catRegistry.tryGet(catId);
  if (!entry) throw new Error(`compileL0: unknown catId "${catId}". Registered: ${catRegistry.getAllIds().join(', ')}`);
  if (projection === 'scoped-member')
    return captureFrozenL0Input({
      catId,
      projection,
      member: entry.config,
      model: options.runtimeModel || context.getCatModel(catId),
      installRoot: REPO_ROOT,
    });
  const all = catRegistry.getAllConfigs();
  const content = {
    catId,
    member: entry.config,
    model: projection === 'public' ? '' : options.runtimeModel || context.getCatModel(catId),
    projection,
    teammates:
      projection === 'public'
        ? []
        : filterAvailableTeammates(all, catId, (id) => context.isCatAvailable(id, context.config)).map(
            ([id, member]) => ({ catId: id, config: member, model: context.getCatModel(id) }),
          ),
    coCreator: projection === 'public' ? { name: '', mentionPatterns: [] } : context.getCoCreatorConfig(context.config),
    installRoot: REPO_ROOT,
    overlayRoot: resolveL0OverlayRoot(),
    dossierRoot,
  };
  if (projection === 'public') return captureFrozenL0Input(content);
  const { loadCompiledGovernanceL0Sync } = await import(
    '../packages/api/dist/domains/cats/services/context/governance-l0.js'
  );
  const dataDir = resolve(process.env.CAT_CAFE_DATA_DIR ?? resolve(homedir(), '.cat-cafe'));
  return captureFrozenL0Input({
    ...content,
    profileDir: options.profileDir ?? resolve(dataDir, ...profileUserRelativePath(DEFAULT_PROFILE_USER_ID).split('/')),
    governanceText: loadCompiledGovernanceL0Sync(REPO_ROOT).content,
  });
}

/** Live diagnostic/library compatibility entry; actual provider calls must supply a frozen DTO. */
export async function compileL0(options) {
  return renderFrozenL0Input(await captureDiagnosticL0(options));
}

export async function writeL0File(options, outPath) {
  const compiled = await compileL0(options);
  writeFileSync(outPath, compiled, 'utf8');
  return compiled;
}

if (isCliEntrypoint(import.meta.url, process.argv[1])) {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const outPath = outIdx >= 0 ? args[outIdx + 1] : undefined;
  let snapshot;
  if (args.includes('--frozen-input')) {
    // Private bytes use the existing child pipe, never argv, context logs or a shared temp file.
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    snapshot = parseFrozenL0Input(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } else {
    const value = (flag) => {
      const index = args.indexOf(flag);
      return index >= 0 ? args[index + 1] : undefined;
    };
    const catId = value('--cat');
    if (!catId) {
      console.error(
        `Usage: node scripts/compile-system-prompt-l0.mjs --frozen-input | --cat <catId> [--out <path>] [--profile-dir <path>] [--projection ${resolveL0Projections().join('|')}]`,
      );
      process.exit(2);
    }
    const projection = value('--projection') ?? 'owner';
    if (!resolveL0Projections().includes(projection))
      throw new Error(`compileL0: unsupported projection "${projection}"`);
    // Import the API bridge first, then keep all diagnostic console output on stderr in this CLI only.
    await import('../packages/api/dist/infrastructure/logger.js');
    const diagnosticConsole = new Console({ stdout: process.stderr, stderr: process.stderr });
    for (const method of ['log', 'info', 'warn', 'error', 'debug'])
      console[method] = diagnosticConsole[method].bind(diagnosticConsole);
    snapshot = await captureDiagnosticL0({
      catId,
      profileDir: value('--profile-dir'),
      projection,
      runtimeModel: value('--runtime-model'),
    });
    const { memberConfigurationRevision } = await import('../packages/api/dist/config/member-config-revision.js');
    const { resolveActiveProjectRoot } = await import('../packages/api/dist/utils/active-project-root.js');
    const revision =
      memberConfigurationRevision(resolveActiveProjectRoot(), catId) ??
      createHash('sha256')
        .update(JSON.stringify(catRegistry.getOrThrow(catId).config))
        .digest('hex');
    // API imports route console.error through a stdout logger; keep diagnostic bytes on stderr.
    process.stderr.write(`Live L0 diagnostic: configurationRevision=${revision} inputDigest=${snapshot.inputDigest}\n`);
  }
  // Frozen input keeps the captured projection; edition policy also applies to the stdin entry.
  if (!resolveL0Projections().includes(snapshot.projection))
    throw new Error(`compileL0: unsupported projection "${snapshot.projection}"`);
  const compiled = renderFrozenL0Input(snapshot);
  if (outPath) writeFileSync(outPath, compiled, 'utf8');
  else process.stdout.write(compiled);
}
