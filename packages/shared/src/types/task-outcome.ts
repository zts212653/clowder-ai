/**
 * F192 Phase G — Task Outcome Episode types shared between frontend and backend.
 *
 * Cancel reasons are the lightweight popup options shown to the user
 * when they cancel (deny) a permission request.
 */

/** Cancel reason categories for permission denials */
export const CANCEL_REASON_OPTIONS = [
  { value: 'should_not_do', label: '不该做这件事', labelEn: 'Should not do this' },
  { value: 'wrong_direction', label: '方向不对', labelEn: 'Wrong direction' },
  { value: 'i_will_do_it', label: '我自己来', labelEn: 'I will do it myself' },
  { value: 'skip', label: '跳过', labelEn: 'Skip' },
] as const;

export type CancelReasonValue = (typeof CANCEL_REASON_OPTIONS)[number]['value'];

/** Event emitted when user cancels a permission request with a reason */
export interface PermissionCancelEvent {
  readonly requestId: string;
  readonly toolName: string;
  readonly reason: CancelReasonValue;
  readonly catId: string;
  readonly threadId: string;
}
