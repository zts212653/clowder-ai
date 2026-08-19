const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { createManualUpdateHandler } = require('./desktop-update-menu');

describe('desktop manual update entry point', () => {
  test('re-presents an existing prompt instead of queuing another check behind it', () => {
    let checks = 0;
    let hasPending = true;
    const onManualUpdate = createManualUpdateHandler({
      getUpdatePrompt: () => ({
        presentPending: () => hasPending,
      }),
      getUpdater: () => ({
        checkForUpdates: () => {
          checks += 1;
        },
      }),
    });

    assert.equal(onManualUpdate(), 'presented');
    assert.equal(checks, 0);

    hasPending = false;
    assert.equal(onManualUpdate(), 'started');
    assert.equal(checks, 1);
  });
});
