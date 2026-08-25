import type { MeetingIntakeOutput } from '@cat-cafe/shared';
import type { Thread } from '@/stores/chat-types';
import { MEETING_OUTPUTS } from './MeetingIntakeForm';

const DESTINATION_PREFIX = 'host:private-thread:';

interface MeetingIntakeSummaryProps {
  readonly speakers: string;
  readonly destination: string;
  readonly outputs: readonly MeetingIntakeOutput[];
  readonly threads: readonly Thread[];
}

export function MeetingIntakeSummary({ speakers, destination, outputs, threads }: MeetingIntakeSummaryProps) {
  const outputLabels = outputs
    .map((output) => MEETING_OUTPUTS.find((candidate) => candidate.id === output)?.label)
    .filter((label): label is string => Boolean(label));
  const destinationId = destination.startsWith(DESTINATION_PREFIX)
    ? destination.slice(DESTINATION_PREFIX.length)
    : null;
  const destinationThread = threads.find((thread) => thread.id === destinationId);
  const speakerNames = speakers
    .split('\n')
    .map((line) => {
      const separator = line.indexOf('=');
      return separator > 0 ? line.slice(separator + 1).trim() : '';
    })
    .filter(Boolean);

  return (
    <div className="space-y-2.5 text-micro">
      <div className="flex items-center gap-2">
        <h4 className="font-semibold text-cafe">猫猫建议</h4>
        <span className="rounded-md border border-cafe px-1.5 py-0.5 text-cafe-muted">可调整</span>
      </div>
      <dl className="grid gap-2 sm:grid-cols-[68px_1fr]">
        <dt className="text-cafe-muted">将生成</dt>
        <dd className="font-medium text-cafe">{outputLabels.length > 0 ? outputLabels.join(' · ') : '请选择内容'}</dd>
        <dt className="text-cafe-muted">保存到</dt>
        <dd className="font-medium text-cafe">{destinationThread?.title?.trim() || '请选择保存位置'}</dd>
        <dt className="text-cafe-muted">参会人</dt>
        <dd className="font-medium text-cafe">{speakerNames.length > 0 ? speakerNames.join('、') : '请补充称呼'}</dd>
      </dl>
    </div>
  );
}

export function MeetingIntakeSourceDetails({
  sourceHandle,
  revision,
  meetingId,
}: {
  readonly sourceHandle: string;
  readonly revision: number;
  readonly meetingId?: string;
}) {
  return (
    <dl className="grid gap-1.5 break-all rounded-md bg-cafe-surface-sunken p-2 sm:grid-cols-[64px_1fr]">
      <dt className="text-cafe-muted">原会议</dt>
      <dd>{sourceHandle}</dd>
      <dt className="text-cafe-muted">版本</dt>
      <dd>{revision}</dd>
      {meetingId && (
        <>
          <dt className="text-cafe-muted">记录编号</dt>
          <dd>{meetingId}</dd>
        </>
      )}
    </dl>
  );
}
