/* Project-owned package declarations. Rendering stays in the existing PDL tables and page.plug. */
'use strict';
function bindPluginSpaces() {
  let fragments = {},
    loaded = false,
    started = false;
  // plugin id → the fragment it is registered with: install, update and uninstall re-register only what changed
  const registered = {};
  let companion = { load: 'loading' };
  const pluginRows = function () {
    return placementData().plugins ? placementData().plugins.plugins : [];
  };
  const mutationErrors = {};
  // Install / update / uninstall in flight, per plugin: the button itself shows it until the request settles.
  const ops = {};
  function pluginOp(id, op, request) {
    ops[id] = op;
    mutationErrors[id] = '';
    render(true);
    request
      .catch(function (error) {
        mutationErrors[id] = error.message;
        return read();
      })
      .then(function () {
        delete ops[id];
        render(true);
      });
  }
  // The plugin list is always read (entries follow it); a pushed operation change re-reads it.
  api.on('cat-cafe:plugin-operation-changed', function () {
    settleHold(read());
  });
  function opOf(plugin) {
    return ops[plugin.pluginId] || plugin.operation;
  }
  WHO_DATA.plugins = function () {
    return Object.fromEntries(
      pluginRows().map(function (plugin) {
        return [plugin.pluginId, { name: plugin.displayName, icon: plugin.icon, instanceId: plugin.pluginInstanceId }];
      }),
    );
  };
  async function readDetail(id) {
    try {
      await chatPort.action('settingsPluginDetailRead', { id: id });
      dataOk('plugin:' + id);
    } catch (error) {
      dataError('plugin:' + id, error);
    }
    await chatDataRender();
  }
  function choose(matches) {
    const selected = S.route === 'extItem' ? S.param : S.extSel;
    return (
      matches.find(function (plugin) {
        return plugin.pluginId === selected;
      }) || matches[0]
    );
  }
  A.companionRead = async function () {
    try {
      companion = Object.assign({ load: '' }, await api.get('/api/concierge/desktop'));
    } catch (error) {
      companion = { load: 'error' };
    }
    await chatDataRender();
  };
  A.companionRestore = async function (d) {
    if (d.lossId !== companion.lossId || !companion.desktopLost) return;
    try {
      const receipt = await api.post('/api/concierge/desktop/show', {}, {});
      if (!receipt.presence || receipt.presence.state !== 'visible' || receipt.presence.maxAgeMs <= 0) {
        companion.load = 'error';
        return;
      }
      companion = Object.assign({ load: '' }, receipt);
    } catch (error) {
      companion.load = 'error';
    } finally {
      render(true);
    }
  };
  api.on('sources:needed', function (diff) {
    if (diff.added.indexOf('companion') >= 0) settleHold(A.companionRead());
    diff.added.forEach(function (name) {
      if (name.indexOf('pluginDetail:') === 0) settleHold(readDetail(name.slice(13)));
      if (name.indexOf('pluginTools:') === 0) settleHold(chatAction('settingsPluginToolsRead', { id: name.slice(12) }));
    });
  });
  function config(plugin) {
    if (projectionNeeded) projectionNeeded.add('pluginDetail:' + plugin.pluginId);
    const detail = placementData().pluginDetails[plugin.pluginId],
      inst = plugin.pluginId;
    if (!detail) return null;
    const fields = detail.configFields,
      steps = (detail.steps || detail.setupSteps || []).map(function (step) {
        return typeof step === 'string' ? { text: step } : step;
      });
    if (!fields.length && !steps.length && !detail.testable) return null;
    return {
      p: inst,
      test: plugin.artifact === 'installed' && !!detail.testable,
      tested: !!pcfState(inst).tested,
      form: pcfModel(inst, {
        plugin: inst,
        clientLibraries: placementData().pluginLibraries[inst],
        fields: fields,
        steps: steps,
        installed: plugin.artifact === 'installed',
        refresh: function () {
          return readDetail(inst);
        },
        save: async function (updates) {
          const receipt = await api.post(
            '/api/plugin-manager/plugins/' + encodeURIComponent(inst) + '/contributions/configuration',
            {},
            { expectedRevision: detail.lifecycleRevision, updates: updates },
          );
          await read();
          await readDetail(inst);
          if (receipt.warning) toast(receipt.warning, null, 'warn');
        },
      }),
      save: { dirty: pcfDirty(inst) },
    };
  }
  S.plugins = {};
  function receivePlugins(rows) {
    S.plugins = {};
    rows.forEach(function (plugin) {
      S.plugins[plugin.pluginId] = { installed: plugin.artifact === 'installed', on: plugin.intent === 'enabled' };
    });
  }
  async function read() {
    try {
      await chatPort.action('settingsPluginsRead', {});
      receivePlugins(placementData().plugins.plugins);
      fragments = placementData().pluginFragments;
      loaded = true;
      if (started && register()) render();
      dataOk('plugins');
    } catch (error) {
      fragments = {};
      S.plugins = {};
      loaded = false;
      dataError('plugins', error);
    }
  }
  onStart('data', read);
  // A plugin's contributions that did not take effect in this theme (host key, missed insert)
  function skipLines(id) {
    const lines = (PDL_SLOT_REJECTS[id] || [])
      .map(function (x) {
        return { key: x.key, path: [x.slot], reason: x.reason || 'host' };
      })
      .concat(
        (PDL_INSERT_SKIPS[id] || []).map(function (x) {
          return { key: x.id, path: [x.anchor], reason: x.reason };
        }),
      );
    return lines.length ? lines : null;
  }
  function register() {
    let changed = false;
    Object.keys(registered).forEach(function (id) {
      if (registered[id] === JSON.stringify(fragments[id])) return;
      pdlUnregister(id);
      delete registered[id];
      changed = true;
    });
    Object.keys(fragments).forEach(function (id) {
      const plugin = pluginRows().find(function (item) {
        return item.pluginId === id;
      });
      if (registered[id] || !plugin) return;
      registered[id] = JSON.stringify(fragments[id]);
      pdlRegister(JSON.parse(registered[id]), id, plugin); // registration tags what it reads: keep the read fragment as read
      frames(id);
      changed = true;
    });
    return changed;
  }
  onStart('pdl', function () {
    started = true;
    register();
  });
  // A registered plugin is its index; the engine reads its subtree the first time one of its nodes is projected.
  ENGINE_PARTS.pluginLoad = function (id) {
    return api.get('/api/plugin-manager/pdl/' + encodeURIComponent(id));
  };
  function frameNodes() {
    return Object.keys(PDL_VIEWS).filter(function (key) {
      return PDL_VIEWS[key].type === 'frame';
    });
  }
  function frames(id) {
    Object.keys(fragments[id].views || {}).forEach(function (key) {
      const frame = PDL_VIEWS[key];
      if (frame.type !== 'frame') return;
      // Whether it opens as a tab is decided by the entry that opens it (pdlOpenOf); this only gives the content
      PANELS[key] = function () {
        return pdlView('page.plug');
      };
      if (!frame.route) return;
      PAGES[frame.route] = function () {
        S.plugKey = id;
        return pdlView('page.plug');
      };
    });
  }
  VM.plug = function () {
    if (projectionNeeded && S.route === 'companion') projectionNeeded.add('companion');
    const tabFrame = frameNodes().find(function (key) {
      return PV.tabKey === key;
    });
    const plugin = pluginRows().find(function (item) {
      return item.pluginId === (tabFrame ? PDL_VIEWS[tabFrame].plugin : S.plugKey);
    });
    if (!plugin || !plugOn(plugin.pluginId)) return null;
    const key = frameNodes().find(function (k) {
        const value = PDL_VIEWS[k];
        return value.plugin === plugin.pluginId && (tabFrame ? k === tabFrame : value.route === S.route);
      }),
      frame = key && PDL_VIEWS[key].src ? PDL_VIEWS[key] : null;
    // The frame on screen is a source: a plugin whose frame address comes from its own request reads it then.
    if (key && projectionNeeded) projectionNeeded.add('node:' + key);
    return {
      load: S.route === 'companion' ? companion.load : '',
      frame:
        S.route === 'companion'
          ? {
              state: companion.desktopLost ? 'lost' : '',
              canRestore: !!companion.desktopLost,
              lossId: companion.lossId,
            }
          : null,
      src: frame ? api.file(frame.src) : null,
      name: plugin.displayName,
      key: plugin.pluginId,
      to: 'extItem-' + plugin.pluginId,
    };
  };
  VM.ext = function () {
    if (!loaded) return null;
    const query = S.extQuery || '';
    const matches = pluginRows().filter(function (plugin) {
      return (plugin.displayName + ' ' + plugin.pluginId).toLowerCase().indexOf(query.toLowerCase()) >= 0;
    });
    const chosen = choose(matches),
      selected = chosen && row(chosen);
    return {
      q: query,
      picked: S.route === 'extItem',
      groups: [
        {
          kind: 'installed',
          items: matches
            .filter(function (plugin) {
              return plugin.artifact === 'installed';
            })
            .map(row),
        },
        {
          kind: 'notInstalled',
          items: matches
            .filter(function (plugin) {
              return plugin.artifact !== 'installed';
            })
            .map(row),
        },
      ],
      sel: chosen
        ? {
            key: chosen.pluginId,
            name: chosen.displayName,
            icon: chosen.icon,
            publisher: chosen.publisher,
            repositoryName:
              chosen.source.kind === 'git' && chosen.source.marketplace ? chosen.source.marketplace.sourceId : '',
            trust: chosen.source.trust,
            closure: chosen.source.dependencyClosure,
            version: chosen.installedVersion || chosen.availableVersion,
            pkg: chosen.source.packageName || '',
            desc: description(chosen),
            canRestart: !!chosen.actions.repair,
            need: selected.need,
            blocked: S.extBlocked === chosen.pluginId && chosen.config !== 'ready',
            needs: chosen.actions.blockingReasons,
            diag: chosen.diagnostic ? chosen.diagnostic.message : '',
            installed: chosen.artifact === 'installed',
            on: chosen.intent === 'enabled',
            canInstall: selected.canInstall,
            installing: selected.installing,
            updating: selected.updating,
            uninstalling: opOf(chosen) === 'uninstall',
            config: config(chosen),
            hasContrib: !!(
              placementData().pluginDetails[chosen.pluginId] &&
              placementData().pluginDetails[chosen.pluginId].contributions
            ),
            docs: pluginDocs(chosen),
            skips: skipLines(chosen.pluginId),
            connection: null,
            mutationError: mutationErrors[chosen.pluginId] || '',
            bindings: (placementData().pluginDetails[chosen.pluginId]?.bindings || []).map(function (b) {
              return {
                key: b.key,
                title: b.threadTitle || b.threadId,
                sub: b.key,
                args: { pluginId: chosen.pluginId, key: b.key, threadId: b.threadId, createdAt: b.createdAt },
              };
            }),
            address: addressVM(chosen),
            permissions:
              chosen.artifact === 'installed' && placementData().pluginDetails[chosen.pluginId]?.permissions
                ? pluginPermissionsVM(chosen.pluginId, placementData().pluginDetails[chosen.pluginId].permissions.label)
                : null,
          }
        : null,
    };
  };
  // The instance's address (@alias and avatar): editable presentation of this host, not package configuration.
  function addressVM(plugin) {
    const detail = placementData().pluginDetails[plugin.pluginId],
      address = detail && detail.address;
    return address
      ? {
          alias: address.alias,
          custom: !!address.icon,
          who: { kind: 'plugin', id: plugin.pluginId, icon: address.icon ? api.file(address.icon) : undefined },
          off: plugin.intent !== 'enabled',
          args: { p: plugin.pluginId, inst: plugin.pluginInstanceId },
        }
      : null;
  }
  async function addressSave(d, patch) {
    const address = placementData().pluginDetails[d.p].address;
    try {
      await api.post(
        '/api/plugin-manager/instances/' + encodeURIComponent(d.inst) + '/address',
        { method: 'PATCH' },
        Object.assign({ alias: address.alias, icon: address.icon || null, expectedRevision: address.revision }, patch),
      );
    } catch (error) {
      const code = error.status === 403 ? 'forbidden' : error.code;
      const why = tcOf('ext.address.error', code);
      toast(why === 'ext.address.error.' + code ? tc('ext.address.error.unknown') : why, null, 'danger');
      return false;
    }
    window.dispatchEvent(new Event('plugin-targets-changed'));
    await readDetail(d.p);
    toast(tc('ext.address.saved', patch.alias || address.alias));
    return true;
  }
  A.pluginAliasSave = function (d) {
    const alias = (document.getElementById('plugin-alias').value || '').trim().replace(/^@/, '');
    if (!alias) {
      toast(tc('ext.address.error.empty'), null, 'danger');
      return false;
    }
    return addressSave(d, { alias: alias });
  };
  A.pluginIconReset = function (d) {
    return addressSave(d, { icon: null });
  };
  // A new avatar: the same uploadable avatar as the member form; choosing a picture saves it.
  CHANGES.pluginIcon = async function (e) {
    const target = e.target;
    if (!target.files || !target.files[0]) return;
    try {
      const url = await chatPort.action('avatarUpload', {}, target);
      await addressSave({ p: target.dataset.p, inst: target.dataset.inst }, { icon: url });
    } catch (error) {
      toast(error.message, null, 'danger');
    }
  };
  function description(plugin) {
    return plugin.description === undefined ? '' : plugin.description;
  }
  function pluginDocs(plugin) {
    const owner = placementData(),
      detail = owner.pluginDetails[plugin.pluginId];
    if (!detail) return null;
    const active = plugin.intent === 'enabled' && (plugin.live === 'running' || plugin.live === 'degraded');
    const items = detail.contributions || detail.capabilities,
      kinds = {
        skill: 'skills',
        mcp: 'mcps',
        schedule: 'scheduler',
        'content-editor-provider': 'editor',
        'desktop-window': 'desktop',
      };
    const groups = new Map();
    items.forEach(function (capability) {
      if (active && projectionNeeded) projectionNeeded.add('pluginTools:' + plugin.pluginId);
      const kind = kinds[capability.kind] || capability.kind;
      if (!groups.has(kind)) groups.set(kind, { kind: kind, scheduler: kind === 'scheduler', items: [] });
      groups.get(kind).items.push({
        key: capability.id,
        kind: kind,
        is: { [kind]: true },
        titleMode: 'plain',
        title: capability.name,
        sub: capability.description,
        installed: plugin.artifact === 'installed',
        tools: (active ? owner.pluginTools[plugin.pluginId] || [] : [])
          .filter(function (tool) {
            return tool.contributionId === capability.id;
          })
          .map(function (tool) {
            return tool.name;
          }),
      });
    });
    return {
      readme: owner.pluginDocumentation[plugin.pluginId]
        ? owner.pluginDocumentation[plugin.pluginId].readmeMarkdown
        : '',
      docsUrl: detail.docsUrl,
      provides: groups.size ? Array.from(groups.values()) : null,
    };
  }
  function row(plugin) {
    const installed = plugin.artifact === 'installed',
      need = !installed
        ? ''
        : plugin.actions.install
          ? 'update'
          : plugin.config === 'incomplete' || plugin.config === 'invalid'
            ? 'config'
            : ['disconnected', 'expired', 'error'].includes(plugin.auth)
              ? 'auth'
              : plugin.live === 'crashed' || plugin.live === 'degraded'
                ? plugin.live
                : '';
    return {
      need: need,
      update: need === 'update',
      needStatus: !!need && need !== 'update',
      key: plugin.pluginId,
      icon: plugin.icon,
      name: plugin.displayName,
      desc: description(plugin),
      pub: plugin.publisher,
      plugin: true,
      installed: installed,
      on: plugin.intent === 'enabled',
      canInstall: !installed && plugin.actions.install,
      installing: opOf(plugin) === 'install',
      updating: opOf(plugin) === 'update',
      selected: (S.route === 'extItem' ? S.param : S.extSel) === plugin.pluginId,
      to: 'extItem-' + plugin.pluginId,
    };
  }
  PAGES.ext = PAGES.extItem = function () {
    return pdlView('page.ext');
  };

  INPUTS.extQ = function (event) {
    S.extQuery = event.target.value;
    render(true);
  };
  A.pcfTest = function (data) {
    pcfState(data.p).tested = '';
    return chatAction('pluginTest', { id: data.p }).then(function (result) {
      if (result !== false) {
        pcfState(data.p).tested = result.message;
        render(true);
      }
    });
  };
  A.capRestart = async function (d) {
    try {
      await chatPort.action('settingsPluginRestart', { id: d.k });
      receivePlugins(placementData().plugins.plugins);
      detailReads[d.k] = placementData().pluginDetails[d.k].lifecycleRevision;
      mutationErrors[d.k] = '';
      return true;
    } catch (error) {
      mutationErrors[d.k] = error.message;
      return false;
    } finally {
      render(true);
    }
  };
  A.pluginDisconnect = function (d) {
    const dd = {
      kind: 'pluginDisconnect',
      args: { key: d.key },
      on: async function () {
        try {
          await chatPort.action('settingsPluginDisconnect', {
            id: d.pluginId,
            key: d.key,
            threadId: d.threadId,
            createdAt: d.createdAt,
          });
          receivePlugins(placementData().plugins.plugins);
          detailReads[d.pluginId] = placementData().pluginDetails[d.pluginId].lifecycleRevision;
          render(true);
        } catch (error) {
          dd.error = error.message;
          dialog(dd);
          return false;
        }
      },
    };
    return dialog(dd);
  };
  A.capUpdate = function (d) {
    const plugin = pluginRows().find(function (p) {
      return p.pluginId === d.k;
    });
    return dialog({
      kind: 'pluginUpdate',
      args: { name: plugin.displayName, version: plugin.availableVersion, on: plugin.intent === 'enabled' },
      on: function () {
        pluginOp(
          d.k,
          'update',
          api
            .post(
              '/api/plugin-manager/plugins/' + encodeURIComponent(d.k) + '/update',
              {},
              { expectedVersion: plugin.availableVersion, expectedRevision: plugin.lifecycleRevision },
            )
            .then(read),
        );
      },
    });
  };
  A.install = function (d) {
    const plugin = pluginRows().find(function (p) {
      return p.pluginId === d.k;
    });
    if (plugin.artifact === 'installed') return A.capUpdate(d);
    const input =
      plugin.source.kind === 'git'
        ? { source: { kind: 'git', url: plugin.source.url, marketplace: plugin.source.marketplace } }
        : {
            source: { kind: 'catalog', catalogId: plugin.source.catalogId },
            expectedVersion: plugin.availableVersion,
            expectedDigest: plugin.packageDigest,
          };
    return dialog({
      kind: 'pluginInstall',
      args: {
        name: plugin.displayName,
        publisher: plugin.publisher,
        version: plugin.availableVersion,
        customLabel: false,
        provides: plugin.capabilitySummary.map(function (c) {
          return { kind: c.kind, items: [{ title: c.name, titleMode: 'plain' }] };
        }),
      },
      on: function () {
        pluginOp(
          d.k,
          'install',
          chatPort.action('settingsPluginInstall', { value: JSON.stringify(input) }).then(function () {
            receivePlugins(chatDataSnapshot.project.settings.plugins.plugins);
          }),
        );
      },
    });
  };
  A.installFile = function () {
    let input = null;
    CHANGES.capFile = function (e) {
      input = e.target;
    };
    return dialog({
      kind: 'pluginFile',
      on: async function () {
        await chatPort.action('pluginArchive', {}, input);
        await read();
      },
    });
  };

  A.togglePlugin = async function (data) {
    const plugin = pluginRows().find(function (item) {
      return item.pluginId === data.k;
    });
    if (!plugin || !plugin.actions.setEnabled) return;
    await api.post(
      '/api/plugin-manager/plugins/' + encodeURIComponent(data.k) + '/set-enabled',
      {},
      {
        enabled: plugin.intent !== 'enabled',
        expectedRevision: plugin.lifecycleRevision,
      },
    );
    await read();
    if (!plugOn(data.k)) {
      pluginPopsClose(data.k);
      frameNodes().forEach(function (key) {
        if (PDL_VIEWS[key].plugin === data.k) nodeClose(key);
      });
    }
    pdlThemeSync();
    render(true);
  };
  const market = {
    q: '',
    kind: 'all',
    eco: 'all',
    trust: 'all',
    results: [],
    sources: [],
    load: '',
    error: '',
    selected: '',
    plan: null,
    read: false,
  };
  const marketKinds = ['mcp_server', 'skill', 'plugin', 'app', 'bundle', 'pack'];
  async function marketRead() {
    market.read = true;
    market.load = 'loading';
    market.error = '';
    market.plan = null;
    chatDataRender();
    const params = { q: market.q };
    if (market.kind !== 'all') params.artifactKinds = market.kind;
    if (market.eco !== 'all') params.ecosystems = market.eco;
    if (market.trust !== 'all') params.trustLevels = market.trust;
    try {
      const result = await api.get('/api/marketplace/search', params);
      market.results = result.results;
      market.sources = result.sources;
      market.load = '';
    } catch (error) {
      market.results = [];
      market.load = 'error';
      market.error = error.message;
    }
    await chatDataRender();
  }
  const marketKey = function (r) {
    return JSON.stringify([r.ecosystem, r.artifactId]);
  };
  async function marketSelect(key) {
    market.selected = key;
    market.plan = null;
    const result = market.results.find(function (r) {
      return marketKey(r) === key;
    });
    if (!result) return;
    try {
      market.plan = (
        await api.post(
          '/api/marketplace/install/plan',
          {},
          { ecosystem: result.ecosystem, artifactId: result.artifactId },
        )
      ).plan;
      market.error = '';
    } catch (error) {
      market.error = error.message;
    }
    await chatDataRender();
  }
  api.on('sources:needed', function (diff) {
    if (diff.added.indexOf('market') >= 0) settleHold(marketRead());
    diff.added.forEach(function (name) {
      if (name.indexOf('marketItem:') === 0) settleHold(marketSelect(name.slice(11)));
    });
  });
  PAGES.market = PAGES.marketItem = function () {
    return pdlView('page.market');
  };
  INPUTS.mkQ = function (e) {
    market.q = e.target.value;
    return marketRead();
  };
  ['Kind', 'Eco', 'Trust'].forEach(function (name) {
    CHANGES['mk' + name] = function (e) {
      market[name.toLowerCase()] = e.target.value;
      return marketRead();
    };
  });
  A.mkRefresh = async function () {
    await api.post('/api/plugin-manager/marketplaces/refresh', {}, {});
    await read();
    return marketRead();
  };

  A.mkCopy = function () {
    const p = market.plan;
    return copyText(p.mode === 'delegated_cli' ? p.delegatedCommand : JSON.stringify(p.mcpEntry, null, 2));
  };
  VM.market = function () {
    if (projectionNeeded) {
      projectionNeeded.add('market');
      if (S.route === 'marketItem') projectionNeeded.add('marketItem:' + S.param);
    }
    const result = market.results.find(function (r) {
        return marketKey(r) === market.selected;
      }),
      p = market.plan;
    return {
      q: market.q,
      kind: market.kind,
      eco: market.eco,
      trust: market.trust,
      picked: S.route === 'marketItem',
      listLoad: market.load,
      kinds: marketKinds.map(function (v) {
        return { v: v };
      }),
      ecos: ['claude', 'codex', 'openclaw', 'antigravity'].map(function (v) {
        return { v: v };
      }),
      trusts: ['official', 'verified', 'community'].map(function (v) {
        return { v: v };
      }),
      sources: market.sources
        .filter(function (s) {
          return s.availability !== 'live' && (market.eco === 'all' || s.ecosystem === market.eco);
        })
        .map(function (s) {
          return { availability: s.availability, eco: s.ecosystem, issues: s.issues };
        }),
      groups: [true, false].map(function (installed) {
        return {
          kind: installed ? 'installed' : 'available',
          items: market.results
            .filter(function (r) {
              return !!(r.lifecycle && r.lifecycle.installed) === installed;
            })
            .map(function (r) {
              return {
                key: marketKey(r),
                name: r.displayName,
                kind: r.artifactKind,
                kindIs: { [r.artifactKind]: true },
                trustIs: { [r.trustLevel]: true },
                desc: r.componentSummary,
                eco: r.ecosystem,
                pub: r.publisherIdentity,
                to: 'marketItem-' + marketKey(r),
              };
            }),
        };
      }),
      sel: result
        ? {
            key: marketKey(result),
            name: result.displayName,
            desc: result.componentSummary,
            kind: result.artifactKind,
            eco: result.ecosystem,
            availability: market.sources.find(function (source) {
              return source.ecosystem === result.ecosystem;
            }).availability,
            installed: !!(result.lifecycle && result.lifecycle.installed),
            trust: result.trustLevel,
            pub: result.publisherIdentity,
            version: result.versionRef,
            mode: p && p.mode,
            modeIs: p ? { [p.mode]: true } : {},
            canInstall: !!p,
            where: null,
            loc: result.sourceLocator,
            // The owner's MCP entry as the item shows it: transport, address, command line (command + args).
            mcp:
              p && p.mcpEntry
                ? {
                    t: p.mcpEntry.url ? 'http' : 'stdio',
                    http: !!p.mcpEntry.url,
                    url: p.mcpEntry.url,
                    command: p.mcpEntry.command ? [p.mcpEntry.command].concat(p.mcpEntry.args || []) : [],
                  }
                : null,
            planText: p && p.delegatedCommand,
            url: result.docsUrl,
            showSource: true,
            steps: p && p.manualSteps,
          }
        : null,
    };
  };
  // Uninstall uses the same entity confirmation/promise protocol as every other owner.
  ENT.plugin = {
    get: function (id) {
      return pluginRows().find(function (item) {
        return item.pluginId === id;
      });
    },
    name: 'displayName',
    confirm: function (plugin) {
      const caps = plugin.capabilitySummary.some(function (c) {
          return c.kind === 'skill' || c.kind === 'mcp';
        }),
        entry = ((fragments[plugin.pluginId] || {}).inserts || [])
          .map(function (x) {
            return pdlEntry('plugin:' + plugin.pluginId + '/' + x.id);
          })
          .find(function (e) {
            const o = e && pdlOpenOf(e.id);
            return o && o.target === ctPages();
          });
      return {
        kind: 'pluginUninstall',
        args: {
          name: plugin.displayName,
          effect: caps ? (entry ? 'caps_entry' : 'caps') : entry ? 'entry' : 'none',
          entryLabel: entry ? entry.title : '',
        },
      };
    },
    remove: function (plugin) {
      if (!plugin.actions.uninstall) return false;
      pluginOp(
        plugin.pluginId,
        'uninstall',
        api
          .post(
            '/api/plugin-manager/plugins/' + encodeURIComponent(plugin.pluginId) + '/uninstall',
            {},
            { expectedRevision: plugin.lifecycleRevision },
          )
          .then(read)
          .then(function () {
            pluginPopsClose(plugin.pluginId);
            frameNodes().forEach(function (key) {
              if (PDL_VIEWS[key].plugin === plugin.pluginId) nodeClose(key);
            });
            pdlThemeSync();
          }),
      );
    },
  };
}
