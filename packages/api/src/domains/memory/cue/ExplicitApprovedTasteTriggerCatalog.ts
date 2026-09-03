import { z } from 'zod';

export const EXPLICIT_APPROVED_TASTE_SOURCE_ANCHOR_PREFIX = 'taste-vignette:';

export const EXPLICIT_APPROVED_TASTE_TRIGGERS = Object.freeze([
  Object.freeze({
    triggerKey: 'ELI5' as const,
    sourcePath: 'docs/taste/vignettes/visual-quality-ELI5-pcpjsd.md',
    requiredTags: Object.freeze(['ELI5', 'HTML富文本', '可视化优先'] as const),
    applicationContract: Object.freeze({
      v: 1 as const,
      tool: 'cat_cafe_create_rich_block' as const,
      requiredRichBlockKind: 'html_widget' as const,
      plainMarkdownSatisfies: false as const,
    }),
  }),
]);

export type ExplicitApprovedTasteTrigger = (typeof EXPLICIT_APPROVED_TASTE_TRIGGERS)[number];

export const explicitApprovedTasteDrillPayloadSchema = z
  .object({
    triggerKey: z.literal('ELI5'),
    applicationContract: z
      .object({
        v: z.literal(1),
        tool: z.literal('cat_cafe_create_rich_block'),
        requiredRichBlockKind: z.literal('html_widget'),
        plainMarkdownSatisfies: z.literal(false),
      })
      .strict(),
    vignette: z.unknown(),
  })
  .strict();

const ELI5_TRIGGER_PATTERN = /(^|[^\p{L}\p{N}_])eli5([^\p{L}\p{N}_]|$)/iu;

export function matchExplicitApprovedTasteTrigger(message: string): ExplicitApprovedTasteTrigger | null {
  return ELI5_TRIGGER_PATTERN.test(message) ? (EXPLICIT_APPROVED_TASTE_TRIGGERS[0] ?? null) : null;
}

export function getExplicitApprovedTasteTrigger(triggerKey: string): ExplicitApprovedTasteTrigger | null {
  return EXPLICIT_APPROVED_TASTE_TRIGGERS.find((trigger) => trigger.triggerKey === triggerKey) ?? null;
}

export function getExplicitApprovedTasteTriggerBySourcePath(sourcePath: string): ExplicitApprovedTasteTrigger | null {
  return EXPLICIT_APPROVED_TASTE_TRIGGERS.find((trigger) => trigger.sourcePath === sourcePath) ?? null;
}
