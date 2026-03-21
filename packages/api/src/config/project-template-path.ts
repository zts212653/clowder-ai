import { relative, resolve, sep } from 'node:path';

export function isWithinProjectRoot(projectRoot: string, candidatePath: string): boolean {
  const rel = relative(resolve(projectRoot), resolve(candidatePath));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..');
}

export function resolveProjectTemplatePath(projectRoot: string): string {
  const envPath = process.env.CAT_TEMPLATE_PATH?.trim();
  if (envPath) {
    const resolvedEnvPath = resolve(envPath);
    if (isWithinProjectRoot(projectRoot, resolvedEnvPath)) return resolvedEnvPath;
  }
  return resolve(projectRoot, 'cat-template.json');
}
