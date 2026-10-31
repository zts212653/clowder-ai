import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { before, test } from 'node:test';
import { build } from 'vite';

/** Actual callback messages → actual ChatMessage and history owner; all browser requests stay isolated. */
export function registerCrossThreadLetterJourneys({ webRoot, browser, evidenceDir }) {
  const origin = 'https://f322-letter.test';
  let script, css, proof;
  before(async () => {
    const fixtureRoot = path.join(webRoot, 'test/browser/fixtures');
    proof = JSON.parse(await readFile(path.join(fixtureRoot, 'f322-cross-thread-letter-delivery.json'), 'utf8'));
    // Keep the original callback archive unchanged; serve its agent identities in the current History DTO.
    proof = {
      ...proof,
      messages: proof.messages.map((message) => {
        assert.equal(message.type, 'assistant');
        assert.equal(typeof message.catId, 'string');
        return { ...message, from: { kind: 'agent', catId: message.catId } };
      }),
    };
    const built = await build({
      root: webRoot,
      configFile: false,
      logLevel: 'silent',
      esbuild: { jsx: 'automatic' },
      resolve: {
        alias: [
          { find: 'next/navigation', replacement: path.join(fixtureRoot, 'f322-shell-navigation.ts') },
          { find: '@', replacement: path.join(webRoot, 'src') },
        ],
      },
      define: { 'process.env.NEXT_PUBLIC_API_URL': JSON.stringify(origin) },
      build: {
        write: false,
        minify: false,
        rollupOptions: {
          input: path.join(fixtureRoot, 'f322-cross-thread-letter.tsx'),
          output: { format: 'es', inlineDynamicImports: true },
        },
      },
    });
    const outputs = built.output;
    script = outputs.find((o) => o.type === 'chunk' && o.isEntry).code;
    css = outputs
      .filter((o) => o.type === 'asset' && o.fileName.endsWith('.css'))
      .map((o) => o.source)
      .join('\n');
  });
  async function open({ width = 720, base = 'light', lang = 'zh', state = 'unloaded', shell = 'v2' } = {}) {
    const page = await browser().newPage({ viewport: { width: width + 24, height: 760 } });
    const errors = [],
      reads = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(
      ({ shell, lang }) => {
        localStorage.setItem('cat-cafe:shell-presentation', shell);
        localStorage.setItem('cat-cafe:shell-language', lang);
      },
      { shell, lang },
    );
    const sourceMessages = [
      {
        from: { kind: 'agent', catId: 'opus' },
        id: 'before-original',
        type: 'assistant',
        catId: 'opus',
        content: 'Before source.\n\n'.repeat(25),
        timestamp: 1,
      },
      {
        from: { kind: 'agent', catId: 'opus' },
        id: 'original-message',
        type: 'assistant',
        catId: 'opus',
        origin: 'stream',
        content: 'Original source message · 原对话里的那一句。',
        timestamp: 2,
        extra: { stream: { invocationId: proof.invocationId, turnInvocationId: proof.invocationId } },
      },
      {
        from: { kind: 'agent', catId: 'opus' },
        id: 'after-original',
        type: 'assistant',
        catId: 'opus',
        content: 'After source.\n\n'.repeat(50),
        timestamp: 3,
      },
    ];
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      assert.equal(url.origin, origin, 'no browser request reaches live services');
      const json = (body, status = 200) =>
        route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (url.pathname === '/proof.js') return route.fulfill({ contentType: 'text/javascript', body: script });
      if (url.pathname === '/proof.css') return route.fulfill({ contentType: 'text/css', body: css });
      if (url.pathname.startsWith('/vendor/app/'))
        return route.fulfill({
          contentType: 'text/css',
          body: await readFile(path.join(webRoot, 'public', url.pathname), 'utf8'),
        });
      if (url.pathname.startsWith('/avatars/'))
        return route.fulfill({
          contentType: 'image/svg+xml',
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="15" fill="#999"/></svg>',
        });
      if (url.pathname === '/api/cats')
        return json({
          cats: [
            ['opus', '布偶猫', '宪宪', '#9B7EBD'],
            ['codex', '缅因猫', '砚砚', '#5B8C5A'],
          ].map(([id, displayName, nickname, primary]) => ({
            id,
            displayName,
            nickname,
            breedId: id === 'opus' ? 'ragdoll' : 'maine-coon',
            avatar: `/avatars/${id}.svg`,
            color: { primary, secondary: '#eee' },
            mentionPatterns: [`@${id}`],
            carrier: 'cli',
            clientId: 'proof',
            defaultModel: 'proof',
          })),
        });
      if (url.pathname === `/api/threads/${proof.source.id}`) {
        reads.push(url.pathname);
        return state === 'unreadable'
          ? json({}, 503)
          : json({ ...proof.source, ...(state === 'deleted' ? { deletedAt: 10 } : {}) });
      }
      if (url.pathname === '/api/threads') return json({ threads: [proof.target] });
      if (url.pathname === '/api/messages')
        return json({
          messages: url.searchParams.get('threadId') === proof.source.id ? sourceMessages : proof.messages,
          hasMore: false,
        });
      if (url.pathname.startsWith('/api/'))
        return json({ cats: [], tasks: [], queue: [], activeInvocations: [], variables: [], catOrder: [] });
      return route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/proof.css"><div id="root"></div><script type="module" src="/proof.js"></script>',
      });
    });
    await page.goto(`${origin}/thread/${proof.target.id}?width=${width}&base=${base}`);
    await page.locator(`[data-message-id="${proof.messages[0].id}"]`).waitFor();
    await page.locator('[data-letter-scroll]').evaluate((el) => {
      el.scrollTop = 0;
    });
    return { page, errors, reads };
  }
  test('real cross-thread cat and human letters: themed paper, recipients, deleted/unloaded/unreadable titles, languages, narrow and long scroll', async () => {
    for (const width of [720, 350])
      for (const base of ['light', 'dark'])
        for (const lang of ['zh', 'en']) {
          const { page, errors, reads } = await open({ width, base, lang });
          try {
            const paper = page.locator('[data-cross-thread-letter]').first();
            await paper.getByText(/来源设计对话/).waitFor();
            assert(reads.length > 0, 'unloaded source is read by exact id');
            assert.equal(await page.locator('[data-cross-thread-letter]').count(), 2);
            assert.equal(await page.locator('[data-cross-thread-source-pill], [data-reply-color-rail]').count(), 0);
            assert((await paper.innerText()).includes('@砚砚'));
            assert(
              (await page.locator('[data-letter-recipient="__co-creator__"]').innerText()).includes(
                lang === 'zh' ? '@你' : '@you',
              ),
            );
            assert.equal(
              await page
                .locator('[data-letter-attention]')
                .getByText(lang === 'zh' ? '@你' : '@you', { exact: true })
                .count(),
              1,
            );
            const geometry = await paper.evaluate((el) => {
              const s = getComputedStyle(el),
                p = el.parentElement;
              return {
                radius: s.borderRadius,
                border: s.borderTopWidth,
                fill: s.backgroundColor,
                rail: getComputedStyle(p).borderLeftWidth,
                width: p.clientWidth,
                scroll: p.scrollWidth,
              };
            });
            assert.equal(geometry.radius, '10px');
            assert.equal(geometry.border, '1px');
            assert.equal(geometry.rail, '0px');
            assert(geometry.scroll <= geometry.width);
            if (evidenceDir) {
              await mkdir(evidenceDir, { recursive: true });
              await paper.scrollIntoViewIfNeeded();
              await page.screenshot({ path: path.join(evidenceDir, `letter-${width}-${base}-${lang}.png`) });
            }
            await page
              .locator('[data-cross-thread-letter]')
              .nth(1)
              .getByRole('button', { name: lang === 'zh' ? /展开|显示/ : /Show more/ })
              .click();
            const scroll = page.locator('[data-letter-scroll]');
            await scroll.hover();
            // Expanding a long letter can retain the history owner's bottom anchor.
            // Establish real upward reading intent and room before testing downward scroll.
            await page.mouse.wheel(0, -500);
            await page.waitForFunction(() => {
              const el = document.querySelector('[data-letter-scroll]');
              return el.scrollHeight - el.clientHeight - el.scrollTop >= 450;
            });
            const before = await scroll.evaluate((el) => el.scrollTop);
            await page.mouse.wheel(0, 450);
            await page.waitForFunction((top) => document.querySelector('[data-letter-scroll]').scrollTop > top, before);
            assert.equal(await page.evaluate(() => window.scrollY), 0);
            assert.deepEqual(errors, []);
          } finally {
            await page.close();
          }
        }
    for (const state of ['deleted', 'unreadable']) {
      const { page, errors } = await open({ state });
      try {
        const paper = page.locator('[data-cross-thread-letter]').first();
        await paper.getByText(state === 'deleted' ? /一个已删除的对话/ : /标题读不到/).waitFor();
        assert.equal(await paper.locator('a').count(), state === 'deleted' ? 0 : 1);
        assert.deepEqual(errors, []);
      } finally {
        await page.close();
      }
    }
    if (evidenceDir) await writeFile(path.join(evidenceDir, 'delivery.json'), JSON.stringify(proof, null, 2));
  });
  test('letter navigation reaches and highlights the original source message through the real history owner', async () => {
    const { page, errors } = await open();
    try {
      await page.locator('[data-cross-thread-letter]').first().locator('a').click();
      await page.locator('[data-message-id="original-message"]').waitFor();
      assert.equal(new URL(page.url()).pathname, `/thread/${proof.source.id}`);
      await page.waitForFunction(() => {
        const el = document.querySelector('[data-message-id="original-message"]'),
          host = document.querySelector('[data-letter-scroll]');
        if (!el || !host) return false;
        const a = el.getBoundingClientRect(),
          b = host.getBoundingClientRect();
        return a.top >= b.top && a.top < b.bottom;
      });
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });
  test('the same callback deliveries retain classic mailbox capsules', async () => {
    const { page, errors, reads } = await open({ shell: 'classic' });
    try {
      assert.equal(await page.locator('[data-cross-thread-letter]').count(), 0);
      assert((await page.locator('[data-letter-scroll]').innerText()).includes('📮'));
      assert.equal(reads.length, 0);
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });
}
