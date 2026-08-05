/**
 * Test helpers for F32-a AgentRegistry migration.
 *
 * Provides createTestAgentRegistry() to convert the old
 * {claudeService, codexService, geminiService} pattern
 * to an AgentRegistry instance.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let sharedTestGlobalConfigRoot = null;
let legacyRoutingTemplatePath = null;

function ensureTestGlobalConfigRoot() {
  if (!process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT) {
    if (!sharedTestGlobalConfigRoot) {
      sharedTestGlobalConfigRoot = mkdtempSync(join(tmpdir(), 'cat-cafe-agent-registry-'));
      process.on('exit', () => {
        if (sharedTestGlobalConfigRoot) {
          rmSync(sharedTestGlobalConfigRoot, { recursive: true, force: true });
        }
      });
    }
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = sharedTestGlobalConfigRoot;
  }
}

/**
 * Ensure catRegistry has all runtime cats registered.
 * Safe to call multiple times (skips if already registered).
 *
 * When the --import setup-cat-registry.js hook has already populated the
 * registry, this is a no-op.  Otherwise falls back to loadCatConfig() using
 * the explicit CAT_TEMPLATE_PATH set by the hook (resolves via dirname to
 * avoid stale catalog overlays).
 */
export async function ensureCatRegistryPopulated() {
  const { catRegistry } = await import('@cat-cafe/shared');
  // setup-cat-registry.js (--import hook) already registered all cats
  if (catRegistry.has('opus')) return;
  const { loadCatConfig, toAllCatConfigs } = await import('../../dist/config/cat-config-loader.js');
  const templatePath = process.env.CAT_TEMPLATE_PATH;
  const allConfigs = toAllCatConfigs(loadCatConfig(templatePath));
  for (const [id, config] of Object.entries(allConfigs)) {
    if (!catRegistry.has(id)) {
      catRegistry.register(id, config);
    }
  }
}

/**
 * Create an AgentRegistry from individual service instances.
 * Drop-in replacement for the old AgentRouter constructor pattern.
 */
export async function createTestAgentRegistry(services) {
  const { AgentRegistry } = await import('../../dist/domains/cats/services/agents/registry/AgentRegistry.js');
  const registry = new AgentRegistry();
  if (services.claudeService) registry.register('opus', services.claudeService);
  if (services.codexService) registry.register('codex', services.codexService);
  if (services.geminiService) registry.register('gemini', services.geminiService);
  return registry;
}

/**
 * Convert old-style AgentRouter options to new format.
 * Usage:
 *   const router = new AgentRouter(await migrateRouterOpts({
 *     claudeService, codexService, geminiService,
 *     registry, messageStore, ...rest
 *   }));
 */
export async function migrateRouterOpts(oldOpts) {
  ensureTestGlobalConfigRoot();
  const { resetMigrationState } = await import('../../dist/config/catalog-accounts.js');
  await ensureLegacyRoutingConfig();
  resetMigrationState();
  await ensureCatRegistryPopulated();
  const { claudeService, codexService, geminiService, ...rest } = oldOpts;
  const agentRegistry = await createTestAgentRegistry({ claudeService, codexService, geminiService });
  return { agentRegistry, ...rest };
}

/**
 * The old-style router fixtures intentionally exercise the pre-variant F32
 * contract where the mock Claude service is registered as `opus`. Keep that
 * fixture isolated from the public template's disabled legacy member so these
 * historical tests do not mask the canonical successor-routing tests.
 */
async function ensureLegacyRoutingConfig() {
  if (legacyRoutingTemplatePath) return;
  const templatePath = process.env.CAT_TEMPLATE_PATH;
  if (!templatePath) return;
  const template = JSON.parse(readFileSync(templatePath, 'utf8'));
  const ragdoll = template.breeds?.find((breed) => breed.id === 'ragdoll');
  if (ragdoll) {
    ragdoll.defaultVariantId = 'opus-default';
    ragdoll.variants = ragdoll.variants?.filter((variant) => variant.id !== 'opus-5');
  }
  if (template.roster?.opus) {
    template.roster.opus.available = true;
    delete template.roster.opus.successor;
  }
  if (template.roster) delete template.roster['opus-5'];
  const legacyDir = mkdtempSync(join(tmpdir(), 'cat-cafe-legacy-router-'));
  legacyRoutingTemplatePath = join(legacyDir, 'cat-template.json');
  writeFileSync(legacyRoutingTemplatePath, JSON.stringify(template, null, 2));
  process.env.CAT_TEMPLATE_PATH = legacyRoutingTemplatePath;
  const { catRegistry } = await import('@cat-cafe/shared');
  const { _resetCachedConfig, loadCatConfig, toAllCatConfigs } = await import('../../dist/config/cat-config-loader.js');
  _resetCachedConfig();
  catRegistry.reset();
  for (const [id, config] of Object.entries(toAllCatConfigs(loadCatConfig(legacyRoutingTemplatePath)))) {
    catRegistry.register(id, config);
  }
  process.on('exit', () => {
    if (legacyRoutingTemplatePath) {
      rmSync(legacyRoutingTemplatePath, { force: true });
    }
  });
}
