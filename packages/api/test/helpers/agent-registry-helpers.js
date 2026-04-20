/**
 * Test helpers for F32-a AgentRegistry migration.
 *
 * Provides createTestAgentRegistry() to convert the old
 * {claudeService, codexService, geminiService} pattern
 * to an AgentRegistry instance.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let sharedTestGlobalConfigRoot = null;

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
 * Ensure catRegistry has the three built-in cats registered.
 * Safe to call multiple times (skips if already registered).
 */
export async function ensureCatRegistryPopulated() {
  const { catRegistry, CAT_CONFIGS } = await import('@cat-cafe/shared');
  for (const [id, config] of Object.entries(CAT_CONFIGS)) {
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
  resetMigrationState();
  await ensureCatRegistryPopulated();
  const { claudeService, codexService, geminiService, ...rest } = oldOpts;
  const agentRegistry = await createTestAgentRegistry({ claudeService, codexService, geminiService });
  return { agentRegistry, ...rest };
}
