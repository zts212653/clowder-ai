import assert from 'node:assert/strict';
import { test } from 'node:test';

const { aggregateThreadArtifacts } = await import(
  '../dist/domains/cats/services/agents/routing/thread-artifacts-aggregator.js'
);

function msg(id, timestamp, blocks, catId = 'opus-48') {
  return { id, catId, timestamp, extra: { rich: { blocks } } };
}

// ── F232 polish: html_widget + interactive → widget artifact ──────────

test('html_widget block → widget artifact with title', () => {
  const r = aggregateThreadArtifacts({
    messages: [msg('m-w1', 300, [{ kind: 'html_widget', v: 1, id: 'b1', html: '<div>chart</div>', title: '架构图' }])],
    prTasks: [],
    fileLedger: [],
  });
  assert.equal(r.length, 1);
  assert.equal(r[0].type, 'widget');
  assert.equal(r[0].name, '架构图');
  assert.equal(r[0].sourceMessageId, 'm-w1');
  assert.equal(r[0].widgetBlockId, 'b1', 'html_widget must carry the block coordinate for Works preview');
});

test('html_widget block without title → fallback name', () => {
  const r = aggregateThreadArtifacts({
    messages: [msg('m-w2', 310, [{ kind: 'html_widget', v: 1, id: 'b2', html: '<div>x</div>' }])],
    prTasks: [],
    fileLedger: [],
  });
  assert.equal(r[0].type, 'widget');
  assert.equal(r[0].name, 'Widget');
});

test('interactive block → widget artifact with title', () => {
  const r = aggregateThreadArtifacts({
    messages: [
      msg('m-i1', 320, [
        {
          kind: 'interactive',
          v: 1,
          id: 'b1',
          interactiveType: 'select',
          title: '选择方案',
          options: [{ id: 'a', label: 'A' }],
        },
      ]),
    ],
    prTasks: [],
    fileLedger: [],
  });
  assert.equal(r.length, 1);
  assert.equal(r[0].type, 'widget');
  assert.equal(r[0].name, '选择方案');
  assert.equal(r[0].sourceMessageId, 'm-i1');
  assert.equal(r[0].widgetBlockId, undefined, 'interactive cards stay in chat and must not enter HTML preview');
});

test('two same-name html_widget blocks in one message keep distinct coordinates', () => {
  const r = aggregateThreadArtifacts({
    messages: [
      msg('m-w3', 340, [
        { kind: 'html_widget', v: 1, id: 'same-a', html: '<div>a</div>', title: '同名' },
        { kind: 'html_widget', v: 1, id: 'same-b', html: '<div>b</div>', title: '同名' },
      ]),
    ],
    prTasks: [],
    fileLedger: [],
  });
  assert.deepEqual(
    r.map((item) => item.widgetBlockId),
    ['same-a', 'same-b'],
  );
  assert.equal(new Set(r.map((item) => item.name)).size, 1);
});

test('interactive block without title uses description fallback', () => {
  const r = aggregateThreadArtifacts({
    messages: [
      msg('m-i2', 330, [
        {
          kind: 'interactive',
          v: 1,
          id: 'b2',
          interactiveType: 'confirm',
          description: '确认部署？',
          options: [],
        },
      ]),
    ],
    prTasks: [],
    fileLedger: [],
  });
  assert.equal(r[0].name, '确认部署？');
});
