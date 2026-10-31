import type {
  CallerDispatchObservationInclusion,
  CallerDispatchObservationPointer,
  CallerDispatchObservationProjection,
  ObservationLine,
} from './caller-dispatch-observation-model.js';

export interface ProjectedObservation extends ObservationLine {
  key: string;
  includedRevision: number;
}

const MAX_READS_PER_PROJECTION = 64;

export async function projectCallerDispatchObservations(options: {
  allPointers: readonly CallerDispatchObservationPointer[];
  maxPromptChars: number;
  refresh: (pointer: CallerDispatchObservationPointer) => Promise<ProjectedObservation | null>;
}): Promise<CallerDispatchObservationProjection> {
  const pointers = options.allPointers
    .slice()
    .sort((left, right) => left.revision - right.revision)
    .slice(0, MAX_READS_PER_PROJECTION);
  if (pointers.length === 0) return { prompt: '', included: [], truncated: false };

  const header = [
    '[Outbound Dispatch Status]',
    '以下状态来自你先前提交的 source×target delivery lifecycle；不是新任务，也不会自动唤醒你。',
  ];
  const observations: ProjectedObservation[] = [];
  for (const pointer of pointers) {
    const observation = await options.refresh(pointer);
    if (observation) observations.push(observation);
  }
  observations.sort((left, right) => Number(right.terminal) - Number(left.terminal));

  const lines: string[] = [];
  const included: CallerDispatchObservationInclusion[] = [];
  let truncated = options.allPointers.length > pointers.length;
  for (const { key, line, terminal, fingerprint, includedRevision } of observations) {
    const candidate = [...header, ...lines, line, '[/Outbound Dispatch Status]'].join('\n');
    if (candidate.length > options.maxPromptChars) {
      truncated = true;
      continue;
    }
    lines.push(line);
    included.push({ key, includedRevision, fingerprint, terminal });
  }

  if (lines.length === 0) return { prompt: '', included: [], truncated };
  if (truncated) {
    const notice = '- 其余待观察项因本 turn 输入预算保留到后续自然 invocation。';
    const withNotice = [...header, ...lines, notice, '[/Outbound Dispatch Status]'].join('\n');
    if (withNotice.length <= options.maxPromptChars) lines.push(notice);
  }
  return {
    prompt: [...header, ...lines, '[/Outbound Dispatch Status]'].join('\n'),
    included,
    truncated,
  };
}
