'use strict';
function bindSetup() {
  VM.guide = function () {
    const guide = projectData('replay') && replayModels().guide;
    return guide && Object.assign({}, guide, { items: guide.items.map(chatMessageVM) });
  };
  A.guideReplay = function () {
    return chatAction('guideOpen', { language: S.lang });
  };
  const member = WHO_DATA.member;
  WHO_DATA.member = function (id, name) {
    const actors = projectData('replay') && replayGuideActors();
    return actors && actors[id] ? actors[id] : member(id, name);
  };
  const form = FORMS.cafeModal,
    select = CHANGES.cafeSel,
    pop = VM.chatPop;
  const cats = function () {
    return chatRead('memberSettings').cats.filter(function (c) {
      return (
        ['anthropic', 'openai', 'opencode'].indexOf(c.clientId) >= 0 &&
        !(c.identityProtection && c.identityProtection.kind === 'builtin-cloud')
      );
    });
  };
  const members = function (tool) {
    return cats().filter(function (c) {
      return c.clientId === tool;
    });
  };
  A.importOpen = async function () {
    const available = cats(),
      tool = available.length ? available[0].clientId : '';
    CS.modal = {
      kind: 'import',
      tool: tool,
      cat: available.length ? available[0].id : '',
      sessions: [],
      sel: null,
      verify: null,
      sessLoad: 'loading',
      error: '',
      pin: false,
    };
    CS.f['im-id'] = '';
    CS.f['im-title'] = '';
    await A.cafeImRefresh();
    render(true);
  };
  A.cafeImRefresh = async function () {
    const m = CS.modal;
    m.sessLoad = 'loading';
    render(true);
    if (!m.cat) {
      m.sessLoad = 'empty';
      return;
    }
    try {
      m.sessions = (await api.get('/api/local-sessions/' + encodeURIComponent(m.cat))).sessions;
      m.sessLoad = m.sessions.length ? '' : 'empty';
      m.error = '';
    } catch (error) {
      m.sessLoad = 'error';
      m.error = error.message;
    }
    render(true);
  };
  SET_AFTER['cs.modal.sel'] = function () {
    if (CS.modal.kind === 'import') CS.modal.verify = null;
  };
  const field = INPUTS.cafeField;
  INPUTS.cafeField = function (e) {
    field(e);
    if (CS.modal && CS.modal.kind === 'import' && e.target.id === 'im-id') {
      CS.modal.verify = null;
      CS.modal.sel = null;
      render(true);
    }
  };
  A.cafeImVerify = async function () {
    const m = CS.modal,
      id = CS.f['im-id'].trim();
    try {
      m.sel = null;
      m.verify = (
        await api.get('/api/local-sessions/' + encodeURIComponent(m.cat) + '/' + encodeURIComponent(id))
      ).session;
      m.error = '';
    } catch (error) {
      m.verify = null;
      m.error = error.message;
    }
    render(true);
  };
  CHANGES.cafeSel = async function (e) {
    const m = CS.modal;
    if (!m || m.kind !== 'import' || ['im-cat', 'im-tool'].indexOf(e.target.id) < 0) return select(e);
    if (e.target.id === 'im-tool') {
      m.tool = e.target.value;
      const options = members(m.tool);
      m.cat = options.length ? options[0].id : '';
    } else m.cat = e.target.value;
    m.sel = null;
    m.verify = null;
    await A.cafeImRefresh();
  };
  MODALS.import = function (m) {
    const options = members(m.tool),
      first = options[0];
    return {
      vm: {
        tool: m.tool,
        tools: [
          ...new Set(
            cats().map(function (c) {
              return c.clientId;
            }),
          ),
        ],
        cats: options.map(function (c) {
          return c.id;
        }),
        cat: m.cat,
        sessLoad: m.sessLoad,
        sessions: m.sessions.map(function (s) {
          return {
            id: s.sessionId,
            first: s.firstPrompt,
            proj: s.projectPath,
            ago: s.lastActivityAt,
            alreadyBound: s.alreadyBound,
            boundThread: s.boundThread,
          };
        }),
        selected: m.sel,
        manualId: CS.f['im-id'],
        verify: m.verify ? { ok: true, proj: m.verify.projectPath, ago: m.verify.lastActivityAt } : null,
        firstCat: first ? { id: first.id, name: first.displayName, handle: first.id } : null,
        verifyTool: m.tool,
        err: m.error,
        pin: m.pin,
      },
      submitDisabled: !m.cat || !(m.sel || m.verify),
      submit: true,
    };
  };
  FORMS.cafeModal = async function () {
    const m = CS.modal;
    if (!m || m.kind !== 'import') return form();
    m.busy = true;
    m.error = '';
    render(true);
    try {
      const s =
        m.verify ||
        m.sessions.find(function (s) {
          return s.sessionId === m.sel;
        });
      await chatPort.action('sessionImport', {
        value: JSON.stringify({
          catId: m.cat,
          sessionId: s.sessionId,
          projectPath: s.projectPath,
          firstPrompt: s.firstPrompt,
        }),
        title: CS.f['im-title'],
        pinned: String(!!m.pin),
      });
      CS.modal = null;
    } catch (error) {
      m.error = error.message;
    } finally {
      m.busy = false;
      render(true);
    }
  };
  function pickerData() {
    const source = projectData('workbench');
    return source && source.projectPicker;
  }
  function cafeProjectVM(path) {
    if (projectionNeeded) projectionNeeded.add('projectSetup:' + path);
    const picker = pickerData(),
      reading = picker && picker.setup[path];
    if (!reading) return { path: path, load: 'loading' };
    if (reading.load) return { path: path, load: reading.load };
    const setup = reading.directory,
      index = reading.index,
      snoozed = !!index.snoozed_until && Date.parse(index.snoozed_until) > Date.now(),
      git = setup.isEmptyDir && !setup.isGitRepo ? { available: setup.gitAvailable, off: !setup.gitAvailable } : null,
      preparation =
        !snoozed && ['missing', 'stale', 'failed', 'building'].includes(index.status)
          ? { state: index.status, busy: index.status === 'building' }
          : null;
    return git || preparation ? { path: path, load: '', git: git, index: preparation } : null;
  }
  async function startBrowse(path) {
    const receipt = await chatAction('projectBrowse', { path: path || '' });
    if (receipt === false) return false;
    CS.ppRoot = receipt.directory.current;
    CS.ppPick = null;
    render(true);
    return true;
  }
  const popPage = A.popPage;
  A.popPage = function (d) {
    if (CS.pop && CS.pop.kind === 'projPick' && d.v === 'browse') {
      CS.pop.page = 'browse';
      return startBrowse();
    }
    if (popPage) return popPage(d);
  };
  api.on('sources:needed', function (diff) {
    diff.added.forEach(function (source) {
      if (source.indexOf('projectSetup:') === 0)
        settleHold(chatAction('cafeProjectPrepare', { path: source.slice(13), op: 'refresh' }));
      if (source.indexOf('projectDirectory:') === 0)
        settleHold(chatAction('projectDirectory', { path: source.slice(17) }));
    });
  });
  VM.chatPop = function () {
    const vm = pop();
    if (!CS.pop || CS.pop.kind !== 'projPick' || CS.pop.page !== 'browse') return vm;
    const picker = pickerData(),
      nodes = {};
    Object.entries(S.folds['tree:ppTree'] || {}).forEach(function (entry) {
      if (entry[1] && projectionNeeded) projectionNeeded.add('projectDirectory:' + entry[0]);
    });
    if (picker && picker.browse) {
      Object.keys(picker.directories).forEach(function (path) {
        nodes[path] = picker.directories[path].entries.map(function (entry) {
          return { name: entry.name, path: entry.path, dir: true, selected: CS.ppPick === entry.path, source: 'fs' };
        });
      });
      nodes[''] = nodes[picker.browse.current].concat(
        picker.drives.map(function (drive) {
          return { name: drive.label, path: drive.path, dir: true, source: 'drive' };
        }),
      );
    }
    const restriction = (picker && CS.ppPick && (picker.directories[CS.ppPick] || {}).projectRestriction) || '';
    return Object.assign({}, vm, {
      browse: {
        root: picker && picker.browse ? picker.browse.current : '',
        nodes: nodes,
        completions:
          picker && picker.completions.prefix === CS.f['pp-path']
            ? picker.completions.entries
                .filter(function (entry) {
                  return entry.isDirectory;
                })
                .map(function (entry) {
                  return { path: entry.path, name: entry.name };
                })
            : [],
        // a browsed folder the host says cannot become a project (the runtime folder): browse only
        restriction: restriction,
        noPick: !CS.ppPick || !!restriction,
      },
    });
  };
  SET_AFTER['cs.ppRoot'] = function (path) {
    return startBrowse(path);
  };
  FORMS.cafePathGo = function () {
    return startBrowse(val('pp-path'));
  };
  INPUTS.cafePathComplete = function (e) {
    const prefix = e.target.value;
    CS.f['pp-path'] = prefix;
    return chatAction('cafePathComplete', { prefix: prefix, cwd: CS.ppRoot });
  };
  A.cafePathPick = async function (d) {
    if (!(await startBrowse(d.path))) return false;
    CS.ppRoot = CS.ppPick = CS.f['pp-path'] = d.path;
    CS.pathCompletions = [];
    S.folds['tree:ppTree'] = {};
    S.treeLoaded.ppTree = {};
    render(true);
  };

  A.cafeProjectClone = function (d) {
    dialog({
      kind: 'projectClone',
      args: { path: d.path },
      on: function () {
        return chatPort.action('cafeProjectClone', { path: d.path, gitCloneUrl: val('dlg-in') });
      },
    });
  };
  A.cafeProjectPrepare = function (d) {
    return chatAction('cafeProjectPrepare', d);
  };
  ['index:progress', 'index:complete', 'index:failed'].forEach(function (event) {
    api.on(event, function (data) {
      const picker = pickerData();
      if (picker && heldNeeded.has('projectSetup:' + data.projectPath))
        return chatAction('cafeProjectPrepare', { path: data.projectPath, op: 'refresh' });
    });
  });
  const composer = VM.chatComposer;
  VM.chatComposer = function () {
    const model = S.route === 'home' ? projectChat(projectChatData(), CS, chatDataSnapshot).chatComposer : composer(),
      data = projectChatData(),
      path =
        data.threadId === 'default'
          ? data.newProjectId
          : data.threads.find(function (t) {
              return t.id === data.threadId;
            })?.projectPath;
    return Object.assign({}, model, { preflight: path && path !== 'default' ? cafeProjectVM(path) : null });
  };
  A.cafeUseFolder = async function () {
    await chatPort.action('newProject', { id: CS.ppPick });
    CS.pop = null;
    render(true);
  };
  A.dirNew = async function (d) {
    const name = val('dlg-in');
    if (!name) return false;
    const r = await chatPort.action('projectMkdir', { path: d.p, name: name });
    CS.ppPick = r.createdPath;
    render(true);
    return true;
  };
}
