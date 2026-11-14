/**
 * F337: one wording for how a turn stopped, read by the cat about to call that member.
 *
 * Inputs are the durable facts: a TurnExecution `terminalReason` (`host_sleep`, `user_cancel`, …) or a
 * response lifecycle `reason` (`HOST_SLEEP`, `user_cancel`, …). Only what those facts promise is said:
 * an automatic continuation is promised only where one is actually scheduled.
 */

import { HOST_SLEEP_TERMINAL_REASON } from '../../stores/ports/TurnExecutionStore.js';

export { HOST_SLEEP_TERMINAL_REASON };
/** The cut-off turn was itself a continuation; the loop guard will not wake it again. */
export const HOST_SLEEP_REPEAT_TERMINAL_REASON = 'host_sleep_repeat';
export const HOST_SLEEP_ERROR_CODE = 'HOST_SLEEP';
export const HOST_SLEEP_REPEAT_ERROR_CODE = 'HOST_SLEEP_REPEAT';

/** Appended to the failed reply the owner and the waiting caller read. */
export const HOST_SLEEP_ERROR_NOTE = '\n\n（这一轮做到一半电脑睡着了，不是这只猫坏了；开盖后它会自动在这里接着做。）';
export const HOST_SLEEP_REPEAT_ERROR_NOTE =
  '\n\n（这一轮做到一半电脑睡着了，不是这只猫坏了。这一轮本身就是被叫回来接着做的，为了不反复打断，这次不再自动叫回；需要的话请再喊它一声。）';

export function describeStopReason(status: string, reason: string | undefined): string {
  switch (reason) {
    case HOST_SLEEP_TERMINAL_REASON:
    case HOST_SLEEP_ERROR_CODE:
      return '电脑睡眠打断，开盖后会自动接着做';
    case HOST_SLEEP_REPEAT_TERMINAL_REASON:
    case HOST_SLEEP_REPEAT_ERROR_CODE:
      return '电脑睡眠打断；这一轮本身是被叫回来的，这次不再自动叫回';
    case 'process_restart':
      return 'runtime 重启打断，重启后会尝试自动叫回';
  }
  if (status === 'canceled') return '被停止，不是失败；没人要你叫它就别再叫醒';
  if (status === 'interrupted') return `中断（${reason ?? '原因未记录'}）`;
  return `失败（${reason ?? '原因未记录'}）`;
}
