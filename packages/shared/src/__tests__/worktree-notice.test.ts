import { describe, expect, it } from 'vitest';
import {
  formatWorktreeNotice,
  readWorktreeNotice,
  WORKTREE_NOTICE_KINDS,
  worktreeNoticeSchema,
} from '../worktree-notice.js';

const base = {
  version: 1 as const,
  kind: 'retention-head-changed' as const,
  owner: 'codex-astra',
  path: '/fixture/cat-cafe-alpha',
  sourceRef: 'task:work:original',
};
describe('worktree notice presentation facts', () => {
  it('keeps each outcome distinct and preserves exact recovery coordinates in text and metadata', () => {
    for (const kind of WORKTREE_NOTICE_KINDS) {
      const note = worktreeNoticeSchema.parse({
        ...base,
        kind,
        archivePath: '/fixture/archive',
        restore: 'git worktree add /fixture/cat-cafe-alpha HEAD',
      });
      const text = formatWorktreeNotice(note);
      expect(text).not.toContain(`：${kind}`);
      expect(text).toContain(note.path);
      expect(text).toContain(note.restore);
      expect(readWorktreeNotice(note, text)).toEqual(note);
    }
  });
  it('reads legacy text without treating a missing optional deadline as corrupt provenance', () => {
    const old = `工位需要原负责人核对收尾：retention-invalid\nowner="codex-astra"\npath="/fixture/cat-cafe-alpha"\nsource="task:work:original"\nuntil=null`;
    expect(readWorktreeNotice(undefined, old)).toMatchObject({ ...base, kind: 'retention-invalid' });
  });
  it('preserves historical cleanup outcomes and their exact recovery material', () => {
    const fields =
      '\nowner="codex-astra"\npath="/fixture/cat-cafe-alpha"\nsource="task:work:original"\narchive="/fixture/archive"\nrestore=git worktree add /fixture/cat-cafe-alpha HEAD';
    const historical = [
      ['已合入工位已自动回收：released/removed', 'merged-removed'],
      ['自动回收已移除工位，完成回执曾被中断；本轮已核验目录/登记消失及恢复归档。', 'merged-removal-interrupted'],
      ['自动回收已暂停，需原负责人核对后手动 finish，不会反复创建归档。', 'merged-retirement-blocked'],
    ];
    for (const [heading, kind] of historical) {
      expect(readWorktreeNotice(undefined, heading + fields)).toMatchObject({
        ...base,
        kind,
        archivePath: '/fixture/archive',
        restore: 'git worktree add /fixture/cat-cafe-alpha HEAD',
      });
    }
  });
  it('leaves unknown or corrupt history unchanged rather than inventing a status', () => {
    expect(readWorktreeNotice({ ...base, kind: 'something-new' }, 'unrecognized message')).toBeNull();
    expect(readWorktreeNotice(undefined, '工位需要原负责人核对收尾：retention-expired\nowner=bad json')).toBeNull();
  });
  it('keeps interrupted-removal recovery instructions prominent and never calls an intact abort a recovery', () => {
    const interrupted = formatWorktreeNotice({
      ...base,
      kind: 'merged-retirement-blocked',
      archivePath: '/fixture/only-copy',
    });
    expect(interrupted).toContain('工位可能已被部分移除');
    expect(interrupted).toContain('请保留恢复归档');
    const aborted = formatWorktreeNotice({ ...base, kind: 'merged-retirement-blocked' });
    expect(aborted).toContain('工位仍完整');
    expect(aborted).not.toContain('恢复材料');
    for (const kind of WORKTREE_NOTICE_KINDS)
      expect(formatWorktreeNotice({ ...base, kind })).not.toContain('本次未清理工位');
  });
});
