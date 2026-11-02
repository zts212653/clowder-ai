import type { MemberVisualAssets } from '@cat-cafe/shared';
import type { MemberDraft } from './member-editor-state';

/** The avatar has its own receipt. Commit only this field, retaining all other profile edits. */
export function commitMemberAvatar(
  draft: MemberDraft,
  value: { avatar?: string; visualAssets: MemberVisualAssets },
): MemberDraft {
  if (!draft.baseline) return draft;
  return { ...draft, baseline: { ...draft.baseline, ...value }, form: { ...draft.form, avatar: value.avatar ?? '' } };
}
