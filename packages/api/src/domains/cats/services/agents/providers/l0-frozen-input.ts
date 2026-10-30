/**
 * W2/C06: frozen input for the L0 compile subprocess.
 *
 * Without it, the child bootstraps the member registry from disk when it runs,
 * which is after admission and after any provider wait: an edit landing in
 * between changed the compiled identity/roster of an already-admitted
 * invocation (while its model/effort stayed frozen). With it, the parent passes
 * the admitted, non-credential member snapshot and the child only renders it.
 *
 * Contents are private project/role context: written to a private temp file
 * for the child and removed after the compile; never logged.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type CatConfig, type CoCreatorConfig, catRegistry } from '@cat-cafe/shared';
import { getCoCreatorConfig, isCatAvailable } from '../../../../../config/cat-config-loader.js';
import { getCatModel } from '../../../../../config/cat-models.js';

export const FROZEN_L0_INPUT_VERSION = 1;

export interface FrozenL0Input {
  readonly version: typeof FROZEN_L0_INPUT_VERSION;
  readonly configs: Readonly<Record<string, CatConfig>>;
  /** Members routable as teammates at admission. */
  readonly availableIds: readonly string[];
  /** Runtime model per member as advertised in the roster (env override applied). */
  readonly models: Readonly<Record<string, string>>;
  readonly coCreator: CoCreatorConfig;
}

/** Synchronous: capture in the same tick as the binding's catConfig read. */
export function freezeL0Input(): FrozenL0Input {
  const configs = catRegistry.getAllConfigs();
  const models: Record<string, string> = {};
  for (const [id, config] of Object.entries(configs)) {
    try {
      models[id] = getCatModel(id, config.defaultModel);
    } catch {
      models[id] = config.defaultModel ?? '';
    }
  }
  return Object.freeze({
    version: FROZEN_L0_INPUT_VERSION,
    configs: structuredClone(configs),
    availableIds: Object.keys(configs).filter((id) => isCatAvailable(id)),
    models,
    coCreator: structuredClone(getCoCreatorConfig()),
  });
}

/** Cache-key component: same snapshot → same compile; any identity input change → new key. */
export function frozenL0InputDigest(input: FrozenL0Input): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

/** Writes the snapshot for one compile; the returned dispose removes it. */
export function writeFrozenL0Input(input: FrozenL0Input): { path: string; dispose(): void } {
  const directory = mkdtempSync(join(tmpdir(), 'cat-cafe-l0-input-'));
  const path = join(directory, 'input.json');
  writeFileSync(path, JSON.stringify(input), { encoding: 'utf8', mode: 0o600 });
  return { path, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}
