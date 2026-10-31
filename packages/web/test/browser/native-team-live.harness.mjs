import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { requireCodexTestHistoryPolicy } from './native-codex-history-policy.mjs';
import { realTaskOutcome } from './native-team-a2a-proof.mjs';
import { openJourneyBrowser } from './native-team-browser.mjs';
import { settleOwnedThread } from './native-team-cleanup.mjs';
import { observePageFaults } from './native-team-observers.mjs';
import { waitForRenderedReply } from './native-team-rendered-reply.mjs';

// Opt-in only: these tests invoke paid, locally authenticated clients. They never
// reset data or copy credentials. HTTP/model traffic must not be mocked here.
export async function openLiveJourney() {
  assert.equal(process.env.CAT_CAFE_ONBOARDING_LIVE_CALLS, 'approved');
  const web = new URL(process.env.CAT_CAFE_ONBOARDING_E2E_URL);
  const api = new URL(process.env.CAT_CAFE_ONBOARDING_E2E_API);
  for (const url of [web, api]) {
    assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
    assert.ok(url.port && !['3003', '3004'].includes(url.port), 'Never use production ports');
  }
  const directory = process.env.CAT_CAFE_ONBOARDING_E2E_EVIDENCE;
  assert.ok(directory && path.isAbsolute(directory));
  await fs.mkdir(directory, { recursive: true });
  const record = {
    modelRequestsMocked: false,
    web: web.origin,
    api: api.origin,
    steps: [],
    calls: [],
    pageErrors: [],
    dialogs: [],
  };
  const save = () => fs.writeFile(path.join(directory, 'live-journey.json'), JSON.stringify(record, null, 2));
  const request = async (url, options = {}, acceptedStatuses = []) => {
    const response = await fetch(new URL(url, api), {
      ...options,
      headers: { 'X-Cat-Cafe-User': 'default-user', 'Content-Type': 'application/json', ...options.headers },
      signal: AbortSignal.timeout(15000),
    });
    assert.ok(response.ok || acceptedStatuses.includes(response.status), `${url}: HTTP ${response.status}`);
    return response.json();
  };
  const { browser, context, page, nativeRenderer } = await openJourneyBrowser(web);
  record.nativeRenderer = nativeRenderer;
  record.initialRendererUrl = page.url();
  page.setDefaultTimeout(20000);
  const stopObserver = await observePageFaults(page, record);
  const log = async (name, details = {}) => {
    record.steps.push({ name, at: new Date().toISOString(), ...details });
    await save();
    console.log(name);
  };
  return {
    web,
    api,
    page,
    nativeRenderer,
    record,
    request,
    save,
    log,
    screenshot: (name) => page.screenshot({ path: path.join(directory, `${name}.png`), fullPage: true }),
    close: async () => {
      try {
        await save();
      } finally {
        try {
          await stopObserver();
          if (!nativeRenderer) await context.close();
        } finally {
          await browser.close();
        }
      }
    },
  };
}

export function roleIdentity(cat) {
  return {
    id: cat.id,
    name: cat.displayName,
    nickname: cat.nickname,
    clientId: cat.clientId,
    avatar: cat.avatar,
    mentionPatterns: cat.mentionPatterns,
  };
}

async function leaveRetiredThread(page, threadId) {
  if (page.url().includes(`/thread/${threadId}`)) await page.goto('about:blank');
}

export async function callRealPartner(journey, cat) {
  if (cat.clientId === 'openai')
    journey.record.nativeHistoryPolicy = await requireCodexTestHistoryPolicy(
      process.env.CAT_CAFE_ONBOARDING_E2E_INSTANCE,
      process.env.CAT_CAFE_ONBOARDING_CODEX_HISTORY_POLICY,
    );
  const { request, page, web, record, save } = journey;
  const marker = `LIVE_${cat.id.replaceAll('-', '_')}_${randomUUID().slice(0, 8)}`;
  const result = { catId: cat.id, marker, passed: false };
  record.calls.push(result);
  const started = Date.now();
  let cleanupError;
  try {
    const thread = await request('/api/threads', {
      method: 'POST',
      body: JSON.stringify({ title: `端到端验收 ${cat.displayName}` }),
    });
    result.threadId = thread.id;
    await page.goto(new URL(`/thread/${thread.id}?shell=v2&lang=zh`, web).href);
    const input = page.locator('textarea').first();
    await input.waitFor();
    await input.fill(`${cat.mentionPatterns[0]} 请只回复 ${marker}，不要调用任何工具。`);
    const response = page.waitForResponse(
      (res) => new URL(res.url()).pathname === '/api/messages' && res.request().method() === 'POST',
    );
    await input.press('Enter');
    assert.equal((await response).status(), 202);
    const deadline = Date.now() + 180000;
    let messages = [];
    while (Date.now() < deadline) {
      messages = (await request(`/api/messages?threadId=${thread.id}&limit=50`)).messages;
      const outcome = realTaskOutcome(messages, cat.id, marker);
      if (outcome) {
        result.terminalOutcome = outcome;
        assert.equal(outcome.status, 'passed', `${cat.id}: ${outcome.reason}`);
        result.replyMessageId = outcome.messageId;
        result.invocationId = messages.find((message) => message.id === outcome.messageId).lifecycle.invocationId;
        break;
      }
      await page.waitForTimeout(750);
    }
    assert.ok(result.replyMessageId, `${cat.id} did not return the unique task marker within 180s`);
    result.historyMessageIds = messages.map((message) => message.id);
    await page.reload();
    await waitForRenderedReply(page, result.replyMessageId, marker);
    await page.waitForFunction(
      ({ messageId, avatar }) =>
        [...document.querySelectorAll(`[data-message-id="${messageId}"] img`)].some(
          (image) => image.getAttribute('src') === avatar && image.complete && image.naturalWidth > 0,
        ),
      { messageId: result.replyMessageId, avatar: cat.avatar },
    );
    result.avatarLoaded = true;
    await journey.screenshot(`reply-${cat.id}-${marker.slice(-8)}`);
    result.passed = true;
  } catch (error) {
    result.passed = false;
    result.error = String(error.message).slice(0, 400);
    await journey.screenshot(`failure-${cat.id}-${marker.slice(-8)}`);
  } finally {
    try {
      // Leave the retired thread before deleting it. The conversation-view
      // hook is intentionally strict about a missing owned thread; keeping
      // the document mounted while cleanup runs turns that expected deletion
      // into a false renderer 404.
      if (result.threadId) await leaveRetiredThread(page, result.threadId);
      if (result.threadId)
        result.cleanup = await settleOwnedThread(request, result.threadId, { cancel: !result.passed });
    } catch (error) {
      result.passed = false;
      result.cleanupError = error.message;
      cleanupError = error;
    }
  }
  if (result.passed) {
    try {
      const invocations = (await request(`/api/threads/${result.threadId}/invocations?limit=20`)).invocations;
      result.invocationStatus = invocations.find(
        (invocation) => invocation.invocationId === result.invocationId,
      )?.status;
      assert.equal(result.invocationStatus, 'done', 'The real invocation must finish naturally after its reply');
    } catch (error) {
      result.passed = false;
      result.error = error.message;
    }
  }
  result.durationMs = Date.now() - started;
  await save();
  console.log(`${cat.id}: ${result.passed ? 'PASS' : result.error || result.cleanupError}`);
  if (cleanupError) throw cleanupError;
  return result;
}

export async function verifyRetainedHistory(journey, previous) {
  const cats = (await journey.request('/api/cats')).cats;
  for (const role of previous.roles) assert.deepEqual(roleIdentity(cats.find((cat) => cat.id === role.id)), role);
  for (const call of previous.calls) {
    assert.ok(
      call.threadId && call.replyMessageId && call.historyMessageIds?.length,
      'Failed calls are not persistence acceptance evidence',
    );
    const messages = (await journey.request(`/api/messages?threadId=${call.threadId}&limit=50`)).messages;
    const ids = new Set(messages.map((message) => message.id));
    for (const id of call.historyMessageIds) assert.ok(ids.has(id), `Persisted message missing: ${id}`);
    const reply = messages.find((message) => message.id === call.replyMessageId);
    assert.ok(JSON.stringify(reply.content).includes(call.marker));
    await journey.page.goto(new URL(`/thread/${call.threadId}?shell=v2&lang=zh`, journey.web).href);
    await waitForRenderedReply(journey.page, call.replyMessageId, call.marker);
  }
  await journey.log('retained-roles-and-message-ids-verified', {
    roles: previous.roles.length,
    threads: previous.calls.length,
  });
  return cats;
}
