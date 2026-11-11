/* 问题反馈插件的 console 部分：面板是插件自己的页面（插件返回的 HTML，放进只允许脚本的沙箱框），
   框里的请求（clowder-plugin-ui/v1）经这里转给插件自己登记的接口 /api/plugins/official.feedback/feedback/panel（宿主只转发）。
   读取跟着投影：面板画出来时登记来源 feedback.panel，来源出现时读一次面板 */
'use strict';
(function () {
  const key = 'feedback.panel',
    route = '/api/plugins/official.feedback/feedback/panel',
    channel = 'clowder-plugin-ui/v1',
    // the panel cannot reach the network or open frames: only the page the plugin gave
    csp =
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'; object-src 'none'";
  function read() {
    pushProjectData({ [key]: { load: 'loading' } });
    return api.post(route, {}, { op: 'open' }).then(
      function (panel) {
        pushProjectData({
          [key]: {
            load: '',
            html:
              '<meta http-equiv="Content-Security-Policy" content="' +
              csp +
              '"><meta name="referrer" content="no-referrer">' +
              panel.html,
          },
        });
      },
      function () {
        pushProjectData({ [key]: { load: 'error' } });
      },
    );
  }
  api.on('sources:needed', function (diff) {
    if (diff.added.indexOf(key) >= 0) settleHold(read());
  });
  VM.feedbackPanel = function () {
    if (projectionNeeded) projectionNeeded.add(key);
    const held = projectData(key);
    return held && !held.load ? { html: held.html } : { load: held ? held.load : 'loading' };
  };
  A.feedbackMessage = function (m) {
    if (!m || m.channel !== channel) return;
    const done = function (run) {
      Promise.resolve()
        .then(run)
        .then(
          function (result) {
            return { result: result };
          },
          function (error) {
            return { error: error.message };
          },
        )
        .then(function (r) {
          ENGINE_PARTS.framePost(
            'feedback',
            Object.assign({ channel: channel, nonce: m.nonce, requestId: m.requestId }, r),
          );
        });
    };
    if (m.type === 'invoke')
      done(function () {
        return api.post(route, {}, m.input);
      });
    else if (m.type === 'clipboard.text')
      done(function () {
        return PLATFORM.clipboard(m.value);
      });
    else if (m.type === 'clipboard.image')
      done(function () {
        return PLATFORM.clipboardImage(m.value);
      });
    else if (m.type === 'close') actFn('close')({ node: key });
  };
})();
