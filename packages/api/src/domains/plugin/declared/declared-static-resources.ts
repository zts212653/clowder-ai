import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { McpConfigIO } from '../../../config/capabilities/capability-mcp-service.js';
import { readCapabilitiesConfig, withCapabilityLock } from '../../../config/capabilities/capability-orchestrator.js';
import { readMountRules } from '../../../config/mount/mount-rules-store.js';
import { addSkill, removeSkill } from '../../../skills/skill-manage.js';
import type { PluginRuntimeAdmission } from '../carrier/runtime-carrier.js';
import { packageDirectoryName } from '../external-runtime/filesystem-package-locator.js';
import { ExternalPluginRuntimeError, type VerifiedPluginPackageLocator } from '../external-runtime/types.js';
import type { BuiltinPluginPackageMaterializer } from '../manager/builtin-package-materializer.js';
import type { PluginRuntimeConfigurationPort } from '../manifest-configuration-projection.js';
import { activateDeclaredMcp, removeDeclaredMcp } from './declared-mcp-resources.js';
import { pluginResourceRoot } from './declared-resource-paths.js';

export interface DeclaredStaticResourceHost {
  readonly projectRoot: string;
  readonly packages: VerifiedPluginPackageLocator;
  readonly mcpPackages?: BuiltinPluginPackageMaterializer;
  readonly resourcesRoot?: string;
  readonly configuration: PluginRuntimeConfigurationPort;
  readonly mcpConfigIO?: McpConfigIO;
}

interface MaterializedSkills {
  readonly names: readonly string[];
  readonly source: string;
}

const MARKER = '.clowder-resource.json';

export async function activateDeclaredStaticResources(
  admission: PluginRuntimeAdmission,
  host: DeclaredStaticResourceHost | undefined,
): Promise<void> {
  await activateDeclaredSkills(admission, host);
  try {
    await activateDeclaredMcp(admission, host);
  } catch (error) {
    await removeDeclaredSkills(admission.packageRecord.pluginId, host).catch(() => undefined);
    throw error;
  }
}

export async function removeDeclaredStaticResources(
  pluginId: string,
  host: DeclaredStaticResourceHost | undefined,
): Promise<void> {
  if (!host) return;
  const results = await Promise.allSettled([removeDeclaredSkills(pluginId, host), removeDeclaredMcp(pluginId, host)]);
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason);
  if (failures.length > 0) throw new AggregateError(failures, `Failed to remove static resources for ${pluginId}`);
  await rm(pluginResourceRoot(host, pluginId), { recursive: true, force: true });
}

export async function activateDeclaredSkills(
  admission: PluginRuntimeAdmission,
  host: DeclaredStaticResourceHost | undefined,
): Promise<void> {
  const skills = (admission.packageRecord.manifest.contributions ?? []).filter(
    (contribution) => contribution.type === 'skill',
  );
  if (skills.length === 0) return;
  if (!host) {
    throw new ExternalPluginRuntimeError('UNSUPPORTED_TRANSPORT', 'Host static-resource activation is unavailable');
  }

  const located = await host.packages.resolveInstalledPackage(admission.packageRecord.packageDigest);
  let materialized: MaterializedSkills;
  try {
    if (!isDeepStrictEqual(located.manifest, admission.packageRecord.manifest)) {
      throw new ExternalPluginRuntimeError(
        'PACKAGE_AUTHORITY_MISMATCH',
        'located package manifest differs from the admitted package record',
      );
    }
    await located.verifyIntegrity();
    materialized = await materializeSkills(host, admission, located.rootDir, skills);
  } finally {
    await located.release();
  }

  const mountRules = await readMountRules(host.projectRoot, host.projectRoot);
  await withCapabilityLock(host.projectRoot, async () => {
    for (const skillName of materialized.names) {
      const result = await addSkill(host.projectRoot, skillName, materialized.source, {
        mountRules,
        pluginId: admission.packageRecord.pluginId,
        capabilityId: skillName,
        skillsSource: relative(host.projectRoot, materialized.source),
      });
      if (result.mounted.length === 0 && result.conflicts.length > 0) {
        throw new Error(
          `All skill mount points conflict for plugin skill '${skillName}': ${result.conflicts
            .map((conflict) => conflict.path)
            .join(', ')}`,
        );
      }
    }
  });
}

export async function removeDeclaredSkills(pluginId: string, host: DeclaredStaticResourceHost | undefined) {
  if (!host) return;
  const mountRules = await readMountRules(host.projectRoot, host.projectRoot);
  await withCapabilityLock(host.projectRoot, async () => {
    const config = await readCapabilitiesConfig(host.projectRoot);
    const owned =
      config?.capabilities.filter((capability) => capability.type === 'skill' && capability.pluginId === pluginId) ??
      [];
    const failures: unknown[] = [];
    for (const skill of owned) {
      try {
        await removeSkill(host.projectRoot, skill.id, {
          mountRules,
          pluginId,
          capabilityId: skill.id,
          ...(skill.skillsSource ? { skillsSource: resolve(host.projectRoot, skill.skillsSource) } : {}),
        });
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `Failed to remove all persisted skills for ${pluginId}`);
    }
  });
}

async function materializeSkills(
  host: DeclaredStaticResourceHost,
  admission: PluginRuntimeAdmission,
  packageRoot: string,
  skills: readonly { readonly path: string }[],
): Promise<MaterializedSkills> {
  const pluginRoot = pluginResourceRoot(host, admission.packageRecord.pluginId);
  const stableRoot = resolve(pluginRoot, packageDirectoryName(admission.packageRecord.packageDigest));
  const names = await declaredSkillNames(packageRoot, skills);
  if (await validMaterialization(stableRoot, admission, names)) {
    return { names, source: resolve(stableRoot, 'skills') };
  }

  await mkdir(pluginRoot, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(resolve(pluginRoot, '.materialize-'));
  try {
    const target = resolve(temporary, 'skills');
    await mkdir(target, { recursive: true, mode: 0o700 });
    for (let index = 0; index < skills.length; index += 1) {
      const source = await resolvePackageSkillDirectory(packageRoot, skills[index].path);
      await cp(source, resolve(target, names[index]), { recursive: true, force: false, errorOnExist: true });
    }
    await writeFile(
      resolve(temporary, MARKER),
      `${JSON.stringify({ pluginId: admission.packageRecord.pluginId, packageDigest: admission.packageRecord.packageDigest })}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );
    try {
      await rename(temporary, stableRoot);
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      if (!(await validMaterialization(stableRoot, admission, names))) throw error;
    }
    return { names, source: resolve(stableRoot, 'skills') };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function validMaterialization(
  root: string,
  admission: PluginRuntimeAdmission,
  names: readonly string[],
): Promise<boolean> {
  try {
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return false;
    const marker = JSON.parse(await readFile(resolve(root, MARKER), 'utf8')) as Record<string, unknown>;
    if (
      marker.pluginId !== admission.packageRecord.pluginId ||
      marker.packageDigest !== admission.packageRecord.packageDigest ||
      Object.keys(marker).length !== 2
    ) {
      return false;
    }
    for (const name of names) {
      const skillRoot = await lstat(resolve(root, 'skills', name));
      const skillManifest = await lstat(resolve(root, 'skills', name, 'SKILL.md'));
      if (!skillRoot.isDirectory() || skillRoot.isSymbolicLink()) return false;
      if (!skillManifest.isFile() || skillManifest.isSymbolicLink()) return false;
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function declaredSkillNames(
  packageRoot: string,
  skills: readonly { readonly path: string }[],
): Promise<string[]> {
  const names = await Promise.all(
    skills.map(async (skill) => basename(await resolvePackageSkillDirectory(packageRoot, skill.path))),
  );
  if (new Set(names).size !== names.length) throw new Error('Declared plugin skills must have unique directory names');
  return names;
}

async function resolvePackageSkillDirectory(packageRoot: string, declaredPath: string): Promise<string> {
  const realPackageRoot = await realpath(packageRoot);
  const skillSourceDir = await realpath(resolve(realPackageRoot, declaredPath));
  const relativePath = relative(realPackageRoot, skillSourceDir);
  if (relativePath === '' || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`Skill resource escapes the verified package root: ${declaredPath}`);
  }
  if (!(await stat(skillSourceDir)).isDirectory()) {
    throw new Error(`Skill resource must be a directory: ${declaredPath}`);
  }
  if (!(await stat(join(skillSourceDir, 'SKILL.md')).catch(() => undefined))?.isFile()) {
    throw new Error(`Skill resource directory must contain SKILL.md: ${declaredPath}`);
  }
  return skillSourceDir;
}
