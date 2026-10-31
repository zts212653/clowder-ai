import { describe, expect, it } from 'vitest';
import { projectDisplayName } from '../thread-utils';

describe('projectDisplayName cross-platform labels (#1585)', () => {
  it.each([
    ['/work/demo', 'demo'],
    ['/work/demo///', 'demo'],
    ['C:\\work\\demo', 'demo'],
    ['C:\\work\\demo\\\\', 'demo'],
    ['C:/work\\demo/', 'demo'],
    ['C:\\工作\\猫咖', '猫咖'],
    ['\\\\server\\share', 'share'],
    ['\\\\server\\share\\', 'share'],
    ['\\\\server\\share\\demo', 'demo'],
    ['\\\\server\\', 'server'],
    ['/', '/'],
    ['///', '///'],
    ['C:\\', 'C:\\'],
    ['C:/', 'C:/'],
    ['C:\\\\', 'C:\\\\'],
    ['default', '未分类'],
    ['', ''],
    ['demo', 'demo'],
  ])('displays %j as %j', (path, expected) => {
    expect(projectDisplayName(path)).toBe(expected);
  });
});
