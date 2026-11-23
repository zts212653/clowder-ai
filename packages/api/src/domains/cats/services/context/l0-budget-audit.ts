import { dirname } from 'node:path';
import { catRegistry } from '@cat-cafe/shared';
import { renderFrozenL0Input } from '@cat-cafe/shared/l0-input';
import { readCatCatalogRaw } from '../../../../config/cat-catalog-store.js';
import { isCatAvailable, loadResolvedCatConfig } from '../../../../config/cat-config-loader.js';
import { resolveProjectTemplatePath } from '../../../../config/project-template-path.js';
import { estimateTokens } from '../../../../utils/token-counter.js';
import { captureInvocationL0Input } from '../agents/providers/l0-input-capture.js';

// This is the historic template regression reference, not a provider limit.
export const L0_REFERENCE_TOKENS = 6000;
/** Count the same owner projection used by the invocation capture, without returning its private text. */
export async function auditL0Budget(input: {
  projectRoot: string;
  userId: string;
  profileDir?: string;
  compilerCwd?: string;
}) {
  const templatePath = resolveProjectTemplatePath(input.projectRoot);
  if (readCatCatalogRaw(dirname(templatePath), { persistMigrations: false }) === null)
    throw new Error('runtime catalog unavailable');
  const catalog = loadResolvedCatConfig(templatePath, { persistMigrations: false });
  const revision = catRegistry.getRevision();
  const configs = Object.entries(catRegistry.getAllConfigs()).filter(([id]) => isCatAvailable(id, catalog));
  const profileDir = input.profileDir;
  const members: { catId: string; tokens: number }[] = [];
  for (const [catId, catConfig] of configs) {
    if (catRegistry.getRevision() !== revision) throw new Error('member registry changed during L0 audit');
    const snapshot = captureInvocationL0Input({
      catId,
      catConfig,
      userId: input.userId,
      ...(input.compilerCwd ? { compilerCwd: input.compilerCwd } : {}),
      readOnlyCatalog: true,
      ...(profileDir ? { profileRepository: { profileDir: () => profileDir } } : {}),
    });
    members.push({ catId, tokens: estimateTokens(renderFrozenL0Input(snapshot)) });
    // Tokenizing every member in one synchronous turn can stall unrelated API requests.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  if (catRegistry.getRevision() !== revision) throw new Error('member registry changed during L0 audit');
  members.sort((a, b) => b.tokens - a.tokens || a.catId.localeCompare(b.catId));
  return {
    tokenizer: 'o200k_base',
    modelSource: 'audit-process-environment-and-configuration',
    referenceTokens: L0_REFERENCE_TOKENS,
    profile: input.profileDir ? 'specified' : 'current-user',
    members,
  };
}
