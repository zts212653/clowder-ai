/**
 * F041/F228 mount health for cat-cafe skills — read-only.
 *
 * Fills `item.mounts` / `item.mountHealth` on the given board items and returns
 * the board-level summary. Source directory = truth for "which skills exist";
 * capabilities.json = truth for "which skills are configured".
 */

import { isAbsolute, join, resolve } from 'node:path';
import type {
  CapabilityBoardItem,
  CapabilityEntry,
  MountRules,
  SkillHealthSummary,
  StandardMountPointId,
} from '@cat-cafe/shared';
import { STANDARD_MOUNT_POINT_IDS } from '@cat-cafe/shared';
import type { SkillMountInspection } from '../../utils/skill-mount.js';

type MountInspect = (
  candidates: string[],
  src: string,
  skillId: string,
  mainSkillsSrc: string,
) => Promise<SkillMountInspection>;

export async function buildMountHealth(input: {
  projectRoot: string;
  capabilities: readonly CapabilityEntry[];
  items: CapabilityBoardItem[];
  mountRules: MountRules;
  enabledMountPoints: readonly StandardMountPointId[];
  customMountTargets: readonly { id: string; candidates: string[] }[];
  mountSkillsSrc: string;
  mainSkillsSrc: string;
  mountSourceNames: ReadonlySet<string>;
  inspectSkillMountAtPoint: MountInspect;
  /** Collector: mount locations that exist but cannot be inspected (`CODE:path`). */
  gaps: string[];
}): Promise<SkillHealthSummary> {
  const { projectRoot, capabilities, mountRules, customMountTargets, mountSkillsSrc, mainSkillsSrc } = input;
  // The inspector that does the reads reports what it could not read; `mounts`
  // stays boolean for the board, and the gap says the `false` is not an observation.
  const check = async (candidates: string[], src: string, skillId: string, fallback: string): Promise<boolean> => {
    const result = await input.inspectSkillMountAtPoint(candidates, src, skillId, fallback);
    if (result.state === 'unknown') input.gaps.push(...result.gaps);
    return result.state === 'mounted';
  };
  // F228: project-only mount point dirs — user-level dirs are managed by the
  // main instance and must not cause false mount health mismatches.
  const projectOnlyMountPointDirs: Record<string, string[]> = {};
  for (const id of STANDARD_MOUNT_POINT_IDS) {
    projectOnlyMountPointDirs[id] = [join(projectRoot, mountRules.mountPoints[id].path)];
  }

  const catCafeSkillItems = input.items.filter((i) => i.type === 'skill' && i.source === 'cat-cafe');
  // Per-skill effective source: custom skillsSource resolves against projectRoot
  // (project-local plugins); global→project propagation stores absolute paths.
  const effectiveSourceBySkill = new Map<string, string>();
  for (const cap of capabilities) {
    if (cap.type === 'skill' && cap.source === 'cat-cafe' && cap.skillsSource) {
      effectiveSourceBySkill.set(
        cap.id,
        isAbsolute(cap.skillsSource) ? cap.skillsSource : resolve(projectRoot, cap.skillsSource),
      );
    }
  }
  await Promise.all(
    catCafeSkillItems.map(async (item) => {
      const src = effectiveSourceBySkill.get(item.id) ?? mountSkillsSrc;
      const [claude, codex, gemini, kimi] = await Promise.all([
        check(projectOnlyMountPointDirs.claude!, src, item.id, mainSkillsSrc),
        check(projectOnlyMountPointDirs.codex!, src, item.id, mainSkillsSrc),
        check(projectOnlyMountPointDirs.gemini!, src, item.id, mainSkillsSrc),
        check(projectOnlyMountPointDirs.kimi!, src, item.id, mainSkillsSrc),
      ]);
      const customMounts = await Promise.all(
        customMountTargets.map((target) => check(target.candidates, src, item.id, mainSkillsSrc)),
      );
      const mounts: Record<string, boolean> = { claude, codex, gemini, kimi };
      customMountTargets.forEach((target, index) => {
        mounts[target.id] = customMounts[index] ?? false;
      });
      item.mounts = mounts;
    }),
  );

  const availableMountPointIds = [...input.enabledMountPoints, ...customMountTargets.map((target) => target.id)];
  for (const item of catCafeSkillItems) {
    if (!item.mounts) continue;
    const declaredMountPaths = Array.isArray(item.mountPaths) ? new Set(item.mountPaths) : null;
    const requiredMountPointIds = declaredMountPaths
      ? availableMountPointIds.filter((mountPointId) => declaredMountPaths.has(mountPointId))
      : availableMountPointIds;
    const mountedCount = requiredMountPointIds.filter((mountPointId) => item.mounts?.[mountPointId]).length;
    item.mountHealth = {
      enabledMountPoints: availableMountPointIds,
      mountedCount,
      requiredCount: requiredMountPointIds.length,
      allMounted: mountedCount === requiredMountPointIds.length,
    };
  }

  // Plugin-owned and custom-source skills are managed outside the default
  // source-tree scanner — exclude them from consistency checks.
  const capSkillNames = new Set(
    capabilities
      .filter((c) => c.type === 'skill' && c.source === 'cat-cafe' && !c.pluginId && !c.skillsSource)
      .map((c) => c.id),
  );
  const unregistered = [...input.mountSourceNames].filter((n) => !capSkillNames.has(n));
  const phantom = [...capSkillNames].filter((n) => !input.mountSourceNames.has(n) && !effectiveSourceBySkill.has(n));
  // F228: mountPaths-first — only mountPaths determines active state (enabled is legacy)
  const mountRequired = catCafeSkillItems.filter((item) => (item.mountPaths?.length ?? 0) > 0);
  let allMounted = mountRequired.every((item) => item.mountHealth?.allMounted === true);
  // Expected cat-cafe skills (source dir non-empty) but none discovered → likely broken mounts.
  if (catCafeSkillItems.length === 0 && input.mountSourceNames.size > 0) allMounted = false;
  return {
    allMounted,
    registrationConsistent: unregistered.length === 0 && phantom.length === 0,
    unregistered,
    phantom,
  };
}
