import assert from 'node:assert/strict';
import { refIdentity } from '@cat-cafe/shared';

export async function verifySameRunGuard({ work, runs, chooseRun }) {
  await chooseRun(work, runs[0]);
  const comparison = work.getByLabel('选择对照实验', { exact: true });
  await comparison.selectOption(refIdentity(runs[1].experimentRef));
  await chooseRun(work, runs[1]);
  assert.equal(await comparison.inputValue(), '', 'changing the primary run clears the previous comparison');
  assert.equal(await work.getByRole('region', { name: '所选实验对照' }).count(), 0);
}

export async function verifyInvalidRecordRecovery({ page, work, fixture, run, oldMediaUrl, capture }) {
  const input = work.getByLabel('继续探索的想法');
  await input.fill('保留这个反例，核对原件后再继续');
  const selection = await work.getByLabel('选择本版实验', { exact: true }).inputValue();
  try {
    fixture.corruptExperiment(run.experimentRef);
    await Promise.all([
      page.waitForResponse((response) => new URL(response.url()).pathname.endsWith('/exploration')),
      page.evaluate(() => window.dispatchEvent(new Event('focus'))),
    ]);
    await work.getByText(/本轮原始记录未通过完整性核验/).waitFor();
    assert.equal(await work.getByRole('region', { name: '所选案例结果' }).count(), 0);
    assert.equal(await work.getByLabel('选择本版实验', { exact: true }).inputValue(), selection);
    assert.equal(await input.inputValue(), '保留这个反例，核对原件后再继续');
    const denied = await page.request.get(new URL(oldMediaUrl, fixture.apiUrl).href);
    assert.equal(denied.status(), 422);
    assert.equal((await denied.json()).error, 'exploration_record_invalid');
    await capture(page, 'exploration-invalid-record');
    fixture.corruptExperiment(undefined);
    await work.getByRole('button', { name: '核对后重读本轮记录', exact: true }).click();
    await work.getByRole('region', { name: '所选案例结果' }).waitFor();
    assert.equal(await work.getByLabel('选择本版实验', { exact: true }).inputValue(), selection);
    assert.equal(await input.inputValue(), '保留这个反例，核对原件后再继续');
  } finally {
    fixture.corruptExperiment(undefined);
  }
}

export async function verifyExplorationRefreshRecovery({
  page,
  work,
  fixture,
  result,
  video,
  original,
  record,
  videoChoice,
  capture,
}) {
  const refresh = async () =>
    Promise.all([
      page.waitForResponse((response) => new URL(response.url()).pathname.endsWith('/exploration')),
      page.evaluate(() => window.dispatchEvent(new Event('focus'))),
    ]);
  try {
    fixture.setExplorationAvailable(false);
    await refresh();
    await work.getByText(/仍展示上次读取成功的记录/).waitFor();
    assert(await video.evaluate((element, previous) => element === previous, original));
    assert(await video.evaluate((element) => element.currentTime > 0));
    await capture(page, 'exploration-offline-playback-retained');
    fixture.setExplorationAvailable(true);
    await refresh();
    await work.getByText(/仍展示上次读取成功的记录/).waitFor({ state: 'detached' });
    assert(await video.evaluate((element, previous) => element === previous, original));

    fixture.withdrawMedia(videoChoice.mediaRef.version);
    await refresh();
    await result.getByText(/所看的原件已不在当前来源列表/).waitFor();
    assert.equal(
      await result.locator('video,img').count(),
      0,
      'withdrawal must not silently select a different original',
    );
    await result.getByRole('heading', { name: '本次实际输入与结果', exact: true }).waitFor();
    const oldMediaUrl = await original.getAttribute('src');
    assert.equal(
      (await page.request.get(new URL(oldMediaUrl, fixture.apiUrl).href)).status(),
      404,
      'the same authenticated handler must also fence withdrawn bytes',
    );
    await capture(page, 'exploration-media-withdrawn');
    const another = record.media.find((media) => media.kind === 'image');
    assert(another, 'this archived replay has a real frame');
    await result.getByRole('button', { name: another.label, exact: true }).click();
    await result.locator('img').waitFor();
    assert((await result.locator('img').getAttribute('src')).includes(another.mediaRef.version));
  } finally {
    fixture.setExplorationAvailable(true);
    fixture.withdrawMedia(undefined);
  }
}
