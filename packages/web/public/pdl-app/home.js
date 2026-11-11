/* The new-conversation and workbench home share one project-scoped recent-works VM. */
'use strict';
function bindHome() {
  PAGES.home = function () {
    return pdlView('cafe.home');
  };
  VM.cafeHome = function () {
    return Object.assign({}, chatRead('cafeHome'), { preview: !!(CS.lb || S.ws.clipPreview) });
  };
  VM.recentWorks = function () {
    return projectData('recentWorks') ? recentWorksModels().recentWorks : null;
  };
  A.cafeRwRetry = function () {
    return chatAction('cafeRwRetry');
  };
  SET_AFTER['cs.homeProj'] = function (id) {
    CS.pop = null;
    return chatAction('newProject', { id: id || '' });
  };
  let route = '';
  onRender(function () {
    if (route === S.route) return;
    route = S.route;
    if (route === 'home' && chatPort.threadId !== 'default') chatAction('thread', { id: 'default' });
  });
}
