import { expect, it } from 'vitest';
import { afterWorkspaceFileSave, type WorkspaceFileDraft, workspaceFileDraftKey } from '../workspace-file-draft';

const sent: WorkspaceFileDraft = {
  v: 1,
  revision: 'sent',
  writerId: 'saving-editor',
  baseSha256: 'a'.repeat(64),
  text: 'save A',
};
it('a save receipt settles the submitted draft but preserves subsequent typing in that same editor', () => {
  expect(afterWorkspaceFileSave(sent, sent, 'b'.repeat(64))).toBeNull();
  const newer = { ...sent, revision: 'later', text: 'save A and keep typing B' };
  expect(afterWorkspaceFileSave(newer, sent, 'b'.repeat(64))).toMatchObject({
    text: newer.text,
    baseSha256: 'b'.repeat(64),
    writerId: sent.writerId,
  });
});
it('a receipt cannot silently rebase an independent page or reopened editor onto its write', () => {
  const other = { ...sent, revision: 'other', writerId: 'another-editor', text: 'independent edit' };
  expect(afterWorkspaceFileSave(other, sent, 'b'.repeat(64))).toBe(other);
  const rebased = { ...sent, revision: 'later', baseSha256: 'c'.repeat(64) };
  expect(afterWorkspaceFileSave(rebased, sent, 'b'.repeat(64))).toBe(rebased);
});
it('draft keys bind the actual user, owner root and file independently of the current chat', () => {
  const key = workspaceFileDraftKey('operator', 'root-A', 'notes.txt');
  expect(workspaceFileDraftKey('another-human', 'root-A', 'notes.txt')).not.toBe(key);
  expect(workspaceFileDraftKey('operator', 'root-B', 'notes.txt')).not.toBe(key);
  expect(workspaceFileDraftKey('operator', 'root-A', 'other.txt')).not.toBe(key);
});
