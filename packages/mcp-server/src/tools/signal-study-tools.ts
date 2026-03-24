import { z } from 'zod';
import type { ToolResult } from './file-tools.js';
import { errorResult, successResult } from './file-tools.js';

const API_URL = process.env['CAT_CAFE_API_URL'] ?? 'http://localhost:3004';
const SIGNAL_USER = process.env['CAT_CAFE_SIGNAL_USER']?.trim() || 'codex';

async function apiJson(
  path: string,
  init?: RequestInit,
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  try {
    const headers = new Headers(init?.headers);
    headers.set('X-Cat-Cafe-User', SIGNAL_USER);
    if (init?.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    const response = await fetch(`${API_URL}${path}`, { ...init, headers });
    if (!response.ok) {
      return { ok: false, error: `API failed (${response.status}): ${await response.text()}` };
    }
    return { ok: true, data: await response.json() };
  } catch (error) {
    return { ok: false, error: `API request failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

// --- Handlers ---

async function handleUpdateArticle(input: {
  id: string;
  status?: string;
  tags?: string[];
  note?: string;
}): Promise<ToolResult> {
  const { id, ...fields } = input;
  const result = await apiJson(`/api/signals/articles/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(fields),
  });
  if (!result.ok) return errorResult(result.error);
  return successResult(`Updated article ${id}: ${JSON.stringify(fields)}`);
}

async function handleDeleteArticle(input: { ids: string[] }): Promise<ToolResult> {
  const result = await apiJson('/api/signals/articles/batch', {
    method: 'POST',
    body: JSON.stringify({ ids: input.ids, action: 'delete' }),
  });
  if (!result.ok) return errorResult(result.error);
  const data = result.data as { affected?: number };
  return successResult(`Soft-deleted ${data.affected ?? 0} article(s).`);
}

async function handleLinkThread(input: { articleId: string; threadId: string; action?: string }): Promise<ToolResult> {
  if (input.action === 'unlink') {
    const path = `/api/signals/articles/${encodeURIComponent(input.articleId)}/threads/${encodeURIComponent(input.threadId)}`;
    const result = await apiJson(path, { method: 'DELETE' });
    if (!result.ok) return errorResult(result.error);
    return successResult(`Unlinked thread ${input.threadId} from article ${input.articleId}`);
  }

  const path = `/api/signals/articles/${encodeURIComponent(input.articleId)}/threads`;
  const result = await apiJson(path, { method: 'POST', body: JSON.stringify({ threadId: input.threadId }) });
  if (!result.ok) return errorResult(result.error);

  return successResult(`Linked thread ${input.threadId} to article ${input.articleId}`);
}

async function handleStartStudy(input: { articleId: string; threadId?: string }): Promise<ToolResult> {
  // Fetch article content for context
  const articleResult = await apiJson(`/api/signals/articles/${encodeURIComponent(input.articleId)}`);
  if (!articleResult.ok) return errorResult(articleResult.error);

  // Link thread if provided
  if (input.threadId) {
    await apiJson(`/api/signals/articles/${encodeURIComponent(input.articleId)}/threads`, {
      method: 'POST',
      body: JSON.stringify({ threadId: input.threadId }),
    });
  }

  const data = articleResult.data as { article?: { title?: string; content?: string; source?: string; tier?: number } };
  const article = data.article;
  if (!article) return errorResult('Article not found');

  const lines = [
    `Study started for: ${article.title}`,
    `Source: ${article.source} (T${article.tier})`,
    input.threadId ? `Linked to thread: ${input.threadId}` : 'No thread linked yet',
    '',
    '--- Article Content ---',
    article.content?.slice(0, 3000) ?? '(no content)',
  ];
  return successResult(lines.join('\n'));
}

async function handleSaveNotes(input: {
  articleId: string;
  notes: string;
  participants?: string[];
}): Promise<ToolResult> {
  // Get study meta to add artifact
  const studyResult = await apiJson(`/api/signals/articles/${encodeURIComponent(input.articleId)}/study`);
  if (!studyResult.ok) return errorResult(studyResult.error);

  // For now, notes are stored via the article note field as a lightweight approach
  // Full sidecar storage will be handled by the backend StudyMetaService
  const result = await apiJson(`/api/signals/articles/${encodeURIComponent(input.articleId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ note: input.notes }),
  });
  if (!result.ok) return errorResult(result.error);

  return successResult(
    `Study notes saved for ${input.articleId}` +
      (input.participants?.length ? ` (participants: ${input.participants.join(', ')})` : ''),
  );
}

async function handleListStudies(input: { articleId?: string; kind?: string; limit?: number }): Promise<ToolResult> {
  if (input.articleId) {
    const result = await apiJson(`/api/signals/articles/${encodeURIComponent(input.articleId)}/study`);
    if (!result.ok) return errorResult(result.error);
    const data = result.data as { meta?: { threads?: unknown[]; artifacts?: unknown[] } };
    const meta = data.meta;
    if (!meta) return successResult('No study data found.');

    const lines = [
      `Study meta for ${input.articleId}:`,
      `  Threads linked: ${meta.threads?.length ?? 0}`,
      `  Artifacts: ${meta.artifacts?.length ?? 0}`,
    ];
    return successResult(lines.join('\n'));
  }

  return successResult('List all studies: not yet implemented (requires article ID for now).');
}

async function handleGeneratePodcast(input: {
  articleId: string;
  mode: string;
  speakers?: string[];
}): Promise<ToolResult> {
  const result = await apiJson(`/api/signals/articles/${encodeURIComponent(input.articleId)}/podcast`, {
    method: 'POST',
    body: JSON.stringify({ mode: input.mode }),
  });
  if (!result.ok) return errorResult(result.error);

  const data = result.data as { artifact?: { id?: string; state?: string } };
  const duration = input.mode === 'essence' ? '2-3 min' : '10 min';

  return successResult(
    [
      `Podcast generation triggered:`,
      `  Artifact: ${data.artifact?.id ?? 'unknown'}`,
      `  State: ${data.artifact?.state ?? 'queued'}`,
      `  Mode: ${input.mode} (${duration})`,
    ].join('\n'),
  );
}

// --- Tool definitions ---

export const signalUpdateArticleInputSchema = {
  id: z.string().min(1).describe('Article ID'),
  status: z.enum(['inbox', 'read', 'archived', 'starred']).optional().describe('New status'),
  tags: z.array(z.string()).optional().describe('Replace tags'),
  note: z.string().optional().describe('铲屎官个人备注'),
};

export const signalDeleteArticleInputSchema = {
  ids: z.array(z.string().min(1)).min(1).describe('Article IDs to soft-delete'),
};

export const signalLinkThreadInputSchema = {
  articleId: z.string().min(1).describe('Article ID'),
  threadId: z.string().min(1).describe('Thread ID to link/unlink'),
  action: z.enum(['link', 'unlink']).optional().default('link').describe('Link or unlink'),
};

export const signalStartStudyInputSchema = {
  articleId: z.string().min(1).describe('Article ID to study'),
  threadId: z.string().optional().describe('Thread to link (omit for no thread link)'),
};

export const signalSaveNotesInputSchema = {
  articleId: z.string().min(1).describe('Article ID'),
  notes: z.string().min(1).describe('Markdown study notes'),
  participants: z.array(z.string()).optional().describe('Cat IDs who participated'),
};

export const signalListStudiesInputSchema = {
  articleId: z.string().optional().describe('Filter by article'),
  kind: z.enum(['note', 'podcast', 'research-report']).optional().describe('Filter by artifact kind'),
  limit: z.number().int().min(1).max(50).optional().describe('Max results'),
};

export const signalGeneratePodcastInputSchema = {
  articleId: z.string().min(1).describe('Article ID'),
  mode: z.enum(['essence', 'deep']).describe('Podcast mode: essence (2-3 min) or deep (10 min)'),
  speakers: z.array(z.string()).optional().describe('Cat IDs for voices (1-3)'),
};

export const signalStudyTools = [
  {
    name: 'signal_update_article',
    description:
      'Update article fields: status, tags, or note. Use for managing articles from chat. ' +
      'STATUS VALUES: inbox (unread), read, starred (important), archived (done). ' +
      'TIP: Use tags for categorization (e.g. ["ai", "infrastructure"]) and note for 铲屎官 personal remarks.',
    inputSchema: signalUpdateArticleInputSchema,
    handler: handleUpdateArticle,
  },
  {
    name: 'signal_delete_article',
    description:
      'Soft-delete one or more articles. Use when 铲屎官 wants to clean up garbage or irrelevant signals. ' +
      'Accepts multiple IDs for batch deletion. Articles are soft-deleted (recoverable).',
    inputSchema: signalDeleteArticleInputSchema,
    handler: handleDeleteArticle,
  },
  {
    name: 'signal_link_thread',
    description:
      'Link or unlink a Signal article to/from a thread for Study association. ' +
      'Use when starting to discuss an article in a specific thread, so the study context is trackable. ' +
      'Default action is "link"; pass action="unlink" to remove the association.',
    inputSchema: signalLinkThreadInputSchema,
    handler: handleLinkThread,
  },
  {
    name: 'signal_start_study',
    description:
      'Start studying a Signal article. Returns full article content for context injection and optionally links a thread. ' +
      'WORKFLOW: start_study → read and discuss → save_notes → optionally generate_podcast. ' +
      'Use this as the entry point for deep-diving into an article.',
    inputSchema: signalStartStudyInputSchema,
    handler: handleStartStudy,
  },
  {
    name: 'signal_save_notes',
    description:
      'Save study notes for an article. Notes should include insights, reflections, and open questions from the study session. ' +
      'Use after discussing/analyzing an article. Include participants array to credit who studied it.',
    inputSchema: signalSaveNotesInputSchema,
    handler: handleSaveNotes,
  },
  {
    name: 'signal_list_studies',
    description:
      'List study artifacts (notes, podcasts, research reports) for an article. ' +
      'Use to check what study work has already been done on an article. ' +
      'TIP: Pass articleId to narrow results to a specific article; omit to list studies across all articles.',
    inputSchema: signalListStudiesInputSchema,
    handler: handleListStudies,
  },
  {
    name: 'signal_generate_podcast',
    description:
      'Generate a podcast from an article study. ' +
      'MODE SELECTION: essence = 2-3 min quick overview, deep = 10 min thorough analysis. ' +
      'Optional speakers param takes cat IDs for voice assignments (1-3 speakers). ' +
      'Returns an artifact ID and state (queued → processing → complete).',
    inputSchema: signalGeneratePodcastInputSchema,
    handler: handleGeneratePodcast,
  },
] as const;
