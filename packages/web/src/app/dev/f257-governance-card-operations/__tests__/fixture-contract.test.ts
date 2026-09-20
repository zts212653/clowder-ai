import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ADD_CHANGE, DISABLE_CHANGE, ENABLE_NOOP_CHANGE, MODIFY_CHANGE, SCENARIOS } from '../fixtures';

/**
 * These fixtures are only useful if the executor could really have produced
 * them. `satisfies` proves shape, not producibility, so every semantic gate the
 * production path applies is asserted here against the repository itself.
 *
 * The previous version of this file passed 7/7 while ADD_CHANGE collided with
 * R1 at per-turn/2200, because it encoded part of
 * HarnessUnitDirectoryWriter.validate and none of
 * HarnessGovernanceExecutor.validateAdd — which runs first. A guard that only
 * covers the gate you remembered is the same failure as no guard, so both are
 * encoded below and named after their source.
 *
 * Parsing note: hook manifests are flat scalars, safe to read with anchored
 * line regexes. The unit manifest mixes block (`- unitId:`) and flow
 * (`- { unitId: ... }`) item styles, and an earlier hand-rolled parse of it
 * silently merged flow items into the preceding block item and produced
 * confident garbage. It is therefore parsed with self-checks that fail loudly
 * on merged or dropped items rather than trusting the split.
 */

const REPO_ROOT = resolve(__dirname, '../../../../../../..');
const UNIT_MANIFEST = resolve(REPO_ROOT, 'docs/harness-feedback/objectives/unit-evaluation-manifest.yaml');
const OBJECTIVE_REGISTRY = resolve(REPO_ROOT, 'docs/harness-feedback/objectives/registry.yaml');
const HOOKS_ROOT = resolve(REPO_ROOT, 'assets/prompt-hooks');

interface ParsedUnit {
  unitId: string;
  hookId: string;
  objectiveIds: string[];
}

interface ParsedHook {
  dir: string;
  id: string;
  stage: string;
  order: number;
  safetyTier: string;
  disableable: boolean;
}

function parseUnitManifest(): ParsedUnit[] {
  const raw = readFileSync(UNIT_MANIFEST, 'utf8');
  const items = raw
    .slice(raw.indexOf('\nunits:'))
    .split(/\n {2}- +/)
    .slice(1);
  return items.map((item) => {
    const ids = item.match(/unitId:/g) ?? [];
    // Two unitIds in one item means the split merged two entries — the exact
    // way the earlier parser lied.
    if (ids.length !== 1) throw new Error(`unit_manifest_item_not_atomic:${ids.length}:${item.slice(0, 60)}`);
    const unitId = /unitId:\s*([A-Za-z0-9_-]+)/.exec(item)?.[1];
    const hookId = /hookId:\s*([A-Za-z0-9_-]+)/.exec(item)?.[1];
    if (!unitId || !hookId) throw new Error(`unit_manifest_item_incomplete:${item.slice(0, 60)}`);
    return { unitId, hookId, objectiveIds: [...item.matchAll(/objectiveId:\s*([A-Za-z0-9_-]+)/g)].map((m) => m[1]) };
  });
}

function parseHooks(): ParsedHook[] {
  return readdirSync(HOOKS_ROOT)
    .filter((dir) => !dir.startsWith('.') && dir !== 'README.md')
    .map((dir) => {
      const raw = readFileSync(resolve(HOOKS_ROOT, dir, 'hook.yaml'), 'utf8');
      const pick = (key: string) => new RegExp(`^${key}:\\s*(\\S+)\\s*$`, 'm').exec(raw)?.[1];
      const id = pick('id');
      const stage = pick('stage');
      const order = pick('order');
      const safetyTier = pick('safetyTier');
      const disableable = pick('disableable');
      if (!id || !stage || !order || !safetyTier || !disableable) {
        throw new Error(`hook_manifest_incomplete:${dir}`);
      }
      return { dir, id, stage, order: Number(order), safetyTier, disableable: disableable === 'true' };
    });
}

function objectiveLifecycles(): Map<string, string> {
  const raw = readFileSync(OBJECTIVE_REGISTRY, 'utf8');
  const map = new Map<string, string>();
  for (const line of raw.split('\n')) {
    const id = /^\s*-\s*\{\s*id:\s*([a-z0-9-]+)/.exec(line)?.[1];
    if (!id) continue;
    map.set(id, /lifecycle:\s*([a-z]+)/.exec(line)?.[1] ?? 'active');
  }
  return map;
}

function membersOf(objectiveId: string): string[] {
  return parseUnitManifest()
    .filter((unit) => unit.objectiveIds.includes(objectiveId))
    .map((unit) => unit.unitId)
    .sort();
}

describe('F257 governance fixture contract', () => {
  it('parses both manifests atomically before asserting anything from them', () => {
    const units = parseUnitManifest();
    expect(units).toHaveLength((readFileSync(UNIT_MANIFEST, 'utf8').match(/unitId:/g) ?? []).length);
    expect(new Set(units.map((unit) => unit.unitId)).size).toBe(units.length);
    expect(units.every((unit) => unit.objectiveIds.length > 0)).toBe(true);
    const hooks = parseHooks();
    expect(hooks.length).toBeGreaterThan(0);
    expect(new Set(hooks.map((hook) => hook.id)).size).toBe(hooks.length);
    expect(objectiveLifecycles().size).toBeGreaterThan(0);
  });

  // --- HarnessGovernanceExecutor.validateAdd -------------------------------
  it('keeps the added unit free of any registry collision', () => {
    const hooks = parseHooks();
    expect(hooks.some((hook) => hook.id === ADD_CHANGE.unitId)).toBe(false);
    const sameCoordinate = hooks.filter(
      (hook) => hook.stage === ADD_CHANGE.manifest.stage && hook.order === ADD_CHANGE.manifest.order,
    );
    expect(sameCoordinate).toEqual([]);
    expect(parseUnitManifest().some((unit) => unit.unitId === ADD_CHANGE.unitId)).toBe(false);
  });

  // --- HarnessUnitDirectoryWriter.validate ---------------------------------
  it('satisfies every writer rule for the add draft', () => {
    expect(ADD_CHANGE.unitId).toMatch(/^[A-Z]+\d+$/u);
    expect(ADD_CHANGE.manifest.id).toBe(ADD_CHANGE.unitId);
    expect(ADD_CHANGE.assetSlug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
    expect(ADD_CHANGE.assetSlug.startsWith(ADD_CHANGE.unitId.toLowerCase())).toBe(true);
    expect(parseUnitManifest().some((unit) => unit.hookId === ADD_CHANGE.assetSlug)).toBe(false);
    expect(ADD_CHANGE.manifest.template).toBe(ADD_CHANGE.manifest.template.split('/').pop());
    expect(ADD_CHANGE.manifest.template.endsWith('.md')).toBe(true);
    expect(ADD_CHANGE.manifest.version).toBe(1);
    expect('resolver' in ADD_CHANGE.manifest).toBe(false);
    expect(ADD_CHANGE.content.trim().length).toBeGreaterThan(0);
    expect(ADD_CHANGE.objectives).toHaveLength(1);
    expect('clauseId' in ADD_CHANGE.objectives[0]).toBe(false);
    // objectiveExists: present AND not retired.
    expect(objectiveLifecycles().get(ADD_CHANGE.objectives[0].objectiveId)).toBe('active');
    // hydrateAdd emits hookId = unitId, not the asset slug.
    expect(ADD_CHANGE.hookId).toBe(ADD_CHANGE.unitId);
  });

  // --- hydrateEnablement ---------------------------------------------------
  it('only disables a unit whose manifest allows it', () => {
    const hooks = parseHooks();
    expect(hooks.find((hook) => hook.id === DISABLE_CHANGE.unitId)?.disableable).toBe(true);
    // The unit the first attempt used must stay excluded for the stated reason.
    expect(hooks.find((hook) => hook.id === 'L4')?.disableable).toBe(false);
  });

  it('derives remainingMemberCount from the manifest rather than by hand', () => {
    for (const change of [DISABLE_CHANGE, ENABLE_NOOP_CHANGE]) {
      const remaining = membersOf(change.objectiveImpact.objectiveId).filter((unitId) => unitId !== change.unitId);
      expect(change.objectiveImpact.remainingMemberCount).toBe(remaining.length);
      expect(membersOf(change.objectiveImpact.objectiveId)).toContain(change.unitId);
      expect(objectiveLifecycles().get(change.objectiveImpact.objectiveId)).toBe('active');
    }
  });

  // --- hydrateModify -------------------------------------------------------
  it('only modifies a unit that is registered and not readonly', () => {
    expect(parseUnitManifest().some((unit) => unit.unitId === MODIFY_CHANGE.unitId)).toBe(true);
    expect(parseHooks().find((hook) => hook.id === MODIFY_CHANGE.unitId)?.safetyTier).not.toBe('readonly');
  });

  it('exposes one scenario per artifact operation without duplicates', () => {
    expect(SCENARIOS.map((scenario) => scenario.change.action)).toEqual(['add', 'disable', 'enable', 'modify']);
    expect(new Set(SCENARIOS.map((scenario) => scenario.id)).size).toBe(SCENARIOS.length);
  });
});
