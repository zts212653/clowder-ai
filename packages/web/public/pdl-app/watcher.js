'use strict';
let watcherData = { settings: null, threads: {}, suggestions: {}, rounds: {}, errors: {} };
const watcherTimers = new Map();
function watcherPublish() {
  const diff = pushProjectData({ watcher: watcherData });
  watcherData = projectHeldData.watcher;
  return diff;
}
function watcherSuggestions(threadId, messageId) {
  if (projectionNeeded) projectionNeeded.add('watcher:suggestions:' + threadId);
  const source = projectData('watcher'),
    value = source && source.suggestions[threadId];
  return value
    ? value.suggestions.filter(function (row) {
        return row.messageId === messageId;
      })
    : [];
}
async function watcherRead(key) {
  const parts = key.split(':'),
    kind = parts[1],
    id = parts.slice(2).join(':');
  try {
    const value = await api.get(
        kind === 'settings'
          ? '/api/watcher/config'
          : kind === 'round'
            ? '/api/watcher/panel/rounds/' + encodeURIComponent(id)
            : '/api/threads/' + encodeURIComponent(id) + '/' + (kind === 'thread' ? 'watcher' : 'suggestions'),
      ),
      field = { thread: 'threads', suggestions: 'suggestions', round: 'rounds' }[kind];
    if (!heldNeeded.has(key)) return;
    watcherData = Object.assign(
      {},
      watcherData,
      { errors: Object.assign({}, watcherData.errors, { [key]: '' }) },
      kind === 'settings' ? { settings: value } : { [field]: Object.assign({}, watcherData[field], { [id]: value }) },
    );
    dataOk(key);
    watcherPublish();
  } catch (error) {
    if (!heldNeeded.has(key)) return;
    watcherData = Object.assign({}, watcherData, {
      errors: Object.assign({}, watcherData.errors, { [key]: error.message }),
    });
    if (kind === 'suggestions') dataError(key, error);
    watcherPublish();
  }
}
api.on('sources:needed', function (diff) {
  diff.added
    .filter(function (key) {
      return key.indexOf('watcher:') === 0;
    })
    .forEach(function (key) {
      settleHold(watcherRead(key));
      clearInterval(watcherTimers.get(key));
      watcherTimers.delete(key);
      if (key.indexOf('watcher:thread:') === 0 && !document.hidden)
        watcherTimers.set(
          key,
          setInterval(function () {
            watcherRead(key);
          }, 5000),
        );
    });
  diff.removed.forEach(function (key) {
    clearInterval(watcherTimers.get(key));
    watcherTimers.delete(key);
  });
});
onStart('late', function () {
  document.addEventListener('visibilitychange', function () {
    watcherTimers.forEach(function (timer) {
      clearInterval(timer);
    });
    watcherTimers.clear();
    if (document.hidden) return;
    heldNeeded.forEach(function (key) {
      if (key.indexOf('watcher:') !== 0) return;
      settleHold(watcherRead(key));
      if (key.indexOf('watcher:thread:') === 0)
        watcherTimers.set(
          key,
          setInterval(function () {
            watcherRead(key);
          }, 5000),
        );
    });
  });
});
api.on('suggestion_updated', function (data) {
  if (!heldNeeded.has('watcher:suggestions:' + data.threadId)) return;
  const current = watcherData.suggestions[data.threadId] || { suggestions: [] },
    row = data.suggestion;
  const rows = new Map(
    current.suggestions.map(function (item) {
      return [item.id, item];
    }),
  );
  rows.set(row.id, row);
  watcherData = Object.assign({}, watcherData, {
    suggestions: Object.assign({}, watcherData.suggestions, {
      [data.threadId]: { suggestions: Array.from(rows.values()) },
    }),
  });
  watcherPublish();
});
onStart('late', function () {
  window.addEventListener('watcher-settings-changed', function () {
    heldNeeded.forEach(function (key) {
      if (key.indexOf('watcher:') === 0) settleHold(watcherRead(key));
    });
  });
});
VM.watcherSettings = function () {
  if (projectionNeeded) projectionNeeded.add('watcher:settings');
  const raw = projectData('watcher'),
    value = raw && raw.settings;
  if (!value)
    return {
      load: raw && raw.errors['watcher:settings'] ? 'error' : 'loading',
      error: raw ? raw.errors['watcher:settings'] || '' : '',
    };
  const muted = new Set(value.config.doNotDisturbLabelIds),
    panel = value.config.panel || value.panelDefaults;
  return Object.assign({}, value, {
    availableLabels: value.availableLabels.map(function (label) {
      return Object.assign({}, label, { muted: muted.has(label.id) });
    }),
    error: raw.errors['watcher:settings'] || '',
    panel: panel,
    panelOn: !!(value.config.panel && value.config.panel.enabled),
    panelLimits: Array.from({ length: 12 }, function (_, i) {
      return { v: i + 1, label: String(i + 1) };
    }),
    panelMembers: value.members
      .filter(function (m) {
        return m.panelSupported;
      })
      .map(function (m) {
        const chosen = panel.members.find(function (x) {
          return x.catId === m.catId;
        });
        return {
          catId: m.catId,
          label: m.displayName,
          active: !!chosen,
          last: !!chosen && panel.members.length === 1,
          account: chosen ? chosen.accountRef || '' : '',
          fieldId: 'watcher-panel-account-' + m.catId,
        };
      }),
  });
};
// The panel is sent back whole (the server takes a complete panel); the members it starts from are the defaults.
function watcherPanel() {
  return watcherData.settings.config.panel || watcherData.settings.panelDefaults;
}
A.watcherPanelSet = function (d) {
  return A.watcherConfigSet({ field: 'panel', value: Object.assign({}, watcherPanel(), { [d.field]: d.value }) });
};
A.watcherPanelMember = function (d) {
  const members = watcherPanel().members,
    on = members.some(function (m) {
      return m.catId === d.id;
    });
  return A.watcherPanelSet({
    field: 'members',
    value: on
      ? members.filter(function (m) {
          return m.catId !== d.id;
        })
      : members.concat([{ catId: d.id }]),
  });
};
CHANGES.watcherPanelAccount = function (e) {
  const id = e.target.dataset.id,
    v = e.target.value;
  return A.watcherPanelSet({
    field: 'members',
    value: watcherPanel().members.map(function (m) {
      return m.catId !== id ? m : v ? { catId: id, accountRef: v } : { catId: id };
    }),
  });
};
CHANGES.watcherPanel = function (e) {
  return A.watcherPanelSet({ field: e.target.dataset.field, value: +e.target.value });
};
// A panel delivery names labels only; 看是谁 reads the round ledger (label -> member, spoke or not) while it is open.
const WATCHER_ROUND_LABELS = '甲乙丙丁戊'; // WATCHER_PANEL_LABELS in the shared package
onStart('early', function () {
  CS.watcherRounds = {};
});
function watcherRoundId(mid) {
  const message = chatMessageIndex.get(mid),
    source = message && message.source;
  return source && source.connector === 'watcher-panel' && source.meta && source.meta.roundId;
}
A.watcherRoundOpen = function (d) {
  CS.watcherRounds[d.id] = d.reload || !CS.watcherRounds[d.id];
  if (d.reload) settleHold(watcherRead('watcher:round:' + watcherRoundId(d.id)));
  render(true);
  return true;
};
function watcherRoundEmbed(x) {
  const id = watcherRoundId(x.mid);
  if (!id) return [];
  const open = !!CS.watcherRounds[x.mid],
    key = 'watcher:round:' + id;
  if (open && projectionNeeded) projectionNeeded.add(key);
  const raw = projectData('watcher'),
    round = open && raw && raw.rounds[id],
    catalog = chatRead('memberCatalog');
  return [
    {
      mid: x.mid,
      round: {
        id: x.mid,
        open: open,
        load: !open || round ? '' : raw && raw.errors[key] ? 'error' : 'loading',
        members: round
          ? round.members
              .slice()
              .sort(function (a, b) {
                return WATCHER_ROUND_LABELS.indexOf(a.label) - WATCHER_ROUND_LABELS.indexOf(b.label);
              })
              .map(function (m) {
                const who = catalog.find(function (c) {
                  return c.id === m.catId;
                });
                return { label: m.label, name: who ? who.name : m.catId, status: m.status };
              })
          : [],
      },
    },
  ];
}
VM.watcherThread = function () {
  const id = CS.modal && CS.modal.kind === 'tset' ? CS.modal.id : chatDataSnapshot.chat.threadId,
    key = 'watcher:thread:' + id;
  if (projectionNeeded) projectionNeeded.add(key);
  const raw = projectData('watcher'),
    value = raw && raw.threads[id];
  if (!value)
    return {
      threadId: id,
      load: raw && raw.errors[key] ? 'error' : 'loading',
      error: raw ? raw.errors[key] || '' : '',
    };
  return Object.assign({}, value, {
    threadId: id,
    pausedUntil: value.control.pausedUntil,
    selected: value.config.scope === 'all' ? value.control.enabled !== false : value.control.enabled === true,
    error: raw.errors[key] || '',
  });
};
A.watcherConfigSet = async function (d) {
  const key = 'watcher:settings',
    body = { expectedRevision: watcherData.settings.config.revision, [d.field]: d.value };
  try {
    const value = await api.post('/api/watcher/config', { method: 'PUT' }, body);
    watcherData = Object.assign({}, watcherData, {
      settings: value,
      errors: Object.assign({}, watcherData.errors, { [key]: '' }),
    });
    watcherPublish();
    window.dispatchEvent(new Event('watcher-settings-changed'));
    return true;
  } catch (error) {
    watcherData = Object.assign({}, watcherData, {
      errors: Object.assign({}, watcherData.errors, { [key]: error.message }),
    });
    watcherPublish();
    return false;
  }
};
CHANGES.watcherConfig = function (e) {
  return A.watcherConfigSet({ field: e.target.dataset.field, value: e.target.value });
};
A.watcherQuietLabel = function (d) {
  const values = Array.from(new Set(watcherData.settings.config.doNotDisturbLabelIds)),
    index = values.indexOf(d.id);
  if (index < 0) values.push(d.id);
  else values.splice(index, 1);
  return A.watcherConfigSet({ field: 'doNotDisturbLabelIds', value: values });
};
A.watcherThreadSet = async function (d) {
  const key = 'watcher:thread:' + d.threadId,
    value = watcherData.threads[d.threadId];
  try {
    const next = await api.post(
      '/api/threads/' + encodeURIComponent(d.threadId) + '/watcher',
      { method: 'PUT' },
      { expectedRevision: value.control.revision, [d.field]: d.value },
    );
    watcherData = Object.assign({}, watcherData, {
      threads: Object.assign({}, watcherData.threads, { [d.threadId]: next }),
      errors: Object.assign({}, watcherData.errors, { [key]: '' }),
    });
    watcherPublish();
    return true;
  } catch (error) {
    watcherData = Object.assign({}, watcherData, {
      errors: Object.assign({}, watcherData.errors, { [key]: error.message }),
    });
    watcherPublish();
    return false;
  }
};
A.watcherNudge = async function (d) {
  const row = watcherData.suggestions[d.threadId].suggestions.find(function (item) {
    return item.id === d.id;
  });
  let accepted = true;
  try {
    await api.post(
      '/api/suggestions/' + encodeURIComponent(d.id) + '/' + d.decision,
      {},
      { expectedRevision: row.revision },
    );
  } catch (error) {
    accepted = false;
    toast(error.message, null, 'danger');
  }
  await watcherRead('watcher:suggestions:' + d.threadId);
  return accepted;
};
