import { readFileSync } from 'node:fs';
import { ScriptTarget, transpileModule } from 'typescript';
import { expect, it, vi } from 'vitest';
import { composerInsertFromRecall } from '@/utils/true-recall';
import { fixtureData, fixtureSidebar } from './chat-fixture';

it('keeps host draft edits out of published sources and still pushes changed source data', () => {
  const source = readFileSync('src/pdl/PdlAppHost.tsx', 'utf8');
  const body = source
    .split("const inputSnapshot = (): ChatPort['data'] => {")[1]
    .split('\n  const port = useRef<ChatPort>')[0]
    .replace(/\n {2}};\s*$/, '');
  const snapshot = new Function(
    'current',
    'exportSnapshot',
    'lastInput',
    'replyCurrent',
    'project',
    'exportMids',
    'playback',
    'admissionRef',
    transpileModule(body, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText,
  );
  const current = { current: fixtureData() },
    lastInput = {},
    project = { current: { data: {} } };
  const reply = { current: { preference: { mode: 'whole', status: 'ready', error: null } } };
  const read = () => snapshot(current, {}, lastInput, reply, project, undefined, {}, {}) as Record<string, unknown>;
  const first = read(),
    sidebar = fixtureSidebar(current.current),
    port = { current: { data: first, sidebarData: sidebar } };
  const publishBody = source.split('const publishData = useCallback(() => {')[1].split(/\n {2}}, \[[^\]]*\]\);/)[0];
  const publish = new Function(
    'inputSnapshot',
    'sidebarSnapshot',
    'lastSidebar',
    'current',
    'port',
    'project',
    transpileModule(publishBody, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText,
  );
  const update = vi.fn();
  window.clowderChat = { update, dataOk: vi.fn(), dataError: vi.fn() } as unknown as typeof window.clowderChat;
  const lastSidebar = {};
  for (const char of 'hello world') {
    current.current = { ...current.current, input: current.current.input + char };
    publish(read, () => sidebar, lastSidebar, current, port, project);
    expect(port.current.data.chat).toBe(first.chat);
  }
  expect(update).not.toHaveBeenCalled();
  current.current = { ...current.current, images: [new File(['image'], 'public.png', { type: 'image/png' })] };
  publish(read, () => sidebar, lastSidebar, current, port, project);
  expect(update).toHaveBeenCalledTimes(1);
  expect(port.current.data.chat).not.toBe(first.chat);
});

it('restores recalled files with their descriptor, rejects truncated bytes, and retains the file insert', async () => {
  const source = readFileSync('src/pdl/PdlAppHost.tsx', 'utf8');
  const code = source.slice(
    source.indexOf('async function downloadImages('),
    source.indexOf('function subscribeDraftOwner'),
  );
  const api = vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(['file contents']) });
  const restore = new Function(
    'apiFetch',
    'File',
    transpileModule(code, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText + '; return downloadImages;',
  )(api, File);
  const block = {
    type: 'file' as const,
    url: '/uploads/recalled',
    fileName: 'notes.txt',
    mimeType: 'text/plain',
    fileSize: 13,
  };
  const insert = composerInsertFromRecall({
    draft: { threadId: 'thread', text: 'words', contentBlocks: [block] },
  } as unknown as Parameters<typeof composerInsertFromRecall>[0]);
  expect(insert?.preservedBlocks).toEqual([block]);
  const files = await restore([block.url], insert?.preservedBlocks);
  expect(files[0]).toMatchObject({ name: 'notes.txt', type: 'text/plain', size: 13 });
  await expect(restore([block.url], [{ ...block, fileSize: 14 }])).rejects.toThrow('attachment_size_mismatch');
});
