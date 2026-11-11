/* 共同体插件的 console 部分：客户端 frame 的地址。frame 画出来时（来源 frame:<键>）读一次插件自己的连接状态，
   选出服务地址给两个 frame；连接器没在运行时没有地址，frame 画占位。 */
'use strict';
(function () {
  const frames = ['collective.home', 'collective.desk'];
  function preferred(connections) {
    const live = connections.filter(function (c) {
      return c.authorityStatus !== 'revoked';
    });
    const key = function (c) {
      return [c.serviceUrl, c.serviceInstanceId, c.collectiveId, c.connectionId].join('\0');
    };
    const ranked = live.slice().sort(function (a, b) {
      return (
        (b.liveStatus === 'online') - (a.liveStatus === 'online') ||
        (b.authorityStatus === 'connected') - (a.authorityStatus === 'connected') ||
        (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)
      );
    });
    return ranked[0] || (connections.length === 1 ? connections[0] : undefined);
  }
  function service(status) {
    const remote = status.remoteService,
      connection = preferred(
        remote
          ? status.connections.filter(function (c) {
              return c.serviceUrl === remote.serviceUrl;
            })
          : status.connections,
      );
    if (connection) return connection.serviceUrl;
    if (remote) return remote.serviceUrl;
    return status.localService && status.localService.state === 'ready' ? status.localService.serviceUrl : undefined;
  }
  function clientUrl(serviceUrl) {
    const source = new URL(serviceUrl),
      url = new URL('/', source.origin);
    url.searchParams.set('hostOrigin', location.origin);
    url.hash = source.hash;
    return url.toString();
  }
  api.on('sources:needed', function (diff) {
    if (
      !diff.added.some(function (k) {
        return frames.indexOf(k.slice(5)) >= 0 && k.indexOf('node:') === 0;
      })
    )
      return;
    settleHold(
      api
        .get('/api/plugins/official.collective-connector/connections')
        .then(service, function () {
          return undefined;
        })
        .then(function (address) {
          frames.forEach(function (k) {
            PDL_VIEWS[k].src = address ? clientUrl(address) : '';
          });
          render(true);
        }),
    );
  });
})();
