import { fixedFixture } from './f307-real-surface-fixtures.mjs';
import { objectFirstViewportHtml } from './f311-object-first-viewport.mjs';

function previewCats() {
  return {
    cats: [
      ...fixedFixture('/api/cats').cats,
      {
        id: 'codex-astra',
        displayName: '小星星·砚砚',
        color: { primary: '#8b6a52', secondary: '#f4e8dc' },
        mentionPatterns: ['@codex-astra'],
        clientId: 'openai',
        defaultModel: 'gpt-6-astra',
        avatar: '',
        roleDescription: '隔离预览中的原文作者',
        personality: '',
        roster: { available: true },
      },
    ],
  };
}

function previewThreadMessages(messages, threadId) {
  return {
    messages: messages
      .filter((message) => message.threadId === threadId)
      .map((message) => ({ ...message, type: message.catId ? 'assistant' : 'user' })),
    hasMore: false,
  };
}

function previewEvidence({ data, projections, writes, timings }) {
  return {
    mode: 'isolated-read-only',
    productionSequence: data.productionSequenceObserved,
    programs: projections.map((projection) => ({
      id: projection.program.programId,
      revision: projection.preparation.sections.object_map.current.ref.version,
    })),
    writes,
    timings,
  };
}

function readPreviewJson(context, url) {
  const { data, threads, projections } = context;
  if (url.pathname === '/api/capability-evolution/programs') return { programs: projections };
  const program = projections.find(
    (projection) =>
      url.pathname === `/api/capability-evolution/programs/${encodeURIComponent(projection.program.programId)}`,
  );
  if (program) return program;
  if (url.pathname === '/api/threads') return { threads };
  if (url.pathname === '/api/cats') return previewCats();
  const thread = threads.find((value) => url.pathname === `/api/threads/${value.id}`);
  if (thread) return thread;
  if (url.pathname === '/api/messages') return previewThreadMessages(data.messages, url.searchParams.get('threadId'));
  if (url.pathname === '/preview-evidence') return previewEvidence(context);
  return undefined;
}

function timedJsonReply(path, timings) {
  const startedAt = performance.now();
  return (body, status = 200) => {
    timings.push({ path, status, durationMs: performance.now() - startedAt });
    return { body, status };
  };
}

export function createObjectFirstPreviewHandler({ data, threads, writes, timings }) {
  const context = { data, threads, projections: [data.duck, data.memory], writes, timings };
  return async function handleReadonlyPreviewRequest({ request, url }) {
    const reply = timedJsonReply(url.pathname, timings);
    if (request.method !== 'GET') {
      writes.push({ method: request.method, path: url.pathname });
      return reply({ error: 'isolated_read_only_preview' }, 405);
    }
    if (url.pathname === '/api/f311-object-first-preview')
      return {
        body: Buffer.from(objectFirstViewportHtml(data)),
        contentType: 'text/html; charset=utf-8',
        binary: true,
      };
    const body = readPreviewJson(context, url);
    return body === undefined ? undefined : reply(body);
  };
}
