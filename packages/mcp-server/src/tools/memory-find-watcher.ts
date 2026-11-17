import { z } from 'zod';
import { searchEvidenceInputSchema } from './evidence-tools.js';

/**
 * The watcher keeps only its original matter-directory route, so the find entry is registered for it with the
 * matters-group fields alone: unusable docs parameters neither cost its small context nor pass validation.
 */
export const searchEvidenceWatcherContract = {
  description:
    'Find matter pages (事情页) readable by this invocation. Pass the clue as query: the whole text is matched literally in titles/descriptions (up to 200 characters, never cut). Omit query to browse the directory. Pass next.arguments unchanged for the following page. Listing records no read; open a readRef with cat_cafe_read_memory.',
  inputSchema: z
    .object({
      query: searchEvidenceInputSchema.query,
      matterCursor: searchEvidenceInputSchema.matterCursor,
      limit: z.number().int().min(1).max(30).optional().describe('Pages per call (default 12, max 30)'),
    })
    .strict(),
};
