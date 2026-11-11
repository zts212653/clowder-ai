/* Personal Chrome 插件的 console 部分：云恢复卡里选一个已授权的 ChatGPT 会话、发出去（渲染类型 cloudRecovery.chatgpt）。
   读写都走插件自己登记的授权动作（/api/plugins/<插件>/actions/…，宿主只转发）；绑定和重试是宿主的动作 bindRetry。
   读取跟着投影：卡片画出来时登记来源 personalChrome.authorizations，来源出现时读一次授权列表和连接状态；刷新名称写完再读。 */
'use strict';
(function () {
  const key = 'personalChrome.authorizations',
    plugin = 'official.companion.personal-chrome',
    actions = '/api/plugins/' + plugin + '/actions/personalChromeAuthorizations/',
    syncCodes = [
      'HELPER_UPDATE_REQUIRED',
      'HELPER_NOT_INSTALLED',
      'EXTENSION_RELOAD_REQUIRED',
      'PAGE_RELOAD_REQUIRED',
      'STALE_HELPER',
      'STALE_HELPER_PROTOCOL',
      'CHROME_DISCONNECTED',
      'TITLE_SYNC_TIMEOUT',
      'AUTHORIZATION_INVALID',
      'UNSUPPORTED_PLATFORM',
    ];
  function publish(next) {
    pushProjectData({ [key]: Object.assign({}, projectData(key), next) });
  }
  function action(name) {
    return api.post(actions + name, {}, {});
  }
  async function read(titleSync) {
    publish({ load: 'loading' });
    try {
      const list = await action('list');
      // Connection health cannot revoke a readable authorization list.
      const status = await action('status').catch(function () {
        return null;
      });
      publish({
        load: '',
        rows: list.data.rows,
        status: status && status.ok ? status.data : null,
        titleSync: titleSync,
      });
    } catch (error) {
      publish({ load: 'error' });
    }
  }
  api.on('sources:needed', function (diff) {
    if (diff.added.indexOf(key) >= 0) settleHold(read(null));
  });
  A.personalChromeRead = function () {
    return read(null);
  };
  A.personalChromeRefreshTitles = function () {
    publish({ load: 'loading' });
    return action('refresh-titles').then(
      function (r) {
        return read(r.data.titleSync);
      },
      function () {
        return read({ status: 'unavailable', errorCode: 'AMBIGUOUS_EFFECT' });
      },
    );
  };
  CHANGES.personalChromePick = function (e) {
    CS.f[e.target.id] = e.target.value;
    render(true);
  };

  // An authorization row is a conversation only when its key is a ChatGPT conversation id and its title is safe to show.
  function safeTitle(value) {
    if (typeof value !== 'string' || value.length > 160) return '';
    const invalid = Array.from(value).some(function (ch) {
      const c = ch.codePointAt(0);
      return c < 32 || c === 127 || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069);
    });
    const title = invalid ? '' : value.trim().replace(/\s+/g, ' ');
    return /^(ChatGPT|New chat|新聊天)$/iu.test(title) ? '' : title;
  }
  function stamp(value) {
    return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
      ? value
      : '';
  }
  function candidates(rows) {
    const seen = {};
    return (Array.isArray(rows) ? rows : []).flatMap(function (row) {
      if (!row || typeof row.key !== 'string' || !/^[a-zA-Z0-9-]+$/.test(row.key) || seen[row.key]) return [];
      const authorizedAt = stamp(row.authorizedAt),
        updatedAt = stamp(row.updatedAt);
      if (authorizedAt && updatedAt && updatedAt < authorizedAt) return [];
      seen[row.key] = true;
      return [
        {
          chatUrl: 'https://chatgpt.com/c/' + row.key,
          displayTitle: row.label === row.key ? '' : safeTitle(row.label),
        },
      ];
    });
  }
  function connectionIssue(s) {
    if (!s) return '';
    const helper = (s.helper && s.helper.state) || '',
      delivery = s.delivery || {};
    if (helper === 'not_installed') return 'HELPER_NOT_INSTALLED';
    if (
      helper === 'invalid_installation' ||
      ['INVALID_INSTALLATION', 'PERMISSION_DENIED', 'DELIVERY_IO'].indexOf(delivery.failure) >= 0
    )
      return 'HELPER_UPDATE_REQUIRED';
    if (delivery.reloadRequired === true) return 'EXTENSION_RELOAD_REQUIRED';
    if (delivery.pageReloadRequired === true) return 'PAGE_RELOAD_REQUIRED';
    if (helper === 'unreachable') return 'CHROME_DISCONNECTED';
    return '';
  }
  function titleSyncOf(sync) {
    if (!sync) return null;
    if (sync.status === 'unavailable')
      return { kind: syncCodes.indexOf(sync.errorCode) >= 0 ? sync.errorCode : 'failed' };
    const n = sync.updatedCount,
      of = sync.requestedCount;
    if (sync.status !== 'synced' || !Number.isInteger(n) || !Number.isInteger(of) || n < 0 || n > of || of > 32)
      return null;
    return { kind: n === 0 ? 'none' : n < of ? 'partial' : 'all', n: n };
  }

  // The card's choice: the host gives the identity, the bound address and whether it can send; the plugin adds which
  // authorized conversation, whether that one is already the bound one, and whether the connection lets it send.
  VM.personalChromeRecovery = function (item) {
    if (projectionNeeded) projectionNeeded.add(key);
    const held = projectData(key);
    if (!held || held.load) return { load: held ? held.load : 'loading' };
    const list = candidates(held.rows),
      id = 'pc-recovery-' + item.key,
      authorized = function (url) {
        return list.some(function (c) {
          return c.chatUrl === url;
        });
      },
      bound = item.bindOnly && authorized(item.boundChatUrl),
      value = authorized(CS.f[id])
        ? CS.f[id]
        : authorized(item.boundChatUrl)
          ? item.boundChatUrl
          : list.length === 1
            ? list[0].chatUrl
            : '',
      issue = connectionIssue(held.status);
    return {
      load: '',
      selectId: id,
      candidates: list,
      value: value,
      only: list.length === 1 && !bound ? list[0] : null,
      canChoose: list.length > 1 && !bound && item.canSubmit,
      bound: bound,
      bindOnly: item.bindOnly,
      connectionIssue: issue,
      titleSync: titleSyncOf(held.titleSync),
      settings: { page: 'extItem-' + plugin },
      canSubmit: item.canSubmit && !bound && !!value && !(item.args.attemptId && issue),
      submit: Object.assign({}, item.args, { chatUrl: value }),
    };
  };
})();
