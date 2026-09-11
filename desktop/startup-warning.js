// User-facing warnings for a degraded startup.
//
// Two conditions matter and they are not equally severe:
//
//   memoryMode    the API is running without Redis, so Redis-backed state is
//                 NOT persisted. Silent degradation is unacceptable: the user
//                 must be told and given a choice, not handed a normal-looking
//                 app whose history disappears on exit.
//   redisRefusal  a Redis that is not ours held the default port, so this
//                 instance moved to a private port. Data is safe — this is a
//                 notice, not an alarm.
//
// Pure logic, so the wording and the button contract are unit-tested without
// Electron.

const SEVERITY = {
  CRITICAL: 'critical',
  NOTICE: 'notice',
};

/** Human explanation of why an existing Redis was refused. */
function describeRefusalReason(redisRefusal) {
  const verdict = redisRefusal?.verdict;
  if (verdict === 'foreign') return 'the Redis on that port is owned by a different Clowder instance.';
  if (verdict === 'unmarked') return 'the Redis on that port carries no Clowder AI instance marker.';
  if (verdict === 'unreachable') return 'the port is held by a listener that is not a usable Redis.';
  return redisRefusal?.reason || 'the Redis on that port could not be verified as ours.';
}

function criticalDetail({ redisRefusal }) {
  return [
    redisRefusal
      ? `Reason: ${describeRefusalReason(redisRefusal)}`
      : 'Reason: no usable Redis binary was found, or it failed to start.',
    '',
    'Clowder AI normally keeps a private Redis beside your user data. Without it the',
    'API runs from an in-memory store that is discarded when the app exits, so chat',
    'history and other stored state will be lost.',
    '',
    'Fix: check the desktop log for the Redis error, then restart the app.',
  ].join('\n');
}

/**
 * Describe the dialog the shell should show, or null when startup is healthy.
 *
 * @param {{ memoryMode?: boolean, redisRefusal?: object|null, redisPort?: number }} status
 * @returns {null | {
 *   severity: string, dialogType: 'warning'|'info', title: string, message: string,
 *   detail: string, buttons: string[], defaultId: number, cancelId: number, continueId: number,
 * }}
 */
function describeStartupWarning(status = {}) {
  const { memoryMode, redisRefusal, redisPort } = status;

  if (memoryMode) {
    return {
      severity: SEVERITY.CRITICAL,
      dialogType: 'warning',
      title: 'Clowder AI — running without persistent storage',
      message: 'Sessions and other stored state will NOT be saved.',
      detail: criticalDetail({ redisRefusal }),
      buttons: ['Continue without saving', 'Quit'],
      defaultId: 0,
      cancelId: 1,
      continueId: 0,
    };
  }

  if (redisRefusal) {
    return {
      severity: SEVERITY.NOTICE,
      dialogType: 'info',
      title: 'Clowder AI — using a private Redis port',
      message: `Port ${redisRefusal.port} belongs to another Redis, so Clowder AI started its own on ${redisPort}.`,
      detail: [
        `Reason: ${describeRefusalReason(redisRefusal)}`,
        '',
        'Your data is unaffected — Clowder AI never reads or writes a Redis it does not own.',
      ].join('\n'),
      buttons: ['OK'],
      defaultId: 0,
      cancelId: 0,
      continueId: 0,
    };
  }

  return null;
}

/** True when the user chose to keep going rather than quit. */
function shouldContinueAfterWarning(warning, responseIndex) {
  return responseIndex === warning.continueId;
}

/**
 * Show the startup warning, if there is one, and report whether to continue.
 *
 * Electron is injected rather than required so this module stays unit-testable
 * and main.js stays inside the 350-line production limit.
 *
 * @param {{
 *   status: object,
 *   dialog: { showMessageBox: (options: object) => Promise<{ response: number }> },
 *   onQuit: () => Promise<void>|void,
 *   log?: (message: string) => void,
 * }} deps
 * @returns {Promise<boolean>} false when the user chose to quit
 */
async function confirmStartupWarning({ status, dialog, onQuit, log }) {
  const warning = describeStartupWarning(status);
  if (!warning) return true;

  if (log) log(`Startup warning (${warning.severity}): ${warning.message}`);

  const { response } = await dialog.showMessageBox({
    type: warning.dialogType,
    title: warning.title,
    message: warning.message,
    detail: warning.detail,
    buttons: warning.buttons,
    defaultId: warning.defaultId,
    cancelId: warning.cancelId,
    noLink: true,
  });

  if (shouldContinueAfterWarning(warning, response)) return true;

  if (log) log('User quit after a degraded startup warning');
  await onQuit();
  return false;
}

module.exports = {
  SEVERITY,
  confirmStartupWarning,
  describeRefusalReason,
  describeStartupWarning,
  shouldContinueAfterWarning,
};
