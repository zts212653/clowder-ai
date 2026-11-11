'use strict';
let watcherData = { settings: null, threads: {}, suggestions: {}, errors: {} };
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
        : '/api/threads/' + encodeURIComponent(id) + '/' + (kind === 'thread' ? 'watcher' : 'suggestions'),
    );
    if (!heldNeeded.has(key)) return;
    watcherData = Object.assign(
      {},
      watcherData,
      { errors: Object.assign({}, watcherData.errors, { [key]: '' }) },
      kind === 'settings'
        ? { settings: value }
        : {
            [kind === 'thread' ? 'threads' : 'suggestions']: Object.assign(
              {},
              watcherData[kind === 'thread' ? 'threads' : 'suggestions'],
              { [id]: value },
            ),
          },
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
  const muted = new Set(value.config.doNotDisturbLabelIds);
  return Object.assign({}, value, {
    availableLabels: value.availableLabels.map(function (label) {
      return Object.assign({}, label, { muted: muted.has(label.id) });
    }),
    error: raw.errors['watcher:settings'] || '',
  });
};
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
