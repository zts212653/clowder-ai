// Only known Host codes become user-facing instructions. Never display raw provider bodies.
const conflicts = new Map([
  ['live_native_unavailable', '当前猫的语音能力尚未接通，可以继续使用文字交流。'],
  ['live_call_active', '当前交流仍在准备或收尾，请稍后重试。'],
  ['live_selection_changed', '猫猫球的选择已改变，请重新打开当前交流。'],
  ['live_duty_unavailable', '当前选择的猫不在名册里，文字记录仍然保留。'],
  ['live_carrier_unavailable', '当前猫咖尚无可用的实时语音载体，可以继续文字交流。'],
  ['live_carrier_ambiguous', '当前猫咖的实时语音载体配置存在冲突，可以继续文字交流。'],
]);

async function hostResponseError(response) {
  let code = 'live_connection_unavailable';
  let message = '家里的语音连接暂时不可用，请检查连接状态后重新连接。';
  if (response.status === 401) {
    code = 'live_session_required';
    message = '登录状态已失效，请重新连接当前猫咖。';
  } else if (response.status === 403) {
    code = 'live_access_denied';
    message = '当前连接无法访问这份资料或会话，请检查连接的猫咖与登录状态。';
  } else if (response.status === 404) {
    code = 'live_endpoint_unavailable';
    message = '当前语音入口或会话不可用，请检查连接的猫咖版本与会话状态。';
  } else if (response.status === 409) {
    const body = await response.json().catch(() => null);
    if (conflicts.has(body?.code)) {
      code = body.code;
      message = conflicts.get(code);
    } else {
      code = 'live_conflict';
      message = '当前语音状态不匹配，请检查连接状态。';
    }
  }
  return Object.assign(new Error(message), { code, retryable: code === 'live_call_active' });
}

module.exports = { hostResponseError };
