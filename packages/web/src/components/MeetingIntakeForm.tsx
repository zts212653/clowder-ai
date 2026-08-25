'use client';

import type { MeetingIntakeOutput } from '@cat-cafe/shared';
import type { Thread } from '@/stores/chat-types';
import { MeetingThreadDestinationPicker } from './MeetingThreadDestinationPicker';

export const MEETING_OUTPUTS: ReadonlyArray<{ id: MeetingIntakeOutput; label: string }> = [
  { id: 'minutes', label: '会议纪要' },
  { id: 'decisions', label: '已确认决定' },
  { id: 'roadmap', label: '后续计划' },
  { id: 'tasks', label: '行动项' },
];

interface MeetingIntakeFormProps {
  readonly speakers: string;
  readonly context: string;
  readonly destination: string;
  readonly outputs: readonly MeetingIntakeOutput[];
  readonly threads: readonly Thread[];
  readonly suggestedTitle: string;
  readonly projectPath: string;
  readonly loadingThreads: boolean;
  readonly disabled: boolean;
  readonly onSpeakersChange: (value: string) => void;
  readonly onContextChange: (value: string) => void;
  readonly onDestinationChange: (value: string) => void;
  readonly onOutputsChange: (value: MeetingIntakeOutput[]) => void;
}

export function MeetingIntakeForm({
  speakers,
  context,
  destination,
  outputs,
  threads,
  suggestedTitle,
  projectPath,
  loadingThreads,
  disabled,
  onSpeakersChange,
  onContextChange,
  onDestinationChange,
  onOutputsChange,
}: MeetingIntakeFormProps) {
  return (
    <section className="space-y-3" aria-label="确认整理内容">
      <label className="block text-micro font-medium">
        发言人称呼
        <textarea
          value={speakers}
          onChange={(event) => onSpeakersChange(event.target.value)}
          placeholder="1=You"
          rows={2}
          className="mt-1 w-full rounded-md border border-cafe bg-cafe-surface p-2 text-sm"
          data-testid="meeting-speakers"
        />
      </label>
      <label className="block text-micro font-medium">
        这次会议主要讨论什么
        <textarea
          value={context}
          onChange={(event) => onContextChange(event.target.value)}
          rows={3}
          className="mt-1 w-full rounded-md border border-cafe bg-cafe-surface p-2 text-sm"
          data-testid="meeting-context"
        />
      </label>
      <MeetingThreadDestinationPicker
        threads={threads}
        value={destination}
        suggestedTitle={suggestedTitle}
        projectPath={projectPath}
        loading={loadingThreads}
        disabled={disabled}
        onChange={onDestinationChange}
      />
      <fieldset>
        <legend className="mb-2 text-micro font-medium">要生成的内容</legend>
        <div className="flex flex-wrap gap-2">
          {MEETING_OUTPUTS.map((output) => (
            <label
              key={output.id}
              className="flex items-center gap-1.5 rounded-md border border-cafe px-2 py-1.5 text-micro"
            >
              <input
                type="checkbox"
                checked={outputs.includes(output.id)}
                onChange={(event) =>
                  onOutputsChange(
                    event.target.checked
                      ? [...outputs, output.id]
                      : outputs.filter((candidate) => candidate !== output.id),
                  )
                }
                data-testid={`meeting-output-${output.id}`}
              />
              {output.label}
            </label>
          ))}
        </div>
      </fieldset>
    </section>
  );
}
