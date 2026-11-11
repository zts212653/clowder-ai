/* Push settings project the existing browser subscription and server owners. */
'use strict';
function bindNotifications() {
  PAGES.env = function () {
    return pdlView('page.env');
  };

  api.on('sources:needed', function (diff) {
    if (diff.added.indexOf('envConfig') >= 0) settleHold(chatAction('settingsEnvRead'));
    if (diff.added.indexOf('systemConfig') >= 0) settleHold(chatAction('settingsSystemRead'));
  });
  VM.env = function () {
    if (projectionNeeded) projectionNeeded.add('envConfig');
    const settings = chatDataSnapshot.project && chatDataSnapshot.project.settings;
    if (!settings || !settings.env) return null;
    const env = settings.env;
    return {
      help: {},
      pending: settings.envPending.length,
      editable: env.variables
        .filter(function (v) {
          return v.runtimeEditable;
        })
        .map(function (v) {
          const value = v.currentValue === null ? v.defaultValue : v.currentValue;
          return {
            key: v.name,
            label: v.description,
            runtime: !!v.runtimeEditable,
            secret: v.sensitive,
            hasValue: v.currentValue !== null,
            value: value,
          };
        }),
      cats: Object.keys(env.categories).map(function (k) {
        return {
          label: env.categories[k],
          count: env.variables.filter(function (v) {
            return v.category === k;
          }).length,
        };
      }),
    };
  };
  A.envOpen = function (d) {
    const v = chatDataSnapshot.project.settings.env.variables.find(function (v) {
      return v.name === d.k;
    });
    dialog({
      kind: 'env',
      args: {
        key: v.name,
        value: v.sensitive ? '' : v.currentValue === null ? v.defaultValue : v.currentValue,
        secret: v.sensitive,
        stored: v.currentValue !== null,
        defaultValue: v.defaultValue,
        label: v.description,
        rule: v.type,
        enumValues: v.allowedValues,
        json: v.type === 'json',
        runtime: !!v.runtimeEditable,
        options: v.allowedValues,
      },
      on: function () {
        return chatPort.action('settingsEnvSave', {
          key: v.name,
          value: val('env-in'),
        });
      },
    });
  };
  A.openUrl = function (d) {
    if (d.url && /^https?:\/\//.test(d.url)) api.send('platform:openUrl', { url: d.url });
  };
  const system = VM.system,
    vapid = { pub: '', priv: '', sub: '' };
  let snapshot = null,
    client = null,
    load = 'loading',
    busy = false,
    result = null;
  async function read() {
    try {
      const values = await Promise.all([api.get('/api/push/status'), chatPort.action('pushClientRead', {})]);
      snapshot = values[0];
      client = values[1];
      load = '';
      dataOk('push');
    } catch (error) {
      load = 'error';
      dataError('push', error);
    }
    await chatDataRender();
  }
  api.on('sources:needed', function (diff) {
    if (diff.added.indexOf('push') >= 0) settleHold(read());
  });
  PAGES.notify = PAGES.system;
  ROUTE_ANCHOR.notify = 'sys-notify';
  VM.system = function () {
    if (projectionNeeded) {
      projectionNeeded.add('push');
      projectionNeeded.add('systemConfig');
      projectionNeeded.add('envConfig');
    }
    const vm = system(),
      settings = placementData(),
      configuration = settings.system,
      environment = settings.env;
    const variables =
      configuration &&
      Object.fromEntries(
        configuration.variables.map(function (variable) {
          return [variable.name, variable];
        }),
      );
    const value = function (name) {
      const variable = variables[name];
      return variable.currentValue === null ? variable.defaultValue : variable.currentValue;
    };
    const enabled = function (name) {
      const variable = variables[name],
        semantics = variable.booleanSemantics,
        raw = variable.currentValue;
      if (raw === null) return semantics.defaultOn;
      if (semantics.trueWhen === 'exactTrue') return raw === 'true';
      if (semantics.trueWhen === 'exactOne') return raw === '1';
      if (semantics.trueWhen === 'notZero') return raw !== '0';
      return raw === '1' || raw.toLowerCase() === 'true';
    };
    const rows =
      configuration &&
      Object.fromEntries(
        configuration.variables.map(function (variable) {
          const row = Object.assign({}, variable, { value: value(variable.name), readonly: !variable.runtimeEditable });
          if (variable.booleanSemantics) row.enabled = enabled(variable.name);
          return [variable.name, row];
        }),
      );
    const groups =
      configuration &&
      Object.fromEntries(
        Object.keys(configuration.groups).map(function (key) {
          return [
            key,
            configuration.variables
              .filter(function (variable) {
                return variable.settingsGroup === key;
              })
              .map(function (variable) {
                return rows[variable.name];
              }),
          ];
        }),
      );
    return Object.assign({}, vm, {
      load: vm.load || load || (configuration && environment ? '' : 'loading'),
      config: configuration,
      variables: rows,
      groups: groups,
      paths: environment && environment.paths,
      env:
        configuration && environment
          ? {
              apiPort: value('API_SERVER_PORT'),
              previewPort: value('PREVIEW_GATEWAY_PORT'),
              listenAddr: value('API_SERVER_HOST'),
              frontendUrl: value('FRONTEND_URL'),
              frontendPort: value('FRONTEND_PORT'),
              dataDir: value('CAT_CAFE_DATA_DIR'),
              redisUrl: value('REDIS_URL'),
              keyPrefix: value('REDIS_KEY_PREFIX'),
              uploadDir: value('UPLOAD_DIR'),
              transcriptDir: value('TRANSCRIPT_DATA_DIR'),
              logDir: environment.paths.dataDirs.runtimeLogs,
              allowedDirs: value('PROJECT_ALLOWED_ROOTS'),
              allowedDirsAppend: value('PROJECT_ALLOWED_ROOTS_APPEND'),
              deniedDirs: value('PROJECT_DENIED_ROOTS'),
              ownerUserId: value('DEFAULT_OWNER_USER_ID'),
            }
          : null,
      v: Object.assign(
        {},
        vm.v,
        configuration
          ? {
              lan: enabled('CORS_ALLOW_PRIVATE_NETWORK'),
              preview: enabled('PREVIEW_GATEWAY_ENABLED'),
              memFallback: enabled('MEMORY_STORE'),
              ttlMsg: value('MESSAGE_TTL_SECONDS'),
              ttlThread: value('THREAD_TTL_SECONDS'),
              ttlTask: value('TASK_TTL_SECONDS'),
              logLevel: value('LOG_LEVEL'),
              timeout: value('CLI_TIMEOUT_MS'),
            }
          : {},
      ),
      pending: {
        lan: settings.envPending.includes('CORS_ALLOW_PRIVATE_NETWORK'),
        preview: settings.envPending.includes('PREVIEW_GATEWAY_ENABLED'),
        memFallback: settings.envPending.includes('MEMORY_STORE'),
      },
      envCount:
        environment &&
        environment.variables.filter(function (variable) {
          return variable.runtimeEditable;
        }).length,
      push: load ? null : VM.pushDiag(),
      notifyTypes: [],
    });
  };
  VM.pushDiag = function () {
    if (projectionNeeded) projectionNeeded.add('push');
    if (load) return null;
    const c = snapshot.capability,
      d = snapshot.delivery,
      canSubscribe = client.isSupported && client.permission !== 'denied' && c.enabled && !client.isSubscribed;
    return {
      capability: c,
      delivery: d,
      subscriptions: snapshot.subscription,
      permission: client.isSupported ? client.permission : 'unsupported',
      errorHints: snapshot.errorHints.map(function (code) {
        return { code: code };
      }),
      attemptAt: d.lastAttemptAt,
      hasHttpStatus: d.lastHttpStatus !== null,
      result: result,
      vapid: vapid,
      subscribed: client.isSubscribed,
      unavailable: !canSubscribe && !client.isSubscribed,
      canSubscribe: !busy && canSubscribe,
      canUnsubscribe: !busy && client.isSubscribed,
      canTest: !busy && c.enabled && client.isSubscribed,
      canGenerate: !busy,
      canSave:
        !busy &&
        Object.values(vapid).some(function (v) {
          return v.trim();
        }),
    };
  };
  INPUTS.vp = function (e) {
    vapid[e.target.dataset.k] = e.target.value;
    render(true);
  };
  async function run(work) {
    busy = true;
    result = null;
    render(true);
    try {
      await work();
    } catch (error) {
      result = { kind: 'error', message: error.message };
      if (!S.dialog) toast(error.message, null, 'danger');
    } finally {
      busy = false;
      await read();
    }
  }
  A.pushSubscribe = function () {
    return run(function () {
      return chatPort.action('pushSubscribe', {});
    });
  };
  A.pushUnsubscribe = function () {
    return run(function () {
      return chatPort.action('pushUnsubscribe', {});
    });
  };
  A.pushToggle = function () {
    return client.isSubscribed ? A.pushUnsubscribe() : A.pushSubscribe();
  };
  A.pushTest = function () {
    return run(function () {
      return api.post('/api/push/test', {}, {});
    });
  };
  A.vapidGen = function () {
    return run(async function () {
      const keys = await api.post('/api/push/generate-vapid', {}, {});
      vapid.pub = keys.publicKey;
      vapid.priv = keys.privateKey;
      result = { kind: 'generated' };
    });
  };
  A.vapidSave = function () {
    return run(async function () {
      const names = { pub: 'VAPID_PUBLIC_KEY', priv: 'VAPID_PRIVATE_KEY', sub: 'VAPID_SUBJECT' },
        updates = Object.keys(names)
          .map(function (k) {
            return { name: names[k], value: vapid[k].trim() };
          })
          .filter(function (r) {
            return r.value;
          });
      await api.post('/api/config/secrets', {}, { updates: updates });
      vapid.pub = vapid.priv = vapid.sub = '';
      result = { kind: 'saved' };
    });
  };
}
