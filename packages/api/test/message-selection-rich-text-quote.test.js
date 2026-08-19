import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

await import('tsx/esm');
const { MessageSelectionResolver, digestMessageBundleQuoteProjection, projectMessageBundleQuoteSourceV2 } =
  await import('../src/domains/cats/services/context/MessageSelectionResolver.ts');

const RICH_TEXT = [
  '## 修复真正的 P1：富文本划线坐标不一致',
  '',
  '浏览器按**渲染后**的 Markdown 取坐标，服务端按原始 Markdown 校验，导致你看到 `Message Bundle source validation failed`。',
  '',
  '> 要统一前后端文本投影，并覆盖标题、粗体、代码块、引用和重复文本。',
  '',
  '1. 修复真正的 P1',
  '2. 改掉这块“狗皮膏药”UI',
].join('\n');

function makeThread(overrides = {}) {
  return {
    id: 'thread-source',
    projectPath: '/test',
    title: 'Source thread',
    createdBy: 'user-1',
    participants: [],
    lastActiveAt: 1,
    createdAt: 1,
    ...overrides,
  };
}

function makeMessage(overrides = {}) {
  return {
    id: 'message-1',
    threadId: 'thread-source',
    userId: 'user-1',
    catId: 'codex-sol',
    content: RICH_TEXT,
    mentions: [],
    timestamp: 100,
    deliveryStatus: 'delivered',
    ...overrides,
  };
}

function createResolver(messages = [makeMessage()], thread = makeThread()) {
  const messageMap = new Map(messages.map((message) => [message.id, message]));
  return new MessageSelectionResolver({
    threadStore: {
      async get(threadId) {
        return thread.id === threadId ? thread : null;
      },
    },
    messageStore: {
      async getById(messageId) {
        return messageMap.get(messageId) ?? null;
      },
      // Whole-message selection resolves the canonical bubble group, so the store must expose the
      // same timeline the browser projected from.
      async getByThreadAfter(threadId) {
        return [...messageMap.values()].filter((message) => message.threadId === threadId);
      },
    },
  });
}

const auth = { userId: 'user-1' };

/**
 * Chromium's Range offsets for selecting the SECOND paragraph of the Markdown source
 * "\n\n\n\nfoo\n\nfoo" rendered through the production stack. Pinned by
 * packages/web/test/browser/message-actions-density.test.mjs so this stays a measured fact
 * rather than a guessed number.
 */
const DOM_SECOND_PARAGRAPH_RANGE = { start: 4, end: 7 };

/** Admission requires the selecting browser's on-screen uniqueness assertion; default to 1. */
async function admitQuote(resolver, item) {
  return resolver.resolveForAdmission(
    { sourceThreadId: 'thread-source', items: [{ kind: 'quote', renderedOccurrences: 1, ...item }] },
    auth,
  );
}

describe('rich-text message quotes are validated in the plane the human selected in', () => {
  it('admits a selection that crosses heading, bold and inline-code boundaries', async () => {
    const resolver = createResolver();
    const rendered = projectMessageBundleQuoteSourceV2(makeMessage());
    const text = '渲染后的 Markdown 取坐标，服务端按原始 Markdown 校验';
    const selectionStart = rendered.indexOf(text);

    const result = await admitQuote(resolver, {
      messageId: 'message-1',
      text,
      selectionStart,
      selectionEnd: selectionStart + text.length,
    });

    assert.equal(result.status, 'resolved');
    assert.equal(result.carrier.items[0].sourceProjectionVersion, 3);
    assert.equal(result.items[0].readableContent, text);
  });

  it('admits the code-span text the reader sees, which never appears in the raw Markdown plane', async () => {
    const result = await admitQuote(createResolver(), {
      messageId: 'message-1',
      text: '导致你看到 Message Bundle source validation failed。',
    });

    assert.equal(result.status, 'resolved');
    assert.equal(result.items[0].readableContent, '导致你看到 Message Bundle source validation failed。');
  });

  it('tolerates the whitespace drift between a DOM selection and the stored source', async () => {
    const result = await admitQuote(createResolver(), {
      messageId: 'message-1',
      // A browser selection across blocks collapses and re-inserts line breaks freely.
      text: '修复真正的 P1：富文本划线坐标不一致\n浏览器按渲染后的 Markdown 取坐标',
      selectionStart: 0,
      selectionEnd: 40,
    });

    assert.equal(result.status, 'resolved');
    assert.match(result.items[0].readableContent, /^修复真正的 P1：富文本划线坐标不一致/);
    assert.match(result.items[0].readableContent, /浏览器按渲染后的 Markdown 取坐标$/);
  });

  it('drops list markers and blockquote markers from the readable plane', async () => {
    const result = await admitQuote(createResolver(), {
      messageId: 'message-1',
      text: '改掉这块“狗皮膏药”UI',
    });

    assert.equal(result.status, 'resolved');
    assert.equal(result.items[0].readableContent, '改掉这块“狗皮膏药”UI');
  });

  it('refuses repeated rendered fragments instead of re-anchoring onto the wrong occurrence', async () => {
    // Rendered as <p>foo</p><p>foo</p>. The DOM plane and the projection plane disagree, so no
    // client number can name the human's range — whatever the browser reports is refused.
    // The exactly-colliding variant of this case is the next test.
    const message = makeMessage({ content: 'foo\n\n\n\n\nfoo' });
    const resolver = createResolver([message]);

    for (const selectionStart of [3, 4]) {
      const result = await admitQuote(resolver, {
        messageId: 'message-1',
        text: 'foo',
        selectionStart,
        selectionEnd: selectionStart + 3,
      });
      assert.deepEqual(result, { status: 'invalid', reason: 'ambiguous_quote', messageId: 'message-1' });
    }
  });

  it('never lets a DOM coordinate name a range, because the two planes do not align', async () => {
    // The browser measures the second paragraph at 4..7 of the rendered text; the projection
    // puts its two occurrences somewhere else entirely. The numbers are not comparable, which
    // is why the readable resolver refuses to read them at all.
    const message = makeMessage({ content: '\n\n\n\nfoo\n\nfoo' });
    const projection = projectMessageBundleQuoteSourceV2(message);
    assert.notEqual(
      projection.lastIndexOf('foo'),
      DOM_SECOND_PARAGRAPH_RANGE.start,
      'the DOM plane and the projection plane must not be assumed to agree',
    );

    const result = await admitQuote(createResolver([message]), {
      messageId: 'message-1',
      text: 'foo',
      selectionStart: DOM_SECOND_PARAGRAPH_RANGE.start,
      selectionEnd: DOM_SECOND_PARAGRAPH_RANGE.end,
    });

    assert.deepEqual(result, { status: 'invalid', reason: 'ambiguous_quote', messageId: 'message-1' });
  });

  it('refuses repetitions that only a real Markdown parse can see', async () => {
    // Each source renders the same visible text twice. An approximation of Markdown grammar
    // drops one occurrence — mismatched pipe rows guessed as tables, a lone `--` guessed as a
    // delimiter row, an invalid numeric reference decoded to its code point instead of U+FFFD —
    // and a dropped occurrence manufactures a false uniqueness. Renderer-backed fixtures live
    // in packages/web/test/browser/message-actions-density.test.mjs.
    const cases = [
      { content: 'a | b | c\n| --- |\n\n`| --- |`', visible: '| --- |' },
      { content: 'a | b\n\n| --- |\n\n`| --- |`', visible: '| --- |' },
      { content: '--\n\n`--`', visible: '--' },
      { content: '&copy;\n\n©', visible: '©' },
      { content: '&#128;\n\n\ufffd', visible: '\ufffd' },
    ];

    for (const { content, visible } of cases) {
      const message = makeMessage({ content });
      const projection = projectMessageBundleQuoteSourceV2(message);
      assert.equal(
        projection.split(visible).length - 1,
        2,
        `projection must keep both rendered occurrences of ${JSON.stringify(visible)} in ${JSON.stringify(content)}`,
      );

      const result = await admitQuote(createResolver([message]), { messageId: 'message-1', text: visible });
      assert.deepEqual(
        result,
        { status: 'invalid', reason: 'ambiguous_quote', messageId: 'message-1' },
        `a repeated visible fragment must fail closed for ${JSON.stringify(content)}`,
      );
    }
  });

  it('refuses repeated text regardless of how well the client coordinates verify', async () => {
    const message = makeMessage({ content: '第一次说转发\n\n中间\n\n第二次说转发' });
    const projection = projectMessageBundleQuoteSourceV2(message);
    const resolver = createResolver([message]);

    for (const selectionStart of [projection.indexOf('转发'), projection.lastIndexOf('转发'), 0]) {
      const result = await admitQuote(resolver, {
        messageId: 'message-1',
        text: '转发',
        selectionStart,
        selectionEnd: selectionStart + 2,
      });
      assert.deepEqual(result, { status: 'invalid', reason: 'ambiguous_quote', messageId: 'message-1' });
    }

    // Widening the selection until it is unique is the documented way through.
    const widened = await admitQuote(resolver, { messageId: 'message-1', text: '第二次说转发' });
    assert.equal(widened.status, 'resolved');
    assert.equal(widened.items[0].readableContent, '第二次说转发');
  });

  it('refuses to anchor at all when the renderer generates text with no source counterpart', async () => {
    // The rendered page shows a generated footnote label `1` and, separately, a code span `1`.
    // The projection can only ever see the code span, so uniqueness there would be a lie.
    // Renderer-backed fixture: the browser guard asserts the label is really on screen.
    for (const content of ['正文[^a]\n\n[^a]: 脚注内容\n\n`1`', '$$E=mc^2$$', '\\[E=mc^2\\]']) {
      const result = await admitQuote(createResolver([makeMessage({ content })]), {
        messageId: 'message-1',
        text: '1',
      });
      assert.deepEqual(
        result,
        { status: 'invalid', reason: 'unsupported_source', messageId: 'message-1' },
        `generated renderer text must block quote anchoring for ${JSON.stringify(content)}`,
      );
    }

    // Whole-message forwarding stays available for those messages.
    const whole = await createResolver([makeMessage({ content: '正文[^a]\n\n[^a]: 脚注内容' })]).resolveForAdmission(
      { sourceThreadId: 'thread-source', items: [{ kind: 'message', messageId: 'message-1' }] },
      auth,
    );
    assert.equal(whole.status, 'resolved');
  });

  it('refuses text the browser saw more than once on screen, whatever the projection says', async () => {
    // The renderer paints characters that no source-derived projection can contain: component
    // loading states, footnote labels, KaTeX glyphs. Only the selecting browser can count them,
    // so its assertion is the load-bearing check and admission demands exactly one occurrence.
    const message = makeMessage({ content: '```mermaid\ngraph TD\n```\n\n正在渲染 Mermaid 图表...' });
    const resolver = createResolver([message]);
    const visible = '正在渲染 Mermaid 图表...';
    // The projection genuinely sees it once — which is exactly why the server cannot decide alone.
    assert.equal(projectMessageBundleQuoteSourceV2(message).split(visible).length - 1, 1);

    const onScreenTwice = await admitQuote(resolver, {
      messageId: 'message-1',
      text: visible,
      renderedOccurrences: 2,
    });
    assert.deepEqual(onScreenTwice, { status: 'invalid', reason: 'ambiguous_quote', messageId: 'message-1' });

    // A client that omits the assertion cannot be trusted to have looked, so it fails closed too.
    const unasserted = await resolver.resolveForAdmission(
      { sourceThreadId: 'thread-source', items: [{ kind: 'quote', messageId: 'message-1', text: visible }] },
      auth,
    );
    assert.deepEqual(unasserted, { status: 'invalid', reason: 'ambiguous_quote', messageId: 'message-1' });

    // Asserted unique on screen and unique in the projection: this is the only accepted path.
    const unique = await admitQuote(resolver, { messageId: 'message-1', text: visible });
    assert.equal(unique.status, 'resolved');
  });

  it('still fails closed when the quoted characters are not in the source at all', async () => {
    const result = await admitQuote(createResolver(), {
      messageId: 'message-1',
      text: '这段话从来没有出现过',
      selectionStart: 0,
      selectionEnd: 10,
    });

    assert.deepEqual(result, { status: 'invalid', reason: 'quote_mismatch', messageId: 'message-1' });
  });

  it('keeps resolving v1 carriers written before the readable-text plane existed', async () => {
    const message = makeMessage({ content: 'alpha beta gamma' });
    const carrier = {
      v: 1,
      sourceThreadId: 'thread-source',
      items: [
        {
          kind: 'quote',
          messageId: message.id,
          selectionStart: 6,
          selectionEnd: 10,
          sourceProjectionVersion: 1,
          sourceProjectionSha256: digestMessageBundleQuoteProjection('alpha beta gamma'),
        },
      ],
    };

    const result = await createResolver([message]).resolveCarrier(carrier, auth);

    assert.equal(result.status, 'resolved');
    assert.deepEqual(result.items[0].readableContent, 'beta');
  });
});
