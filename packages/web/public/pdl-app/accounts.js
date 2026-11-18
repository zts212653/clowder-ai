/* Account settings use the existing account and native-login owners. */
'use strict';
const ACCOUNT_STATE = { accQ: '', accOpen: {}, accountSwitch: null, evOpen: {}, quota: {} };
function bindAccounts() {
  const st = ACCOUNT_STATE;
  S.accountFilter = 'all';
  let providers = [],
    selections = {},
    load = 'loading',
    timer;
  const accountTool = function (p) {
    return p.agy ? 'agy' : p.clientId === 'anthropic' ? 'claude' : 'codex';
  };
  const vendor = function (p) {
    return p.clientId === 'anthropic' ? 'Claude' : p.clientId === 'openai' ? 'Codex' : p.clientId || ''; // API-key accounts have no clientId
  };
  const account = function (id) {
    return providers.find(function (p) {
      return p.id === id;
    });
  };
  async function read() {
    // The directory and each family's selection are read on their own; a selection that fails only leaves its
    // members unknown (the last one read, or none).
    const tools = ['codex', 'claude', 'agy'],
      values = await Promise.allSettled(
        [api.get('/api/accounts')].concat(
          tools.map(function (tool) {
            return api.get('/api/accounts/' + tool + '/members');
          }),
        ),
      );
    if (values[0].status === 'fulfilled') providers = values[0].value.providers;
    tools.forEach(function (tool, i) {
      const v = values[i + 1];
      selections[tool] = v.status === 'fulfilled' ? v.value.selection : selections[tool] || { members: [] };
    });
    load = values[0].status === 'fulfilled' || load === '' ? '' : 'error';
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
  // The sidebar quota pin preference: read when a projection shows it (a theme that draws the quota bars).
  let pin = null;
  async function readPin() {
    try {
      pin = await api.get('/api/config/quota-pin');
    } catch {
      pin = null;
    }
    await chatDataRender();
  }
  api.on('sources:needed', function (diff) {
    if (diff.removed.indexOf('accounts') >= 0) clearTimeout(timer);
    if (diff.added.indexOf('accounts') >= 0) {
      clearTimeout(timer);
      settleHold(read());
    }
    if (diff.added.indexOf('quotaPin') >= 0) settleHold(readPin());
  });
  PAGES.accounts = function () {
    return pdlView('page.accounts');
  };

  function accountUsers(p) {
    const tool = accountTool(p);
    return (
      p.clientId === 'openai' || p.clientId === 'anthropic' || p.agy
        ? selections[tool].members
        : chatRead('memberSettings').cats.map((m) => ({
            id: m.id,
            name: m.nickname || m.displayName,
            accountRef: m.accountRef,
            avatar: m.avatar,
            available: !m.roster || m.roster.available,
          }))
    ).filter((m) => m.accountRef === p.id);
  }
  // Remaining below this percentage is low (that item of the quota row is shown as a warning).
  const QUOTA_LOW = 20;
  // One reading shape for every family: { observedAt, items } (agy / kimi store just that; Codex adds a status).
  function accountQuotaData(o) {
    const ok = !o.status || o.status === 'ok',
      items = ok ? o.items : (o.lastSuccess || {}).items || [];
    const left = function (x) {
      return Math.max(0, Math.min(100, x.percentKind === 'remaining' ? x.usedPercent : 100 - x.usedPercent));
    };
    return {
      items: items.map(function (x) {
        return { label: x.label, left: left(x), low: left(x) < QUOTA_LOW };
      }),
      resets: items
        .map(function (x) {
          return x.resetsText || x.resetsAt;
        })
        .filter(Boolean),
      at: o.lastSuccess ? o.lastSuccess.observedAt : o.observedAt,
      hasAt: true,
      out:
        ok &&
        items.some(function (x) {
          return left(x) === 0;
        }),
      fail: o.failure
        ? o.failure.kind
        : o.status === 'unsupported'
          ? 'unsupported'
          : o.status === 'unavailable'
            ? 'service_unreachable'
            : '',
    };
  }
  // Mirrors claudeQuotaWindows (packages/shared/src/claude-quota.ts): five_hour and seven_day are account-wide and keep the
  // newest reading; other windows stay per model. Left = (1 - utilization) * 100; a reading past its reset, 10 minutes old
  // or from the future is stale. Named windows carry their key (the theme names them); others show key and model.
  function claudeQuotaData(samples, fail) {
    const latest = {},
      now = api.now();
    Object.keys(samples).forEach(function (model) {
      const s = samples[model];
      Object.keys(s.windows).forEach(function (key) {
        const id = key === 'five_hour' || key === 'seven_day' ? key : model + ':' + key;
        if (!latest[id] || latest[id].observedAt <= s.observedAt)
          latest[id] = Object.assign({ key: key, model: model, observedAt: s.observedAt }, s.windows[key]);
      });
    });
    const ws = Object.values(latest).filter(function (w) {
      return w.utilization != null;
    });
    const named = function (w) {
      return (
        w.key === 'five_hour' ||
        w.key === 'seven_day' ||
        (w.key === 'seven_day_overage_included' && /fable/i.test(w.model))
      );
    };
    const stale = ws.some(function (w) {
      return (w.resetsAt != null && now >= w.resetsAt * 1000) || now - w.observedAt >= 600000 || w.observedAt > now;
    });
    const items = ws.map(function (w) {
      return {
        window: named(w) ? w.key : '',
        label: w.key + ' (' + w.model + ')',
        left: Math.round((1 - w.utilization) * 100),
        low: (1 - w.utilization) * 100 < QUOTA_LOW,
      };
    });
    return {
      items: items,
      resets: ws
        .filter(function (w) {
          return w.resetsAt != null;
        })
        .map(function (w) {
          return { at: w.resetsAt * 1000 };
        }),
      at: Math.max.apply(
        null,
        ws.map(function (w) {
          return w.observedAt;
        }),
      ),
      hasAt: !!ws.length,
      // No switch menu when it runs out: that menu lists Codex accounts only.
      out: false,
      fail: fail || (stale ? 'stale' : ''),
    };
  }
  function quotaMatches(p, observation) {
    if (!p.managed && !(p.codex && p.codex.identity)) return true;
    const identity = p.codex && p.codex.identity,
      owner = observation && observation.owner;
    return (
      !!identity &&
      !!owner &&
      owner.accountRef === p.id &&
      owner.userId === identity.userId &&
      owner.workspaceId === identity.workspaceId
    );
  }
  function row(p) {
    const tool = accountTool(p),
      selection = selections[tool],
      users = accountUsers(p);
    const attempt = p.codex && p.codex.attempt,
      state =
        p.authType === 'api_key'
          ? p.hasApiKey
            ? 'key'
            : 'nokey'
          : p.clientId === 'anthropic' && p.builtin
            ? 'cliManaged'
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
      agy: !!p.agy,
      agyState: p.agyLoginStatus,
      agyCommand: p.agyLoginCommand,
      state:
        {
          ready: 'ok',
          success: 'ok',
          reused: 'ok',
          waiting: 'login',
          queued: 'login',
          preparing: 'login',
          review: 'conflict',
          canceled: 'cancelled',
          interrupted: 'cancelled',
          failed: 'cancelled',
          timeout: 'cancelled',
          not_logged_in: 'none',
          saved: 'token',
        }[state] || state,
      loginState: attempt && attempt.state,
      terminalAvailable:
        !!p.codex &&
        !!attempt &&
        ['preparing', 'queued', 'waiting', 'failed', 'timeout', 'interrupted', 'canceled'].includes(attempt.state),
      projectId: p.googleCloud && p.googleCloud.projectId,
      activeUsers: users.filter((m) => m.available).length,
      usersCount: users.length,
      hasUsers: !!users.length,
      users: users.map(function (m) {
        return { id: m.id, name: m.name, avatar: m.avatar, available: m.available };
      }),
      email: p.codex && p.codex.identity && p.codex.identity.email,
      url: p.baseUrl,
      models: p.models,
      dir: p.codex && p.codex.credentialHome,
      open: open,
      quota:
        !!storedQuota(p) ||
        (p.authType === 'oauth' &&
          p.clientId === 'openai' &&
          ((p.codex && p.codex.status === 'ready') ||
            (p.quota && p.quota.status === 'unavailable') ||
            !!st.quota[p.id])),
      quotaBusy: !!(st.quota[p.id] && st.quota[p.id].busy),
      quotaIdentityChanged:
        !!(st.quota[p.id] && st.quota[p.id].identityChanged) || (!!p.quota && !quotaMatches(p, p.quota)),
      quotaData: quotaDataOf(p),
      canSwitch:
        (p.clientId === 'openai' ||
          p.clientId === 'anthropic' ||
          (p.agy && ['ready', 'refreshable'].includes(p.agyLoginStatus))) &&
        selection.accountRef !== p.id,
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
    const providerCounts = {};
    providers.forEach((p) => {
      providerCounts[p.clientId] =
        (providerCounts[p.clientId] || 0) + accountUsers(p).filter((m) => m.available).length;
    });
    filtered.sort(
      (a, b) =>
        providerCounts[b.clientId] - providerCounts[a.clientId] ||
        (a.clientId || '').localeCompare(b.clientId || '') ||
        Number(row(b).using) - Number(row(a).using) ||
        a.displayName.localeCompare(b.displayName),
    );
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
      directory: ['oauth', 'key'].map((kind) => ({
        kind,
        items: S.accountFilter === 'all' || S.accountFilter === kind ? group(kind).items : [],
      })),
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
  A.agyOpen = function (d) {
    const p = d.id ? account(d.id) : null;
    dialog({
      kind: 'agy',
      args: { name: p ? p.displayName : '' },
      on: async function () {
        const body = { displayName: val('agy-note').trim() };
        if (p) {
          await chatPort.action('accountSave', { id: p.id, value: JSON.stringify(body) });
          st.accOpen[p.id] = true;
        } else {
          const result = await api.post(
            '/api/accounts',
            {},
            Object.assign(body, { clientId: 'google', authType: 'oauth', agyOAuth: true }),
          );
          st.accOpen[result.profile.id] = true;
        }
        await read();
      },
    });
  };
  A.agyRefresh = function () {
    return read();
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
  // The quota an account row shows; 执行 shows the same reading for the account a member uses.
  function quotaDataOf(p) {
    const fail = st.quota[p.id] && st.quota[p.id].fail;
    if (p.clientId === 'anthropic')
      return p.claudeQuota || fail ? claudeQuotaData(p.claudeQuota ? p.claudeQuota.samples : {}, fail) : null;
    if (storedQuota(p)) {
      const reading = p.agyQuota || p.kimiQuota;
      return reading
        ? Object.assign(accountQuotaData(reading), fail ? { fail: fail } : {})
        : fail
          ? { items: [], resets: [], fail: fail }
          : null;
    }
    const observation = (st.quota[p.id] && st.quota[p.id].observation) || p.quota;
    return observation && quotaMatches(p, observation) && !(st.quota[p.id] && st.quota[p.id].identityChanged)
      ? accountQuotaData(observation)
      : null;
  }
  // Members on a built-in login use the account its selection names; others the account set on the member.
  function memberAccountRef(id, own) {
    const picked = Object.values(selections)
      .flatMap(function (sel) {
        return sel.members;
      })
      .find(function (m) {
        return m.id === id;
      });
    return (picked && picked.accountRef) || own;
  }
  VM.memberQuota = function (id, own) {
    if (projectionNeeded) projectionNeeded.add('accounts');
    const p = account(memberAccountRef(id, own)),
      q = p && quotaDataOf(p);
    return q && q.items.length ? { account: p.displayName, items: q.items } : null;
  };
  // Quota pin: every signed-in account's reading (the same as its account row) and, per family, the least left among
  // the selected accounts. Which accounts count is the owner's choice (null = all); drawing it is a theme's choice.
  const QUOTA_FAMILIES = ['claude', 'codex', 'agy', 'kimi'];
  function quotaFamily(p) {
    if (p.authType !== 'oauth' || p.googleCloud) return '';
    if (p.agy) return 'agy';
    return { anthropic: p.baseUrl ? '' : 'claude', openai: 'codex', kimi: 'kimi' }[p.clientId] || '';
  }
  VM.quotaPin = function () {
    if (projectionNeeded) {
      projectionNeeded.add('accounts');
      projectionNeeded.add('quotaPin');
    }
    if (!pin) return { pinned: false, bars: [], accounts: [], selected: [], count: 0 };
    const all = providers.filter(quotaFamily).map(function (p) {
      const q = quotaDataOf(p);
      return {
        id: p.id,
        family: quotaFamily(p),
        name: p.displayName,
        inUse: accountUsers(p).length > 0,
        items: q ? q.items : [],
        canRefresh: !!storedQuota(p) || p.clientId === 'openai',
      };
    });
    const chosen =
      pin.selectedAccountRefs ||
      all.map(function (a) {
        return a.id;
      });
    all.forEach(function (a) {
      a.selected = chosen.indexOf(a.id) >= 0;
    });
    const bars = QUOTA_FAMILIES.map(function (f) {
      const left = all
        .filter(function (a) {
          return a.selected && a.family === f;
        })
        .reduce(function (m, a) {
          return a.items.reduce(function (n, i) {
            return n == null || i.left < n ? i.left : n;
          }, m);
        }, null);
      return { family: f, left: left, has: left != null, low: left != null && left < QUOTA_LOW };
    });
    return {
      pinned: pin.pinned,
      bars: bars,
      accounts: all,
      selected: all.filter(function (a) {
        return a.selected;
      }),
      choosing: !!CS.quotaChoosing,
      count: chosen.length,
    };
  };
  A.quotaPinSet = async function (d) {
    pin = await api.post('/api/config/quota-pin', { method: 'PUT' }, d);
    await chatDataRender();
    return true;
  };
  A.quotaPinSelect = function (d) {
    return A.quotaPinSet({
      selectedAccountRefs: VM.quotaPin()
        .accounts.filter(function (a) {
          return a.selected !== (a.id === d.id);
        })
        .map(function (a) {
          return a.id;
        }),
    });
  };
  A.quotaPinRefresh = async function () {
    await Promise.all(
      VM.quotaPin()
        .selected.filter(function (a) {
          return a.canRefresh;
        })
        .map(function (a) {
          return A.accQuota({ k: a.id });
        }),
    );
    return true;
  };
  // Claude, agy and kimi: the account list carries the stored reading; reading again stores a new one and the list is
  // read again. A failed read keeps the last reading and names why.
  function storedQuota(p) {
    return p.clientId === 'anthropic'
      ? p.authType === 'oauth' && !p.baseUrl
        ? 'claude'
        : ''
      : p.agyQuotaReady
        ? 'agy'
        : p.kimiLoginReady
          ? 'kimi'
          : '';
  }
  async function readStoredQuota(p) {
    const state = (st.quota[p.id] = { busy: true });
    render(true);
    try {
      await api.post('/api/accounts/' + encodeURIComponent(p.id) + '/' + storedQuota(p) + '/quota', {}, {});
    } catch (error) {
      state.identityChanged = error.status === 409;
      state.fail =
        error.status === 409
          ? ''
          : error.message === 'claude_quota_owner_unknown'
            ? 'owner_unknown'
            : 'service_unreachable';
    }
    await read();
    state.busy = false;
    render(true);
  }
  A.accQuota = async function (d) {
    const p = account(d.k);
    if (storedQuota(p)) return readStoredQuota(p);
    const signature = JSON.stringify(p.codex && p.codex.identity),
      previous = (st.quota[p.id] && st.quota[p.id].observation) || p.quota;
    const state = (st.quota[p.id] = { busy: true });
    render(true);
    try {
      const receipt = await api.post(
        '/api/accounts/' + encodeURIComponent(p.id) + '/codex/quota',
        {},
        previous && previous.failure && previous.failure.kind === 'renewal_required' ? { renewExpired: true } : {},
      );
      await read();
      const current = account(p.id);
      state.identityChanged =
        !current ||
        signature !== JSON.stringify(current.codex && current.codex.identity) ||
        !quotaMatches(current, receipt.quota);
      if (!state.identityChanged) state.observation = receipt.quota;
    } catch (error) {
      if (error.status === 409) {
        state.identityChanged = true;
        await read();
      } else
        state.observation = {
          observedAt: Date.now(),
          status: 'unavailable',
          items: [],
          failure: { kind: 'service_unreachable' },
          owner: previous && previous.owner,
          lastSuccess:
            previous &&
            (previous.status === 'ok'
              ? { observedAt: previous.observedAt, items: previous.items }
              : previous.lastSuccess),
        };
    } finally {
      state.busy = false;
      render(true);
    }
  };
  async function login(p, op, terminal = false) {
    try {
      await api.post(
        '/api/accounts/' + encodeURIComponent(p.id) + '/codex/login/' + op,
        {},
        op === 'start' ? (terminal ? { terminal: true } : {}) : { attemptId: p.codex.attempt.id },
      );
      await read();
    } catch {}
  }
  A.accRelogin = function (d) {
    return login(account(d.id), 'start');
  };
  A.accLogin = function (d) {
    const p = account(d.k),
      attempt = p.codex.attempt;
    return login(
      p,
      d.v === 'cancel' ? 'cancel' : d.v !== 'terminal' && attempt && attempt.state === 'review' ? 'confirm' : 'start',
      d.v === 'terminal',
    );
  };
  A.accConflict = function (d) {
    return login(account(d.k), d.v === 'keep' ? 'create-new' : 'cancel');
  };
  async function preview(id, overrides) {
    const p = account(id),
      tool = accountTool(p);
    const state = (st.accountSwitch = {
      id: id,
      tool: tool,
      includeOverrides: overrides,
      load: 'loading',
      busy: false,
    });
    // The dialog's OK commits this preview; a failed commit reopens it with the reason.
    dialog({
      kind: 'runtimeAccountSwitch',
      args: { name: p.displayName },
      on: function () {
        return commit(state);
      },
    });
    try {
      state.preview = await api.post(
        '/api/accounts/' + encodeURIComponent(id) + '/' + tool + '/binding/preview',
        {},
        { scope: 'local', includeOverrides: overrides },
      );
      state.load = '';
    } catch {
      state.load = 'error';
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
  async function commit(s) {
    if (s !== st.accountSwitch || s.load || !s.preview.previewToken) return false;
    s.busy = true;
    try {
      await api.post(
        '/api/accounts/' + encodeURIComponent(s.id) + '/' + s.tool + '/binding/commit',
        {},
        { scope: 'local', includeOverrides: s.includeOverrides, previewToken: s.preview.previewToken },
      );
      await chatPort.action('membersRead', {});
      await read();
    } finally {
      s.busy = false;
    }
  }
}
