/* Account settings use the existing account and native-login owners. */
'use strict';
const ACCOUNT_STATE = { accQ: '', accOpen: {}, accountSwitch: null, evOpen: {} };
function bindAccounts() {
  const st = ACCOUNT_STATE;
  S.accountFilter = 'all';
  let providers = [],
    selections = {},
    load = 'loading',
    timer;
  const vendor = function (p) {
    return p.clientId === 'anthropic' ? 'Claude' : p.clientId === 'openai' ? 'Codex' : p.clientId;
  };
  const account = function (id) {
    return providers.find(function (p) {
      return p.id === id;
    });
  };
  async function read() {
    try {
      const values = await Promise.all([
        api.get('/api/accounts'),
        api.get('/api/accounts/codex/members'),
        api.get('/api/accounts/claude/members'),
      ]);
      providers = values[0].providers;
      selections = { codex: values[1].selection, claude: values[2].selection };
      load = '';
      dataOk('accounts');
    } catch (error) {
      load = 'error';
      dataError('accounts', error);
    }
    arm();
    await chatDataRender();
  }
  function arm() {
    clearTimeout(timer);
    if (!heldNeeded.has('accounts') || document.hidden) return;
    const pending = providers.some(function (p) {
      return p.codex && p.codex.attempt && ['preparing', 'queued', 'waiting'].indexOf(p.codex.attempt.state) >= 0;
    });
    if (!pending) return; // a login finishes in the browser outside: check while one is in progress
    timer = setTimeout(function () {
      settleHold(read());
    }, 2000);
  }
  document.addEventListener('visibilitychange', function () {
    clearTimeout(timer);
    if (!document.hidden && heldNeeded.has('accounts')) settleHold(read());
  });
  api.on('sources:needed', function (diff) {
    if (diff.removed.indexOf('accounts') >= 0) clearTimeout(timer);
    if (diff.added.indexOf('accounts') >= 0) {
      clearTimeout(timer);
      settleHold(read());
    }
  });
  PAGES.accounts = function () {
    return pdlView('page.accounts');
  };

  function row(p) {
    const tool = p.clientId === 'anthropic' ? 'claude' : 'codex',
      selection = selections[tool],
      users = (
        p.clientId === 'openai' || p.clientId === 'anthropic' ? selection.members : chatRead('memberSettings').cats
      ).filter(function (m) {
        return m.accountRef === p.id;
      });
    const attempt = p.codex && p.codex.attempt,
      state =
        p.authType === 'api_key'
          ? p.hasApiKey
            ? 'key'
            : 'nokey'
          : attempt
            ? attempt.state
            : p.codex
              ? p.codex.status
              : p.codexLoginStatus || p.claudeTokenStatus || p.kind;
    const open = !!st.accOpen[p.id],
      busy = attempt && ['preparing', 'queued', 'waiting'].indexOf(attempt.state) >= 0,
      kind = p.authType === 'api_key' ? 'key' : p.authType;
    return {
      id: p.id,
      name: p.displayName,
      vendor: p.clientId,
      kind: kind,
      is: { [kind]: true },
      using: selection && selection.accountRef === p.id,
      builtin: !!p.builtin,
      managed: !!p.managed,
      renaming: S.renaming && S.renaming.entity === 'account' && S.renaming.id === p.id,
      state: state,
      usersCount: users.length,
      hasUsers: !!users.length,
      users: users.map(function (m) {
        return { id: m.id, name: m.name, handle: m.handle };
      }),
      email: p.codex && p.codex.identity && p.codex.identity.email,
      url: p.baseUrl,
      models: p.models,
      dir: p.codex && p.codex.credentialHome,
      open: open,
      quota: false,
      canSwitch: (p.clientId === 'openai' || p.clientId === 'anthropic') && selection.accountRef !== p.id,
      loggingIn: !!busy || state === 'review',
      cancelled:
        !!p.codex &&
        ['not_prepared', 'canceled', 'interrupted', 'failed', 'timeout', 'not_logged_in'].indexOf(state) >= 0,
      conflict: state === 'review',
    };
  }
  VM.accounts = function () {
    if (projectionNeeded) projectionNeeded.add('accounts');
    const q = st.accQ.toLowerCase(),
      filtered = providers.filter(function (p) {
        return (p.displayName + vendor(p)).toLowerCase().indexOf(q) >= 0;
      });
    const group = function (key) {
      const list = filtered.filter(function (p) {
        return (p.authType === 'api_key') === (key === 'key');
      });
      return { count: list.length, hasAny: !!list.length, items: list.map(row) };
    };
    const counts = {
      all: providers.length,
      key: providers.filter(function (p) {
        return p.authType === 'api_key';
      }).length,
      oauth: providers.filter(function (p) {
        return p.authType !== 'api_key';
      }).length,
    };
    const uses = new Map();
    Object.values(selections).forEach(function (selection) {
      selection.members.forEach(function (member) {
        if (member.accountRef) uses.set(member.accountRef, (uses.get(member.accountRef) || 0) + 1);
      });
    });
    return {
      load: load,
      q: st.accQ,
      filter: S.accountFilter,
      counts: counts,
      mixed: uses.size > 1,
      mixedCount: uses.size,
      accountUse: Array.from(uses, function (entry) {
        const p = account(entry[0]);
        return {
          id: entry[0],
          name: p ? p.displayName : entry[0],
          count: entry[1],
          using: Object.values(selections).some(function (selection) {
            return selection.accountRef === entry[0];
          }),
        };
      }),
      login: S.accountFilter === 'key' ? null : group('oauth'),
      keys: S.accountFilter === 'oauth' ? null : group('key'),
      legacy: null,
    };
  };
  INPUTS.accQ = function (e) {
    st.accQ = e.target.value;
    render(true);
  };
  ENT.account = {
    get: account,
    inline: 'acc-rn',
    rename: async function (p, value) {
      await chatPort.action('accountSave', { id: p.id, value: JSON.stringify({ displayName: value }) });
      await read();
    },
  };
  const rename = A.rename;
  A.rename = async function (d) {
    if (d.entity !== 'account' || d.v == null) return rename(d);
    try {
      await ENT.account.rename(account(d.id), d.v);
      S.renaming = null;
      render(true);
    } catch (error) {
      fieldErr('acc-rn', error.message);
    }
  };

  A.accOpen = function (d) {
    const p = d.id ? account(d.id) : null,
      mode = p ? (p.authType === 'oauth' ? 'oauth' : 'key') : d.v || 'oauth';
    let dd = {
      kind: 'acc',
      args: {
        edit: !!p,
        newAccount: !p,
        mode: mode,
        name: p && p.displayName,
        vendor: p ? p.clientId : 'openai',
        owner: p ? p.clientId : 'openai',
        url: p ? p.baseUrl : '',
        models: p && p.models ? p.models.slice() : [],
        env: Object.entries(p && p.envVars ? p.envVars : {}),
        loginVendors: [{ v: 'openai', label: 'openai' }],
        keyOwners: ['anthropic', 'openai', 'google', 'kimi', 'opencode', 'acp'].map(function (v) {
          return { v: v, label: v };
        }),
        loginCounter: { n: providers.length + 1 },
        urlPlaceholder: '',
      },
      on: async function () {
        const oauth = dd.panes.cur === 'oauth',
          body = {
            displayName: val(oauth ? 'acc-note' : 'acc-name'),
            clientId: val(oauth ? 'acc-vendor' : 'acc-owner'),
            authType: oauth ? 'oauth' : 'api_key',
          };
        if (!oauth) {
          body.baseUrl = val('acc-url');
          body.models = dd.fields.find(function (f) {
            return f.id === 'acc-models';
          }).chips.vals;
          const env = dd.fields.find(function (f) {
            return f.id === 'acc-env';
          });
          body.envVars = Object.fromEntries(
            env.env.rows.filter(function (r) {
              return r[0];
            }),
          );
          if (val('acc-key')) body.apiKey = val('acc-key');
        }
        if (p) await chatPort.action('accountSave', { id: p.id, value: JSON.stringify(body) });
        else {
          const created = await api.post('/api/accounts', {}, body);
          if (oauth)
            await api.post('/api/accounts/' + encodeURIComponent(created.profile.id) + '/codex/login/start', {}, {});
        }
        await read();
      },
    };
    dialog(dd);
    dd = S.dialog;
  };
  CHANGES.accVendorSet = function (e) {
    S.dialog.args.vendor = e.target.value;
  };
  CHANGES.accOwnerSet = function (e) {
    S.dialog.args.owner = e.target.value;
  };
  A.tokenOpen = function (d) {
    const p = d.id ? account(d.id) : null;
    dialog({
      kind: 'token',
      args: { name: p && p.displayName },
      on: async function () {
        const body = {
          displayName: val('tk-note'),
          clientId: 'anthropic',
          authType: 'oauth',
          claudeToken: val('tk-token'),
        };
        if (p) await chatPort.action('accountSave', { id: p.id, value: JSON.stringify(body) });
        else await api.post('/api/accounts', {}, body);
        await read();
      },
    });
  };
  async function login(p, op) {
    try {
      await api.post(
        '/api/accounts/' + encodeURIComponent(p.id) + '/codex/login/' + op,
        {},
        op === 'start' ? {} : { attemptId: p.codex.attempt.id },
      );
      await read();
    } catch (error) {
      dataError('accounts', error);
    }
  }
  A.accRelogin = function (d) {
    return login(account(d.id), 'start');
  };
  A.accLogin = function (d) {
    const p = account(d.k),
      attempt = p.codex.attempt;
    return login(p, d.v === 'cancel' ? 'cancel' : attempt && attempt.state === 'review' ? 'confirm' : 'start');
  };
  A.accConflict = function (d) {
    return login(account(d.k), d.v === 'keep' ? 'create-new' : 'cancel');
  };
  async function preview(id, overrides) {
    const p = account(id),
      tool = p.clientId === 'anthropic' ? 'claude' : 'codex';
    const state = (st.accountSwitch = {
      id: id,
      tool: tool,
      includeOverrides: overrides,
      load: 'loading',
      busy: false,
    });
    dialog({ kind: 'runtimeAccountSwitch', args: { name: p.displayName }, on: function () {} });
    try {
      state.preview = await api.post(
        '/api/accounts/' + encodeURIComponent(id) + '/' + tool + '/binding/preview',
        {},
        { scope: 'local', includeOverrides: overrides },
      );
      state.load = '';
      dataOk('accounts.switch');
    } catch (error) {
      state.load = 'error';
      dataError('accounts.switch', error);
    }
    render(true);
  }
  A.accSwitch = function (d) {
    return preview(d.k, false);
  };
  const toggle = A.toggle;
  A.toggle = function (d) {
    if (d.path === 'ss.accountSwitch.includeOverrides')
      return preview(st.accountSwitch.id, !st.accountSwitch.includeOverrides);
    return toggle(d);
  };
  VM.accountSwitch = function () {
    if (projectionNeeded) projectionNeeded.add('accounts');
    const s = st.accountSwitch,
      p = s.preview;
    return {
      load: s.load,
      id: s.id,
      includeOverrides: s.includeOverrides,
      busy: s.busy,
      canCommit: !s.load && !s.busy && !!p.previewToken,
      targets: (p ? p.targets : []).map(function (x) {
        return { id: x.catId, title: x.name };
      }),
      exceptions: (p ? p.exceptions : []).map(function (x) {
        return { id: x.catId, title: x.name, sub: x.previousAccountName || x.previousAccountRef };
      }),
    };
  };
  A.accSwitchOk = async function (d) {
    const s = st.accountSwitch;
    s.busy = true;
    render(true);
    try {
      await api.post(
        '/api/accounts/' + encodeURIComponent(d.k) + '/' + s.tool + '/binding/commit',
        {},
        { scope: 'local', includeOverrides: s.includeOverrides, previewToken: s.preview.previewToken },
      );
      await chatPort.action('membersRead', {});
      await read();
      S.dialog = null;
    } catch (error) {
      S.dialog.error = error.message;
    } finally {
      s.busy = false;
      render(true);
    }
  };
}
