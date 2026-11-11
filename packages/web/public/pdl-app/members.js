/* Member settings: real owner data and generic form controls; no React UI. */
'use strict';
function bindMembers() {
  let meta = null,
    pending = null,
    page = '',
    editor = null,
    access = 'all',
    tpl = 'blank';
  S.memberFilter = 'on';
  const model = function () {
    return chatRead('memberSettings');
  };
  const cats = function () {
    return model().cats;
  };
  async function act(name, args, element) {
    try {
      return await chatPort.action(name, args, element);
    } catch (error) {
      if (error.name === 'PdlReadError' && name !== 'memberSave') {
        meta = null;
        dataError('members', error);
      }
      if (['runtime.readError', 'members.loadError', 'memberNew.templatesError'].indexOf(error.message) >= 0)
        throw new Error(tc(error.message));
      throw error;
    }
  }
  function read() {
    if (pending) return pending;
    const target = page,
      id = page.slice(8);
    pending = settleHold(
      act('membersRead', {})
        .then(async function (data) {
          if (id && id !== 'new' && id !== 'list') {
            const values = await Promise.all([act('settingsHooksRead', {}), act('memberCanonRead', { id: id })]);
            data.canon = values[1];
          }
          if (target === page) {
            meta = data;
            dataOk('members');
          }
        })
        .catch(function (error) {
          meta = null;
          if (error.name !== 'PdlReadError') dataError('members', error);
        })
        .finally(function () {
          pending = null;
          if (target !== page && page) read();
          return chatDataRender();
        }),
    );
    return pending;
  }
  api.on('sources:needed', function (diff) {
    diff.added.forEach(function (key) {
      if (key.indexOf('members:') !== 0) return;
      page = key;
      read();
    });
  });
  function draft() {
    if (!meta) return null;
    const id = S.route === 'memberNew' ? '' : S.param,
      key = id || 'new';
    if (!editor || editor.key !== key) {
      const cat = id
        ? cats().find(function (cat) {
            return cat.id === id;
          })
        : null;
      if (id && !cat) return null;
      const strategy = meta.strategies.find(function (entry) {
        return entry.id === id;
      });
      editor = {
        key: key,
        member: cat,
        saveState: 'idle',
        saveError: '',
        pendingWrite: null,
        id: id,
        revision: cat && cat.configurationRevision,
        form: pdlClone(cat ? cat.form : meta.blank),
        original: pdlClone(cat ? cat.form : meta.blank),
        shared: pdlClone(meta.codex),
        sharedOriginal: pdlClone(meta.codex),
        strategy: strategy ? pdlClone(strategy.form) : null,
        clients: {},
      };
      editor.strategyOriginal = pdlClone(editor.strategy);
      tpl = 'blank';
    }
    return editor;
  }
  function dirty() {
    return (
      !!editor &&
      (JSON.stringify(editor.form) !== JSON.stringify(editor.original) ||
        JSON.stringify(editor.shared) !== JSON.stringify(editor.sharedOriginal) ||
        JSON.stringify(editor.strategy) !== JSON.stringify(editor.strategyOriginal) ||
        (editor.clientKey && clientSettingsDirty(editor.clients[editor.clientKey])))
    );
  }
  formDraft('member', {
    dirty: dirty,
    drop: function () {
      editor = null;
    },
  });
  SET_AFTER['ss.draft'] = function () {
    editor = null;
  };
  SET_AFTER['ss.access'] = function (value) {
    access = value || 'all';
  };
  ['members', 'member', 'memberNew'].forEach(function (name) {
    PAGES[name] = function () {
      return pdlView('page.' + name);
    };
  });

  ENT.member = {
    get: function (id) {
      return cats().find(function (cat) {
        return cat.id === id;
      });
    },
    confirm: function (cat) {
      return {
        kind: 'memberDelete',
        args: { name: cat.nickname || cat.displayName || cat.name, handle: cat.mentionPatterns[0] || '' },
      };
    },
    remove: function (cat) {
      return act('memberDelete', { id: cat.id, expectedRevision: cat.configurationRevision });
    },
    after: function (_, op) {
      if (op === 'remove') {
        editor = null;
        go('members');
      }
    },
  };
  VM.members = function () {
    if (projectionNeeded) projectionNeeded.add('members:list');
    const source = model();
    if (!source) return null;
    const all = source.cats,
      enabled = function (c) {
        return !c.roster || c.roster.available;
      },
      on = all.filter(enabled),
      carrier = function (c) {
        return c.identityProtection && c.identityProtection.kind === 'builtin-cloud'
          ? 'cloud'
          : c.agyProfile
            ? 'agy'
            : c.carrier;
      },
      prefs = projectTeam().teamPreferences;
    return {
      onOpts: on.map(function (c) {
        return c.id;
      }),
      defaultCat: (
        all.find(function (c) {
          return c.isDefaultResponder;
        }) || {}
      ).id,
      counts: { all: all.length, on: on.length, off: all.length - on.length },
      filter: S.memberFilter,
      owner: { name: source.owner.name, tags: source.owner.mentionPatterns },
      prefsCount: prefs ? prefs.length : 0,
      access: access,
      stale: source.stale,
      rows: all
        .filter(function (c) {
          return (
            (S.memberFilter === 'all' || enabled(c) === (S.memberFilter === 'on')) &&
            (access === 'all' || carrier(c) === access)
          );
        })
        .map(function (c) {
          const preferences = memberPreferences(c.form, meta ? runtimeCatalogState(c.form, c.id) : null);
          return {
            id: c.id,
            configurationSource: c.configurationSource,
            name: c.nickname || c.displayName,
            handle: c.mentionPatterns[0],
            model: preferences.model,
            modelLabel: preferences.modelLabel,
            modelSource: preferences.modelSource,
            modelStatus: preferences.catalog && preferences.catalog.defaultModelStatus,
            on: enabled(c),
            availability: projectMemberAvailability(c.id),
            cloud: carrier(c) === 'cloud',
          };
        }),
    };
  };
  CHANGES.accessFilter = function (e) {
    access = e.target.value;
    render(true);
  };
  CHANGES.umDefault = async function (e) {
    try {
      await act('memberDefault', { id: e.target.value });
      render(true);
    } catch (error) {
      toast(error.message, null, 'danger');
      render(true);
    }
  };
  A.umOrder = async function (data) {
    return chatAction('umOrder', data);
  };
  const statusAction = A.setStatus;
  A.setStatus = function (data) {
    if (data.entity !== 'member') return statusAction(data);
    const cat = cats().find(function (cat) {
      return cat.id === data.id;
    });
    const next = data.v == null ? !!cat.roster && !cat.roster.available : data.v === true || data.v === 'true';
    return chatAction('memberAvailable', { id: data.id, v: String(next) });
  };

  function selectedRuntime(form) {
    return meta.runtimes.find(function (row) {
      return (
        row.form.clientId === form.clientId &&
        row.form.carrier === form.carrier &&
        (form.clientId !== 'google' || row.form.agyNativeEnabled === form.agyNativeEnabled) &&
        (form.carrier !== 'acp' ||
          (form.acpAgentProvider
            ? row.form.acpAgentProvider === form.acpAgentProvider
            : row.form.acpCommand === form.acpCommand &&
              row.form.acpStartupArgs === form.acpStartupArgs &&
              (row.form.acpTransport || 'stdio') === (form.acpTransport || 'stdio')))
      );
    });
  }
  const catalogs = new Map();
  // The model a catalog is read for: the one the form had, then each committed model (change: blur, Enter, a picked
  // candidate) — typing alone doesn't read.
  const catalogModels = new WeakMap();
  function commitModel(f) {
    catalogModels.set(f, f.defaultModel);
  }
  // A typed model the catalog doesn't list has no catalog of its own: only following the tool or a listed model re-reads.
  function listedModel(f, id, runtime) {
    const state = runtimeCatalogState(f, id, runtime),
      catalog = state && state.value;
    return (
      !f.defaultModel ||
      (!!catalog &&
        catalog.models.some(function (m) {
          return m.value === f.defaultModel;
        }))
    );
  }
  function runtimeCatalogState(f = draft().form, id = draft().id, runtime = selectedRuntime(f)) {
    if (!runtime && !f.acpAgentProvider) return null;
    // Manual or draft entries are not discovered tools: their models are entered by hand, nothing to read.
    if (!f.acpAgentProvider && /^(manual|draft):/.test(runtime.id)) return null;
    if (!catalogModels.has(f)) commitModel(f);
    const request = Object.assign(
      f.acpAgentProvider ? { ref: f.acpAgentProvider } : { runtimeId: runtime.id, catId: id || undefined },
      {
        accountRef: f.accountRef || undefined,
        model: catalogModels.get(f) || undefined,
        customStartup: !!f.cliConfigArgs.length,
        refresh: false,
      },
    );
    const key = JSON.stringify(request);
    if (!catalogs.has(key)) catalogs.set(key, { request: request, load: 'loading', value: null });
    if (projectionNeeded) projectionNeeded.add('memberCatalog:' + key);
    return catalogs.get(key);
  }
  // Refresh: read the current catalog again past the server's cache; the list on screen stays until it arrives.
  A.memberCatalogRefresh = function () {
    const state = runtimeCatalogState();
    if (!state) return;
    state.load = 'loading';
    render(true);
    settleHold(
      act('memberRuntimeModels', { value: JSON.stringify(Object.assign({}, state.request, { refresh: true })) })
        .then(
          function (value) {
            state.value = value;
            state.load = '';
          },
          function () {
            state.load = 'error';
          },
        )
        .finally(chatDataRender),
    );
  };
  api.on('sources:needed', function (diff) {
    diff.added
      .filter(function (key) {
        return key.indexOf('memberCatalog:') === 0;
      })
      .forEach(function (key) {
        const state = catalogs.get(key.slice('memberCatalog:'.length));
        settleHold(
          act('memberRuntimeModels', { value: JSON.stringify(state.request) })
            .then(
              function (value) {
                if (!heldNeeded.has(key)) return;
                state.value = value;
                state.load = '';
                dataOk(key);
              },
              function (error) {
                state.load = 'error';
                dataError(key, error);
              },
            )
            .finally(chatDataRender),
        );
      });
  });
  function memberPreferences(f, catalogState, poolDefault) {
    const catalog = catalogState && catalogState.value;
    if (!catalog)
      return {
        catalog: null,
        catalogLoading: !!catalogState && catalogState.load === 'loading',
        catalogRead: !!catalogState,
        acpMaxDefault: poolDefault,
        model: f.defaultModel,
        modelLabel: f.defaultModel,
        modelSource: f.defaultModel ? 'member' : undefined,
      };
    const selected = catalog.models.find(function (m) {
      return m.value === f.defaultModel;
    });
    const selectedEffort = catalog.selectedEffort !== undefined && catalog.selectedModel === f.defaultModel;
    const efforts = catalog.effortOptions || (selected && selected.efforts);
    const effortOption =
      efforts &&
      efforts.find(function (e) {
        return e.value === f.cliEffort;
      });
    return {
      catalog: catalog,
      catalogLoading: catalogState.load === 'loading',
      catalogRead: true,
      acpMaxDefault: poolDefault,
      selectedModel: selected,
      model: f.defaultModel || catalog.defaultModel,
      effort: f.cliEffort || (selectedEffort ? catalog.selectedEffort : catalog.defaultEffort),
      modelLabel: selected ? selected.label : f.defaultModel || catalog.defaultModelLabel || catalog.defaultModel,
      effortLabel: effortOption
        ? effortOption.label
        : f.cliEffort ||
          (selectedEffort
            ? catalog.selectedEffortLabel || catalog.selectedEffort
            : catalog.defaultEffortLabel || catalog.defaultEffort),
      modelSource: f.defaultModel ? 'member' : catalog.defaultModelSource,
      effortSource: f.cliEffort
        ? 'member'
        : selectedEffort
          ? catalog.selectedEffortSource
          : catalog.defaultEffortSource,
      efforts: efforts,
      invalidEffort:
        !!f.cliEffort &&
        !!efforts &&
        efforts.length > 0 &&
        !efforts.some(function (e) {
          return e.value === f.cliEffort;
        }),
    };
  }
  function memberRuntimeVM(f) {
    const raw = placementData(),
      hooks = raw.hooks,
      result = raw.connections[[f.clientId, f.accountRef, f.defaultModel].join(':')];
    return {
      hooks: {
        status: hooks ? hooks.status : 'loading',
        error: raw.hooksError,
        targets: hooks ? hooks.targets : [],
        canSync: !!hooks && !raw.hooksError && ['missing', 'stale', 'error'].includes(hooks.status),
      },
      canTest:
        !!f.accountRef &&
        meta.clients.some(function (c) {
          return c.id === f.clientId;
        }),
      connection: result
        ? { status: result.skipped ? 'skipped' : result.ok ? 'ok' : 'error', tip: result.error || result.message }
        : null,
    };
  }
  A.memberConnection = function () {
    const f = draft().form;
    return chatAction('settingsMemberConnection', {
      key: [f.clientId, f.accountRef, f.defaultModel].join(':'),
      value: JSON.stringify({ profileId: f.accountRef, clientId: f.clientId, model: f.defaultModel }),
    });
  };
  const memberFields = {
    breed: 'name',
    name: 'nickname',
    suffix: 'variantLabel',
    role: 'roleDescription',
    avatarPath: 'avatar',
    tint: 'colorPrimary',
    fixedColor: 'colorPrimary',
    good: 'teamStrengths',
    traits: 'personality',
    care: 'caution',
    client: 'clientId',
    via: 'carrier',
    acc: 'accountRef',
    model: 'defaultModel',
    provider: 'provider',
    args: 'commandArgs',
    effort: 'cliEffort',
    speed: 'codexSpeed',
    mcp: 'mcpSupport',
    acpCmd: 'acpCommand',
    acpArgs: 'acpStartupArgs',
    acpMax: 'acpMaxLiveProcesses',
    acpTtl: 'acpIdleTtlMinutes',
    agyOn: 'agyNativeEnabled',
    agyPerm: 'agyAutoApprove',
    agyProfile: 'agyProfileId',
    agyRoot: 'agyHomeRoot',
    agyDirs: 'agyTrustedWorkspaces',
    ctxWin: 'contextWindow',
    vLang: 'voiceLangCode',
    vVoice: 'voiceVoice',
    vSpeed: 'voiceSpeed',
    vRef: 'voiceRefAudio',
    vRefText: 'voiceRefText',
    vTone: 'voiceInstruct',
    vVar: 'voiceTemperature',
    executionApproval: 'executionApproval',
  };
  function form() {
    const state = draft();
    if (!state) return null;
    const f = state.form,
      client = meta.clients.find(function (c) {
        return c.id === f.clientId;
      }),
      account = meta.accounts.find(function (a) {
        return a.id === f.accountRef;
      }),
      cat = state.member,
      // protection is the member's current record (pushed), not the copy the editor started from
      current =
        cats().find(function (c) {
          return cat && c.id === cat.id;
        }) || cat,
      cloud = !!(current && current.identityProtection && current.identityProtection.kind === 'builtin-cloud'),
      catalogState = runtimeCatalogState(),
      runtime = selectedRuntime(f),
      shared = clientSettingsState();
    const d = Object.fromEntries(
      Object.keys(memberFields).map(function (key) {
        return [key, f[memberFields[key]]];
      }),
    );
    d.aliases = f.mentionPatterns
      .split(',')
      .map(function (v) {
        return v.trim();
      })
      .filter(Boolean);
    d.tags = d.aliases;
    d.color = { primary: f.colorPrimary, secondary: f.colorSecondary };
    if (state.strategy)
      Object.assign(d, {
        ctxStrat: state.strategy.strategy,
        ctxWarn: state.strategy.warnThreshold,
        ctxLine: state.strategy.actionThreshold,
        ctxMax: state.strategy.maxCompressions,
      });
    Object.assign(d, { cxSandbox: state.shared.sandboxMode, cxApproval: state.shared.approvalPolicy });
    const active = {
      provider: f.clientId === 'opencode',
      acpCmd: f.carrier === 'acp',
      acpArgs: f.carrier === 'acp',
      acpMax: f.carrier === 'acp',
      acpTtl: f.carrier === 'acp',
      executionApproval: f.carrier === 'acp',
      cxSandbox: f.clientId === 'openai',
      cxApproval: f.clientId === 'openai',
      agyOn: f.clientId === 'google' && f.carrier !== 'acp',
      agyPerm: f.clientId === 'google' && f.carrier !== 'acp',
      agyProfile: f.clientId === 'google' && f.carrier !== 'acp',
      agyRoot: f.clientId === 'google' && f.carrier !== 'acp',
      agyDirs: f.clientId === 'google' && f.carrier !== 'acp',
    };
    const n =
      Object.keys(f).filter(function (key) {
        return JSON.stringify(f[key]) !== JSON.stringify(state.original[key]);
      }).length +
      (state.strategy
        ? Object.keys(state.strategy).filter(function (key) {
            return JSON.stringify(state.strategy[key]) !== JSON.stringify(state.strategyOriginal[key]);
          }).length
        : 0) +
      (JSON.stringify(state.shared) !== JSON.stringify(state.sharedOriginal) ? 1 : 0) +
      (shared && clientSettingsDirty(shared) ? 1 : 0);
    const missing = !state.id
      ? ['breed', 'role', 'aliases'].filter(function (key) {
          return !d[key] || (Array.isArray(d[key]) && !d[key].length);
        })
      : [];
    return {
      isNew: !state.id,
      existing: !!state.id,
      id: state.id,
      on: !cat || !cat.roster || cat.roster.available,
      cloud: cloud,
      configurationSource: f.configurationSource,
      accountRef: f.accountRef,
      clientName: client && client.label,
      nativeLogin: runtime && runtime.readiness,
      d: d,
      clients: meta.clients.map(function (c) {
        return { value: c.id, name: c.label, type: c.plugin ? 'plugin' : 'name', pluginName: c.plugin, why: '' };
      }),
      via: (client ? client.carriers : []).map(function (c) {
        return { value: c[0], name: c[0], type: 'name', why: '' };
      }),
      acp: f.carrier === 'acp',
      accounts: meta.accounts
        .filter(function (a) {
          return client && client.accounts.includes(a.id);
        })
        .map(function (a) {
          return {
            id: a.id,
            name: a.displayName,
            kind: a.builtin ? 'builtin' : a.authType === 'api_key' ? 'key' : a.authType,
          };
        }),
      preferences: cloud
        ? null
        : memberPreferences(f, catalogState, runtime ? runtime.acpMaxDefault : client.acpMaxDefault),
      identityProtection: cat && cat.identityProtection,
      follow: f.accountBindingMode === 'follow',
      overrideAccount: f.accountBindingMode === 'override',
      required: { provider: f.clientId === 'opencode' },
      noAccount: !meta.accounts.length,
      active: active,
      fromPlugin: f.acpAgentProvider,
      model: { provider: providerVM(), plugin: null },
      runtime: !state.id || cloud ? null : memberRuntimeVM(f),
      clientShared: cloud
        ? null
        : {
            name: client && client.label,
            plugin:
              shared && shared.plugin
                ? pcfModel('mrt-c:' + shared.plugin.pluginId, {
                    plugin: shared.plugin.pluginId,
                    fields: [
                      Object.assign({}, shared.field, {
                        currentValue: JSON.stringify(shared.rows),
                        configurationMode: shared.library.configurationMode,
                        defaultClient: shared.library.defaultClient,
                      }),
                    ],
                    steps: [],
                    installed: true,
                  })
                : null,
          },
      ext: null,
      canonBound: !!meta.canon && !!meta.canon.bound,
      avatarPathOpen: !!CS.voice.avPathOpen,
      handleLock: cloud ? cat.mentionPatterns[0] : d.aliases.length === 1 ? d.aliases[0] : '',
      ctxDirty: !!state.strategy && JSON.stringify(state.strategy) !== JSON.stringify(state.strategyOriginal),
      hybrid: d.ctxStrat === 'hybrid',
      speedOn: f.clientId === 'openai' && !!account && account.authType === 'oauth' && f.carrier !== 'acp',
      astra: /astra/.test(f.defaultModel),
      invalid: {},
      routing: null,
      save: {
        state: state.saveState,
        error: state.saveError,
        pendingWrite: state.pendingWrite,
        n: n,
        missing: missing.map(function (k) {
          return { k: k };
        }),
        missingCount: missing.length,
      },
    };
  }
  VM.member = function () {
    if (projectionNeeded) projectionNeeded.add('members:' + S.param);
    const state = draft();
    if (!state) return null;
    const cat = state.member;
    const memberForm = form();
    return {
      id: cat.id,
      load: memberLoad(),
      name: cat.nickname || cat.displayName,
      handle: cat.mentionPatterns[0],
      breed: cat.name,
      model: memberForm.cloud ? cat.defaultModel : memberForm.preferences.model,
      modelSource: memberForm.cloud ? undefined : memberForm.preferences.modelSource,
      on: !cat.roster || cat.roster.available,
      is: { ok: !cat.roster || cat.roster.available },
      note: cat.roster && cat.roster.reason,
      form: memberForm,
    };
  };
  VM.memberNew = function () {
    if (projectionNeeded) projectionNeeded.add('members:new');
    return meta
      ? {
          tpl: tpl,
          load: memberLoad(),
          tplLoad: '',
          templates: meta.templates,
          form: form(),
        }
      : null;
  };
  function change(e) {
    const state = draft(),
      key = memberFields[e.target.dataset.k] || e.target.dataset.k;
    if (!state) return;
    const strategy = {
      ctxStrat: 'strategy',
      ctxWarn: 'warnThreshold',
      ctxLine: 'actionThreshold',
      ctxMax: 'maxCompressions',
    };
    if (strategy[key]) state.strategy[strategy[key]] = e.target.value;
    else if (key === 'cxSandbox' || key === 'cxApproval')
      state.shared[key === 'cxSandbox' ? 'sandboxMode' : 'approvalPolicy'] = e.target.value;
    else if (typeof state.form[key] === 'boolean') state.form[key] = e.target.value === 'true';
    else state.form[key] = e.target.value;
    if (e.type === 'change' && (key !== 'defaultModel' || listedModel(state.form))) commitModel(state.form);
    if (key === 'clientId' || key === 'carrier') state.form.acpAgentProvider = null;
    if (key === 'name') state.form.displayName = e.target.value;
    if (key === 'accountRef' && e.target.value) {
      state.form.configurationSource = 'managed_account';
      state.form.accountBindingMode = 'override';
    } else if (key === 'accountRef') state.form.configurationSource = 'native_tool'; // the client's own login and configuration
    if (key === 'clientId') {
      const client = meta.clients.find(function (row) {
        return row.id === state.form.clientId;
      });
      state.form.carrier = client.carriers[0][0];
      state.form.accountRef = '';
      state.form.cliEffort = '';
    }
    render(true);
  }
  SET_AFTER['ss.draft.{k}'] = function (v, d) {
    draft().form[memberFields[d.k]] = v;
  };
  INPUTS.md = change;
  CHANGES.md = change;
  A.followAcc = async function () {
    const state = draft(),
      client = state.form.clientId;
    if (client !== 'openai' && client !== 'anthropic') return;
    if ((await chatAction('settingsFollowRead', { clientId: client })) === false) return;
    const selected = chatDataSnapshot.project.settings.follows[client];
    if (selected.accountRef) {
      state.form.accountRef = selected.accountRef;
      state.form.accountBindingMode = 'follow';
      state.form.configurationSource = 'managed_account';
    }
    render(true);
  };
  INPUTS.mdColor = function (e) {
    const state = draft();
    if (state) {
      state.form.colorPrimary = e.target.value;
      render(true);
    }
  };
  CHANGES.memberShared = function (e) {
    draft().shared[e.target.dataset.k] = e.target.value;
    render(true);
  };
  CHANGES.memberRuntime = function (e) {
    const state = draft(),
      runtime = meta.runtimes.find(function (row) {
        return row.id === e.target.value;
      });
    if (!runtime) return;
    Object.assign(state.form, pdlClone(runtime.form));
    commitModel(state.form);
    render(true);
  };

  CHANGES.memberStrategy = INPUTS.memberStrategy = function (e) {
    draft().strategy[e.target.dataset.k] = e.target.value;
    render(true);
  };
  function providerState() {
    const state = draft(),
      f = state.form,
      runtime = selectedRuntime(f),
      signature = JSON.stringify([f.clientId, f.carrier, f.acpCommand, f.acpStartupArgs]),
      prepared = state.provider && state.provider.receipt && state.provider.signature === signature;
    if (
      f.configurationSource !== 'native_tool' ||
      f.accountRef ||
      (!prepared && !(runtime && runtime.dshSetupSupported))
    )
      return null;
    if (!state.provider || state.provider.signature !== signature) {
      state.provider = {
        signature: signature,
        runtimeId: runtime.id,
        load: '',
        sourceProfile: 'acp',
        profiles: ['acp', 'desktop', 'web'],
        provider: '',
        model: '',
        inspection: null,
        receipt: null,
        tested: false,
      };
    }
    return state.provider;
  }
  function providerVM() {
    const s = providerState();
    if (!s) return null;
    const routes = s.inspection ? s.inspection.source.providers : [],
      route = routes.find(function (row) {
        return row.id === s.provider;
      });
    return {
      sourceProfile: s.sourceProfile,
      error: s.error,
      load: s.load,
      profiles: s.profiles,
      provider: s.provider,
      model: s.model,
      routes: routes.map(function (row) {
        return { v: row.id, label: row.id };
      }),
      models: route
        ? route.models.map(function (row) {
            return { v: row.id, label: row.label };
          })
        : [],
      canPrepare: !!s.inspection && !!s.provider && !!s.model,
      canTest: !!s.receipt,
      tested: s.tested,
    };
  }
  const runtimeSet = CHANGES.runtimeSet;
  CHANGES.runtimeSet = function (e) {
    if (!e.target.dataset.path || e.target.dataset.path.indexOf('ss.providerSetup.') !== 0) return runtimeSet(e);
    const key = e.target.dataset.path.split('.').pop(),
      previous = providerState(),
      s = Object.assign({}, previous);
    editor.provider = s;
    s[key] = e.target.value;
    s.receipt = null;
    s.tested = false;
    if (key === 'sourceProfile') s.inspection = null;
    if (key === 'provider') {
      const route = s.inspection.source.providers.find(function (row) {
        return row.id === s.provider;
      });
      s.model = route.models.length ? route.models[0].id : '';
    }
    render(true);
  };
  A.memberProviderSetup = async function (data) {
    if (editor && editor.catalog && editor.catalog.load === 'error') editor.catalog = null;
    if (editor)
      Object.keys(editor.clients).forEach(function (key) {
        if (editor.clients[key].load === 'error') delete editor.clients[key];
      });
    if (!meta) return read();
    const state = draft(),
      s = providerState();
    if (!s) return read();
    const body =
      data.op === 'inspect'
        ? { runtimeId: s.runtimeId, sourceProfile: s.sourceProfile }
        : data.op === 'prepare'
          ? {
              runtimeId: s.runtimeId,
              sourceProfile: s.sourceProfile,
              revision: s.inspection.revision,
              provider: s.provider,
              model: s.model,
            }
          : { id: s.receipt };
    s.load = 'loading';
    s.error = '';
    if (data.op === 'inspect') {
      s.inspection = null;
      s.receipt = null;
      s.tested = false;
    }
    render(true);
    try {
      const receipt = await act('memberProviderSetup', { op: data.op, value: JSON.stringify(body) });
      if (editor !== state || providerState() !== s) return;
      if (data.op === 'inspect') {
        s.inspection = receipt;
        s.profiles = receipt.profiles;
        const route =
          receipt.source.providers.find(function (row) {
            return row.id === receipt.active.provider;
          }) || receipt.source.providers[0];
        s.provider = route ? route.id : '';
        s.model =
          route && route.models.length
            ? (
                route.models.find(function (row) {
                  return row.id === receipt.active.model;
                }) || route.models[0]
              ).id
            : '';
        s.receipt = null;
        s.tested = false;
      }
      if (data.op === 'prepare') {
        Object.assign(state.form, receipt.launch);
        s.signature = JSON.stringify([
          state.form.clientId,
          state.form.carrier,
          state.form.acpCommand,
          state.form.acpStartupArgs,
        ]);
        s.receipt = receipt.id;
        s.tested = false;
      }
      if (data.op === 'test') s.tested = true;
      s.load = '';
    } catch (error) {
      if (editor === state && state.provider === s) {
        s.load = '';
        s.error = error.message;
        if (error.profiles) s.profiles = error.profiles;
      }
    }
    render(true);
  };
  function clientSettingsState() {
    const state = draft(),
      f = state.form;
    state.clientKey = null;
    if (f.carrier !== 'acp' || !f.acpAgentProvider) return null;
    const library = meta.libraries.find(function (row) {
      return row.clients.some(function (client) {
        return client.ref === f.acpAgentProvider;
      });
    });
    if (!library || !library.configurationKey) return null;
    const key = library.pluginId;
    state.clientKey = key;
    if (projectionNeeded) projectionNeeded.add('memberClient:' + key);
    if (!state.clients[key]) {
      state.clients[key] = {
        key: key,
        library: library,
        load: 'loading',
        rows: null,
        original: null,
        plugin: null,
      };
    }
    return state.clients[key];
  }
  api.on('sources:needed', function (diff) {
    diff.added
      .filter(function (source) {
        return source.indexOf('memberClient:') === 0;
      })
      .forEach(function (source) {
        const state = draft(),
          key = source.slice('memberClient:'.length),
          client = state.clients[key],
          library = client.library;
        settleHold(
          act('memberPluginRead', { id: key })
            .then(function (plugin) {
              if (!heldNeeded.has(source) || editor !== state) return;
              const field = plugin.configFields.find(function (row) {
                return row.key === library.configurationKey;
              });
              const raw =
                field.currentValue === null
                  ? field.default === undefined
                    ? library.configurationMode === 'single'
                      ? '{}'
                      : '[]'
                    : typeof field.default === 'object'
                      ? JSON.stringify(field.default)
                      : String(field.default)
                  : field.currentValue;
              client.plugin = plugin;
              client.field = field;
              client.rows = JSON.parse(raw);
              client.original = JSON.stringify(client.rows);
              client.load = '';
            })
            .catch(function () {
              client.load = 'error';
            })
            .finally(function () {
              return chatDataRender();
            }),
        );
      });
  });
  function clientSettingsLoad() {
    const client = clientSettingsState();
    return client ? client.load : '';
  }
  function clientSettingsDirty(client) {
    return client.library.configurationMode === 'single'
      ? pcfDirty('mrt-c:' + client.key)
      : client.rows && JSON.stringify(client.rows) !== client.original;
  }
  function memberLoad() {
    const provider = providerState();
    return (provider ? provider.load : '') || clientSettingsLoad();
  }

  function clientFor(instance) {
    return draft().clients[instance.slice('mrt-c:'.length)];
  }
  function clientList(data, update) {
    const split = data.l.lastIndexOf('|'),
      instance = data.l.slice(0, split),
      path = data.l.slice(split + 1).split('#');
    const client = clientFor(instance),
      row = client.rows[+path[1]],
      items = (row[path[2]] || []).slice();
    update(items);
    row[path[2]] = items;
    render(true);
  }
  const pcfOp = A.pcfOp;
  A.pcfOp = async function (data) {
    const instance = data.p || (data.l && data.l.slice(0, data.l.lastIndexOf('|')));
    if (!instance || instance.indexOf('mrt-c:') !== 0) return pcfOp(data);
    if (clientFor(instance).library.configurationMode === 'single') return pcfOp(data);
    if (data.op === 'add' || data.op === 'del')
      return clientList(data, function (items) {
        if (data.op === 'add') items.push('');
        else items.splice(+data.i, 1);
      });
    const client = clientFor(instance);
    if (data.op === 'recCheck') {
      const row = client.rows[+data.i];
      (client.checks || (client.checks = {}))[row.id] = await pcfCheckRecord(row.bootstrapRoot);
    }
    if (data.op === 'recAdd') {
      const preset = client.library.presets.find(function (row) {
        return row.id === data.preset;
      });
      const profile = preset
        ? pdlClone(preset)
        : { id: 'client-' + crypto.randomUUID(), name: '', command: '', startupArgs: [] };
      let id = profile.id,
        n = 2;
      while (
        client.rows.some(function (row) {
          return row.id === id;
        })
      )
        id = profile.id + '-' + n++;
      profile.id = id;
      client.rows.push(profile);
    }
    if (data.op === 'recDel') client.rows.splice(+data.i, 1);
    render(true);
  };
  const pcfRecIn = INPUTS.pcfRecIn;
  INPUTS.pcfRecIn = function (e) {
    const target = e.target;
    if (target.dataset.p.indexOf('mrt-c:') !== 0) return pcfRecIn(e);
    if (clientFor(target.dataset.p).library.configurationMode === 'single') return pcfRecIn(e);
    const path = target.dataset.k.split('#');
    const row = clientFor(target.dataset.p).rows[+path[1]];
    if (path[2] === 'bootstrapRoot' && !target.value) delete row.bootstrapRoot;
    else row[path[2]] = target.value;
    render(true);
  };
  const pcfListIn = INPUTS.pcfListIn;
  INPUTS.pcfListIn = function (e) {
    const value = e.target.dataset.draft,
      split = value.lastIndexOf(':'),
      list = value.slice(0, split);
    if (list.indexOf('mrt-c:') !== 0) return pcfListIn(e);
    if (clientFor(list.slice(0, list.lastIndexOf('|'))).library.configurationMode === 'single') return pcfListIn(e);
    return clientList({ l: list }, function (items) {
      items[+value.slice(split + 1)] = e.target.value;
    });
  };
  A.pickTpl = async function (data) {
    const state = draft();
    try {
      state.form = await act('memberTemplate', { id: data.id, value: JSON.stringify(state.form) });
      tpl = data.id;
      render(true);
    } catch (error) {
      if (error.name !== 'PdlReadError') toast(error.message, null, 'danger');
    }
  };
  CHANGES.pickTpl = function (e) {
    return A.pickTpl({ id: e.target.value });
  };
  function chips(data) {
    const field = dlgFieldById(data.for);
    if (field && field.chips)
      return {
        values: field.chips.vals,
        put: function (values) {
          dlgSync();
          field.chips.vals = values;
          S.dialog.error = '';
        },
      };
    if (editor && data.k === 'aliases')
      return {
        values: editor.form.mentionPatterns
          .split(',')
          .map(function (v) {
            return v.trim();
          })
          .filter(Boolean),
        put: function (values) {
          editor.form.mentionPatterns = values.join(', ');
        },
      };
    return null;
  }
  A.chipAdd = function (data) {
    const target = chips(data);
    if (!target) return;
    let value = data.v.trim();
    if (data.kind === 'handle' && value[0] !== '@') value = '@' + value;
    if (target.values.indexOf(value) >= 0) return fieldErr(data.for + '-in', tc('memberForm.tags.err', value));
    target.put(target.values.concat([value]));
    render(true);
    focusField(data.for + '-in');
  };
  A.chipDel = function (data) {
    const target = chips(data);
    if (target) {
      target.put(
        target.values.filter(function (value) {
          return value !== data.v;
        }),
      );
      render(true);
    }
  };
  api.on('member:save', function (update) {
    if (!editor || editor.key !== update.key) return;
    const state = editor;
    state.saveState = update.state;
    state.saveError = update.error;
    state.pendingWrite = update.draft.pendingWrite || null;
    if (update.draft.baseline) {
      state.member = update.draft.baseline;
      state.revision = state.member.configurationRevision;
    }
    if (update.error === 'recovered_draft') {
      const form = pdlClone(update.draft.form);
      Object.keys(state.form).forEach(function (key) {
        if (JSON.stringify(state.form[key]) !== JSON.stringify(state.submitted[key])) form[key] = state.form[key];
      });
      state.form = form;
    }
    if (update.error && update.draft.baseline) {
      state.original = update.baselineForm;
      state.id = state.member.id;
      state.key = state.id;
      if (S.route === 'memberNew') go('member-' + state.id);
    }
    return chatDataRender();
  });
  FORMS.member = async function () {
    const state = draft();
    if (state.saveState !== 'idle') return;
    if (form().preferences && form().preferences.invalidEffort) return;
    state.submitted = pdlClone(state.form);
    state.saveState = state.pendingWrite ? 'checking' : 'saving';
    state.saveError = '';
    render(true);
    try {
      const client = clientSettingsState();
      if (client && clientSettingsDirty(client)) {
        client.plugin = await act('memberPluginSave', {
          plugin: JSON.stringify(client.plugin),
          key: client.library.configurationKey,
          value:
            client.library.configurationMode === 'single'
              ? pcfRaw('mrt-c:' + client.key, client.field.key)
              : JSON.stringify(client.rows),
          fixedClient: client.library.defaultClient ? JSON.stringify(client.library.defaultClient) : '',
        });
        client.original = client.plugin.configFields.find(function (field) {
          return field.key === client.library.configurationKey;
        }).currentValue;
        if (client.library.configurationMode === 'single') client.rows = JSON.parse(client.original);
      }
      const receipt = await act('memberSave', {
        id: state.id,
        expectedRevision: state.revision || '',
        value: JSON.stringify(state.submitted),
        shared:
          JSON.stringify(state.shared) !== JSON.stringify(state.sharedOriginal)
            ? JSON.stringify({
                sandboxMode: state.shared.sandboxMode,
                approvalPolicy: state.shared.approvalPolicy,
                baseline: state.sharedOriginal,
              })
            : '',
      });
      if (editor !== state) return;
      state.saveState = 'saving';
      const edited = JSON.stringify(state.form) !== JSON.stringify(state.submitted);
      state.id = receipt.id;
      state.key = receipt.id;
      state.member = receipt;
      state.revision = receipt.configurationRevision;
      state.original = state.submitted;
      state.sharedOriginal = pdlClone(state.shared);
      if (state.strategy && JSON.stringify(state.strategy) !== JSON.stringify(state.strategyOriginal)) {
        state.strategy = await act('memberStrategySave', { id: receipt.id, value: JSON.stringify(state.strategy) });
        state.strategyOriginal = pdlClone(state.strategy);
      }
      if (!edited) editor = null;
      await read();
      go('member-' + receipt.id);
    } catch (error) {
      if (!state.saveError) state.saveError = error.code || error.message;
    } finally {
      state.saveState = 'idle';
      if (editor === state) render(true);
    }
  };
  A.ownerOpen = function () {
    const owner = model().owner;
    let d = {
      kind: 'owner',
      args: {
        name: owner.name,
        nickname: owner.nickname || '',
        lead: { name: owner.name, color: owner.color && owner.color.primary },
        aliases: owner.aliases || [],
        tags: owner.mentionPatterns,
        avatar: owner.avatar,
      },
      on: async function () {
        const field = function (id) {
            return d.fields.find(function (f) {
              return f.id === id;
            });
          },
          primary = field('c1').value;
        if (!field('ow-name').value.trim()) throw new Error(tc('settings.notifications.emptyName'));
        if (!field('ow-tags').chips.vals.length) throw new Error(tc('settings.notifications.handleRequired'));
        const nickname = field('ow-nickname').value.trim();
        const body = {
          name: field('ow-name').value.trim(),
          aliases: field('ow-alias').chips.vals,
          mentionPatterns: field('ow-tags').chips.vals,
          avatar: field('ow-ava').value || owner.avatar || null,
          color: primary ? { primary: primary, secondary: owner.color ? owner.color.secondary : primary } : null,
        };
        if (nickname !== d.args.nickname) body.nickname = nickname || null;
        await act('ownerSave', { value: JSON.stringify(body) });
      },
    };
    dialog(d);
    d = S.dialog;
  };
  S.nativeSetup = null;
  beforeRender(function () {
    if (S.popOn.nativeSetup && !S.nativeSetup) A.nativeDetect({ refresh: false });
    if (!S.popOn.nativeSetup) S.nativeSetup = null;
  });
  A.nativeDetect = function (data) {
    const previous = S.nativeSetup;
    if (previous && previous.busy) return;
    const setup = (S.nativeSetup = {
      journeyId: previous ? previous.journeyId : crypto.randomUUID(),
      partners: [],
      busy: true,
      submitError: '',
      failedPartner: null,
    });
    return settleHold(
      act('nativeDetect', { journeyId: setup.journeyId, refresh: String(data.refresh !== false) })
        .then(
          function (partners) {
            if (S.nativeSetup === setup) setup.partners = partners;
          },
          function (error) {
            if (S.nativeSetup === setup) setup.submitError = error.message;
          },
        )
        .finally(function () {
          setup.busy = false;
          return chatDataRender();
        }),
    );
  };
  VM.nativeSetup = function () {
    const g = S.nativeSetup;
    if (!g) return null;
    return {
      items: g.partners.map(function (p) {
        return {
          id: p.id,
          name: p.form.displayName,
          runtime: p.runtime,
          selected: p.selected,
          existingId: p.existingId,
          selectable: p.selectable && !p.existingId && !p.identityConflict,
          payload: { defaultModel: p.form.defaultModel, cliEffort: p.form.cliEffort },
          fieldIds: {
            model: 'probe-' + p.id + '-model',

            effort: 'probe-' + p.id + '-effort',
          },
          adjusting: !!p.adjusting,
          get preferences() {
            return memberPreferences(p.form, runtimeCatalogState(p.form, '', p.runtime), p.runtime.acpMaxDefault);
          },
          state: p.existingId ? 'created' : p.identityConflict ? 'conflict' : p.selectable ? 'ready' : 'unavailable',
        };
      }),
      createDisabled:
        g.busy ||
        !g.partners.some(function (p) {
          return p.selected && p.selectable && !p.existingId && !p.identityConflict;
        }),
      hasMembers: cats().length > 0,
      submitError: g.submitError,
      failedPartner: g.failedPartner,
    };
  };
  A.nativeSelect = function (data) {
    const setup = S.nativeSetup;
    if (setup.busy) return;
    const partner = setup.partners.find(function (row) {
      return row.id === data.id;
    });
    partner.selected = !partner.selected;
    render(true);
  };
  A.nativeAdjust = function (d) {
    const partner = S.nativeSetup.partners.find(function (p) {
      return p.id === d.id;
    });
    partner.adjusting = !partner.adjusting;
    render(true);
  };
  INPUTS.nativePreference = CHANGES.nativePreference = function (e) {
    const partner = S.nativeSetup.partners.find(function (p) {
      return p.id === e.target.dataset.id;
    });
    partner.form[{ model: 'defaultModel', effort: 'cliEffort' }[e.target.dataset.k]] = e.target.value;
    if (e.target.dataset.k === 'model' && e.type === 'change' && listedModel(partner.form, '', partner.runtime))
      commitModel(partner.form);
    render(true);
  };
  A.nativeCreate = async function () {
    const setup = S.nativeSetup;
    if (setup.busy) return;
    setup.busy = true;
    setup.submitError = '';
    setup.failedPartner = null;
    render(true);
    let selected;
    // Two picked partners with the same name would make two members with one identity: refuse before any write.
    const names = setup.partners
      .filter(function (row) {
        return row.selected && row.selectable && !row.existingId && !row.identityConflict;
      })
      .map(function (row) {
        return (row.form.nickname || row.form.displayName).trim().normalize('NFKC').toLowerCase();
      });
    if (new Set(names).size !== names.length) {
      setup.busy = false;
      setup.submitError = tc('nativeSetup.conflict');
      render(true);
      return;
    }
    try {
      for (const partner of setup.partners.filter(function (row) {
        return row.selected && row.selectable && !row.existingId && !row.identityConflict;
      })) {
        selected = partner;
        const preference = memberPreferences(
          partner.form,
          runtimeCatalogState(partner.form, '', partner.runtime),
          partner.runtime.acpMaxDefault,
        );
        if ((partner.runtime.agyCarrier === 'native' && !partner.form.defaultModel.trim()) || preference.invalidEffort)
          throw new Error('runtime_preference_required');
        const cat = await act('nativeCreate', { journeyId: setup.journeyId, value: JSON.stringify(partner) });
        partner.existingId = cat.id;
      }
      await read();
    } catch (error) {
      setup.submitError = error.message;
      setup.failedPartner = { name: selected.form.displayName, client: selected.runtime.label };
    } finally {
      setup.busy = false;
      render(true);
    }
  };
  A.memberCloudRestore = async function () {
    const state = draft();
    try {
      const receipt = await act('memberCloudRestore', { id: state.id, expectedRevision: state.revision });
      state.member = receipt;
      state.revision = receipt.configurationRevision;
      state.form = pdlClone(receipt.form);
      state.original = pdlClone(receipt.form);
      state.saveError = '';
    } catch (error) {
      state.saveError = error.code || error.message;
    }
    render(true);
  };
  A.canonAvatarOpen = function (data) {
    const c = meta.canon;
    dialog({
      kind: 'canonAvatar',
      args: {
        current: c.current,
        versions: c.versions.map(function (v) {
          return Object.assign({}, v, { superseded: !!v.supersededReason });
        }),
      },
      on: function () {
        return A.canonAvatar({ id: data.id, version: picked('canon-v'), reason: val('dlg-in') }, fileOf('canon-file'));
      },
    });
  };
  A.canonAvatar = async function (data, file) {
    const c = meta.canon,
      reason = data.reason.trim();
    if (!reason) throw new Error(tc('hub.detail.reason'));
    const selected = c.versions.find(function (v) {
      return v.id === data.version;
    });
    if (!file && !selected) throw new Error(tc('common.select'));
    const body = { operationId: crypto.randomUUID(), reason: reason, expectedBindingRevision: c.bindingRevision };
    if (!file) {
      body.indexedVersionRef = selected.id;
      body.expectedAssetRevision = selected.assetRevision;
    }
    meta.canon = await act('memberCanonSave', { id: data.id, value: JSON.stringify(body) }, file);
    editor.form.avatar = editor.original.avatar = meta.canon.avatar;
    editor.revision = cats().find(function (cat) {
      return cat.id === data.id;
    }).configurationRevision;
    render(true);
  };
  document.addEventListener('change', async function (e) {
    const target = e.target;
    if (
      target.type === 'file' &&
      target.files &&
      target.files[0] &&
      memberFields[target.dataset.k] === 'voiceRefAudio' &&
      target.closest('#mform')
    ) {
      const editing = editor;
      try {
        const receipt = await act('memberRefAudioUpload', {}, target);
        editing.form.voiceRefAudio = receipt.url;
        render(true);
      } catch (error) {
        toast(error.message, null, 'danger');
      }
      return;
    }
    if (target.type !== 'file' || !target.files || !target.files[0] || !target.closest('.ava-up')) return;
    const owner =
      S.dialog &&
      S.dialog.fields &&
      S.dialog.fields.find(function (row) {
        return row.id === 'ow-ava';
      });
    const editing = editor;
    if (!owner && (!editor || !target.closest('#mform'))) return;
    try {
      const url = await act('avatarUpload', {}, target);
      if (owner) {
        owner.value = url;
        owner.avatar.lead.avatarPath = api.file(url);
      } else editing.form.avatar = url;
      render(true);
    } catch (error) {
      if (owner) dlgError(error.message);
      else toast(error.message, null, 'danger');
    }
  });
}
