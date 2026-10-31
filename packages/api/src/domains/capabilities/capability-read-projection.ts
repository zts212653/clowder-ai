/**
 * F300 Task 2.1 — presentation side of the capability read: the source
 * revision, and the Console vs member board built from one set of items.
 */

import { createHash } from 'node:crypto';
import type {
  CapabilityBoardItem,
  CapabilityBoardResponse,
  CapabilityReadEnvelope,
  CapabilityReadScope,
  SkillHealthSummary,
} from '@cat-cafe/shared';
import { catRegistry } from '@cat-cafe/shared';
import { GovernanceRegistry } from '../../config/governance/governance-registry.js';
import { pathsEqual } from '../../utils/project-path.js';
import { buildCatFamilies } from './capability-board-parts.js';

/**
 * The revision names the source state. It hashes the source facts — config
 * bytes (`configRefs`), which skills each provider directory actually holds
 * (`presence`), and the view-independent item fields — and leaves out what is
 * a view of them: `enabled` and `cats` (derived per global/project view, F249;
 * review R1 P2), launch fields and secret values (covered by the config sha),
 * and live probe results (a different owner's observation, applied after).
 *
 * `presence` is passed in rather than read back out of `cats`: `cats` was the
 * only place a skill's filesystem presence showed up, so stripping it for view
 * independence also hid real mounts/unmounts (review R2 P1-1).
 */
export function sourceRevisionOf(input: {
  configRefs: readonly string[];
  presence: Readonly<Record<string, readonly string[]>>;
  items: readonly CapabilityBoardItem[];
  health: SkillHealthSummary;
}): string {
  const presence = Object.keys(input.presence)
    .sort()
    .map((provider) => [provider, [...(input.presence[provider] ?? [])].sort()]);
  const canonicalItems = input.items.map(({ enabled: _enabled, cats: _cats, ...item }) => {
    if (!item.mcpServer) return item;
    const { transport, resolver, envKeys } = item.mcpServer;
    return { ...item, mcpServer: { transport, resolver, envKeys } };
  });
  const body = JSON.stringify({
    configRefs: input.configRefs,
    presence,
    items: canonicalItems,
    skillHealth: input.health,
  });
  return `sha256:${createHash('sha256').update(body).digest('hex')}`;
}

export async function assembleBoard(input: {
  scope: CapabilityReadScope;
  projectRoot: string;
  mainRoot: string;
  items: CapabilityBoardItem[];
  skillHealth: SkillHealthSummary;
  envelope: CapabilityReadEnvelope;
}): Promise<CapabilityBoardResponse> {
  const { scope, projectRoot, mainRoot, skillHealth, envelope } = input;
  // F070: Governance health for external projects
  const registry = new GovernanceRegistry(mainRoot);
  const governanceHealth = projectRoot !== mainRoot ? await registry.checkHealth(projectRoot) : undefined;

  if (scope.kind === 'member') {
    const board: CapabilityBoardResponse = {
      items: input.items.map((item) => narrowToMember(item, scope.catId)),
      catFamilies: [],
      projectPath: projectRoot,
      skillHealth,
      envelope,
    };
    if (governanceHealth) board.governanceHealth = governanceHealth;
    return board;
  }

  const allCats = [...catRegistry.getAllIds()].map((catId) => ({
    catId,
    displayName: catRegistry.tryGet(catId)?.config.displayName ?? catId,
  }));
  const board: CapabilityBoardResponse = {
    items: input.items,
    catFamilies: buildCatFamilies(),
    projectPath: projectRoot,
    // F228: only the home root and the queried project; thread-derived paths merge client-side.
    knownProjectPaths: pathsEqual(mainRoot, projectRoot) ? [mainRoot] : [mainRoot, projectRoot],
    skillHealth,
    allCats,
    envelope,
  };
  if (governanceHealth) board.governanceHealth = governanceHealth;
  return board;
}

/**
 * A member sees every capability of the home, but only its own per-cat state:
 * which other members have something blocked is not part of its answer.
 */
function narrowToMember(item: CapabilityBoardItem, catId: string): CapabilityBoardItem {
  const cats: Record<string, boolean> = {};
  const own = item.cats[catId];
  if (own !== undefined) cats[catId] = own;
  const narrowed: CapabilityBoardItem = { ...item, cats };
  if (item.blockedCats !== undefined) narrowed.blockedCats = item.blockedCats.filter((id) => id === catId);
  return narrowed;
}
