import { workReferenceCardSchema, workReferenceSchema } from '@cat-cafe/shared';
import { z } from 'zod';
import { callbackPost } from './callback-tools.js';
import { errorResult, successResult, type ToolResult } from './file-tools.js';

const pageSchema = z.object({
  encoding: z.literal('json-text-chunk'),
  snapshot: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  json: z.string(),
  nextCursor: z.number().int().positive().nullable(),
});
const referenceResult = z.object({ reference: workReferenceSchema, block: workReferenceCardSchema }).strict();
type Input = {
  contentTaskId?: string;
  command: { action: 'publish-reference'; reference: z.infer<typeof workReferenceSchema> };
  cursor: number;
  expectedSnapshot?: string;
};

/** Read-only owner resolution precedes an explicit rich-block effect in the original message pipeline. */
export async function deliverWorkReference(input: Input): Promise<ToolResult> {
  if (input.cursor !== 0) return errorResult('Publish a reference with cursor=0; delivery joins its own fenced pages.');
  try {
    const read = await readReferencePages(input);
    if ('failure' in read) return read.failure;
    const resolved = referenceResult.parse(JSON.parse(read.json));
    if (
      JSON.stringify(resolved.reference) !== JSON.stringify(input.command.reference) ||
      JSON.stringify(resolved.block.meta.reference) !== JSON.stringify(resolved.reference)
    )
      return errorResult('Work reference does not match the requested version; no card was attached.');
    const attached = await callbackPost(
      '/api/callbacks/create-rich-block',
      { block: resolved.block },
      { enableOutbox: true },
    );
    if (attached.isError) return attached;
    if (z.object({ status: z.literal('ok') }).safeParse(JSON.parse(attached.content[0]?.text ?? '')).success)
      return successResult(
        JSON.stringify({
          status: 'reference_attached',
          reference: resolved.reference,
          blockId: resolved.block.id,
          delivery: 'attached_to_current_message',
        }),
      );
    return errorResult(
      'The work is retained, but card attachment is unconfirmed. Retry the same fixed reference; do not resubmit its bytes.',
    );
  } catch {
    return errorResult(
      'Work reference resolution or attachment is unconfirmed. Keep the fixed reference and retry; no new work version is needed.',
    );
  }
}

async function readReferencePages(input: Input): Promise<{ json: string } | { failure: ToolResult }> {
  let cursor = 0,
    snapshot = input.expectedSnapshot,
    joined = '';
  for (;;) {
    const read = await callbackPost('/api/callbacks/work', { ...input, cursor, expectedSnapshot: snapshot });
    if (read.isError) return { failure: read };
    const page = pageSchema.parse(JSON.parse(read.content[0]?.text ?? ''));
    if ((snapshot && snapshot !== page.snapshot) || !page.json.length)
      throw new Error('Work reference changed or returned no progress');
    joined += page.json;
    if (Buffer.byteLength(joined) > 16 * 1024 * 1024) throw new Error('Work reference exceeds the inspection limit');
    snapshot = page.snapshot;
    if (page.nextCursor === null) break;
    if (page.nextCursor !== cursor + page.json.length) throw new Error('Work reference pagination is inconsistent');
    cursor = page.nextCursor;
  }
  return { json: joined };
}
