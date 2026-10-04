/**
 * F300 Task 2.1 — F041 capability read service.
 *
 * One read path for "what capabilities does this home have", used by the
 * Console board (`GET /api/capabilities`) and by cats (`GET
 * /api/capabilities/snapshot` → MCP `cat_cafe_capabilities_snapshot`).
 *
 * It never bootstraps, migrates on disk, or writes back: the config arrives
 * already loaded, and a missing config is answered as `absent`, not created.
 * The Console route keeps its writer duties (bootstrap, heal, CLI config,
 * skill sync, discovery) and then reads through here, so the two entries
 * cannot compute different answers for the same source state.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type {
  CapabilityBoardItem,
  CapabilityReadEnvelope,
  CapabilityReadScope,
  CapabilitySnapshotResponse,
  SkillHealthSummary,
} from '@cat-cafe/shared';
import { catRegistry, STANDARD_MOUNT_POINT_IDS } from '@cat-cafe/shared';
import type { CapabilitiesConfigState } from '../../config/capabilities/capability-orchestrator.js';
import { readCapabilitiesConfigState } from '../../config/capabilities/capability-orchestrator.js';
import { resolveMountRulesFromConfigs } from '../../config/mount/mount-rules-store.js';
import {
  parseManifestSkillMetaState,
  readSkillMetaState,
  resolveSkillMcpStatuses,
  type SkillMeta,
} from '../../skills/skill-meta.js';
import { pathsEqual } from '../../utils/project-path.js';
import { inspectSkillMountAtPoint } from '../../utils/skill-mount.js';
import { resolveCatCafeSkillsSource } from '../../utils/skill-source.js';
import {
  buildBoardMcpServer,
  CAT_CAFE_SKILLS_SRC,
  describeMcpCapability,
  listSkillSubdirsState,
  scanProjectSkillSources,
  sortBoardItems,
} from './capability-board-parts.js';
import { buildMountHealth } from './capability-mount-health.js';
import { applyMcpProbe, type McpProbeResolver } from './capability-probe-overlay.js';
import { assembleBoard, sourceRevisionOf } from './capability-read-projection.js';

export type { McpProbeResolver } from './capability-probe-overlay.js';

export interface CapabilityReadRequest {
  /** Already validated; the service does not resolve or authorize paths. */
  readonly projectRoot: string;
  /** The home's own root (global view). */
  readonly mainRoot: string;
  /** `true` when the caller named a project; toggles derive from blockedCats only (F249). */
  readonly isProjectView: boolean;
  /** Loaded by the caller with `readCapabilitiesConfigState`; never re-read or created here. */
  readonly config: CapabilitiesConfigState;
  readonly scope: CapabilityReadScope;
  /** Console-only (F062): launch fields and secret values. Ignored for member scope. */
  readonly secrets?: { readonly launchFields: boolean; readonly values: boolean };
  /** Owner resolvers for live facts outside capabilities.json. Absent = not observed. */
  readonly resolvers?: { readonly probeMcp?: McpProbeResolver };
  readonly now?: () => number;
}

export async function readCapabilitySnapshot(request: CapabilityReadRequest): Promise<CapabilitySnapshotResponse> {
  const now = request.now ?? Date.now;
  const { projectRoot, mainRoot, config, scope } = request;
  const isExternalProject = !pathsEqual(projectRoot, mainRoot);
  // Always load global config for external projects so newly discovered skills
  // inherit global disabled state. It is a source of this answer, so its state
  // (including "unreadable") is named in sourceRefs rather than silently dropped.
  const globalState = isExternalProject ? await readCapabilitiesConfigState(mainRoot) : null;
  const configRefs = [configRef(config), ...(globalState ? [configRef(globalState)] : [])];
  const invalidators = [config, ...(globalState ? [globalState] : [])].map((state) => ({
    ownerRef: 'F041',
    ref: `file:${state.path}`,
  }));
  const envelopeBase = {
    subjectRef: `capabilities:project:${projectRoot}`,
    ownerRef: 'F041' as const,
    visibility: scope.kind === 'member' ? ('member_private' as const) : ('authorized_shared' as const),
  };

  const unknownFrom = (
    state: Extract<CapabilitiesConfigState, { kind: 'unreadable' }>,
    reason: 'config_unreadable' | 'global_config_unreadable',
  ): CapabilitySnapshotResponse => ({
    status: 'unknown',
    reason,
    cause: state.cause,
    scope,
    envelope: {
      ...envelopeBase,
      sourceRefs: configRefs,
      revision: reason,
      freshness: { observedAt: now(), invalidators },
    },
  });

  if (config.kind === 'absent') {
    const envelope: CapabilityReadEnvelope = {
      ...envelopeBase,
      sourceRefs: configRefs,
      revision: 'config_missing',
      freshness: { observedAt: now(), invalidators },
    };
    return { status: 'absent', reason: 'config_missing', scope, envelope };
  }
  if (config.kind === 'unreadable') return unknownFrom(config, 'config_unreadable');
  // An external project inherits policy (globalEnabled, default mount rules,
  // new-skill defaults) from the home config. If that owner cannot be read, the
  // answer is unknown — not the project's stale local copy (review R1 P1-2).
  if (globalState?.kind === 'unreadable') return unknownFrom(globalState, 'global_config_unreadable');

  // `absent` home config is a fact (no inherited policy); only `present` feeds it.
  const globalConfig = globalState?.kind === 'present' ? globalState.config : null;
  const secrets = scope.kind === 'console' ? request.secrets : undefined;
  const home = homedir();
  // Every field is computed from the configs loaded above, never a second read
  // of the same file that could be a different version (review R1 P1-3).
  const mountRules = resolveMountRulesFromConfigs(config.config, isExternalProject ? globalConfig : config.config);
  const enabledMountPoints = STANDARD_MOUNT_POINT_IDS.filter((id) => mountRules.mountPoints[id].enabled);
  const scan = await scanProjectSkillSources(projectRoot, home, mountRules);
  const { customMountTargets, projectSkillsDir, mountPointSkills, catCafeOwnSkills, allSkillNames } = scan;
  // Everything that exists but could not be read; empty = the scan is complete.
  const gaps: string[] = [...scan.gaps];
  // Dir existence (not skill count): an existing-but-empty source is not "missing".
  const hasProjectCatCafeSkillsDir = catCafeOwnSkills !== null && existsSync(CAT_CAFE_SKILLS_SRC);

  // Categories + registration must be parsed from the SAME root used for mount checks.
  const mainSkillsSrc = await resolveCatCafeSkillsSource();
  const mountSkillsSrc = hasProjectCatCafeSkillsDir ? CAT_CAFE_SKILLS_SRC : mainSkillsSrc;
  const manifestState = await parseManifestSkillMetaState(mountSkillsSrc);
  if (manifestState.kind === 'unreadable') gaps.push(`${manifestState.errno ?? 'EUNKNOWN'}:${manifestState.path}`);
  const manifestMetaMap = manifestState.kind === 'present' ? manifestState.meta : new Map<string, SkillMeta>();
  const skillMetaMap = await readProjectSkillMeta(projectRoot, projectSkillsDir, allSkillNames, gaps);
  const mergedMetaForMcp = new Map(manifestMetaMap);
  for (const [name, meta] of skillMetaMap) {
    if (!mergedMetaForMcp.has(name)) mergedMetaForMcp.set(name, meta);
  }
  const mcpStatuses = await resolveSkillMcpStatuses(projectRoot, mergedMetaForMcp, config.config);

  const catIds = catRegistry.getAllIds().map((id) => id as string);
  const items: CapabilityBoardItem[] = [];
  const globalMcpMap = new Map(
    (globalConfig?.capabilities ?? []).filter((c) => c.type === 'mcp').map((c) => [c.id, c] as const),
  );
  for (const cap of config.config.capabilities) {
    if (cap.type !== 'mcp') continue;
    // F249 Bug 3: external projects without a project-level override inherit globalEnabled.
    const inheritFromGlobal = isExternalProject && cap.blockedCats === undefined;
    const globalCap = inheritFromGlobal ? globalMcpMap.get(cap.id) : undefined;
    const effectiveGlobalEnabled = globalCap ? (globalCap.globalEnabled ?? true) : (cap.globalEnabled ?? true);
    const baseCap = !request.isProjectView && inheritFromGlobal && globalCap ? globalCap : cap;
    const cats: Record<string, boolean> = {};
    for (const catId of catIds) cats[catId] = !(baseCap.blockedCats?.includes(catId) ?? false);
    const catValues = Object.values(cats);
    const projectEnabled = request.isProjectView
      ? catValues.length > 0
        ? catValues.some(Boolean)
        : true
      : effectiveGlobalEnabled;
    const mcpItem: CapabilityBoardItem = {
      id: cap.id,
      type: 'mcp',
      source: cap.source,
      enabled: projectEnabled,
      globalEnabled: effectiveGlobalEnabled,
      cats,
      mcpServer: await buildBoardMcpServer(cap, {
        includeLaunchFields: secrets?.launchFields ?? false,
        includeSecrets: secrets?.values ?? false,
      }),
      layer: 'L1',
      pluginId: cap.pluginId,
      blockedCats: cap.blockedCats,
      hasOverride: cap.mcpServerOverride !== undefined,
      ...(cap.ecosystem && { ecosystem: cap.ecosystem }),
      ...(cap.lockVersion && { lockVersion: cap.lockVersion }),
      ...(cap.discoveredFrom && { discoveredFrom: cap.discoveredFrom }),
    };
    const mcpDesc = describeMcpCapability(cap);
    if (mcpDesc) mcpItem.description = mcpDesc;
    items.push(mcpItem);
  }

  for (const cap of config.config.capabilities) {
    if (cap.type !== 'skill') continue;
    const cats: Record<string, boolean> = {};
    for (const catId of catIds) {
      const provider = catRegistry.tryGet(catId)?.config.clientId ?? 'unknown';
      // Sparse cats: omit irrelevant cats so frontend filter works
      if (!(mountPointSkills[provider] ?? []).includes(cap.id)) continue;
      cats[catId] = cap.globalEnabled ?? true;
    }
    const skillItem: CapabilityBoardItem = {
      id: cap.id,
      type: 'skill',
      source: cap.source,
      enabled: cap.globalEnabled ?? true,
      globalEnabled: cap.globalEnabled ?? true,
      cats,
      layer: cap.source === 'external' ? 'L3' : 'L2',
      pluginId: cap.pluginId,
      mountPaths: cap.mountPaths,
    };
    let meta =
      cap.source === 'cat-cafe' ? (manifestMetaMap.get(cap.id) ?? skillMetaMap.get(cap.id)) : skillMetaMap.get(cap.id);
    // Plugin skills store their source path; relative paths are relative to projectRoot.
    if (!meta?.description && cap.skillsSource) {
      const pluginMeta = await readSkillMetaState(join(resolveSkillsSource(projectRoot, cap.skillsSource), cap.id));
      if (pluginMeta.kind === 'unreadable') gaps.push(`${pluginMeta.errno ?? 'EUNKNOWN'}:${pluginMeta.path}`);
      if (pluginMeta.kind === 'present') meta = pluginMeta.meta;
    }
    if (meta?.description) skillItem.description = meta.description;
    if (meta?.triggers) skillItem.triggers = meta.triggers;
    if (meta?.requiresMcp?.length) {
      skillItem.requiresMcp = meta.requiresMcp.map((id) => mcpStatuses.get(id) ?? { id, status: 'missing' as const });
    }
    const manifestCategory = manifestMetaMap.get(cap.id)?.category;
    if (manifestCategory) skillItem.category = manifestCategory;
    else if (meta?.category) skillItem.category = meta.category;
    items.push(skillItem);
  }

  let sourceListing = catCafeOwnSkills;
  if (mountSkillsSrc !== CAT_CAFE_SKILLS_SRC) {
    const listing = await listSkillSubdirsState(mountSkillsSrc);
    gaps.push(...listing.gaps);
    sourceListing = listing.names;
  }
  const mountSourceNames = new Set(sourceListing ?? []);
  const mountHealth = await buildMountHealth({
    projectRoot,
    capabilities: config.config.capabilities,
    items,
    mountRules,
    enabledMountPoints,
    customMountTargets,
    mountSkillsSrc,
    mainSkillsSrc,
    mountSourceNames,
    inspectSkillMountAtPoint,
    gaps,
  });
  // A partial read is still reported, but says so and names what it could not
  // read — "environment problem at X", not "no such skill" (review R1 P1-4).
  const unreadablePaths = [...new Set(gaps)].sort();
  const skillHealth: SkillHealthSummary = {
    ...mountHealth,
    scanComplete: unreadablePaths.length === 0,
    ...(unreadablePaths.length > 0 ? { unreadable: unreadablePaths } : {}),
  };

  sortBoardItems(items);
  // Before scoping and before live probe results: see sourceRevisionOf.
  const revision = sourceRevisionOf({ configRefs, presence: mountPointSkills, items, health: skillHealth });

  if (request.resolvers?.probeMcp) {
    await applyMcpProbe(items, config.config.capabilities, request.resolvers.probeMcp);
  }

  const envelope: CapabilityReadEnvelope = {
    ...envelopeBase,
    sourceRefs: [...configRefs, `dir:${mountSkillsSrc}`],
    revision,
    freshness: {
      observedAt: now(),
      invalidators: [...invalidators, { ownerRef: 'F041', ref: `dir:${mountSkillsSrc}` }],
    },
  };
  const board = await assembleBoard({ scope, projectRoot, mainRoot, items, skillHealth, envelope });
  return { status: 'present', scope, envelope, board };
}

function configRef(state: CapabilitiesConfigState): string {
  if (state.kind === 'present') return `file:${state.path}#sha256=${state.sha256}`;
  return `file:${state.path}#${state.kind}`;
}

function resolveSkillsSource(projectRoot: string, skillsSource: string): string {
  return isAbsolute(skillsSource) ? skillsSource : resolve(projectRoot, skillsSource);
}

async function readProjectSkillMeta(
  projectRoot: string,
  projectSkillsDir: string,
  allSkillNames: Set<string>,
  gaps: string[],
) {
  const skillMetaMap = new Map<string, SkillMeta>();
  const candidates: { name: string; dir: string }[] = [];
  for (const name of allSkillNames) {
    candidates.push({ name, dir: join(projectSkillsDir, name) });
    candidates.push({ name, dir: join(projectRoot, '.codex', 'skills', name) });
    candidates.push({ name, dir: join(projectRoot, '.gemini', 'skills', name) });
    candidates.push({ name, dir: join(projectRoot, '.kimi', 'skills', name) });
  }
  const results = await Promise.all(
    candidates.map(async ({ name, dir }) => ({ name, state: await readSkillMetaState(dir) })),
  );
  for (const { name, state } of results) {
    if (state.kind === 'unreadable') gaps.push(`${state.errno ?? 'EUNKNOWN'}:${state.path}`);
    if (state.kind === 'present' && state.meta.description && !skillMetaMap.has(name)) {
      skillMetaMap.set(name, state.meta);
    }
  }
  return skillMetaMap;
}
