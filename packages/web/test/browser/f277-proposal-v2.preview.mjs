import assert from 'node:assert/strict';
import { renameSync, writeFileSync } from 'node:fs';
import { startSearchGroupBrowserFixture } from './f277-search-group-browser.harness.mjs';

// Manual, managed preview of the production components using an isolated synthetic owner.
const fixture = await startSearchGroupBrowserFixture({
  webPort: 3181,
  previewPath: '/dev/f277-attention-preview/proposals?proof=F329-F330&shell=v2',
});
const seeded = await fixture.api.app.inject({ method: 'POST', url: '/__test/proposal-v2' });
assert.equal(seeded.statusCode, 200, seeded.body);
process.stdout.write(
  `V2 proposal preview ready: ${fixture.webUrl}/dev/f277-attention-preview/proposals?proof=F329-F330&shell=v2\n`,
);
let closing;
async function closePreview() {
  let exitCode = 0;
  try {
    await fixture.close();
  } catch (error) {
    console.error(error);
    exitCode = 1;
  }
  const resultPath = process.env.CAT_CAFE_PREVIEW_CLEANUP_RESULT;
  if (resultPath) {
    const temporaryPath = `${resultPath}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify({ pid: process.pid, processGroupId: process.pid, exitCode }));
    renameSync(temporaryPath, resultPath);
  }
  process.exit(exitCode);
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    closing ??= closePreview();
    void closing;
  });
}
