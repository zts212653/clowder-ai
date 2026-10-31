import assert from 'node:assert/strict';

/** Lose the real committed HTTP response, then retry the exact saved request through the normal composer. */
export async function sendSharedRequestAfterLostReply(page, f) {
  let committed;
  let artifactId;
  await page.route(
    '**/api/artifacts/requests/publish',
    async (route) => {
      const response = await route.fetch();
      assert.equal(response.status(), 201);
      committed = (await response.json()).source;
      artifactId = route.request().postDataJSON().artifactId;
      await f.store.updateArtifactAccess(f.owner.sessionToken, {
        ...f.coordinates,
        artifactId,
        humanId: f.member.human.humanId,
        expectedAccessRevision: 1,
        access: 'apply',
        requestId: 'browser-grant-after-committed-request',
      });
      await route.abort('failed');
    },
    { times: 1 },
  );
  const failed = page.waitForEvent('requestfailed', {
    predicate: (request) => request.url().endsWith('/api/artifacts/requests/publish') && request.method() === 'POST',
  });
  const send = page.locator('.context-panel').getByRole('button', { name: '发送', exact: true });
  await send.click();
  await failed;
  assert.ok(committed);
  assert.equal(await page.locator('.context-panel textarea').inputValue(), committed.body);
  const replay = page.waitForResponse(
    (response) => response.url().endsWith('/api/artifacts/requests/publish') && response.status() === 201,
  );
  await send.click();
  const feedback = (await (await replay).json()).source;
  assert.equal(feedback.eventId, committed.eventId);
  await page.waitForFunction(() => document.querySelector('.context-panel textarea')?.value === '');
  // Preserve the rest of the journey's read-only member: this active downgrade also keeps the request live.
  await f.store.updateArtifactAccess(f.owner.sessionToken, {
    ...f.coordinates,
    artifactId,
    humanId: f.member.human.humanId,
    expectedAccessRevision: 2,
    access: 'read',
    requestId: 'browser-restore-read-after-request-recovery',
  });
  return feedback;
}
