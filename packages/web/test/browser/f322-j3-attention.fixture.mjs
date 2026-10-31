import assert from 'node:assert/strict';
import { projectCompanionDecisions } from '../../../api/dist/routes/companion-decision-projection.js';
import { readUserMentionTodos } from '../../../api/dist/routes/user-mention-todo-projection.js';

/** Controlled inputs, projected by the original F310 producers; never represents real cat work. */
export async function readJ3Attention(url, now, snapshot, messageStore) {
  const period = url.searchParams.get('mentionPeriod') ?? 'week';
  const mentions = await readUserMentionTodos(messageStore, 'default-user', { cutover: 0, now, period });
  const source = (coverage) => ({
    status: 'available',
    exhaustiveness: 'complete',
    startedAt: now - 1000,
    observedAt: now,
    coverage,
  });
  const approval = {
    proposalId: 'j3-controlled-open-approval',
    sourceFeatureId: 'F221',
    requesterCatId: 'codex',
    ownerUserId: 'default-user',
    summary: '受控审批，只有这一项计入角标',
    detail: {},
    navigation: { state: 'legacy_unanchored' },
    inlineApprovable: false,
    resolution: 'open',
    materialization: { state: 'not_started' },
    createdAt: now - 2000,
  };
  return projectCompanionDecisions(
    { items: [approval], coverage: { state: 'complete' } },
    { ownerReads: [], coverage: { state: 'complete' } },
    'default-user',
    { offset: Number(url.searchParams.get('offset') ?? 0), limit: Number(url.searchParams.get('limit') ?? 20) },
    now,
    {
      approvals: source('all_registered_F246_producers'),
      needsMe: source('current_linked_F310_five_producers'),
      structuredChoices: source('pending_f306_structured_choices'),
    },
    mentions,
    [],
    url.searchParams.has('personalView')
      ? {
          mode: url.searchParams.get('personalView'),
          snapshot,
          state: source('owner_personal_ignored_items'),
        }
      : undefined,
  );
}

export async function assertQualifiedMailboxCounts(page, language, mentionCount) {
  const expected = '1';
  const countLabel = language === 'en' ? /1 items/ : /1 件/;
  const button = page.getByTestId('mailbox-button');
  const count = page.getByTestId('mailbox-tab-count');
  await page.waitForFunction(() => {
    const panel = document.querySelector('[data-testid="mailbox-panel"]');
    return panel && getComputedStyle(panel).backgroundColor !== 'rgba(0, 0, 0, 0)';
  });
  await page.waitForFunction(
    (value) => document.querySelector('[data-testid="mailbox-tab-count"]')?.textContent === value,
    expected,
  );
  assert.match(await button.getAttribute('aria-label'), countLabel);
  assert.equal(await count.innerText(), expected);
  const filters = page.getByTestId('mailbox-mention-controls');
  const period = filters.getByRole('combobox', { name: language === 'en' ? 'Request date filter' : '请求时间筛选' });
  await period.selectOption('earlier');
  await page.waitForFunction(() =>
    document
      .querySelector('[data-testid="mailbox-group-mentions"]')
      ?.textContent?.match(/暂无 @你 请求|No @you requests/),
  );
  assert.match(await page.getByTestId('mailbox-group-mentions').innerText(), /暂无 @你 请求|No @you requests/);
  assert.equal(
    await count.innerText(),
    '1',
    'the identically named Needs me tab keeps the global qualified decision count across request periods',
  );
  assert.match(await button.getAttribute('aria-label'), countLabel);
  await period.selectOption('week');
  await page.waitForFunction(
    (value) => document.querySelector('[data-testid="mailbox-tab-count"]')?.textContent === value,
    expected,
  );
  assert.match(await button.getAttribute('aria-label'), countLabel);
  await page.getByTestId('mailbox-has-more').waitFor();
  assert.match(await filters.locator('h3').innerText(), new RegExp(String(mentionCount)));
  assert.doesNotMatch(
    await filters.locator('h3').innerText(),
    /本页|on this page/,
    'the group uses the original full-vector count',
  );
  assert.ok(mentionCount > 20, 'this original journey must keep crossing the mailbox page boundary');
}
