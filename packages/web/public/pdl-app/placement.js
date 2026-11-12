/* Placement owners: the host pushes receipts; these VMs project the held settings snapshot. */
'use strict';
function placementData() {
  return chatDataSnapshot.project && chatDataSnapshot.project.settings;
}
function bindPlacement() {
  RESETS.voice = {
    get: function () {
      return chatDataSnapshot.project.voice.settings;
    },
    def: function () {
      return { customTerms: [], customPrompt: null, language: 'zh' };
    },
    set: function (value) {
      return chatAction('voiceSettingsRestore', { value: JSON.stringify(value) });
    },
    text: function () {
      return tc('settings.notifications.voiceReset');
    },
  };
  const reset = A.reset;
  A.reset = async function (d) {
    if (d.scope !== 'voice') return reset(d);
    const before = RESETS.voice.get(),
      changed = before.customTerms.length || before.customPrompt !== null || before.language !== 'zh';
    if ((await chatAction('voiceSettingsReset')) === false) return;
    if (changed)
      undoShow({
        text: RESETS.voice.text(),
        undo: function () {
          return RESETS.voice.set(before);
        },
      });
  };
  A.voiceInstallOpen = async function (d) {
    const s = chatDataSnapshot.project.voice.services.items[+d.id],
      modify = !!d.modify,
      preview = await chatPort.action('voiceInstallRead', { id: s.id }),
      rec = preview.recommendation;
    let dd = {
      kind: 'install',
      args: {
        name: s.name,
        modify: modify,
        host: {
          platform: preview.profile.os,
          gpu: preview.profile.gpuDetail,
          memory: preview.profile.ramGb,
          diskFree: preview.profile.diskFreeGb,
          python: preview.profile.pythonVersion,
        },
        models: rec.models.map(function (m) {
          return Object.assign({}, m, { id: m.name });
        }),
        model: modify ? s.selectedModel : rec.models[0] && rec.models[0].name,
        port: preview.suggestedPort,
        portValue: modify ? s.port : '',
        portNote: '',
        unsupported: rec.unsupported,
        custom: rec.customModelHint,
      },
      error: rec.unsupported && rec.unsupported.reason,
      on: function () {
        const port = val('svc-port').trim(),
          modelField = dd.fields.find(function (f) {
            return f.id === 'svc-model';
          });
        if (port && !(/^\d+$/.test(port) && +port >= 1 && +port <= 65535)) {
          fieldErr('svc-port', tc('settings.notifications.invalidPort'));
          return false;
        }
        const selected = modelField ? modelField.opts.cur : '',
          model = selected === 'custom' ? modelField.opts.custom.value.trim() : selected;
        if (selected === 'custom' && !model) {
          fieldErr('svc-custom', tc('settings.notifications.modelRequired'));
          return false;
        }
        return chatPort.action('voiceService', {
          id: s.id,
          op: modify ? 'reconfigure' : 'install',
          port: port,
          model: model,
        });
      },
    };
    dialog(dd);
    dd = S.dialog;
  };
  A.svcInstall = function (d) {
    const i = d.i != null ? d.i : d.k,
      s = chatDataSnapshot.project.voice.services.items[+i];
    if (!s.installed && !s.prerequisites?.models?.length) return chatAction('svcInstall', { i: i });
    return A.voiceInstallOpen({ id: i });
  };
  A.capAudit = function (d) {
    CS.modal = { kind: 'capAudit', capabilityType: d.capabilityType };
    render(true);
    return chatAction('settingsCapAuditRead', { projectPath: S.project === 'default' ? '' : S.project });
  };
  const refresh = A.refresh;
  A.refresh = function (d, el) {
    return d.k === 'cap-audit'
      ? chatAction('settingsCapAuditRead', { projectPath: S.project === 'default' ? '' : S.project })
      : refresh(d, el);
  };
  VM.capAudit = function () {
    const raw = placementData(),
      m = CS.modal;
    return {
      load: raw.auditError ? 'error' : raw.audit ? '' : 'loading',
      items:
        raw.auditError || !raw.audit
          ? []
          : raw.audit.entries
              .filter(function (e) {
                return (e.after || e.before).type === m.capabilityType;
              })
              .map(function (e) {
                return {
                  key: e.timestamp + ':' + e.capabilityId,
                  action: e.action,
                  capabilityId: e.capabilityId,
                  timestamp: e.timestamp,
                  userId: e.userId,
                  before: e.before,
                  after: e.after,
                };
              }),
    };
  };
  MODALS.capAudit = function () {
    return { vm: VM.capAudit() };
  };
  api.on('sources:needed', function (diff) {
    if (
      diff.added.some(function (name) {
        return name === 'project.settings.marketSources' || name.indexOf('project.settings.marketSources.') === 0;
      })
    )
      settleHold(chatAction('settingsMarketRead'));
  });
  PAGES.marketSources = function () {
    return pdlView('page.marketSources');
  };
  VM.marketSources = function () {
    const raw = placementData();
    return {
      load: raw.marketError ? 'error' : raw.marketSources ? '' : 'loading',
      sources:
        raw.marketError || !raw.marketSources
          ? []
          : raw.marketSources.sources.map(function (s) {
              return {
                id: s.id,
                title: s.url,
                branch: s.branch,
                commit: s.commit,
                status: s.status,
                error: s.error,
                canRemove: s.origin === 'user',
              };
            }),
    };
  };
  A.marketSourceAdd = function (d) {
    const body = { url: d.v.trim() },
      branch = val('market-branch').trim();
    if (branch) body.branch = branch;
    return chatAction('settingsMarketWrite', { op: 'add', value: JSON.stringify(body) });
  };
  A.marketSourcesRefresh = function () {
    return chatAction('settingsMarketWrite', { op: 'refresh' });
  };
  ENT.marketSource = {
    get: function (id) {
      return placementData().marketSources.sources.find(function (s) {
        return s.id === id;
      });
    },
    confirm: function (s) {
      return { kind: 'marketSourceDelete', args: { url: s.url } };
    },
    remove: function (s) {
      return chatPort.action('settingsMarketWrite', { op: 'delete', id: s.id });
    },
  };
  A.memberHooksSync = function () {
    return dialog({
      kind: 'memberHooksSync',
      on: function () {
        return chatPort.action('settingsHooksSync', {});
      },
    });
  };
  A.pageActionOpen = function () {
    CS.voice.pageAction = { pageId: '' };
    dialog({ kind: 'pageAction' });
    return chatAction('settingsPageActionRead');
  };
  VM.pageAction = function () {
    const s = CS.voice.pageAction;
    if (!s) return null;
    const raw = placementData(),
      owner = raw.pageAction,
      available = owner && owner.kind === 'available',
      p = available && owner.preview,
      rows = available
        ? [
            { field: 'request', value: owner.requestText },
            { field: 'page', value: owner.pageUrl },
          ]
        : [];
    if (p) {
      rows.push(
        { field: 'target', value: p.field },
        { field: 'operation', value: p.operation },
        { field: 'permission', value: p.permissionScope },
        { field: 'expires', value: p.expiresAtMs },
      );
      if (p.value !== undefined) rows.push({ field: 'value', value: p.value });
    }
    if (available && owner.result) rows.push({ field: 'result', value: owner.result.status });
    return {
      load: raw.pageActionError ? 'error' : owner ? '' : 'loading',
      state: available ? owner.state : 'unavailable',
      rows: rows,
      pages: raw.pageActionPages.map(function (p) {
        return { v: p.pageId, title: p.title, url: p.url };
      }),
      pageId: s.pageId,
      canSelect: available && owner.pageSelection && !p,
      canInspect: available && ['ready', 'awaiting_consent'].includes(owner.state),
      canConfirm: !!p && owner.state === 'awaiting_consent',
      canRevoke: !!p && ['awaiting_consent', 'executing'].includes(owner.state),
      previewId: p && p.previewId,
    };
  };
  CHANGES.pageActionPick = function (e) {
    CS.voice.pageAction.pageId = e.target.value;
    return A.pageAction({ op: 'select' });
  };
  A.pageAction = function (d) {
    if (d.op === 'refresh') {
      return A.pageActionOpen();
    }
    return chatAction('settingsPageAction', {
      op: d.op,
      previewId: d.previewId,
      pageId: CS.voice.pageAction.pageId,
    }).then(function () {
      return !placementData().pageActionError;
    });
  };
}
