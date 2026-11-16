'use strict';
function bindCapabilities() {
  let board = null,
    skills = [],
    rules = null,
    load = 'loading',
    skillDoc = null,
    preview = null,
    original = null;
  const syncReads = {};
  S.project = 'default';
  S.skillCat = 'all';
  S.skillQuery = '';
  S.skillFilter = 'all';
  S.mcpQuery = '';
  S.mcpSrc = 'all';
  S.mcpFilter = 'all';
  S.mcpDraft = null;
  S.mcpProbe = {};
  S.mcpErr = '';
  const isDef = function () {
    return S.project === 'default';
  };
  const query = function () {
    return isDef() ? {} : { projectPath: S.project };
  };
  const items = function (type) {
    return board
      ? board.items.filter(function (item) {
          return item.type === type;
        })
      : [];
  };
  function selected(type) {
    return items(type)[+S.param];
  }
  async function read() {
    load = 'loading';
    try {
      const values = await Promise.all([
        api.get('/api/capabilities', query()),
        api.get('/api/skills', query()),
        api.get('/api/mount-rules', Object.assign({}, query(), isDef() ? { scope: 'default' } : {})),
      ]);
      board = values[0];
      skills = values[1].skills;
      rules = values[2].rules;
      load = '';
      dataOk('capabilities');
      await Promise.all(
        Object.keys(syncReads)
          .filter((key) => heldNeeded.has(key))
          .map((key) => readSync(key)),
      );
    } catch (error) {
      load = 'error';
      dataError('capabilities', error);
    }
    await chatDataRender();
  }
  api.on('sources:needed', function (diff) {
    if (diff.added.indexOf('capabilities:' + S.project) >= 0) settleHold(read());
    diff.added.filter((key) => key.startsWith('capDrift:')).forEach((key) => settleHold(readSync(key)));
    diff.added.forEach(function (name) {
      if (name.indexOf('skillDoc:') !== 0) return;
      skillDoc = null;
      settleHold(
        api.get('/api/rules/skill/' + encodeURIComponent(name.slice(9)), query()).then(function (value) {
          skillDoc = value;
          return chatDataRender();
        }),
      );
    });
  });
  ['skills', 'skill'].forEach(function (k) {
    PAGES[k] = function () {
      return pdlView('page.skills');
    };
  });
  ['mcp', 'mcpItem', 'mcpNew'].forEach(function (k) {
    PAGES[k] = function () {
      return pdlView(k === 'mcpNew' ? 'page.mcpNew' : 'page.mcp');
    };
  });
  function scopeVM() {
    if (projectionNeeded) projectionNeeded.add('capabilities:' + S.project);
    return {
      global: isDef(),
      readState: load,
      projectScope: isDef() ? board && (board.knownProjectPaths || [])[0] : S.project,
      scopeV: S.project,
      projects: (board ? board.knownProjectPaths : []).map(function (path) {
        return { id: path, path: path, name: new Map(sidebarData().projectNames).get(path) || path };
      }),
    };
  }
  function issues(item) {
    return (item.requiresMcp || [])
      .filter(function (d) {
        return d.status !== 'ready';
      })
      .map(function (d) {
        return { code: 'dep', id: d.id, state: d.status };
      });
  }
  function list(type) {
    const all = items(type),
      q = type === 'skill' ? S.skillQuery : S.mcpQuery;
    return all
      .filter(function (item) {
        return (
          (item.id + (item.description || '')).toLowerCase().indexOf(q.toLowerCase()) >= 0 &&
          (type !== 'skill' || S.skillCat === 'all' || item.category === S.skillCat) &&
          (type !== 'mcp' || S.mcpSrc === 'all' || item.source === (S.mcpSrc === 'builtin' ? 'cat-cafe' : S.mcpSrc)) &&
          ((type === 'skill' ? S.skillFilter : S.mcpFilter) !== 'bad' || issues(item).length)
        );
      })
      .map(function (item) {
        const index = all.indexOf(item);
        return {
          category: item.category,
          issue: issues(item)[0],
          foldKey: 'v2-' + type + '-' + item.id,
          expanded: !!S.folds['v2-' + type + '-' + item.id],
          ...(type === 'skill'
            ? skillFields(item)
            : {
                index: index,
                editable: item.source === 'external' && !item.pluginId,
                managed: !!item.accessManagedByPlugin,
                pluginId: item.pluginId,
                transport: item.mcpServer && (item.mcpServer.transport || 'stdio'),
                cats: Object.entries(item.cats).map(([id, on]) => ({
                  name: pdlReads('who').member(id).name,
                  on,
                  key: item.id + '|' + id,
                })),
              }),
          skill: type === 'skill',
          mcp: type === 'mcp',
          on: item.enabled,
          selected: all.indexOf(item) === +S.param,
          ov: item.hasOverride ? (isDef() ? 'default' : 'project') : '',
          resetScope: item.hasOverride ? type + '.' + item.id : '',
          key: item.id,
          name: item.id,
          desc: item.description,
          to: type === 'skill' ? 'skill-' + index : 'mcpItem-' + index,
        };
      });
  }
  function syncKey(kind) {
    return 'capDrift:' + kind + ':' + S.project;
  }
  async function checkDrift(kind, scope) {
    const scopes = scope === 'default' ? ['default'].concat(board.knownProjectPaths || []) : [scope];
    const results = await Promise.all(
      scopes.map(async (path) => {
        const params = Object.assign({ type: kind }, path === 'default' ? {} : { projectPath: path });
        return { scope: path, params, result: await api.post('/api/drift/check', {}, params) };
      }),
    );
    return results.filter(
      (row, i) => results.findLastIndex((r) => r.result.projectRoot === row.result.projectRoot) === i,
    );
  }
  function driftModel(kind, scope, results) {
    const projects = results.filter((r) => r.result.result.issues.length),
      nodes = { '': [] };
    projects.forEach((row) => {
      const children = row.result.result.issues.map((i) => ({ name: i.id, issue: i.issueType, text: i.message }));
      nodes[''].push({
        id: row.scope,
        name: row.scope,
        path: row.result.projectRoot,
        home: row.scope === 'default',
        children,
      });
      nodes[row.result.projectRoot] = children;
    });
    return {
      k: kind,
      tree: 'capDrift-' + kind,
      scoped: scope !== 'default',
      project: { home: scope === 'default', name: scope },
      projectCount: projects.length,
      nodes,
    };
  }
  async function readSync(key) {
    const [, kind, ...parts] = key.split(':'),
      scope = parts.join(':');
    syncReads[key] = { load: 'loading' };
    try {
      const results = await checkDrift(kind, scope);
      syncReads[key] = { load: '', results, model: driftModel(kind, scope, results) };
      dataOk(key);
    } catch (error) {
      syncReads[key] = { load: 'error' };
      dataError(key, error);
    }
    await chatDataRender();
  }
  function syncVM(kind) {
    const key = syncKey(kind);
    if (board && projectionNeeded) projectionNeeded.add(key);
    const read = syncReads[key];
    return read && read.model;
  }
  function skillFields(item) {
    const mounts = skillMountRows(item),
      read = syncReads[syncKey('skill')];
    const fields = {
      mounts,
      mountCount: item.mountHealth && item.mountHealth.mountedCount,
      mountTotal: item.mountHealth && item.mountHealth.requiredCount,
    };
    if (read && read.results) {
      const projects = read.results.filter((r) => r.scope !== 'default');
      const different = projects.filter((r) => r.result.result.issues.some((i) => i.id === item.id));
      fields.projectSync = different.length
        ? { same: projects.length - different.length, total: projects.length }
        : null;
    }
    return fields;
  }
  VM.skills = function () {
    const scope = scopeVM(),
      sync = syncVM('skill'),
      rows = list('skill');
    return Object.assign(scope, {
      totalProjects: board && (board.knownProjectPaths || []).length,
      total: items('skill').length,
      batchEnabled: rows.filter((r) => r.on).length > rows.length / 2,
      summary: board && board.skillHealth,
      mountRules: rules && VM.mountRules(),
      sync: sync,
      readState: load || (syncReads[syncKey('skill')] ? syncReads[syncKey('skill')].load : 'loading'),
      picked: S.route === 'skill',
      q: S.skillQuery,
      cat: S.skillCat,
      cats: [
        ...new Set(
          items('skill')
            .map(function (s) {
              return s.category;
            })
            .filter(Boolean),
        ),
      ].map(function (v) {
        return { v: v };
      }),
      items: list('skill'),
      count: list('skill').length,
      cardsLoad: load,
      bad: null,
      mount: {
        n: rules ? Object.values(rules.mounts || {}).filter(Boolean).length : 0,
        scope: isDef() ? 'global' : 'project',
      },
    });
  };
  VM.mcp = function () {
    return Object.assign(scopeVM(), {
      total: items('mcp').length,
      sync: syncVM('mcp'),
      readState: load || (syncReads[syncKey('mcp')] ? syncReads[syncKey('mcp')].load : 'loading'),
      picked: S.route === 'mcpItem' || S.route === 'mcpNew',
      isNew: S.route === 'mcpNew',
      q: S.mcpQuery,
      src: S.mcpSrc,
      items: list('mcp'),
      cardsLoad: load,
      bad: null,
      export: JSON.stringify(
        {
          mcpServers: Object.fromEntries(
            items('mcp').map(function (item) {
              return [item.id, item.mcpServer];
            }),
          ),
        },
        null,
        2,
      ),
    });
  };
  VM.skill = function () {
    if (projectionNeeded) projectionNeeded.add('capabilities:' + S.project);
    const item = selected('skill');
    if (!item) return null;
    if (projectionNeeded) projectionNeeded.add('skillDoc:' + item.id);
    const dependencies = issues(item),
      src = item.pluginId ? 'plugin' : item.source === 'market' ? 'market' : 'builtin';
    return {
      name: item.id,
      desc: item.description,
      on: item.enabled,
      tags: [
        { k: 'src_' + src, v: item.pluginId || '' },
        { k: item.category ? 'cat' : 'cat_none', v: item.category },
      ].concat(
        (item.triggers || []).map(function (v) {
          return { k: 'trigger', v: v };
        }),
      ),
      issues: {
        dep: dependencies.length
          ? [
              {
                code: 'dep',
                n: dependencies.length,
                deps: dependencies.map(function (dep) {
                  return { id: dep.id, st: dep.state };
                }),
                missing: dependencies.some(function (dep) {
                  return dep.state === 'missing';
                }),
              },
            ]
          : [],
        drift: [],
        xproj: [],
      },
      src: { [src]: true },
      srcTo: src === 'plugin' ? 'extItem-' + item.pluginId : '',
      ov: item.hasOverride ? (isDef() ? 'default' : 'project') : '',
      resetScope: item.hasOverride ? 'skill.' + item.id : '',
      path: skillDoc ? skillDoc.path : '',
      doc: { missing: !skillDoc, md: skillDoc && skillDoc.content },
      mounted: rules ? Object.values(rules.mounts || {}).filter(Boolean).length : 0,
    };
  };
  async function toggle(item, enabled, mountPointId) {
    await chatAction('capabilitySave', {
      value: JSON.stringify(
        Object.assign(
          {},
          query(),
          {
            capabilityId: item.id,
            capabilityType: item.type,
            source: item.source,
            pluginId: item.pluginId,
            scope: isDef() ? 'global' : 'project',
            enabled: enabled,
          },
          mountPointId ? { mountPointId: mountPointId } : {},
        ),
      ),
    });
    await read();
  }
  const statusAction = A.setStatus;
  A.setStatus = async function (d) {
    if (d.entity === 'skill' || d.entity === 'mcp') {
      const item = items(d.entity).find(function (i) {
        return i.id === d.id;
      });
      return toggle(item, d.v == null ? !item.enabled : String(d.v) === 'true');
    }
    if (d.entity === 'mcpCat') {
      const ids = d.id.split('|'),
        item = items('mcp').find(function (i) {
          return i.id === ids[0];
        });
      await chatAction('capabilitySave', {
        value: JSON.stringify(
          Object.assign({}, query(), {
            capabilityId: item.id,
            capabilityType: 'mcp',
            source: item.source,
            pluginId: item.pluginId,
            scope: isDef() ? 'cat' : 'project',
            catId: ids[1],
            mountPointId: isDef() ? undefined : ids[1],
            enabled: d.v == null ? !item.cats[ids[1]] : String(d.v) === 'true',
          }),
        ),
      });
      return read();
    }
    if (d.entity === 'mount' || d.entity === 'mountPoint') {
      const rule = rules.mountPoints[d.id];
      rule.enabled = d.v == null ? !rule.enabled : String(d.v) === 'true';
      return saveRules();
    }
    if (d.entity === 'skillMount') {
      const item = selected('skill');
      return toggle(item, d.v == null ? !mountTargets(item).includes(d.id) : String(d.v) === 'true', d.id);
    }
    return statusAction(d);
  };
  A.capSkill = function (d) {
    const item = d && d.n ? items('skill').find((item) => item.id === d.n) : selected('skill');
    return toggle(item, !item.enabled);
  };
  A.capSkillMount = function (d) {
    const item = items('skill').find(function (item) {
      return item.id === d.n;
    });
    return toggle(item, !mountTargets(item).includes(d.m), d.m);
  };
  A.capBulk = async function (d) {
    const names = list('skill').map(function (r) {
      return r.key;
    });
    await chatAction('capabilitySave', {
      value: JSON.stringify(
        Object.assign({}, query(), {
          capabilityIds: names,
          capabilityType: 'skill',
          scope: isDef() ? 'global' : 'project',
          enabled: d.v === '1',
        }),
      ),
    });
    await read();
  };
  async function saveRules() {
    await chatAction('mountRulesSave', {
      value: JSON.stringify(Object.assign({}, query(), isDef() ? { scope: 'default' } : {}, { rules: rules })),
    });
    await read();
  }
  function mountRow(name, rule, entity) {
    return {
      name: name,
      path: rule.path,
      on: !!rule.enabled,
      pointOff: !!rule.disabled,
      rule: entity === 'mountPoint',
      skill: null,
    };
  }
  VM.mountRules = function () {
    if (projectionNeeded) projectionNeeded.add('capabilities:' + S.project);
    return {
      scope: isDef() ? 'global' : 'project',
      projectName: isDef() ? '' : S.project,
      adding: !!(S.dialog && S.dialog.adding),
      std: rules
        ? Object.keys(rules.mountPoints).map(function (name) {
            return mountRow(name, rules.mountPoints[name], 'mountPoint');
          })
        : [],
      custom: rules
        ? rules.customPaths.map(function (r) {
            return { name: r.alias, path: r.path, custom: true, i: r.alias };
          })
        : [],
    };
  };
  function mountTargets(item) {
    return item.mountPaths || (item.mountHealth && item.mountHealth.enabledMountPoints);
  }
  function skillMountRows(item) {
    if (!rules) return undefined;
    const targets = mountTargets(item);
    if (!targets) return undefined;
    return Object.entries(rules.mountPoints)
      .map(([name, rule]) => {
        const on = rule.enabled && targets.includes(name);
        return {
          ...mountRow(name, { path: rule.path + '/' + item.id, enabled: on, disabled: !rule.enabled }, 'skillMount'),
          skill: item.id,
          broken: on && item.mounts && item.mounts[name] === false,
        };
      })
      .concat(
        rules.customPaths.map((r) => ({
          ...mountRow(r.alias, { path: r.path + '/' + item.id, enabled: targets.includes(r.alias) }, 'skillMount'),
          skill: item.id,
          broken: targets.includes(r.alias) && item.mounts && item.mounts[r.alias] === false,
        })),
      );
  }
  VM.skillMounts = function () {
    if (projectionNeeded) projectionNeeded.add('capabilities:' + S.project);
    const item = selected('skill');
    return { name: item.id, mounts: skillMountRows(item) };
  };

  ENT.mountCustom = {
    get: function (id) {
      return rules.customPaths.find(function (r) {
        return r.alias === id;
      });
    },
    fields: [
      { id: 'mt-alias', key: 'alias', req: true },
      { id: 'mt-path', key: 'path', req: true },
    ],
    add: async function (v) {
      rules.customPaths.push(v);
      await saveRules();
    },
    remove: async function (v) {
      rules.customPaths.splice(rules.customPaths.indexOf(v), 1);
      await saveRules();
    },
  };
  INPUTS.skillQ = function (e) {
    S.skillQuery = e.target.value;
    render(true);
  };
  INPUTS.mcpQ = function (e) {
    S.mcpQuery = e.target.value;
    render(true);
  };
  CHANGES.capProject = function (e) {
    S.project = e.target.value;
    render(true);
  };
  CHANGES.skillCat = function (e) {
    S.skillCat = e.target.value;
    render(true);
  };
  CHANGES.mcpSrc = function (e) {
    S.mcpSrc = e.target.value;
    render(true);
  };
  async function drift(d) {
    const scope = d.all ? 'default' : d.s || S.project,
      projects = await checkDrift(d.k, scope);
    dialog({
      kind: 'drift',
      args: driftModel(d.k, scope, projects),
      on: async function () {
        for (const row of projects)
          await api.post(
            '/api/drift/resolve',
            {},
            Object.assign({}, row.params, { action: 'sync', conflictPolicy: 'use-global' }),
          );
        await read();
      },
    });
  }
  A.capSync = function (d) {
    return settleHold(
      drift(d).catch(function (error) {
        dataError('capabilities', error);
      }),
    );
  };
  A.driftOpen = function (d) {
    return A.capSync(d);
  };
  A.capFix = A.capSync;
  A.capSysSync = function () {
    dialog({
      kind: 'mcpImport',
      on: async function () {
        await api.post('/api/capabilities/mcp/discover', {}, query());
        await read();
      },
    });
  };

  const reset = A.reset;
  A.reset = async function (d) {
    if (d.scope.indexOf('cap.cfg.') !== 0) return reset(d);
    try {
      await api.post('/api/capabilities/mcp/install', {}, Object.assign(installBody(), { clearOverride: true }));
      S.mcpDraft = null;
      await read();
    } catch (error) {
      S.mcpErr = error.message;
      render(true);
    }
  };
  ENT.mcpServer = {
    get: function (id) {
      return (
        items('mcp').find(function (i) {
          return i.id === id;
        }) || items('mcp')[id]
      );
    },
    confirm: function (m) {
      return { kind: 'mcpUninstall' };
    },
    remove: async function (m) {
      await chatPort.action('mcpRemove', { id: m.id, value: JSON.stringify(query()) });
      await read();
      go('mcp');
    },
  };
  function mcpFields(d) {
    return JSON.stringify({
      name: d.name,
      t: d.t,
      cmd: d.cmd,
      args: d.args,
      url: d.url,
      env: d.env.map(function (r) {
        return r.slice(0, 2);
      }),
      headers: d.headers.map(function (r) {
        return r.slice(0, 2);
      }),
    });
  }
  function mcpData(item) {
    const c = item.mcpServer || {};
    return {
      name: item.id,
      desc: item.description,
      src: item.source === 'cat-cafe' ? 'builtin' : item.source,
      ext: item.pluginId,
      t: c.transport === 'streamableHttp' ? 'http' : 'stdio',
      cmd: c.command || '',
      args: c.args || [],
      url: c.url || '',
      env: c.env || {},
      headers: c.headers || {},
      resolver: c.resolver,
    };
  }
  function mcpDraft(key, m, isNew) {
    if (!S.mcpDraft) {
      S.mcpDraft = {
        name: isNew ? '' : m.name,
        t: isNew ? 'stdio' : m.t,
        cmd: isNew ? '' : m.cmd,
        args: isNew ? [] : m.args.slice(),
        url: isNew ? '' : m.url,
        env: isNew
          ? []
          : Object.entries(m.env).map(function (e) {
              return [e[0], '', false, true];
            }),
        headers: isNew
          ? []
          : Object.entries(m.headers).map(function (e) {
              return [e[0], '', false, true];
            }),
      };
      original = mcpFields(S.mcpDraft);
      S.mcpPreview = false;
      S.mcpErr = '';
    }
    return S.mcpDraft;
  }
  function mcpFormVM(m, isNew) {
    const ro = !isNew && (m.src === 'builtin' || m.src === 'plugin'),
      d = mcpDraft(isNew ? 'new' : m.name + ':' + S.project, m, isNew),
      isEdit = !isNew && !ro,
      key = isNew ? '__new' : m.name,
      probe = S.mcpProbe[key] || { s: 'idle' },
      kv = function (rows) {
        return rows.map(function (r) {
          return { k: r[0], v: r[1], show: !!r[2], saved: isEdit && !!r[3] };
        });
      };
    return {
      readOnly:
        ro ||
        (!isNew && items('mcp').some((item) => item.id === m.name && (item.pluginId || item.source !== 'external'))),
      err: S.mcpErr,
      d: d,
      ro: ro,
      key: key,
      scope: isDef() ? 'default' : 'project',
      resolver: m && m.resolver,
      desc: m && m.desc,
      args: d.args.map(function (v) {
        return { v: v };
      }),
      env: kv(d.env),
      headers: kv(d.headers),
      tools: {
        state: probe.s,
        errorCode: probe.errorCode,
        errorText: probe.msg,
        total: probe.s === 'ok' ? probe.tools.length : 0,
        rows:
          probe.s === 'ok'
            ? probe.tools.map(function (t) {
                return { name: t[0], desc: t[1] };
              })
            : [],
      },
      preview: S.mcpPreview,
      dirty: S.dirty,
    };
  }
  function installBody() {
    const d = S.mcpDraft;
    return Object.assign({}, query(), {
      id: d.name,
      transport: d.t === 'http' ? 'streamableHttp' : 'stdio',
      command: d.cmd,
      args: d.args,
      url: d.url,
      env: Object.fromEntries(
        d.env
          .filter(function (r) {
            return r[0] && (!r[3] || r[1]);
          })
          .map(function (r) {
            return [r[0], r[1]];
          }),
      ),
      headers: Object.fromEntries(
        d.headers
          .filter(function (r) {
            return r[0] && (!r[3] || r[1]);
          })
          .map(function (r) {
            return [r[0], r[1]];
          }),
      ),
    });
  }
  VM.mcpItem = function () {
    if (projectionNeeded) projectionNeeded.add('capabilities:' + S.project);
    const item = selected('mcp');
    if (!item) return null;
    const m = mcpData(item),
      src = m.src,
      ov = item.hasOverride ? (isDef() ? 'default' : 'project') : '';
    return {
      name: item.id,
      idx: S.param,
      on: item.enabled,
      scope: isDef() ? 'default' : 'project',
      ov: ov,
      cfgOv: !!item.hasOverride,
      src: { [src]: true, external: src === 'external' },
      srcTo: src === 'plugin' ? 'extItem-' + item.pluginId : '',
      resetScope: ov ? 'mcp.' + item.id : '',
      cfgResetScope: item.hasOverride ? 'cfg.' + item.id : '',
      command: m.t === 'http' ? m.url : m.cmd,
      json: JSON.stringify({ mcpServers: { [item.id]: item.mcpServer } }, null, 2),
      tags: [{ k: src, v: item.pluginId || '' }],
      issues: issues(item),
      desc: item.description,
      cats: {
        off: board.allCats.filter(function (c) {
          return !item.cats[c.catId];
        }).length,
        items: board.allCats.map(function (c) {
          return { id: c.catId, on: item.cats[c.catId], name: c.displayName, key: item.id + '|' + c.catId };
        }),
      },
      form: mcpFormVM(m, false),
    };
  };
  VM.mcpNew = function () {
    if (projectionNeeded) projectionNeeded.add('capabilities:' + S.project);
    return { form: mcpFormVM(null, true) };
  };
  INPUTS.mcpDirty = function (e) {
    const t = e.target,
      p = t.dataset.draft.split(':');
    if (p.length === 1) S.mcpDraft[p[0]] = t.value;
    else if (p[0] === 'args') S.mcpDraft.args[+p[1]] = t.value;
    else S.mcpDraft[p[0]][+p[1]][p[2] === 'k' ? 0 : 1] = t.value;
    preview = null;
    S.mcpPreview = false;
    markDirty();
  };
  SET_AFTER['s.mcpDraft.t'] = function () {
    preview = null;
    S.mcpPreview = false;
    markDirty();
  };
  SET_AFTER['s.mcpDraft.{l}'] = function () {
    preview = null;
    S.mcpPreview = false;
    markDirty();
  };
  A.mcpPreview = async function () {
    try {
      preview = await api.post('/api/capabilities/mcp/preview', {}, installBody());
      S.mcpPreview = true;
      S.mcpErr = '';
    } catch (error) {
      preview = null;
      S.mcpPreview = false;
      S.mcpErr = error.message;
    }
    render(true);
  };
  A.mcpProbe = async function () {
    const key = S.route === 'mcpNew' ? '__new' : selected('mcp').id,
      body = S.route === 'mcpNew' || mcpFields(S.mcpDraft) !== original ? installBody() : query();
    S.mcpProbe[key] = { s: 'probing' };
    render(true);
    try {
      const result = await api.post('/api/mcp/' + encodeURIComponent(body.id || key) + '/tools', {}, body);
      S.mcpProbe[key] = {
        s: result.connectionStatus === 'connected' ? 'ok' : 'error',
        msg: result.error,
        tools: result.tools.map(function (t) {
          return [t.name, t.description];
        }),
      };
    } catch (error) {
      S.mcpProbe[key] = { s: 'error', msg: error.message };
    }
    render(true);
  };
  FORMS.mcp = async function () {
    if (S.route === 'mcpNew' && !preview) return;
    try {
      await api.post('/api/capabilities/mcp/install', {}, installBody());
      S.mcpDraft = null;
      S.mcpPreview = false;
      preview = null;
      await read();
      if (S.route === 'mcpNew') go('mcp');
    } catch (error) {
      S.mcpErr = error.message;
      render(true);
    }
  };
  formDraft('mcp', {
    dirty: function () {
      return ['mcpItem', 'mcpNew'].indexOf(S.route) >= 0 && !!S.mcpDraft && mcpFields(S.mcpDraft) !== original;
    },
    drop: function () {
      S.mcpDraft = null;
      preview = null;
    },
  });
}
