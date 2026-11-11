'use strict';
const PR_CHANGES = new Map();
const WORK_COVERS = new Map();
function workPrTarget(work) {
  const match = /^([^#]+)#(\d+)$/.exec(work.ref);
  return {
    kind: 'github-pr',
    v: 1,
    repoFullName: match[1].toLowerCase(),
    prNumber: Number(match[2]),
    worktreeId: projectData('reviews').worktreeId,
    threadId: work.threadId || null,
  };
}
function prTargetKey(target) {
  return encodeURIComponent(
    JSON.stringify([target.kind, target.v, target.repoFullName, target.prNumber, target.worktreeId, target.threadId]),
  );
}
function prDiffFiles(data) {
  const patches = data.diff.split(/^diff --git /m).slice(1);
  return data.changedFiles.map(function (file) {
    const patch = patches.find(function (part) {
        return part.split('\n')[0].endsWith('b/' + file.path);
      }),
      hunks = [];
    if (patch)
      patch.split('\n').forEach(function (line) {
        if (/^@@/.test(line)) hunks.push([line, []]);
        else if (hunks.length && /^[ +\-]/.test(line)) hunks[hunks.length - 1][1].push([line[0], line.slice(1)]);
      });
    const lines = hunks.flatMap(function (hunk) {
      return hunk[1];
    });
    return Object.assign({}, file, {
      st: { modified: 'M', added: 'A', removed: 'D', renamed: 'R' }[file.status],
      add: lines.filter(function (line) {
        return line[0] === '+';
      }).length,
      del: lines.filter(function (line) {
        return line[0] === '-';
      }).length,
      diff: { hunks: hunks, mode: S.ws.diffMode },
    });
  });
}
function prChangesVM(target) {
  const key = prTargetKey(target);
  if (projectionNeeded) projectionNeeded.add('prChanges:' + key);
  if (!PR_CHANGES.has(key)) PR_CHANGES.set(key, { target: target, load: 'loading' });
  const state = PR_CHANGES.get(key);
  return Object.assign({}, state, { files: state.data ? prDiffFiles(state.data) : [] });
}
A.prChangesRead = async function (d) {
  const key = prTargetKey(d.target),
    source = 'prChanges:' + key;
  const previous = PR_CHANGES.get(key),
    state = { target: d.target, load: previous && previous.data ? '' : 'loading', data: previous && previous.data };
  PR_CHANGES.set(key, state);
  chatDataRender();
  try {
    const data = await api.get(
      d.target.threadId ? '/api/workspace/chat-pull-request-changes' : '/api/workspace/pull-request-changes',
      { target: key },
    );
    if (heldNeeded.has(source) && PR_CHANGES.get(key) === state)
      Object.assign(state, {
        data: receiveProjectValue(state.data, data, 'prChanges.data', {
          added: [],
          changed: [],
          removed: [],
          orderChanged: false,
          fields: [],
        }),
        load: '',
      });
  } catch (error) {
    if (PR_CHANGES.get(key) === state) Object.assign(state, { data: null, load: 'error', error: error.message });
  }
  return chatDataRender();
};
function detailsWork(id) {
  const source = projectData('reviews');
  const works = source.artifacts.works.concat(
    source.global.works,
    source.recentOwners,
    source.openedWork ? [source.openedWork.artifact] : [],
  );
  return works.find(function (work) {
    return workKey(work) === id;
  });
}
A.workPrChanges = function (d) {
  S.ws.prTarget = workPrTarget(detailsWork(d.id));
  return A.open({ node: 'git', anchor: 'panel' });
};
A.prChangesClose = function () {
  S.ws.prTarget = null;
  render(true);
};
function workCoverKey(reference) {
  return encodeURIComponent(JSON.stringify(reference));
}
function workCoverVM(reference) {
  const key = workCoverKey(reference);
  if (projectionNeeded) projectionNeeded.add('workCover:' + key);
  if (!WORK_COVERS.has(key)) WORK_COVERS.set(key, { reference: reference, load: 'loading', value: null });
  return WORK_COVERS.get(key).value;
}
async function workCoverRead(reference) {
  const key = workCoverKey(reference),
    state = WORK_COVERS.get(key);
  try {
    const value = await api.get('/api/works/cover', reference);
    if (heldNeeded.has('workCover:' + key)) Object.assign(state, { value: value, load: '' });
  } catch (error) {
    Object.assign(state, { value: null, load: 'error', error: error.message });
  }
  return chatDataRender();
}
api.on('sources:needed', function (diff) {
  diff.added.forEach(function (source) {
    if (source.indexOf('prChanges:') === 0)
      settleHold(A.prChangesRead({ target: PR_CHANGES.get(source.slice('prChanges:'.length)).target }));
    if (source.indexOf('workCover:') === 0)
      settleHold(workCoverRead(WORK_COVERS.get(source.slice('workCover:'.length)).reference));
    if (source.indexOf('workCoverEditor:') === 0) settleHold(readCoverEditor(S.ws.cover));
  });
});
onStart('late', function () {
  const refresh = function () {
    heldNeeded.forEach(function (source) {
      if (source.indexOf('workCover:') === 0)
        settleHold(workCoverRead(WORK_COVERS.get(source.slice('workCover:'.length)).reference));
      if (source.indexOf('workCoverEditor:') === 0) settleHold(readCoverEditor(S.ws.cover));
    });
  };
  window.addEventListener('cat-cafe:work-cover-changed', refresh);
  window.addEventListener('cat-cafe:entrusted-work-projection-invalidated', refresh);
});
async function readCoverEditor(state) {
  try {
    const values = await Promise.all([
      api.get('/api/works/cover', state.reference),
      api.get('/api/works/cover/candidates', state.reference),
    ]);
    if (S.ws.cover === state)
      Object.assign(state, { cover: values[0], candidates: values[1].candidates, load: '', error: '' });
  } catch (error) {
    Object.assign(state, { load: 'error', error: error.message, errorStatus: error.status });
  }
  return chatDataRender();
}
A.workCoverOpen = function (d) {
  const previous = S.ws.cover;
  if (previous && previous.id === d.id && previous.operation) {
    dialog({ kind: 'workCover' });
    return;
  }
  const work = detailsWork(d.id);
  S.ws.cover = {
    id: d.id,
    reference: { contentRef: work.work.contentRef, ownerRevision: work.work.ownerRevision },
    cover: null,
    candidates: [],
    load: 'loading',
    previousCoverRevision: previous && previous.id === d.id ? previous.previousCoverRevision : null,
    error: '',
  };
  dialog({ kind: 'workCover' });
  if (heldNeeded.has('workCoverEditor:' + d.id)) return settleHold(readCoverEditor(S.ws.cover));
};
VM.workCover = function () {
  if (projectionNeeded) projectionNeeded.add('workCoverEditor:' + S.ws.cover.id);
  return S.ws.cover;
};
A.workCoverSave = async function (d) {
  const state = S.ws.cover,
    candidate = d.key
      ? state.candidates.find(function (row) {
          return row.key === d.key;
        })
      : null;
  const choice =
    d.choice ||
    (candidate
      ? { mode: 'image', pick: candidate.pick }
      : d.mode === 'restore'
        ? { mode: 'restore', coverRevision: state.previousCoverRevision }
        : { mode: 'frame' });
  if (!state.operation)
    state.operation = {
      action: 'set-cover',
      reference: state.reference,
      operationId: crypto.randomUUID(),
      expectedCoverRevision: state.cover.coverRevision,
      choice: choice,
    };
  try {
    const result = await api.post('/api/works/cover', {}, { command: state.operation });
    state.previousCoverRevision = state.cover.coverRevision;
    state.cover = result.cover;
    state.operation = null;
    state.error = '';
    WORK_COVERS.set(workCoverKey(state.reference), { reference: state.reference, value: result.cover, load: '' });
    window.dispatchEvent(new CustomEvent('cat-cafe:work-cover-changed', { detail: state.reference }));
  } catch (error) {
    state.error = error.message;
    state.errorStatus = error.status;
    if (error.status >= 400 && error.status < 500) state.operation = null;
    if (error.status === 409) state.cover = await api.get('/api/works/cover', state.reference);
    dialog({ kind: 'workCover' });
    render(true);
    return false;
  }
  dialog({ kind: 'workCover' });
  render(true);
  return true;
};
A.workCoverUpload = function () {
  PLATFORM.pickFile('image/png,image/jpeg,image/webp', async function (file) {
    const form = new FormData();
    form.append('file', file);
    try {
      const result = await api.post('/api/uploads/work-cover', {}, form);
      return A.workCoverSave({ choice: { mode: 'image', pick: { kind: 'upload', uploadUrl: result.url } } });
    } catch (error) {
      S.ws.cover.error = error.message;
      S.ws.cover.errorStatus = error.status;
      dialog({ kind: 'workCover' });
      render(true);
    }
  });
};
