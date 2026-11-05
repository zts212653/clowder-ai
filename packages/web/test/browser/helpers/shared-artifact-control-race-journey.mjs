import assert from 'node:assert/strict';

/** Advance the real owner after the button's CAS was read, then retry through the same normal control. */
export async function cancelSharedRequestAfterProposalRace({ page, card, advance }) {
  let stale;
  let current;
  let intercepted = false;
  const handler = async (route) => {
    const input = route.request().postDataJSON();
    if (input?.action !== 'cancel' || intercepted) return route.continue();
    intercepted = true;
    stale = input;
    current = await advance();
    const response = await route.fetch();
    assert.equal(response.status(), 409);
    await route.fulfill({ response });
  };
  await page.route('**/api/artifacts/owner/request', handler);
  const cancelled = (response) =>
    response.url().endsWith('/api/artifacts/owner/request') &&
    response.request().method() === 'POST' &&
    response.request().postDataJSON().action === 'cancel';
  const refused = page.waitForResponse(cancelled);
  await card.getByRole('button', { name: '取消这次修改', exact: true }).click();
  assert.equal((await refused).status(), 409);
  await page.unroute('**/api/artifacts/owner/request', handler);
  await card.getByRole('alert').waitFor();
  await card.getByRole('button', { name: '查看对照', exact: true }).waitFor();
  const receipt = page.waitForResponse(cancelled);
  await card.getByRole('button', { name: '取消这次修改', exact: true }).click();
  const response = await receipt;
  const retried = response.request().postDataJSON();
  assert.equal(retried.payload.expectedRequestRevision, current.request.revision);
  assert.notEqual(retried.requestId, stale.requestId);
  assert.equal(response.status(), 200);
  const result = (await response.json()).value.request;
  assert.equal(result.state, 'cancelled');
  assert.equal(result.requestId, current.request.requestId);
  return result;
}
