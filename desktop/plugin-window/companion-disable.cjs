/** A package cannot confirm its own lifecycle revocation. This dialog belongs to
 * the current native Host principal and carries no package-selected instance. */
function createCompanionDisable({ dialog, win, current, disable, begin, settle }) {
  let pending = false;
  return async (activated) => {
    if (activated !== true) return { kind: 'error', code: 'permission_required' };
    if (pending) return { kind: 'error', code: 'busy' };
    const epoch = current();
    if (epoch === null) return { kind: 'error', code: 'cancelled' };
    pending = true;
    const ticket = begin();
    let result = { kind: 'error', code: 'unavailable' };
    try {
      const answer = await dialog.showMessageBox(win, {
        type: 'question',
        title: '停用猫猫球',
        message: '停用会结束通话并关闭桌面猫，设置会保留。之后可以从插件设置中恢复。',
        buttons: ['取消', '停用'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      result = answer.response !== 1 || current() !== epoch ? { kind: 'error', code: 'cancelled' } : await disable();
      return result;
    } catch {
      return result;
    } finally {
      settle(ticket, result);
      pending = false;
    }
  };
}

module.exports = { createCompanionDisable };
