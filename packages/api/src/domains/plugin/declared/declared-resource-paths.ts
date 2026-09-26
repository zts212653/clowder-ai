import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export function pluginResourceRoot(
  host: { readonly projectRoot: string; readonly resourcesRoot?: string },
  pluginId: string,
): string {
  const root = host.resourcesRoot ?? resolve(host.projectRoot, '.cat-cafe', 'plugin-host', 'resources');
  return resolve(root, createHash('sha256').update(pluginId, 'utf8').digest('hex'));
}

export async function resolvePackageFile(packageRoot: string, declaredPath: string, label: string): Promise<string> {
  const realPackageRoot = await realpath(packageRoot);
  const candidate = resolve(realPackageRoot, declaredPath);
  const relativePath = relative(realPackageRoot, candidate);
  if (relativePath === '' || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`${label} escapes the verified package root: ${declaredPath}`);
  }
  const file = await lstat(candidate);
  if (!file.isFile() || file.isSymbolicLink() || (await realpath(candidate)) !== candidate) {
    throw new Error(`${label} must be a package-local regular file: ${declaredPath}`);
  }
  return candidate;
}
