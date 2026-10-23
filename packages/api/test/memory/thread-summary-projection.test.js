import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { IndexBuilder } from '../../dist/domains/memory/IndexBuilder.js';
import { buildSearchableMessageContent } from '../../dist/domains/memory/message-search-content.js';

const thread = {
  id: 'summary-fixture',
  title: 'Evidence summary',
  participants: ['sol'],
  featureIds: ['F324'],
  lastActiveAt: 1700000000000,
};
const message = (content, extra = {}) => ({
  id: 'message',
  threadId: thread.id,
  timestamp: thread.lastActiveAt,
  content,
  ...extra,
});
function hash(title, summary, keywords) {
  return createHash('sha256').update(JSON.stringify({ title, summary, keywords })).digest('hex').slice(0, 16);
}
async function project(messages, snapshot = thread, suppressed = new Set()) {
  const receiver = {
    suppressedMessageIds: () => suppressed,
    messageListFn: (id, limit) => {
      assert.equal(id, snapshot.id);
      assert.equal(limit, 100);
      return messages;
    },
  };
  return IndexBuilder.prototype.buildThreadEvidenceItem.call(receiver, snapshot);
}
// Characterize the existing complete-projection contract, independently of the bounded consumer.
function expected(messages, snapshot = thread, suppressed = new Set()) {
  const title = suppressed.size
    ? `Thread ${snapshot.id.slice(0, 12)}`
    : (snapshot.title ?? `Thread ${snapshot.id.slice(0, 12)}`);
  const joined = messages
    .filter((m) => !suppressed.has(m.id))
    .map((m) => {
      const body = buildSearchableMessageContent(m);
      return body ? `[${m.catId ?? 'user'}] ${body}` : '';
    })
    .filter(Boolean)
    .join('\n');
  let summary = joined.length > 3000 ? `${joined.slice(0, 2997)}...` : joined;
  if (!summary && suppressed.size === 0) summary = snapshot.threadMemory?.summary ?? '';
  if (!summary) summary = title;
  return {
    title,
    summary,
    sourceHash: hash(title, summary, [...snapshot.participants, ...(snapshot.featureIds ?? [])]),
  };
}
function equalProjection(actual, want) {
  for (const key of ['title', 'summary', 'sourceHash']) assert.equal(actual[key], want[key], key);
}

test('summary consumer avoids all 99 irrelevant body projections while retaining the same source hash', async () => {
  const counts = { hydrated: 0, content: 0, tail: 0, inputCodeUnits: 0 };
  const messages = Array.from({ length: 100 }, (_, i) => {
    counts.hydrated++;
    return {
      ...message('', { id: `m-${i}` }),
      get content() {
        const body = i ? 'unretained '.repeat(800) : 'prefix '.repeat(1500);
        counts.content++;
        if (i) counts.tail++;
        counts.inputCodeUnits += body.length;
        return body;
      },
    };
  });
  const actual = await project(messages);
  equalProjection(actual, expected([message('prefix '.repeat(1500))]));
  assert.equal(counts.hydrated, 100, 'source hydration has not been optimized by this consumer change');
  assert.deepEqual(
    { content: counts.content, tail: counts.tail, inputCodeUnits: counts.inputCodeUnits },
    { content: 1, tail: 0, inputCodeUnits: 10500 },
  );
});

test('exact 3000 boundary distinguishes absent/empty tails from a later visible turn', async () => {
  const first = message('a'.repeat(2993)); // [user] prefix adds seven UTF-16 units.
  for (const tail of [[], [message(' \t\n')], [message('', { richBlocks: [{ title: '  ' }] })], [message('z')]]) {
    equalProjection(await project([first, ...tail]), expected([first, ...tail]));
  }
  assert.equal((await project([first])).summary, '[user] ' + 'a'.repeat(2993));
  assert.ok((await project([first, message('z')])).summary.endsWith('...'));
});

test('budget follows normalized visible text, not raw whitespace or rich-block metadata', async () => {
  const messages = [
    message(' \u2003'.repeat(5000)),
    message(' same\t ', {
      contentBlocks: [
        { type: 'text', text: ' SAME ' },
        {
          type: 'context_attachment',
          attachment: { text: 'Quoted   idea', comment: 'Owner\tcomment', source: { text: 'PRIVATE_METADATA' } },
        },
      ],
      richBlocks: [{ title: 'same', items: [{ caption: 'Diagram\ncaption' }] }],
    }),
    message('same', { catId: 'cat' }),
  ];
  const result = await project(messages);
  assert.equal(result.summary, '[user] same\nQuoted idea\nOwner comment\nDiagram caption\n[cat] same');
  equalProjection(result, expected(messages));
});

test('suppression excludes bodies before projection and keeps safe title/memory fallback', async () => {
  const hidden = {
    ...message('', { id: 'hidden' }),
    get content() {
      throw Error('suppressed body was accessed');
    },
  };
  const suppressed = new Set(['hidden']);
  const snapshot = { ...thread, title: 'Potential recalled title', threadMemory: { summary: 'recalled memory' } };
  const actual = await project([hidden, message('visible')], snapshot, suppressed);
  assert.equal(actual.title, `Thread ${thread.id.slice(0, 12)}`);
  assert.equal(actual.summary, '[user] visible');
  assert.equal((await project([hidden], snapshot, suppressed)).summary, actual.title);
  equalProjection(await project([message('')], snapshot), expected([message('')], snapshot));
});

test('unavailable source and a retained projection error keep the existing fail-open fallback', async () => {
  const snapshot = { ...thread, title: null, threadMemory: { summary: 'memory '.repeat(1000) } };
  const failed = {
    ...message(''),
    get content() {
      throw Error('retained projection unavailable');
    },
  };
  const result = await project([failed], snapshot);
  assert.equal(result.summary, snapshot.threadMemory.summary, 'memory fallback is not newly truncated');
  assert.equal(result.title, `Thread ${thread.id.slice(0, 12)}`);
  const receiver = {
    suppressedMessageIds: () => new Set(),
    messageListFn: () => {
      throw Error('source unavailable');
    },
  };
  equalProjection(
    await IndexBuilder.prototype.buildThreadEvidenceItem.call(receiver, snapshot),
    expected([], snapshot),
  );
});

test('UTF-16 slice and source hashes match the existing output across deterministic rich/empty/boundary cases', async () => {
  let seed = 212653;
  const random = (n) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % n;
  };
  const bits = ['a', '汉', '😀', '\ud800', '\udfff', '\0', '  ', '\t', '\n', '\u00a0', '\u2003', '\ufeff'];
  for (let run = 0; run < 200; run++) {
    const messages = Array.from({ length: 1 + random(8) }, (_, i) => {
      const text = Array.from({ length: 1 + random(12) }, () => bits[random(bits.length)]).join('');
      return message(text.repeat([1, 30, 2990, 3000][random(4)]), {
        id: `m-${i}`,
        catId: [undefined, '', 'sol', '猫'][random(4)],
        contentBlocks: [{ type: 'context_attachment', attachment: { text: ' quote ', comment: ' paired comment ' } }],
        richBlocks: [{ text, sections: [{ bodyMarkdown: text.toUpperCase() }] }],
      });
    });
    const suppressed = new Set(run % 3 === 0 ? ['m-0'] : []);
    equalProjection(await project(messages, thread, suppressed), expected(messages, thread, suppressed));
  }
  for (const length of [2992, 2993, 2994]) {
    const messages = [message('x'.repeat(length) + '😀')];
    equalProjection(await project(messages), expected(messages));
  }
});
