/**
 * F314-13: Workspace (useWorkspace.fetchSubtree) and the F307 Files surface
 * merge a lazily loaded directory with this one function.
 */
import { describe, expect, it } from 'vitest';
import { mergeSubtree } from '@/components/workbench/files-tree';
import type { TreeNode } from '@/hooks/useWorkspace';

const dir = (path: string, children?: TreeNode[]): TreeNode => ({
  name: path.split('/').at(-1) ?? path,
  path,
  type: 'directory',
  ...(children ? { children } : {}),
});
const file = (path: string): TreeNode => ({ name: path.split('/').at(-1) ?? path, path, type: 'file' });

const loaded = [file('src/lib/deep/new.ts')];

function tree(): TreeNode[] {
  return [
    dir('src', [dir('src/lib', [dir('src/lib/deep')]), file('src/index.ts')]),
    dir('src2', [file('src2/x.ts')]),
    file('README.md'),
  ];
}

describe('mergeSubtree (F314-13)', () => {
  it('puts the loaded children under the nested directory and keeps untouched branches as they were', () => {
    const before = tree();
    const after = mergeSubtree(before, 'src/lib/deep', loaded);
    expect(after[0].children?.[0].children?.[0].children).toEqual(loaded);
    expect(after[0].children?.[1]).toBe(before[0].children?.[1]);
    expect(after[1]).toBe(before[1]);
    expect(after[2]).toBe(before[2]);
  });

  it('does not treat a sibling that shares a name prefix as an ancestor', () => {
    const before = tree();
    const after = mergeSubtree(before, 'src2', loaded);
    expect(after[1].children).toEqual(loaded);
    expect(after[0]).toBe(before[0]);
  });

  it('leaves the tree unchanged for a file path or a path that is not in the tree', () => {
    for (const target of ['src/index.ts', 'README.md', 'missing/dir']) {
      expect(mergeSubtree(tree(), target, loaded)).toEqual(tree());
    }
  });
});
