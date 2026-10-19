export const COLLECTIVE_RESULT_READY_RECOMMENDATION: Readonly<Record<'zh' | 'en', string>> = {
  zh: '查看共同体工作中准备好的成果',
  en: 'Review the prepared result in its Collective Work',
};

interface SystemRecommendation {
  readonly key: 'collective_result_ready';
  readonly producerId: 'f290.collective_work_result';
  readonly subjectRef: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/** Only known system prose crosses the locale boundary; producer/Human-authored recommendations remain verbatim. */
export function readAttentionSystemRecommendation(value: unknown): SystemRecommendation | null {
  const receipt = record(value);
  const producer = record(receipt?.producer);
  return receipt?.eligible === true &&
    receipt.reasonCode === 'collective_result_ready' &&
    producer?.producerId === 'f290.collective_work_result' &&
    typeof producer.subjectRef === 'string'
    ? {
        key: 'collective_result_ready',
        producerId: 'f290.collective_work_result',
        subjectRef: producer.subjectRef,
      }
    : null;
}

export function needsMeRecommendation(value: unknown, language: 'zh' | 'en'): string | null {
  const system = readAttentionSystemRecommendation(value);
  if (system) return COLLECTIVE_RESULT_READY_RECOMMENDATION[language];
  const recommendation = record(value)?.recommendation;
  return typeof recommendation === 'string' && recommendation.trim() !== '' ? recommendation : null;
}
