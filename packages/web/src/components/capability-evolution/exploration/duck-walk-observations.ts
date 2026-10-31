import type { EvolutionExplorationRecordV1 } from '@cat-cafe/shared';

/** Existing northstar video annotations, usable only with the exact reviewed replay revision. */
const observations: Record<string, { sha256: string; text: string }> = {
  v1: {
    sha256: '5fa4f5f1adbb0b30411b85e3719e197bd8514458cb98a72d280859c5a5693e06',
    text: '原地没起步：20秒只挪了2.5cm',
  },
  v2: {
    sha256: '2d45a5581573c0b2cb2256d967f4a31d3d3ac39a7f0f98a2bf0028b7806a6b30',
    text: '2.6秒走到球边就停住，没起脚',
  },
  v3: { sha256: 'd45b35c94609c77bbb01c8a7cacf16aea958d661a9d99892eb4c8a90e4f5bc85', text: '走弧线，19.9秒才走到球边' },
  v4: { sha256: 'd0cc70e7df0efb9de009a876ed6e5bcccdc4481dd9cd5db63fdc003c84d003ce', text: '18.9秒起脚，这一侧踢空' },
};
export const walkObservationSource = {
  ownerFeatureId: 'F311',
  ownerStateRef: 'visual-observation:northstar-v2-left-far',
  version: 'cd88a3c1c859745481c689879b52ce1e0dcadc0e',
};
export const walkObservationHref =
  'https://github.com/zts212653/clowder-ai/blob/cd88a3c1c859745481c689879b52ce1e0dcadc0e/docs/evidence/2026-10-12-f311-northstar/mock/f311-northstar.html#L10439';
export function duckWalkObservation(version: string, record: EvolutionExplorationRecordV1): string | undefined {
  const note = observations[version];
  return note &&
    record.caseId === 'approach-left-far' &&
    record.media.some((media) => media.kind === 'video' && media.mediaRef.version === note.sha256)
    ? note.text
    : undefined;
}
