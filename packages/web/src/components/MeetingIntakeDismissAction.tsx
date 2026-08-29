'use client';

import { useConfirm } from './useConfirm';

interface MeetingIntakeDismissActionProps {
  readonly judgmentState: unknown;
  readonly executionState: unknown;
  readonly busy: boolean;
  readonly onDismiss: () => void;
}

export function MeetingIntakeDismissAction({
  judgmentState,
  executionState,
  busy,
  onDismiss,
}: MeetingIntakeDismissActionProps) {
  const confirm = useConfirm();
  const visible = judgmentState !== 'dismissed' && executionState !== 'running' && executionState !== 'succeeded';
  if (!visible) return null;

  async function requestDismiss(): Promise<void> {
    const accepted = await confirm({
      title: '确认这次会议不写入吗？',
      message: '确认后会停止这次会议写入；已填写内容会保留为记录，已经创建的保存位置不会被删除。',
      confirmLabel: '确认不写入',
      cancelLabel: '返回',
      variant: 'danger',
    });
    if (accepted) onDismiss();
  }

  return (
    <button
      type="button"
      onClick={() => void requestDismiss()}
      disabled={busy}
      className="rounded-md border border-cafe px-3 py-1.5 text-micro text-cafe-secondary hover:bg-cafe-muted disabled:opacity-50"
      data-testid="meeting-dismiss"
    >
      这次会议不写入
    </button>
  );
}
