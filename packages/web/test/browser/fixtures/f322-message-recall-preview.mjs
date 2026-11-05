// Actual Next Thread/ChatContainer author preview with isolated HTTP fixtures. No Redis or production data.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLIENT_REQUEST_DIAGNOSTIC_HEADER } from '@cat-cafe/shared';
import { OTHER_THREAD_ID, realSurfaceApiResponse, THREAD_ID } from '../f307-real-surface-fixtures.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const web = path.join(repo, 'packages/web');
const port = Number(process.argv[2] ?? 5333);
assert.ok(Number.isInteger(port) && port >= 1024 && port < 65535);
assert.ok(![3001, 3002, 3011, 3012, 4111, 6397, 6398, 6399].includes(port));
export const previewRecords = Array.from({ length: 22 }, (_, i) => ({
  from:
    i % 5 === 4 ? { kind: 'user', userId: 'default-user' } : { kind: 'agent', catId: i % 2 ? 'codex61-sol' : 'opus55' },
  id: `recall-preview-${i}`,
  type: i % 5 === 4 ? 'user' : 'assistant',
  ...(i % 5 === 4 ? {} : { catId: i % 2 ? 'codex61-sol' : 'opus55' }),
  timestamp: Date.UTC(2026, 9, 1, 1, 25 + i),
  content:
    i === 0
      ? '对话导航为什么现在不准，改成琴键。先找回以前讨论过的消息，再回到刚才的阅读位置。'
      : `第 ${i + 1} 条：琴键导航与阅读位置。${'长期一起干活的对话需要有据地找回。'.repeat(8)}`,
}));
const cats = [
  {
    id: 'codex61-sol',
    displayName: '小太阳·砚砚',
    breedId: 'maine-coon',
    avatar: '/avatars/codex.png',
    carrier: 'cli',
    clientId: 'openai',
    defaultModel: 'gpt-6.1-sol',
    mentionPatterns: ['@codex61-sol'],
    color: { primary: '#5B8C5A', secondary: '#D4E6D3' },
    roster: { available: true },
  },
  {
    id: 'opus55',
    displayName: '宪宪',
    breedId: 'ragdoll',
    avatar: '/avatars/opus.png',
    carrier: 'cli',
    clientId: 'anthropic',
    defaultModel: 'claude-opus-5-5',
    mentionPatterns: ['@opus55'],
    color: { primary: '#9B7EBD', secondary: '#E8DFF5' },
    roster: { available: true },
  },
];
const api = createServer(async (request, response) => {
  response.setHeader('Access-Control-Allow-Origin', `http://127.0.0.1:${port}`);
  response.setHeader('Access-Control-Allow-Credentials', 'true');
  response.setHeader('Access-Control-Allow-Headers', `content-type,${CLIENT_REQUEST_DIAGNOSTIC_HEADER}`);
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return;
  }
  const url = new URL(request.url, `http://127.0.0.1:${port + 1}`);
  const fixture = realSurfaceApiResponse({ url: () => url.href, method: () => request.method }, false);
  if (url.pathname === '/api/cats') fixture.body = { cats };
  if (url.pathname === '/api/config/cat-order') fixture.body = { catOrder: cats.map((cat) => cat.id) };
  if (url.pathname === '/api/config')
    fixture.body = { config: { coCreator: { name: 'You', aliases: [], mentionPatterns: ['@co-creator'] } } };
  if (url.pathname === '/api/messages') fixture.body = { messages: previewRecords, hasMore: false };
  if (url.pathname === '/api/evidence/navigation-source') {
    const messageId = url.searchParams.get('messageId');
    const threadId = url.searchParams.get('threadId');
    const known =
      [THREAD_ID, OTHER_THREAD_ID].includes(threadId) &&
      (!messageId || previewRecords.some((record) => record.id === messageId));
    fixture.status = known ? 200 : 404;
    fixture.body = known
      ? {
          status: 'available',
          updated: false,
          target: { threadId, ...(messageId ? { messageId, contentRevision: `preview-${messageId}` } : {}) },
        }
      : { error: 'fixture_source_unavailable' };
  }
  if (url.pathname === '/api/evidence/search') {
    const global = !url.searchParams.has('threadId');
    fixture.body = {
      searchId: 'author-preview-query',
      query: url.searchParams.get('q'),
      results: previewRecords.slice(0, 4).map((record) => ({
        threadId: THREAD_ID,
        messageId: record.id,
        threadTitle: '长期对话 · 找回以前的消息',
        speaker: record.catId ?? 'user',
        timestamp: record.timestamp,
        timelineOrderAt: record.timestamp,
        snippet: { text: record.content, start: 0, end: record.content.length, source: 'body' },
        highlights: [{ start: record.content.indexOf('琴键'), end: record.content.indexOf('琴键') + 2 }],
        match: 'lexical',
        contentRevision: `preview-${record.id}`,
        publiclyQuotable: true,
      })),
      meta: {
        scope: global ? 'global' : 'thread',
        sort: url.searchParams.get('messageSort') ?? 'time',
        requestedMode: 'hybrid',
        effectiveMode: 'lexical',
        degraded: true,
        partial: true,
        hasMore: true,
        candidateLimit: 2000,
        semanticCandidatesLimited: false,
        sourceCoverage: 'unknown',
        freshness: 'unknown',
        response: { budgetChars: 24000, serializedChars: 2500, truncated: false, continuation: 'unavailable' },
      },
    };
  }
  response.writeHead(fixture.status ?? 200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(fixture.body));
});
api.listen(port + 1, '127.0.0.1');
await once(api, 'listening');
const dist = '.next-test-f322-recall-preview';
const tsconfig = 'tsconfig.next-test-f322-recall-preview.json';
await writeFile(
  path.join(web, tsconfig),
  JSON.stringify({
    extends: './tsconfig.json',
    compilerOptions: { noEmit: true },
    include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', `${dist}/types/**/*.ts`],
    exclude: ['node_modules'],
  }),
);
const next = spawn(
  process.execPath,
  [path.join(repo, 'node_modules/next/dist/bin/next'), 'dev', '-H', '127.0.0.1', '-p', String(port)],
  {
    cwd: web,
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_ENV: 'development',
      NEXT_PUBLIC_API_URL: `http://127.0.0.1:${port + 1}`,
      API_SERVER_PORT: String(port + 1),
      CAT_CAFE_WEB_TEST_DIST_DIR: dist,
      CAT_CAFE_WEB_TEST_TSCONFIG: tsconfig,
      NEXT_TELEMETRY_DISABLED: '1',
    },
  },
);
console.log(
  JSON.stringify({
    kind: 'author-real-host-fixture',
    origin: `http://127.0.0.1:${port}`,
    path: `/thread/${THREAD_ID}?shell=v2`,
    productionData: false,
  }),
);
next.on('exit', (code) => {
  api.close();
  process.exit(code ?? 1);
});
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => {
    next.kill(signal);
    api.close();
  });
