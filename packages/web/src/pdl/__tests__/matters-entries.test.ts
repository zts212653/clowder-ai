import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { expect, it, vi } from 'vitest';

const page = {
  matter: { matterId: 'm1', title: '发布约定', description: '', revision: 3, status: 'active' },
  entries: [
    {
      entryId: 'quote',
      status: 'active',
      source: {
        threadId: 't1',
        messageId: 'msg1',
        segment: 'body',
        start: 0,
        end: 4,
        sourceRevision: 'r',
        author: { kind: 'agent', catId: 'sol' },
        timestamp: 10,
      },
      sourceStatus: 'current',
      quote: '先核对',
      attribution: 'author',
    },
    {
      entryId: 'thread',
      status: 'active',
      source: { kind: 'thread', threadId: 't2', origin: 'explicit' },
      sourceStatus: 'thread_only',
      summary: '回退前先确认版本',
      summaryAuthor: { kind: 'user', userId: 'u' },
      recordedAt: 20,
      attribution: 'author',
    },
  ],
};

function bindMatters(post = vi.fn(async (_path: string, _q: unknown, body: unknown) => body)) {
  const fields: Record<string, string> = {};
  const errors: Record<string, string> = {};
  let dialog: { args: Record<string, string>; on: () => Promise<boolean> } | undefined;
  const context = createContext({
    VM: {},
    A: {},
    INPUTS: {},
    onStart: vi.fn(),
    settleHold: (p: unknown) => p,
    pushProjectData: vi.fn(),
    addEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
    Event: class {},
    CS: { m: { matterId: 'm1' } },
    URL,
    location: { origin: 'http://localhost', href: 'http://localhost/memory' },
    crypto: { randomUUID: () => 'req-1' },
    render: vi.fn(),
    tc: (k: string) => k,
    val: (id: string) => fields[id] ?? '',
    fieldErr: (id: string, message: string) => {
      errors[id] = message;
    },
    dialog: (d: typeof dialog) => {
      dialog = d;
    },
    projectData: () => ({ catalogs: {}, details: { m1: { data: page } } }),
    pdlReads: () => ({ member: (id: string) => ({ name: `name:${id}` }), me: () => ({ name: '我' }) }),
    api: { on: vi.fn(), get: vi.fn(), post },
  });
  runInContext(readFileSync('public/pdl-app/matters.js', 'utf8'), context);
  return { context, fields, errors, post, dialog: () => dialog! };
}

it('maps a quote entry and a thread-only summary into the same entry row', () => {
  const { context } = bindMatters();
  const [quote, thread] = runInContext('matterState(true).data.entries.map(e => matterEntryVM(e, true))', context);
  expect(quote).toMatchObject({
    quote: '先核对',
    speaker: 'sol',
    time: 10,
    pointer: '',
    jump: { t: 't1', mid: 'msg1' },
  });
  expect(thread).toMatchObject({
    quote: '',
    summary: '回退前先确认版本',
    summaryBy: '我',
    speaker: '',
    time: 20,
    pointer: 'explicit',
    threadOnly: true,
    jump: { t: 't2', mid: '' },
    editable: true,
  });
});

it('lists only the changed lines of a description', () => {
  const { context } = bindMatters();
  expect(runInContext(`matterDiff('a\\nb\\nc', 'a\\nB\\nc')`, context)).toEqual({
    mode: 'unified',
    hunks: [
      [
        '',
        [
          ['-', 'b'],
          ['+', 'B'],
        ],
      ],
    ],
  });
});

it('takes a thread link with a summary, and needs a message link for a quote', async () => {
  const post = vi.fn(async (_path: string, _q: unknown, body: unknown) => ({
    outcome: 'applied',
    matter: { matterId: 'm1' },
    body,
  }));
  const { context, fields, errors, dialog } = bindMatters(post);
  runInContext(`A.matterSource({})`, context);
  fields['matter-link'] = 'http://localhost/thread/t9';
  fields['matter-quote'] = '原话';
  expect(await dialog().on()).toBe(false);
  expect(errors['matter-link']).toBe('memoryOwners.matter.quoteNeedsMessage');
  fields['matter-quote'] = '';
  expect(await dialog().on()).toBe(false);
  expect(errors['matter-summary']).toBe('memoryOwners.matter.summaryOrQuote');
  fields['matter-summary'] = '只记归纳';
  await dialog().on();
  expect(post).toHaveBeenLastCalledWith(
    '/api/memory/matters/write',
    {},
    expect.objectContaining({ operation: 'append', summary: '只记归纳', sources: [{ threadId: 't9' }] }),
  );
});

it('keeps the original location when a correction leaves the link and quote unchanged', async () => {
  const post = vi.fn<(path: string, q: unknown, body: unknown) => Promise<unknown>>(async () => ({
    outcome: 'applied',
    matter: { matterId: 'm1' },
  }));
  const { context, fields, dialog } = bindMatters(post);
  runInContext(`A.matterSource({ entryId: 'thread' })`, context);
  expect(dialog().args).toMatchObject({ link: 'http://localhost/thread/t2', summary: '回退前先确认版本', quote: '' });
  Object.assign(fields, { 'matter-link': dialog().args.link, 'matter-summary': '改过的归纳' });
  await dialog().on();
  const body = post.mock.calls.at(-1)![2] as Record<string, unknown>;
  expect(body).toMatchObject({ operation: 'correct', entryId: 'thread', summary: '改过的归纳' });
  expect(body).not.toHaveProperty('source');
});
