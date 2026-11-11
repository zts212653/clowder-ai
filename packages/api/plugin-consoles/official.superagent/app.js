/* 我的助手（superagent）插件的 console 部分：对话列表顶部的入口，角标是待你决定的问题数；点它进助手的主对话，
   还没设置好（或出错）时去插件的设置。读取跟着投影：入口画出来时登记来源 superagent.view，来源出现时读一次插件自己登记的接口（宿主只转发） */
'use strict';
(function () {
  const key = 'superagent.view',
    route = '/api/plugins/official.superagent/superagent/view';
  function read() {
    return api.get(route).then(
      function (value) {
        pushProjectData({ [key]: { load: '', value: value } });
      },
      function () {
        pushProjectData({ [key]: { load: 'error' } });
      },
    );
  }
  api.on('sources:needed', function (diff) {
    if (diff.added.indexOf(key) >= 0) settleHold(read());
  });
  function view() {
    const held = projectData(key);
    return held && held.value;
  }
  BADGES.superagent = function () {
    if (projectionNeeded) projectionNeeded.add(key);
    const v = view();
    return (v && v.badgeCount) || null;
  };
  A.superagentOpen = function () {
    const v = view();
    if (v && v.threadId && v.status !== 'setup' && v.status !== 'error') return A.thread({ id: v.threadId });
    go('extItem-official.superagent');
  };
})();
