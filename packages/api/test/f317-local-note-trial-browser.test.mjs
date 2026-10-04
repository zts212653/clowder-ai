import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, test } from 'node:test';
import puppeteer from 'puppeteer-core';
import { loadChromium } from '../../../scripts/f317-page-action/browser-binary.mjs';
import { startFixtureServer } from '../../../scripts/f317-page-action/serve.mjs';
import { pageActionGrantSha256 } from '../src/domains/concierge/action/LivePageAction.ts';
import { appendUser, fixture, scope, startedActionCall } from './helpers/f317-page-action-fixture.ts';

const compiled = process.env.F317_TEST_COMPILED_ACTOR === '1';
const { createCdpPageActionPort } = await import(
  compiled
    ? '../dist/domains/concierge/action/CdpPageActionPort.js'
    : '../src/domains/concierge/action/CdpPageActionPort.ts'
);
const { createLocalNoteTrialProfile, prepareLocalNoteRollback, prepareLocalNoteTrial, selectLocalNoteAction } =
  await import(
    compiled
      ? '../dist/domains/concierge/action/LocalNoteTrialProfile.js'
      : '../src/domains/concierge/action/LocalNoteTrialProfile.ts'
  );

let browser;
let server;
let url;
before(async () => {
  ({ server, url } = await startFixtureServer());
  const chromium = await loadChromium();
  browser = await puppeteer.launch({ headless: true, executablePath: chromium.executablePath() });
});
after(async () => {
  await browser?.close();
  await new Promise((resolve) => server?.close(resolve));
});

function approvalFor(id, profile, action) {
  return {
    approvalId: id,
    permissionScope: profile.profileId,
    expiresAtMs: Date.now() + 60_000,
    origin: profile.origin,
    url: profile.url,
    targetId: action.targetId,
    operation: action.operation,
    value: action.value,
    expectedReadback: action.expectedReadback,
  };
}

function approvalRecord(source, approval, action) {
  const requestRevision = createHash('sha256')
    .update(JSON.stringify([source.id, source.content]))
    .digest('hex');
  return {
    approvalId: approval.approvalId,
    scope,
    requestSourceRef: `${scope.threadId}#${source.id}`,
    requestRevision,
    actionSha256: pageActionGrantSha256({
      origin: approval.origin,
      url: approval.url,
      requestRevision,
      actions: [
        {
          targetId: action.targetId,
          operation: action.operation,
          value: action.value,
          fingerprint: action.fingerprint,
          expectedReadback: action.expectedReadback,
        },
      ],
    }),
    permissionScope: approval.permissionScope,
    expiresAtMs: approval.expiresAtMs,
  };
}

async function withLocalTrial(run) {
  const page = await browser.newPage();
  let call;
  try {
    await page.goto(url);
    const f = fixture();
    const started = await startedActionCall(f);
    call = started.call;
    return await run({ page, call, store: f.store, ledger: started.approvalLedger });
  } finally {
    await call?.stop();
    await page.close();
  }
}

test('the named local page takes an explicit grant, fills, rereads and restores under a new grant', async () => {
  await withLocalTrial(async ({ page, call, store, ledger }) => {
    const profile = createLocalNoteTrialProfile(url);
    const outbound = [];
    const favicon = new URL('/favicon.ico', url).href;
    page.on('request', (request) => {
      if (request.url() !== favicon) outbound.push(`${request.method()} ${request.url()}`);
    });
    const forwardPort = createCdpPageActionPort(page, profile.spec);
    const trial = prepareLocalNoteTrial(url, await forwardPort.inspect());
    const forwardSource = appendUser(store, `Fill the local note with ${trial.action.value}`, 'trial-forward');
    const forwardApproval = approvalFor('local-trial-forward', profile, trial.action);
    const forwardRecord = approvalRecord(forwardSource, forwardApproval, trial.action);

    assert.equal(await ledger.verify({ ...forwardRecord, signal: new AbortController().signal }), false);
    assert.equal(await page.$eval('#readback', (element) => element.textContent), trial.beforeReadback);
    ledger.issue(forwardRecord); // The isolated owner Allow once, after the preview above.
    const forward = await call.boundaryContexts.runPageAction({
      requestMessageId: forwardSource.id,
      approval: forwardApproval,
      port: forwardPort,
      selector: selectLocalNoteAction(trial.action),
    });
    assert.equal(forward.status, 'applied');
    assert.equal(await page.$eval('#readback', (element) => element.textContent), trial.action.expectedReadback);
    call.boundaryContexts.revokePageAction(forwardApproval.approvalId);
    assert.equal(await ledger.verify({ ...forwardRecord, signal: new AbortController().signal }), false);

    const restorePort = createCdpPageActionPort(page, profile.spec);
    const restore = prepareLocalNoteRollback(trial, forward, await restorePort.inspect());
    assert.notEqual(restore.fingerprint, trial.action.fingerprint);
    const restoreSource = appendUser(store, 'Restore the local trial note to its original value', 'trial-restore');
    const restoreApproval = approvalFor('local-trial-restore', profile, restore);
    const restoreRecord = approvalRecord(restoreSource, restoreApproval, restore);
    ledger.issue(restoreRecord); // A second bounded owner approval, never reuse the old fingerprint.
    const restored = await call.boundaryContexts.runPageAction({
      requestMessageId: restoreSource.id,
      approval: restoreApproval,
      port: restorePort,
      selector: selectLocalNoteAction(restore),
    });
    assert.equal(restored.status, 'applied');
    assert.equal(restored.after, trial.beforeReadback);
    assert.equal(await page.$eval('#readback', (element) => element.textContent), trial.beforeReadback);
    call.boundaryContexts.revokePageAction(restoreApproval.approvalId);
    assert.deepEqual(outbound, []);
  });
});

test('revoking the named local approval at the browser commit fence leaves no page effect', async () => {
  await withLocalTrial(async ({ page, call, store, ledger }) => {
    const profile = createLocalNoteTrialProfile(url);
    const approvalId = 'local-trial-revoke';
    const sessions = [];
    let bindingCount = 0;
    const createSession = page.createCDPSession.bind(page);
    page.createCDPSession = async () => {
      const session = await createSession();
      session.on('Runtime.bindingCalled', () => {
        bindingCount++;
        call.boundaryContexts.revokePageAction(approvalId);
      });
      sessions.push(session);
      return session;
    };
    const forwardPort = createCdpPageActionPort(page, profile.spec);
    const trial = prepareLocalNoteTrial(url, await forwardPort.inspect());
    const source = appendUser(store, `Fill the local note with ${trial.action.value}`, 'trial-revoke');
    const approval = approvalFor(approvalId, profile, trial.action);
    const record = approvalRecord(source, approval, trial.action);
    ledger.issue(record);
    const selector =
      process.env.F317_TEST_REVOKE_SHORT_CIRCUIT === '1'
        ? {
            async select() {
              return { kind: 'ask', reason: 'short_circuit_probe' };
            },
          }
        : selectLocalNoteAction(trial.action);
    const result = await call.boundaryContexts.runPageAction({
      requestMessageId: source.id,
      approval,
      port: forwardPort,
      selector,
    });
    assert.equal(bindingCount, 1, 'the browser must request its final Host permit before revocation');
    assert.equal(await ledger.verify({ ...record, signal: new AbortController().signal }), false);
    assert.equal(result.status, 'cancelled');
    assert.equal(await page.$eval('#readback', (element) => element.textContent), trial.beforeReadback);
    assert.equal(sessions.length, 1);
    assert.ok(sessions.every((session) => session.detached));
  });
});
