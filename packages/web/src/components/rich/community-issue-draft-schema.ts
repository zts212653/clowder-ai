import { z } from 'zod';

/** The plugin response is validated once, before it drives a live publish UI. */
export const communityDraftSchema = z
  .object({
    draftId: z.string().min(1),
    status: z.enum(['draft', 'publishing', 'uncertain', 'published', 'cancelled']),
    title: z.string(),
    bodyMarkdown: z.string(),
    targetRepo: z.string(),
    labels: z.array(z.string()),
    githubIssueNumber: z.number().int().positive().optional(),
    githubIssueUrl: z.string().url().optional(),
  })
  .refine(
    (draft) =>
      draft.status !== 'published' ||
      (draft.githubIssueNumber !== undefined &&
        draft.githubIssueUrl?.toLowerCase() ===
          `https://github.com/${draft.targetRepo}/issues/${draft.githubIssueNumber}`.toLowerCase()),
    { message: '未收到可核验的 GitHub Issue 回链，尚不能确认提交成功。' },
  );
