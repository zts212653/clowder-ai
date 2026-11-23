import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Real Sidebar reads synthetic HTTP snapshots; only the fixture supplies changing facts. */
export async function verifyArrangeGeometry(browser, fixture, evidence, errors, owner) {
  const members = ['Geometry member A', 'Geometry member B'].map((title) => fixture.store.create(owner, title, '/A'));
  const source = fixture.store.create(
    owner,
    '整理期间保持拖放目标稳定的长中文标题，用来覆盖标题换行与实时状态组合',
    '/A',
  );
  const target = fixture.store.create(owner, 'Geometry lower target', '/A');
  const created = await fixture.api.app.inject({
    method: 'POST',
    url: '/api/config/thread-attention/groups',
    payload: { action: 'create', name: 'Geometry group', threadIds: members.map((row) => row.id) },
  });
  assert.equal(created.statusCode, 200);
  const group = created.json().groups.find((item) => item.threadIds.includes(members[0].id));
  await fixture.api.app.inject({
    method: 'PUT',
    url: '/api/config/thread-attention',
    payload: { anchor: `group:${group.id}`, open: false },
  });
  const extras = Array.from({ length: 60 }, (_, index) => fixture.store.create(owner, `Geometry extra ${index}`, '/A'));
  const results = [];
  for (const view of ['flat', 'project', 'virtual'])
    for (const initial of [false, true]) {
      await fixture.api.app.inject({
        method: 'PUT',
        url: '/api/config/thread-attention',
        payload: { anchor: `group:${group.id}`, open: false },
      });
      const context = await browser.newContext({
        viewport: { width: initial ? 240 : 300, height: 900 },
        deviceScaleFactor: 2,
        reducedMotion: 'reduce',
      });
      try {
        const page = await context.newPage();
        page.on('pageerror', (error) => errors.push(error.message));
        let facts = {
          unreadCount: initial ? 7 : 0,
          hasUserMention: false,
          presence: { status: initial ? 'working' : 'idle' },
        };
        let pending = false;
        let factsId = members[0].id;
        let sourceTitle = source.title;
        await page.route(/\/api\/threads\?view=sidebar/, (route) =>
          route.fulfill({
            json: {
              threads: [source, target, ...members, ...(view === 'virtual' ? extras : [])].map((row, index) => ({
                ...row,
                title: row.id === source.id ? sourceTitle : row.title,
                lastActiveAt: Date.now() - index * 1000,
                pinned: row.id === members[0].id,
                unreadCount: 0,
                hasUserMention: false,
                presence: { status: 'idle' },
                ...(row.id === factsId ? facts : {}),
              })),
            },
          }),
        );
        await page.route(/\/api\/concierge\/work\/decisions\?/, (route) => {
          const sourceRead = { status: 'available', exhaustiveness: 'complete' };
          const count = Number(pending);
          return route.fulfill({
            json: {
              version: 1,
              status: 'available',
              scope: 'owner_all_projects',
              identity: { ownerUserId: owner },
              observedAt: 3,
              sources: { approvals: sourceRead, needsMe: sourceRead, personalPreferences: sourceRead },
              personalView: {
                mode: 'visible',
                preferenceRevision: 1,
                originalTotalCount: count,
                visibleTotalCount: count,
                ignoredTotalCount: 0,
                originalAttentionCount: count,
                visibleAttentionCount: count,
                ignoredAttentionCount: 0,
              },
              readWindow: { startedAt: 1, endedAt: 3, consistency: 'independent_source_reads' },
              consistency: { state: 'verified', reasons: [] },
              totalCount: count,
              page: { offset: 0, limit: 20, scope: 'known_rows', hasMore: false },
              items: pending
                ? [
                    {
                      decisionRef: 'approval:F193:geometry',
                      kind: 'approval',
                      summary: 'Geometry decision',
                      linkedNeedsMe: [],
                      approval: {
                        proposalId: 'geometry',
                        resolution: 'open',
                        navigation: {
                          state: 'anchored',
                          approvalCardRef: { threadId: factsId, messageId: 'synthetic-message' },
                        },
                      },
                      preferenceCoordinate: {
                        kind: 'mailbox',
                        decisionRef: 'approval:F193:geometry',
                        version: `sha256:${'a'.repeat(64)}`,
                      },
                    },
                  ]
                : [],
            },
          });
        });
        await page.addInitScript(
          ({ draftIds }) => {
            localStorage.setItem('cat-cafe:shell-presentation', 'v2');
            localStorage.setItem('cat-cafe:shell-language', 'zh');
            localStorage.setItem('cat-cafe:sidebar:active-tab', 'recent');
            sessionStorage.setItem(
              'cat-cafe:thread-drafts',
              JSON.stringify(draftIds.map((id) => [id, 'Synthetic geometry draft'])),
            );
          },
          { draftIds: initial ? [source.id, members[0].id] : [] },
        );
        await page.goto(`${fixture.webUrl}/dev/f277-attention-preview/search`);
        await page.locator(`[data-thread-id="${source.id}"]`).waitFor();
        if (view === 'project') {
          await page.getByTestId('sidebar-view-menu').click();
          await page.getByTestId('sidebar-tab-project').click();
        }
        if (view === 'virtual') await page.getByTestId('virtual-attention-list').waitFor();
        const header = page.locator(`[data-attention-cluster="group:${group.id}"]`);
        await header.waitFor();
        const coordinates = () =>
          page.locator(`[data-thread-id="${source.id}"], [data-thread-id="${target.id}"]`).evaluateAll((rows) =>
            rows.map((row) => ({
              id: row.dataset.threadId,
              y: row.getBoundingClientRect().y,
              height: row.getBoundingClientRect().height,
            })),
          );
        const before = await coordinates();
        const sourceRow = page.locator(`[data-attention-draggable-thread="${source.id}"]`);
        await sourceRow.hover();
        await page.mouse.down();
        await page.getByTestId('attention-arrange-toolbar').waitFor();
        await page.mouse.up();
        assert.deepEqual(await coordinates(), before, 'entry keeps the same geometry');
        for (const kind of ['unread', 'mention', 'decision', 'working', 'done', 'error'])
          for (const on of [true, false]) {
            facts = {
              unreadCount: kind === 'unread' && on ? 7 : 0,
              hasUserMention: kind === 'mention' && on,
              presence: { status: on && ['working', 'done', 'error'].includes(kind) ? kind : 'idle' },
            };
            pending = kind === 'decision' && on;
            await Promise.all([
              page.waitForResponse((response) => response.url().includes('/api/threads?view=sidebar') && response.ok()),
              page.waitForResponse(
                (response) => response.url().includes('/api/concierge/work/decisions?') && response.ok(),
              ),
              page.evaluate(() => {
                window.dispatchEvent(new Event('online'));
                window.dispatchEvent(new Event('cat-cafe:proposal-updated'));
              }),
            ]);
            await page.waitForFunction(
              ({ anchor, attention, presence }) => {
                const group = document.querySelector(`[data-attention-cluster="${anchor}"]`);
                const count = group?.querySelector('[data-testid="group-count"]')?.textContent;
                const status = group?.querySelector(
                  '[data-testid="group-running-cat"], [data-testid="group-replied-cat"], [data-testid="group-error-dot"], [data-testid="arrange-signal-badge"]:not([data-presence="idle"])',
                );
                return (attention ? count?.includes('1') : !count) && Boolean(status) === presence;
              },
              {
                anchor: `group:${group.id}`,
                attention: on && ['unread', 'mention', 'decision'].includes(kind),
                presence: on && ['working', 'done', 'error'].includes(kind),
              },
            );
            await page.evaluate(
              () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
            );
            const after = await coordinates();
            if (kind === 'unread' && on)
              await page.screenshot({
                path: path.join(evidence, `geometry-${view}-${initial ? 'occupied' : 'empty'}-unread.png`),
              });
            results.push({ view, initial, kind, on, before, after });
            await writeFile(path.join(evidence, 'geometry-results.json'), JSON.stringify(results, null, 2));
            assert.deepEqual(after, before, `${view} initial=${initial} ${kind}=${on}: no target moves`);
          }
        await page.getByTestId('attention-arrange-toolbar').getByRole('button', { name: '完成', exact: true }).click();
        await page.waitForFunction(
          (anchor) => !document.querySelector(`[data-attention-cluster="${anchor}"] [data-testid="group-status-line"]`),
          `group:${group.id}`,
        );
        assert.equal(await header.locator('[data-testid="collapsed-group-peek"]').count(), 0);
        for (const phase of ['ordinary', 'member']) {
          factsId = phase === 'ordinary' ? source.id : members[0].id;
          if (phase === 'member') {
            await header.locator('button[aria-controls^="attention-members-"]').click();
            await page.locator(`[data-attention-draggable-thread="${members[0].id}"]`).waitFor();
          }
          const sync = async () => {
            await Promise.all([
              page.waitForResponse((response) => response.url().includes('/api/threads?view=sidebar') && response.ok()),
              page.waitForResponse(
                (response) => response.url().includes('/api/concierge/work/decisions?') && response.ok(),
              ),
              page.evaluate(() => {
                window.dispatchEvent(new Event('online'));
                window.dispatchEvent(new Event('cat-cafe:proposal-updated'));
              }),
            ]);
            await page.evaluate(
              () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
            );
          };
          facts = {
            unreadCount: initial ? 1 : 0,
            hasUserMention: initial,
            presence: { status: initial ? 'working' : 'idle', cats: initial ? ['codex', 'claude'] : [] },
          };
          pending = initial;
          await sync();
          if (phase === 'ordinary') {
            sourceTitle = await sourceRow.locator('[role="link"]').evaluate((node) => {
              const canvas = document.createElement('canvas');
              const context = canvas.getContext('2d');
              const style = getComputedStyle(node);
              context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
              return '静'.repeat(Math.floor(node.getBoundingClientRect().width / context.measureText('静').width));
            });
            await sync();
          }
          const changing = page.locator(`[data-attention-draggable-thread="${factsId}"]`);
          const signalLayout = initial
            ? await changing
                .getByTestId('thread-row-signals')
                .evaluate((line) => ({ height: line.getBoundingClientRect().height, split: line.dataset.signalSplit }))
            : null;
          if (initial && phase === 'member')
            assert.equal(signalLayout.split, 'true', '240px member with complete facts really splits before entry');
          const stable = await coordinates();
          await sourceRow.hover();
          await page.mouse.down();
          await page.getByTestId('attention-arrange-toolbar').waitFor();
          await page.mouse.up();
          assert.deepEqual(await coordinates(), stable, `${view}/${phase}: entry`);
          for (const kind of ['unread', 'mention', 'decision', 'working', 'done', 'error', 'combined'])
            for (const on of [true, false]) {
              facts = {
                unreadCount: on && ['unread', 'combined'].includes(kind) ? 999 : 0,
                hasUserMention: on && ['mention', 'combined'].includes(kind),
                presence: {
                  status:
                    on && ['working', 'done', 'error', 'combined'].includes(kind)
                      ? kind === 'combined'
                        ? 'working'
                        : kind
                      : 'idle',
                },
              };
              pending = on && ['decision', 'combined'].includes(kind);
              await sync();
              const live = await changing.evaluate(
                (row) =>
                  row.textContent +
                  [...row.querySelectorAll('[aria-label]')].map((node) => node.getAttribute('aria-label')).join(' '),
              );
              const label = {
                unread: '未读',
                mention: '@你',
                decision: '等你决定',
                working: '执行中',
                done: '已回复',
                error: '出错',
                combined: '未读',
              }[kind];
              assert.equal(live.includes(label), on, `${phase}/${kind}: live facts remain visible`);
              if (kind === 'combined' && on)
                assert.equal(
                  await changing.getByTestId('thread-pin-button').evaluate((button) => {
                    const box = button.getBoundingClientRect();
                    return button.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
                  }),
                  true,
                  'the live corner mark leaves the pin button reachable',
                );
              if (signalLayout)
                assert.equal(
                  await changing
                    .getByTestId('thread-row-signals')
                    .evaluate((line) => line.getBoundingClientRect().height),
                  signalLayout.height,
                  'captured split/empty signal space stays the same height',
                );
              const after = await coordinates();
              results.push({ view, phase, initial, kind, on, before: stable, after });
              await writeFile(path.join(evidence, 'geometry-results.json'), JSON.stringify(results, null, 2));
              if (kind === 'combined' && on)
                await page.screenshot({
                  path: path.join(evidence, `geometry-${view}-${initial ? 'occupied' : 'empty'}-${phase}-combined.png`),
                });
              assert.deepEqual(after, stable, `${view}/${phase} initial=${initial} ${kind}=${on}: no target moves`);
            }
          if (phase === 'ordinary') {
            facts = { unreadCount: 0, hasUserMention: false, presence: { status: 'idle' }, lastActiveAt: 0 };
            await sync();
            const after = await coordinates();
            results.push({ view, phase, initial, kind: 'time', before: stable, after });
            await writeFile(path.join(evidence, 'geometry-results.json'), JSON.stringify(results, null, 2));
            assert.deepEqual(after, stable, `${view}/ordinary time text: no target moves`);
            facts = { unreadCount: 0, hasUserMention: false, presence: { status: 'idle' } };
            await sync();
          }
          await page
            .getByTestId('attention-arrange-toolbar')
            .getByRole('button', { name: '完成', exact: true })
            .click();
          if (initial) await changing.getByTestId('thread-row-draft').waitFor();
          else await changing.locator('[data-testid="thread-row-signals"]').waitFor({ state: 'detached' });
        }
      } finally {
        await context.close();
      }
    }
  assert.deepEqual(errors, []);
}
