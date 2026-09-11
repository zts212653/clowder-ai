/**
 * Unit tests for desktop/startup-warning.js.
 *
 * The in-memory fallback used to be silent: the app looked normal while its
 * history was thrown away on exit. These tests pin the contract that the shell
 * must be able to show a blocking, choose-able warning for that case, and only
 * an informational notice when data was never at risk.
 */
const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  SEVERITY,
  confirmStartupWarning,
  describeRefusalReason,
  describeStartupWarning,
  shouldContinueAfterWarning,
} = require('./startup-warning');

describe('startup-warning: healthy start', () => {
  it('returns null when Redis is healthy', () => {
    assert.equal(describeStartupWarning({ memoryMode: false, redisRefusal: null, redisPort: 6399 }), null);
  });

  it('returns null for an empty status', () => {
    assert.equal(describeStartupWarning(), null);
    assert.equal(describeStartupWarning({}), null);
  });
});

describe('startup-warning: in-memory fallback is critical', () => {
  it('warns that state will not be saved and offers a quit option', () => {
    const warning = describeStartupWarning({ memoryMode: true, redisRefusal: null, redisPort: 6399 });

    assert.equal(warning.severity, SEVERITY.CRITICAL);
    assert.equal(warning.dialogType, 'warning');
    assert.match(warning.message, /will NOT be saved/);
    assert.match(warning.detail, /Fix:/);
    assert.deepEqual(warning.buttons, ['Continue without saving', 'Quit']);
  });

  it('does not let Escape silently continue', () => {
    const warning = describeStartupWarning({ memoryMode: true });
    // Escape maps to cancelId; it must be the "Quit" button, not "Continue".
    assert.notEqual(warning.cancelId, warning.continueId);
    assert.equal(warning.buttons[warning.cancelId], 'Quit');
  });

  it('explains a missing Redis binary when nothing was refused', () => {
    const warning = describeStartupWarning({ memoryMode: true, redisRefusal: null });
    assert.match(warning.detail, /no usable Redis binary was found/);
  });

  it('explains a foreign Redis when that is the root cause', () => {
    const warning = describeStartupWarning({
      memoryMode: true,
      redisRefusal: { port: 6399, verdict: 'foreign', reason: 'owned by inst-b' },
    });
    assert.match(warning.detail, /owned by a different Clowder instance/);
    assert.match(warning.detail, /will be lost/);
  });
});

describe('startup-warning: port move is only a notice', () => {
  it('reports the port change without alarming the user', () => {
    const warning = describeStartupWarning({
      memoryMode: false,
      redisRefusal: { port: 6399, verdict: 'unmarked', reason: 'no marker' },
      redisPort: 59765,
    });

    assert.equal(warning.severity, SEVERITY.NOTICE);
    assert.equal(warning.dialogType, 'info');
    assert.match(warning.message, /Port 6399 belongs to another Redis/);
    assert.match(warning.message, /its own on 59765/);
    assert.match(warning.detail, /Your data is unaffected/);
    assert.deepEqual(warning.buttons, ['OK']);
  });

  it('prefers the critical warning when both apply', () => {
    const warning = describeStartupWarning({
      memoryMode: true,
      redisRefusal: { port: 6399, verdict: 'foreign' },
      redisPort: 59765,
    });
    assert.equal(warning.severity, SEVERITY.CRITICAL);
  });
});

describe('startup-warning: refusal reasons', () => {
  it('maps each verdict to an explanation and never returns undefined', () => {
    assert.match(describeRefusalReason({ verdict: 'foreign' }), /different Clowder instance/);
    assert.match(describeRefusalReason({ verdict: 'unmarked' }), /no Clowder AI instance marker/);
    assert.match(describeRefusalReason({ verdict: 'unreachable' }), /not a usable Redis/);
    assert.match(describeRefusalReason({ verdict: 'something-new', reason: 'raw reason' }), /raw reason/);
    assert.equal(typeof describeRefusalReason(undefined), 'string');
  });
});

describe('startup-warning: continue decision', () => {
  it('continues only on the designated button', () => {
    const warning = describeStartupWarning({ memoryMode: true });
    assert.equal(shouldContinueAfterWarning(warning, warning.continueId), true);
    assert.equal(shouldContinueAfterWarning(warning, warning.cancelId), false);
  });
});

describe('startup-warning: dialog orchestration', () => {
  function makeDeps({ response = 0, status = { memoryMode: true } } = {}) {
    const calls = { dialogs: [], quits: 0, logs: [] };
    return {
      calls,
      deps: {
        status,
        dialog: {
          showMessageBox: async (options) => {
            calls.dialogs.push(options);
            return { response };
          },
        },
        onQuit: async () => {
          calls.quits += 1;
        },
        log: (message) => calls.logs.push(message),
      },
    };
  }

  it('shows nothing when startup is healthy', async () => {
    const { deps, calls } = makeDeps({ status: { memoryMode: false, redisRefusal: null } });

    assert.equal(await confirmStartupWarning(deps), true);
    assert.equal(calls.dialogs.length, 0);
    assert.equal(calls.quits, 0);
  });

  it('continues when the user accepts the in-memory warning', async () => {
    const { deps, calls } = makeDeps({ response: 0 });

    assert.equal(await confirmStartupWarning(deps), true);
    assert.equal(calls.quits, 0);
    assert.equal(calls.dialogs[0].type, 'warning');
    assert.deepEqual(calls.dialogs[0].buttons, ['Continue without saving', 'Quit']);
    assert.equal(calls.dialogs[0].noLink, true);
    assert.match(calls.logs[0], /critical/);
  });

  it('quits when the user rejects it', async () => {
    const { deps, calls } = makeDeps({ response: 1 });

    assert.equal(await confirmStartupWarning(deps), false);
    assert.equal(calls.quits, 1);
  });

  it('works without a logger', async () => {
    const { deps } = makeDeps({ response: 0 });
    deps.log = undefined;

    assert.equal(await confirmStartupWarning(deps), true);
  });
});
