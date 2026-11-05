import { z } from 'zod';

/** Canonical F22 presentation shapes. Hosts add their own authority-bearing metadata and actions. */
const richChecklistItemSchema = z.object({ id: z.string(), text: z.string(), checked: z.boolean().optional() });
const richMediaItemSchema = z.object({ url: z.string(), alt: z.string().optional(), caption: z.string().optional() });
export const richBlockSchema = z.discriminatedUnion('kind', [
  z.object({
    id: z.string().min(1),
    kind: z.literal('card'),
    v: z.literal(1),
    title: z.string(),
    bodyMarkdown: z.string().optional(),
    meta: z.record(z.unknown()).optional(),
    tone: z.enum(['info', 'success', 'warning', 'danger']).optional(),
    fields: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal('diff'),
    v: z.literal(1),
    filePath: z.string(),
    diff: z.string(),
    languageHint: z.string().optional(),
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal('checklist'),
    v: z.literal(1),
    title: z.string().optional(),
    items: z.array(richChecklistItemSchema).min(1),
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal('media_gallery'),
    v: z.literal(1),
    title: z.string().optional(),
    items: z.array(richMediaItemSchema).min(1),
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal('audio'),
    v: z.literal(1),
    url: z.string().optional().default(''),
    text: z.string().optional(),
    title: z.string().optional(),
    durationSec: z.number().optional(),
    mimeType: z.string().optional(),
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal('interactive'),
    v: z.literal(1),
    interactiveType: z.enum(['select', 'multi-select', 'card-grid', 'confirm']),
    title: z.string().optional(),
    description: z.string().optional(),
    options: z
      .array(
        z.object({
          id: z.string().min(1),
          label: z.string().min(1),
          emoji: z.string().optional(),
          icon: z.string().optional(),
          description: z.string().optional(),
          level: z.number().optional(),
          group: z.string().optional(),
          customInput: z.boolean().optional(),
          customInputPlaceholder: z.string().optional(),
          action: z
            .object({
              type: z.literal('callback'),
              endpoint: z.string().min(1),
              payload: z.record(z.unknown()).optional(),
            })
            .optional(),
        }),
      )
      .min(1),
    maxSelect: z.number().int().min(1).optional(),
    allowRandom: z.boolean().optional(),
    messageTemplate: z.string().optional(),
    disabled: z.boolean().optional(),
    selectedIds: z.array(z.string()).optional(),
    autoGroup: z.boolean().optional(),
    groupId: z.string().min(1).optional(),
  }),
  // F088 Phase J: file attachment block
  z.object({
    id: z.string().min(1),
    kind: z.literal('file'),
    v: z.literal(1),
    url: z
      .string()
      .min(1)
      .refine(
        (u) => !u.includes('..') && (/^\/uploads\//.test(u) || /^\/api\//.test(u) || /^https:\/\//.test(u)),
        'file url must start with /uploads/, /api/, or https://',
      ),
    fileName: z.string().min(1),
    mimeType: z.string().optional(),
    fileSize: z.number().int().min(0).optional(),
  }),
  // F120 Phase C: html_widget — inline sandboxed HTML/JS visualization
  z.object({
    id: z.string().min(1),
    kind: z.literal('html_widget'),
    v: z.literal(1),
    html: z.string().min(1).max(500_000),
    title: z.string().optional(),
    height: z.number().int().min(50).max(2000).optional(),
  }),
]);
