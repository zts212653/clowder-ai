import { z } from 'zod';

const publicId = (prefix: string) =>
  z
    .string()
    .min(prefix.length + 8)
    .max(160)
    .regex(new RegExp(`^${prefix}[A-Za-z0-9_-]+$`));
const catId = z.string().trim().min(1).max(120);
const resultFileName = z
  .string()
  .min(1)
  .max(220)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:md|txt)$/iu);
const resultFileSourceHref = z
  .string()
  .max(1_000)
  .regex(/^\/uploads\/cwork-[A-Za-z0-9._-]+\.(?:md|txt)$/iu);
const resultFileDigest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const canonicalBase64 = z
  .string()
  .max(87_384)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u);

export const collectiveWorkResultTextSourceSchema = z
  .object({
    v: z.literal(1),
    sourceHref: resultFileSourceHref,
    fileName: resultFileName,
    mediaType: z.enum(['text/markdown', 'text/plain']),
    contentDigest: resultFileDigest,
    byteLength: z.number().int().nonnegative().max(65_536),
    contentBase64: canonicalBase64,
  })
  .strict();

export const collectiveWorkResultFileIdSchema = z.string().regex(/^wrf_[a-f0-9]{64}$/u);
export const collectiveWorkResultFileSchema = collectiveWorkResultTextSourceSchema
  .extend({ fileId: collectiveWorkResultFileIdSchema })
  .strict();

export function collectiveWorkResultMediaTypeForFileName(fileName: string): 'text/markdown' | 'text/plain' | undefined {
  const parsed = resultFileName.safeParse(fileName);
  if (!parsed.success) return undefined;
  return parsed.data.toLowerCase().endsWith('.md') ? 'text/markdown' : 'text/plain';
}

export const COLLECTIVE_WORK_RESULT_FILE_PATH = '/api/collaboration/work-result-files/';

export function collectiveWorkResultFilePath(input: { readonly fileId: string; readonly fileName: string }): string {
  const fileId = collectiveWorkResultFileIdSchema.parse(input.fileId);
  const fileName = resultFileName.parse(input.fileName);
  return `${COLLECTIVE_WORK_RESULT_FILE_PATH}${fileId}/${encodeURIComponent(fileName)}`;
}

export function parseCollectiveWorkResultFilePath(pathname: string) {
  if (!pathname.startsWith(COLLECTIVE_WORK_RESULT_FILE_PATH)) return undefined;
  const parts = pathname.slice(COLLECTIVE_WORK_RESULT_FILE_PATH.length).split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return undefined;
  try {
    return {
      fileId: collectiveWorkResultFileIdSchema.parse(parts[0]),
      fileName: resultFileName.parse(decodeURIComponent(parts[1])),
    };
  } catch {
    return undefined;
  }
}

/** Host claim, checked against the current Work before the Service issues a receipt. */
export const collectiveWorkResultIntentSchema = z
  .object({
    assignmentEventId: publicId('evt_'),
    assignmentCatId: catId.optional(),
    participationRevision: z.number().int().positive(),
    resultRevision: z.number().int().positive(),
    executionRevision: z.number().int().positive().optional(),
  })
  .strict();
const author = {
  workId: publicId('work_'),
  connectionId: publicId('con_'),
  humanId: publicId('human_'),
  catId,
};
export const collectiveWorkResultReceiptSchema = collectiveWorkResultIntentSchema.extend(author).strict();
/** Progress is scoped to the current execution and result round, but creates no result. */
export const collectiveWorkProgressIntentSchema = collectiveWorkResultIntentSchema
  .extend({
    executionRevision: z.number().int().positive(),
  })
  .strict();
export const collectiveWorkProgressReceiptSchema = collectiveWorkProgressIntentSchema.extend(author).strict();
export type CollectiveWorkResultIntent = z.infer<typeof collectiveWorkResultIntentSchema>;
export type CollectiveWorkResultReceipt = z.infer<typeof collectiveWorkResultReceiptSchema>;
export type CollectiveWorkProgressIntent = z.infer<typeof collectiveWorkProgressIntentSchema>;
export type CollectiveWorkProgressReceipt = z.infer<typeof collectiveWorkProgressReceiptSchema>;
export type CollectiveWorkResultTextSource = z.infer<typeof collectiveWorkResultTextSourceSchema>;
export type CollectiveWorkResultFile = z.infer<typeof collectiveWorkResultFileSchema>;
