import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const WEB_ROOT = process.cwd();
const COMPONENTS_ROOT = path.join(WEB_ROOT, 'src/components');

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const absolute = path.join(root, entry);
    if (statSync(absolute).isDirectory()) files.push(...sourceFiles(absolute));
    else if (/\.(ts|tsx)$/.test(entry)) files.push(absolute);
  }
  return files;
}

function relative(file: string): string {
  return path.relative(WEB_ROOT, file).replaceAll(path.sep, '/');
}

function filesMatching(pattern: RegExp): string[] {
  return sourceFiles(COMPONENTS_ROOT)
    .filter((file) => !file.includes(`${path.sep}__tests__${path.sep}`))
    .filter((file) => pattern.test(readFileSync(file, 'utf8')))
    .map(relative);
}

describe('F307 Workbench ownership guard', () => {
  it('has one generic layout contract, reducer, and persistence owner', () => {
    expect(filesMatching(/export interface WorkbenchLayoutState/)).toEqual([
      'src/components/workbench/workbench-contract.ts',
    ]);
    expect(filesMatching(/export function reduceWorkbench/)).toEqual(['src/components/workbench/workbench-model.ts']);
    expect(filesMatching(/export const WORKBENCH_STORAGE_KEY/)).toEqual([
      'src/components/workbench/workbench-persistence.ts',
    ]);
  });

  it('keeps domain records and the rejected F290 state out of the generic reducer', () => {
    const reducer = readFileSync(path.join(COMPONENTS_ROOT, 'workbench/workbench-model.ts'), 'utf8');
    for (const forbidden of [
      'collectiveWorkingSet',
      'workspaceMode',
      'artifactRecord',
      'channelRecord',
      'threadRecord',
      'invocationRecord',
    ]) {
      expect(reducer).not.toContain(forbidden);
    }
  });

  it('allows the controlled F307 host adapter to consume persistence without creating another owner', () => {
    expect(filesMatching(/from ['"]@\/components\/workbench\/workbench-persistence['"]/)).toEqual([
      'src/components/workbench/experience-workbench-store.ts',
    ]);
  });
});
