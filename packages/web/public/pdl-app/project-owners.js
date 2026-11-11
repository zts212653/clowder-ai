/* Project owner receipts use the same held-record comparison as the thread/sidebar path. */
'use strict';
let projectHeldData = {};
function projectRecordId(value, path) {
  if (!value || typeof value !== 'object') return undefined;
  if (value.pointer) return JSON.stringify([value.sessionId, value.pointer.eventNo]);
  if (value.path && (value.matchType || value.line != null))
    return JSON.stringify([value.path, value.line, value.matchType]);
  if (path === 'settings.audit.entries') return value.timestamp + ':' + value.capabilityId;
  if (/^settings\.(system|env)\.variables$/.test(path)) return value.name;
  if (path === 'settings.hooks.targets') return value.name;
  if ('pageId' in value) return value.pageId;
  if ('externalChatId' in value) return value.externalChatId;
  if (path === 'ops.read.value.sessions' && 'sessionId' in value) return value.sessionId;
  if (path === 'memory.reads.person.data.entries' && 'personId' in value) return value.personId;
  if (path === 'memory.reads.entity.data.entries' && 'entityId' in value) return value.entityId;
  if ('decisionRef' in value) return value.decisionRef;
  if ('id' in value) return String(value.id);
  if ('pluginId' in value) return value.pluginId;
  if ('contributionId' in value && 'name' in value) return JSON.stringify([value.contributionId, value.name]);
  if ('program' in value) return value.program.programId;
  if ('binding' in value && 'catId' in value.binding) return value.binding.catId;
  if ('eventId' in value) return value.eventId;
  if ('entryId' in value) return value.entryId;
  if ('matterId' in value) return value.matterId;
  if ('event' in value && 'id' in value.event) return value.event.id;
  if ('domainId' in value) return value.domainId;
  if ('bundleKey' in value) return value.bundleKey;
  if ('disposition' in value) return value.disposition.signalId;
  if ('daemonShortId' in value) return value.daemonShortId;
  if ('revisionId' in value) return value.revisionId;
  for (const key of [
    'navigationId',
    'eventNo',
    'eventIndex',
    'invocationId',
    'executionId',
    'sessionId',
    'paneId',
    'taskId',
    'port',
    'contentRef',
    'path',
    'sha',
    'hash',
    'revision',
  ])
    if (value[key] != null) return String(value[key]);
  if (value.record) return value.record.indexedVersionRef;
  if (value.envelope) return value.envelope.subjectRef;
  if ('catId' in value) return value.catId;
  if ('profileId' in value) return value.profileId;
  if ('sourceId' in value) return value.sourceId;
  if ('collectionId' in value) return value.collectionId;
  if ('chunk_num' in value) return String(value.chunk_num);
  if ('anchor' in value) return value.anchor;
  if ('versionRef' in value) return projectRefIdentity(value.versionRef);
  if ('recordRef' in value) return projectRefIdentity(value.recordRef);
  if ('experimentRef' in value) return projectRefIdentity(value.experimentRef);
  if ('nodeRef' in value) return projectRefIdentity(value.nodeRef);
  if ('ownerStateRef' in value) return projectRefIdentity(value);
  if ('from' in value && 'to' in value && 'relation' in value)
    return JSON.stringify([value.from, value.to, value.relation]);
  return undefined;
}
function receiveProjectValue(previous, next, path, diff) {
  if (previous === next) return previous;
  if (Array.isArray(next)) {
    const old = Array.isArray(previous) ? previous : [],
      sample = next.length ? next[0] : old[0];
    const idFor = function (row) {
      return projectRecordId(row, path);
    };
    if (idFor(sample) !== undefined) {
      const before = new Map(
          old.map(function (row) {
            return [idFor(row), row];
          }),
        ),
        ids = new Set(next.map(idFor));
      const rows = next.map(function (row) {
        const id = idFor(row),
          held = before.get(id);
        if (held === row || (held && chatDataEqual(held, row))) return held;
        (held ? diff.changed : diff.added).push(id);
        return row;
      });
      before.forEach(function (_, id) {
        if (!ids.has(id)) diff.removed.push(id);
      });
      if (
        old.length !== next.length ||
        next.some(function (row, i) {
          return idFor(row) !== idFor(old[i]);
        })
      )
        diff.orderChanged = true;
      return Array.isArray(previous) &&
        rows.every(function (row, i) {
          return row === old[i];
        }) &&
        rows.length === old.length
        ? previous
        : rows;
    }
    if (
      Array.isArray(previous) &&
      old.length === next.length &&
      next.every(function (row, i) {
        return row === old[i] || chatDataEqual(old[i], row);
      })
    )
      return previous;
    diff.fields.push(path);
    return next;
  }
  if (next && Object.prototype.toString.call(next) === '[object Object]') {
    const before = previous && Object.prototype.toString.call(previous) === '[object Object]' ? previous : {},
      result = {};
    const records =
      /^chatOwners\.(proposals|bundles|queueTargets|delivery|repeatReceipts|deliveryErrors|proposalErrors)$/.test(
        path,
      ) ||
      /^settings\.(connections|pluginDetails|pluginPermissions|pluginPermissionsErrors|pluginLibraries)$/.test(path) ||
      /^sources\.records\.(evidence|works|generations)$/.test(path) ||
      /^(evolution\.)?(explorationRequests|requests)\.records$/.test(path);
    Object.keys(next).forEach(function (key) {
      if (records) {
        if (before[key] === next[key]) result[key] = before[key];
        else {
          (key in before ? diff.changed : diff.added).push(key);
          result[key] = next[key];
        }
      } else result[key] = receiveProjectValue(before[key], next[key], path + '.' + key, diff);
    });
    Object.keys(before).forEach(function (key) {
      if (!(key in next)) {
        if (records) diff.removed.push(key);
        else diff.fields.push(path + '.' + key);
      }
    });
    return previous &&
      Object.keys(before).length === Object.keys(result).length &&
      Object.keys(result).every(function (key) {
        return result[key] === before[key];
      })
      ? previous
      : result;
  }
  diff.fields.push(path);
  return next;
}
function projectReadState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  if (value.load === 'error' || value.load === 'stale') return 'error';
  const states = Object.values(value).map(projectReadState);
  return states.includes('error') ? 'error' : value.load === 'loading' || states.includes('loading') ? 'loading' : '';
}
function receiveProjectData(next) {
  const previous = projectHeldData,
    held = Object.assign({}, previous),
    diffs = {};
  let changed = false;
  Object.keys(next).forEach(function (owner) {
    const diff = { added: [], changed: [], removed: [], orderChanged: false, fields: [] };
    held[owner] = receiveProjectValue(previous[owner], next[owner], owner, diff);
    if (held[owner] !== previous[owner]) changed = true;
    ['added', 'changed', 'removed', 'fields'].forEach(function (key) {
      diff[key] = Array.from(new Set(diff[key]));
    });
    diffs[owner] = diff;
    if (['sources', 'general', 'trash', 'desktop'].includes(owner) && held[owner] !== previous[owner]) {
      const error = next[owner].error || next[owner].viewError;
      if (error) dataError(owner, error);
      else dataOk(owner);
    }
  });
  if (changed) {
    projectHeldData = held;
    chatDataSnapshot = projectionSource(Object.assign({}, chatDataSnapshot, { project: held }), '');
    const beforeFailures = previous.readFailures || {},
      failures = held.readFailures || {};
    Object.keys(Object.assign({}, beforeFailures, failures)).forEach(function (owner) {
      const failure = failures[owner],
        state = projectReadState(held[owner]);
      if (held[owner] === previous[owner] && failure === beforeFailures[owner]) return;
      // Existing read-error/retry components own this failure without a second toast.
      if (state === 'error') return;
      if (!failure || projectReadState(previous[owner]) === 'error') dataOk(owner);
      else if (beforeFailures[owner] !== failure) dataError(owner, failure);
    });
    syncWorkspace();
    syncChatOwners();
  }
  if (next.desktop && held.desktop !== previous.desktop)
    S.desktopUpdate = projectDesktop(held.desktop).desktopUpdateState;
  return diffs;
}
// The sources a project push changed, as reads name them: a changed field by its full path; collection entries
// added, changed or removed name the whole owner (their ids need not match the read path).
function pushProjectData(next) {
  const diffs = receiveProjectData(next);
  if (
    Object.keys(diffs).some(function (owner) {
      const d = diffs[owner];
      return d.added.length || d.changed.length || d.removed.length || d.orderChanged || d.fields.length;
    })
  )
    chatDataRender();
  return diffs;
}
function bindOwnerProjections() {
  VM.eval = function () {
    return projectEvaluation().eval;
  };
  VM.voice = function () {
    return projectVoice().voice;
  };
  VM.cafeWsVoice = function () {
    return projectVoice().cafeWsVoice;
  };
  VM.cafeMemory = function () {
    return projectMemory().cafeMemory;
  };
}
