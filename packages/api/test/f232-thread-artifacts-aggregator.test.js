import assert from 'node:assert/strict';
import { test } from 'node:test';

const { aggregateThreadArtifacts, collectAllThreadMessages } = await import(
  '../dist/domains/cats/services/agents/routing/thread-artifacts-aggregator.js'
);

function msg(id, timestamp, blocks, catId = 'opus-48') {
  return { id, catId, timestamp, extra: { rich: { blocks } } };
}

test('media_gallery block → one image artifact per item', () => {
  const r = aggregateThreadArtifacts({
    messages: [
      msg('m1', 100, [
        {
          kind: 'media_gallery',
          v: 1,
          id: 'b1',
          items: [{ url: '/uploads/a.png', caption: '架构图' }, { url: '/uploads/b.png' }],
        },
      ]),
    ],
    prTasks: [],
    fileLedger: [],
  });
  assert.equal(r.length, 2);
  assert.ok(r.every((a) => a.type === 'image'));
  const names = r.map((a) => a.name);
  assert.ok(names.includes('架构图')); // caption
  assert.ok(names.includes('image')); // fallback when no caption/alt
  assert.ok(r.every((a) => a.sourceMessageId === 'm1'));
});

test('file block → file artifact with url + fileName', () => {
  const r = aggregateThreadArtifacts({
    messages: [msg('m2', 50, [{ kind: 'file', v: 1, id: 'b1', url: '/uploads/report.pdf', fileName: '报告.pdf' }])],
    prTasks: [],
    fileLedger: [],
  });
  assert.equal(r.length, 1);
  assert.equal(r[0].type, 'file');
  assert.equal(r[0].name, '报告.pdf');
  assert.equal(r[0].url, '/uploads/report.pdf');
  assert.equal(r[0].sourceMessageId, 'm2');
});

test('diff block → code artifact (no url, ref=filePath)', () => {
  const r = aggregateThreadArtifacts({
    messages: [msg('m3', 60, [{ kind: 'diff', v: 1, id: 'b1', filePath: 'src/x.ts', diff: '@@ ...' }])],
    prTasks: [],
    fileLedger: [],
  });
  assert.equal(r[0].type, 'code');
  assert.equal(r[0].name, 'src/x.ts');
  assert.equal(r[0].url, undefined);
  assert.equal(r[0].ref, 'src/x.ts');
});

test('audio block → audio artifact (title preferred, else truncated text)', () => {
  const r = aggregateThreadArtifacts({
    messages: [
      msg('m4', 70, [
        {
          kind: 'audio',
          v: 1,
          id: 'b1',
          url: '/uploads/v.mp3',
          text: '这是一段很长很长很长很长很长很长很长的语音总结内容',
        },
      ]),
    ],
    prTasks: [],
    fileLedger: [],
  });
  assert.equal(r[0].type, 'audio');
  assert.equal(r[0].url, '/uploads/v.mp3');
  assert.equal(r[0].name.length, 24); // truncated to AUDIO_NAME_MAX
});

test('PR task → pr artifact (ref strips pr: prefix, catId from owner)', () => {
  const r = aggregateThreadArtifacts({
    messages: [],
    fileLedger: [],
    prTasks: [
      { subjectKey: 'pr:org/repo#123', title: 'cache fix', ownerCatId: 'opus-47', status: 'open', updatedAt: 80 },
    ],
  });
  assert.equal(r[0].type, 'pr');
  assert.equal(r[0].name, 'cache fix');
  assert.equal(r[0].ref, 'org/repo#123');
  assert.equal(r[0].catId, 'opus-47');
});

test('PR task without subjectKey is skipped', () => {
  const r = aggregateThreadArtifacts({
    messages: [],
    fileLedger: [],
    prTasks: [{ subjectKey: null, title: 'x', ownerCatId: 'c', status: 'open', updatedAt: 1 }],
  });
  assert.equal(r.length, 0);
});

test('file ledger entry → file artifact', () => {
  const r = aggregateThreadArtifacts({
    messages: [],
    prTasks: [],
    fileLedger: [{ ref: 'src/foo.ts', label: 'foo.ts', updatedAt: 90, updatedBy: 'opus-48' }],
  });
  assert.equal(r[0].type, 'file');
  assert.equal(r[0].name, 'foo.ts');
  assert.equal(r[0].ref, 'src/foo.ts');
  assert.equal(r[0].catId, 'opus-48');
});

test('dedup by ref keeps latest createdAt; result is time-desc', () => {
  const r = aggregateThreadArtifacts({
    messages: [],
    prTasks: [{ subjectKey: 'pr:o/r#1', title: 'pr', ownerCatId: 'c', status: 'open', updatedAt: 10 }],
    fileLedger: [
      { ref: 'a.ts', label: 'a.ts', updatedAt: 30, updatedBy: 'c' },
      { ref: 'a.ts', label: 'a.ts', updatedAt: 50, updatedBy: 'c' }, // dup ref, newer wins
    ],
  });
  assert.equal(r.length, 2); // a.ts deduped + pr#1
  assert.equal(r[0].createdAt, 50); // newest first
  assert.equal(r[1].createdAt, 10);
});

test('empty input → empty array', () => {
  assert.deepEqual(aggregateThreadArtifacts({ messages: [], prTasks: [], fileLedger: [] }), []);
});

test('non-collected blocks (card / html_widget) are ignored', () => {
  const r = aggregateThreadArtifacts({
    messages: [
      msg('m', 1, [
        { kind: 'card', v: 1, id: 'b1', title: 'x' },
        { kind: 'html_widget', v: 1, id: 'b2', html: '<div></div>' },
      ]),
    ],
    prTasks: [],
    fileLedger: [],
  });
  assert.equal(r.length, 0);
});

test('collectAllThreadMessages paginates a REAL store with no overlap (oldest→newest cursor)', async () => {
  // 砚砚 P1: mock 不能伪造分页顺序——必须用真实 MessageStore（返回 oldest→newest），
  // 否则错 cursor（page[last]）会重叠重扫，250 条返回上万条。
  const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
  const store = new MessageStore();
  const base = Date.now();
  // 250 > THREAD_SCAN_PAGE(200) → 强制多页
  for (let i = 0; i < 250; i++) {
    store.append({ userId: 'u', catId: 'opus-48', content: `m${i}`, mentions: [], timestamp: base + i, threadId: 'T' });
  }
  const all = await collectAllThreadMessages(store, 'T');
  const uniqueIds = new Set(all.map((m) => m.id));
  assert.equal(all.length, 250, 'no page overlap — returned count equals message count');
  assert.equal(uniqueIds.size, 250, 'all unique — no duplicate re-scan');
});

// ── F232 Phase A.2: video artifact detection ──────────────────

test('file block with video mimeType → type=video (AC-A9)', () => {
  const r = aggregateThreadArtifacts({
    messages: [
      msg('m-v1', 200, [
        { kind: 'file', v: 1, id: 'b1', url: '/uploads/demo.mp4', fileName: 'demo.mp4', mimeType: 'video/mp4' },
      ]),
    ],
    prTasks: [],
    fileLedger: [],
  });
  assert.equal(r.length, 1);
  assert.equal(r[0].type, 'video');
  assert.equal(r[0].name, 'demo.mp4');
  assert.equal(r[0].url, '/uploads/demo.mp4');
});

test('file block with video extension but no mimeType → type=video (extension fallback)', () => {
  const r = aggregateThreadArtifacts({
    messages: [msg('m-v2', 210, [{ kind: 'file', v: 1, id: 'b2', url: '/uploads/clip.webm', fileName: 'clip.webm' }])],
    prTasks: [],
    fileLedger: [],
  });
  assert.equal(r[0].type, 'video');
});

test('file block with non-video mimeType stays type=file', () => {
  const r = aggregateThreadArtifacts({
    messages: [
      msg('m-v3', 220, [
        {
          kind: 'file',
          v: 1,
          id: 'b3',
          url: '/uploads/report.pdf',
          fileName: 'report.pdf',
          mimeType: 'application/pdf',
        },
      ]),
    ],
    prTasks: [],
    fileLedger: [],
  });
  assert.equal(r[0].type, 'file');
});

test('file block with non-video mimeType wins over misleading video-looking filename', () => {
  const r = aggregateThreadArtifacts({
    messages: [
      msg('m-v3b', 225, [
        {
          kind: 'file',
          v: 1,
          id: 'b3b',
          url: '/uploads/report.mp4',
          fileName: 'report.mp4',
          mimeType: 'application/pdf',
        },
      ]),
    ],
    prTasks: [],
    fileLedger: [],
  });
  assert.equal(r[0].type, 'file');
});

test('file block with mov extension → type=video', () => {
  const r = aggregateThreadArtifacts({
    messages: [
      msg('m-v4', 230, [{ kind: 'file', v: 1, id: 'b4', url: '/uploads/screen.mov', fileName: 'screen.mov' }]),
    ],
    prTasks: [],
    fileLedger: [],
  });
  assert.equal(r[0].type, 'video');
});

test('getByThreadBefore (in-memory) uses effective order time — queued→delivered cursor does not re-include itself (P1 cloud review round 3)', async () => {
  // P1 回归：collectAllThreadMessages 的游标用 effective order time（deliveredAt ?? timestamp），
  // 与 Redis zset score 一致。但 in-memory getByThreadBefore 原本只比较 raw msg.timestamp——
  // 当游标传 deliveredAt（> 原始 timestamp），cursor 消息自身 timestamp < deliveredAt 仍满足边界，
  // 被再次包含 → collectAllThreadMessages 在同一页无限循环（dev/test 非 Redis 部署 hang）。
  const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
  const store = new MessageStore();
  const base = Date.now();
  store.append({ userId: 'u', catId: 'c', content: 'older', mentions: [], timestamp: base + 50, threadId: 'T' });
  const queued = store.append({
    userId: 'u',
    catId: 'c',
    content: 'queued',
    mentions: [],
    timestamp: base + 100,
    threadId: 'T',
    deliveryStatus: 'queued',
  });
  store.markDelivered(queued.id, base + 300); // re-scored: effective order time = base+300

  // 游标 = queued 的 effective order time（deliveredAt），与 collectAllThreadMessages 一致。
  const page = store.getByThreadBefore('T', base + 300, 200, queued.id);
  const ids = page.map((m) => m.id);
  assert.ok(
    !ids.includes(queued.id),
    'cursor message must not reappear in its own before-page (effective order time, not raw timestamp)',
  );
  assert.equal(page.length, 1, 'only the genuinely-older message precedes the cursor');
  assert.equal(page[0].content, 'older');
});
