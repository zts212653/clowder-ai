/* Project-owned data and action bindings for the copied declarations. */
'use strict';
const projectFiles = {};
const projectWorks = {};
function projectData(owner) {
  const project = chatDataSnapshot.project;
  return project && project[owner];
}
function projectChatData() {
  const fields = {
    get input() {
      if (projectionNeeded) projectionNeeded.add('chat.input');
      return CS.draft['chat-input'];
    },
    get threads() {
      return sidebarData().threads;
    },
    get projectPins() {
      return new Set(sidebarData().projectPins);
    },
    get projectNames() {
      return new Map(sidebarData().projectNames);
    },
    fileUrl: api.file,
    get cloudRecoveries() {
      return Object.fromEntries(
        Object.entries(chatDataSnapshot.chat.cloudRecoveries || {}).map(function (entry) {
          const value = entry[1];
          return [entry[0], Object.assign({}, value, { controller: value })];
        }),
      );
    },
  };
  return new Proxy(chatDataSnapshot.chat, {
    get: function (source, key) {
      return key in fields ? fields[key] : source[key];
    },
  });
}
function syncWorkspace() {
  if (CS.workspace) {
    S.ws = CS.workspace.workbench;
    S.pv = CS.workspace.preview;
    S.ws.wk = CS.workspace.reviews.works;
    CS.ws = CS.workspace.reviews.text;
  }
  const bench = projectData('workbench'),
    replay = projectData('replay');
  if (bench) S.ws.wt = bench.workspace.worktreeId || '';
  if (replay) {
    const engine = replay.engine;
    S.rp = {
      source: replay.source,
      at: engine.currentIndex,
      on: engine.state === 'playing' || replay.typingMs !== null,
      speed: String(engine.speed),
      skip: engine.adaptivePacing,
      mode: engine.displayMode,
    };
  }
}
function panelScoped(key) {
  return !!PANEL_VIEWS[key] && PANEL_VIEWS[key][2] === 'thread';
}
function panelShown(key) {
  return !panelScoped(key) || PDL_SPACES[panelSpace()].threadRoutes.indexOf(S.route) >= 0;
}
function projectFileKey(data) {
  const key = 'file:' + JSON.stringify([data.w, data.p]);
  projectFiles[key] = data;
  PANEL_VIEWS[key] = [data.p.split('/').pop(), 'file', '', 'file', data.p];
  PANELS[key] = function () {
    return pdlView('file.body');
  };
  return key;
}
/* Dialog required-field binding. */
function dlgNeed(dd, ids, msg) {
  const miss = ids.filter(function (id) {
    return !val(id);
  });
  if (!miss.length) return false;
  S.dialog = dd;
  miss.forEach(function (id) {
    FIELD_ERR[id] = msg || tc('common.required');
  });
  render(true);
  focusField(miss[0]);
  return true;
}
function receiveTerminalOutput(data) {
  const source = projectData('terminal'),
    output = source.mine.id === data.id ? source.mine : source.outputs[data.id];
  output.output += data.data;
}
function bindProject() {
  const homeSections = [
    ['members', 'member.title', { ref: 'members' }],
    ['profiles', 'profiles.title', { ref: 'profiles' }],
    ['accounts', 'accounts.title', { ref: 'accounts' }],
    ['skills', 'Skill', { ref: 'skills' }],
    ['mcp', 'MCP', { ref: 'mcp' }],
    ['plugins', 'ext.title', { ref: 'ext' }],
    ['marketplace', 'mcp.market', { ref: 'market' }],
    ['voice', 'voice.title', { ref: 'voice' }],
    ['system', 'env.title', { ref: 'system' }],
    ['rules', 'rules.title', { ref: 'rules' }],
    ['notify', 'system.notify', { page: 'notify' }],
    ['ops', 'workbench.panels.ops', { node: 'ops', anchor: 'panel' }],
    ['appearance', 'system.theme', { ref: 'appearance' }],
  ];
  api.on('home:inspect', function () {
    if (document.hidden) return null;
    return {
      route: location.pathname + location.search,
      threadId: S.route === 'chat' && chatPort.threadId !== 'default' ? chatPort.threadId : null,
      composer: false,
      sections: homeSections.map(function (row) {
        return { id: row[0], labelKey: row[1] };
      }),
    };
  });
  api.on('home:execute', async function (grant) {
    if (grant.kind !== 'navigate') return false;
    const target = grant.action;
    let args;
    if (target.kind === 'settings') {
      const section = homeSections.find(function (row) {
        return row[0] === target.sectionId;
      });
      if (!section) return false;
      args = section[2];
    } else if (target.kind === 'thread') return (await A.threadOpen({ id: target.threadId })) !== false;
    else return false;
    return (await A.open(args)) !== false;
  });
  api.on('workspace:navigate', async function (event) {
    if (event.action !== 'knowledge-feed') return (await A.wsFile({ p: event.path, w: event.worktreeId })) !== false;
    pathSet('cs.m.view', 'library');
    return A.wsTool({ k: 'mem' }) !== false;
  });
  api.on('preview:auto-open', function () {
    return A.wsTool({ k: 'preview' }) !== false;
  });
  api.on('terminal:output', receiveTerminalOutput);
  api.on('thread:teleport', function (event) {
    if (event.threadId === chatPort.threadId) go('chat');
    return A.msgJump({ t: event.threadId, mid: event.messageId });
  });
  api.on('notification:toast', function (event) {
    toast(
      [event.title, event.message].filter(Boolean).join(' · '),
      event.action
        ? {
            label: event.action.label,
            act: 'msgJump',
            data: { t: event.action.threadId, mid: event.action.messageId },
          }
        : null,
      event.type === 'error' ? 'danger' : event.type === 'success' ? 'ok' : null,
    );
  });

  syncWorkspace();
  beforeRender(function () {
    const focused = navFocusC(),
      frame = navTop(focused).f,
      panel = rtCur('panel');
    [
      ['ops', 'gov', 'govPath'],
      ['evolution', 'sub', 'evoId'],
      ['signals', 'sub', 'sigDetail'],
      ['team', 'sub', 'teamSub'],
    ].forEach(function (item) {
      const inFocus = frame === item[0] || frame === 'ws.' + item[0];
      if (inFocus || panel === item[0])
        S.ws[item[2]] = navArg(item[1], inFocus ? focused : navTabKey('panel', item[0])) || null;
    });
    if (S.ws.evoId) {
      S.ws.evoReading[S.ws.evoId] ||= { view: 'judge', stage: null, decision: '', notice: '' };
    }
  });
  S.sys = store.get('sys', { record: 'collapsed' });
  S.lang = store.get('lang', 'zh');
  CS.recordExpanded = S.sys.record === 'expanded';
  S.lastPanel = 'home';
  S.wsQ = '';
  Object.defineProperty(S, 'panel', {
    configurable: true,
    get: function () {
      return rtCur('panel');
    },
    set: function (value) {
      if (value == null) {
        navTabs('panel').open = false;
        return;
      }
      rtEnsure('panel', value);
      rtShow('panel', value);
    },
  });
  A.workbench = function () {
    if (S.panel && !panelScoped(S.panel)) {
      S.panel = null;
      render(true);
    } else ENGINE_PARTS.openTab('panel', S.lastPanel);
  };
  // path / v: set one state before opening (the find's query into the works search), as open does
  A.wsTool = function (d) {
    if (d.path) pathSet(d.path, d.v, d);
    return ENGINE_PARTS.openTab('panel', d.k, {
      from: null,
      preview: false,
      args: d.view == null ? null : { view: d.view },
    });
  };
  A.wsReopen = function () {
    const key = navTabCur('panel');
    return ENGINE_PARTS.openTab('panel', key && PANEL_VIEWS[key] && panelShown(key) ? key : S.lastPanel);
  };
  A.wsPop = function (d, el) {
    S.ws.pop = S.ws.pop === d.v ? null : d.v;
    if (S.ws.pop && !(el && el.closest)) {
      render(true);
      popAnchorAt('ws.launcher', '.ws-headacts [data-act="wsPop"], [data-act="wsPop"][data-v="launcher"]');
    }
    render(true);
    if (S.ws.pop === 'launcher') focusField('ws-q');
  };
  A.dirOpen = function (d) {
    S.ws.dir = d.p;
    if (S.panel !== 'files') return A.wsTool({ k: 'files' });
    render(true);
  };
  INPUTS.wsQ = function (e) {
    S.wsQ = e.target.value;
    render(true);
  };
  REGION_TABS.panel.chromeVM = function () {
    return { width: S.ws.width, launcherOpen: S.ws.pop === 'launcher', wide: !!S.panelWide, focus: !!S.ws.focus };
  };
  REGION_TABS.panel.visible = panelShown;
  SET_AFTER['s.panel'] = function (value) {
    if (value == null) S.panelWide = false;
  };

  [
    ['workbench', workbenchModels, ['tasks', 'files', 'git', 'filePage', 'cafeWsRecall']],
    ['home', homeModels, ['live', 'execDetail']],
    ['recentWorks', recentWorksModels, ['recentWorks']],
    ['board', boardModels, ['hubPanel']],
    ['schedule', scheduleModels, ['schedule']],
    ['terminal', terminalModels, ['terminal']],
    ['preview', previewModels, ['preview']],
    ['reviews', reviewsModels, ['works', 'worksAll', 'mediaReview', 'contentModification']],
    ['canon', canonModels, ['assetCanon']],
    ['film', filmModels, ['cafeWsClips', 'filmProject', 'filmPreview']],
  ].forEach(function (binding) {
    binding[2].forEach(function (name) {
      VM[name] = function () {
        return projectData(binding[0]) ? binding[1]()[name] : null;
      };
    });
  });
  STATE_ROOTS.ws = function () {
    return S.ws;
  };
  STATE_ROOTS.wc = STATE_ROOTS.ws;
  STATE_ROOTS.pv = function () {
    return S.pv;
  };
  STATE_ROOTS.ss = function () {
    return Object.assign(CS.voice, ACCOUNT_STATE);
  };
  ['voice', 'memory', 'system', 'works'].forEach(function (key) {
    PAGES[key] = function () {
      return pdlView(key === 'memory' ? 'cafe.memory' : 'page.' + key);
    };
  });

  VM.system = function () {
    const desktop = projectDesktop(),
      native = desktop.desktopSystem,
      general = projectGeneral().systemGeneral,
      system = chatRead('system');
    return Object.assign({}, system, native, {
      load: general ? general.load : '',
      v: {
        lang: S.lang === 'en' ? 'en' : 'zh-Hans',
        record: S.sys.record,
        send: general ? general.send : null,
      },
      legacyRoute: S.route !== 'system',
      help: {},
      update: native && native.update,
    });
  };
  CHANGES.sysPick = function (event) {
    const key = event.target.dataset.k,
      value = event.target.value;
    if (key === 'send') return chatAction('systemSend', { v: value });
    if (key === 'lang') {
      S.lang = value === 'en' ? 'en' : 'zh';
      store.set('lang', S.lang);
    }
    if (key === 'record') {
      S.sys.record = value;
      CS.recordExpanded = value === 'expanded';
      store.set('sys', S.sys);
    }
    render(true);
  };
  A.desktopUpdate = function (data) {
    const state = S.desktopUpdate,
      prompt = state && state.prompt;
    if (data.op === 'check') return chatAction('desktop:check');
    if (data.op === 'download' && prompt && prompt.kind === 'available' && !state.progress)
      return chatAction('desktop:action', { action: 'download', version: prompt.version });
    if (data.op === 'install' && prompt && prompt.kind === 'ready-to-install')
      dialog({
        kind: 'desktopInstall',
        args: { version: prompt.version },
        on: function () {
          return chatPort.action('desktop:action', { action: 'install', version: prompt.version });
        },
      });
  };
  SET_AFTER['s.desktopUpdate.settings.autoCheck'] = function (value) {
    return chatAction('desktop:autoCheck', { autoCheck: value });
  };

  VM.wsMore = function () {
    const ts = navTabs('panel');
    return {
      home: S.panel === 'home',
      focus: !!S.ws.focus,
      tabCount: ts.list.length,
      split: !!ts.split,
      closable: ts.list.filter(function (t) {
        return t.k !== S.panel && !tabPinned('panel', t.k);
      }).length,
      unpinned: ts.list.filter(function (t) {
        return !tabPinned('panel', t.k);
      }).length,
    };
  };
  const filePage = VM.filePage;
  VM.filePage = function () {
    const model = filePage(),
      docs = documentModels();
    return model
      ? Object.assign({}, model, { documentReview: docs.documentReview, annotations: docs.documentAnnotations })
      : null;
  };
  PAGES.trash = function () {
    return pdlView('cafe.trash');
  };

  VM.cafeTrash = function () {
    const model = projectTrash().cafeTrash;
    return model ? Object.assign({}, model, { navHidden: CS.navHidden }) : null;
  };
  ENT.trashRestore = {
    coll: function () {
      const model = projectTrash().cafeTrash;
      return model ? model.items : [];
    },
    remove: function (item) {
      return chatAction('trashRestore', { id: item.id });
    },
  };
  const panels = {
    exec: 'ws.exec',
    tasks: 'ws.tasks',
    files: 'ws.files',
    git: 'ws.git',
    recall: 'cafe.ws.recall',
    voice: 'cafe.ws.voice',
    'works-t': 'ws.works',
    mem: 'cafe.memory',
    clips: 'cafe.ws.clips',
    terminal: 'ws.terminal',
    home: 'works.recent',
    live: 'ws.live',
    board: 'ws.board',
    schedule: 'ws.schedule',
    eval: 'ws.eval',
    signals: 'cafe.ws.signals',
    team: 'cafe.ws.team',
    ops: 'cafe.ws.ops',
    replay: 'ws.replay',
    evolution: 'cafe.ws.evolution',
    preview: 'ws.preview',
  };
  Object.keys(panels).forEach(function (key) {
    PANELS[key] = function () {
      return pdlView(panels[key]);
    };
  });
  VM.cafeWsRecall = function () {
    if (!projectData('workbench')) return null;
    const model = workbenchModels().cafeWsRecall;
    return Object.assign({}, model, {
      groups: model.filtered
        ? model.groups.filter(function (g) {
            return g.key === model.filterFor;
          })
        : model.groups,
    });
  };
  SET_AFTER['ws.recallFor'] = function () {
    return chatAction('recallBrowse');
  };
  A.recallOpen = function (d) {
    const item = chatRead('chatStream').items[+d.i];
    S.ws.recallFor = item && item.mid;
    S.ws.recallExpected = item ? Number(item.meta.recall) : 0;
    return ENGINE_PARTS.openTab('panel', 'recall');
  };
  A.execOpen = function (d) {
    return chatAction('homeExecOpen', d).then(function (result) {
      if (result !== false) ENGINE_PARTS.openTab('panel', 'live');
    });
  };

  A.opForceReset = function (d) {
    dialog({
      kind: 'opForceReset',
      on: function () {
        return chatAction('opForceReset', { threadId: d.threadId });
      },
    });
  };

  A.worksMore = function () {
    return chatAction('worksMore');
  };
  A.worksRestart = function () {
    return chatAction('worksRestart');
  };

  A.wsRefluxDelete = function (d) {
    return chatAction('wsRefluxDelete', d);
  };
  A.pvDiscovered = function (d) {
    return chatAction('pvDiscovered', d);
  };
  A.rpAnnotate = function (d) {
    return chatAction('rpAnnotate', d);
  };
  SET_AFTER['ws.execDetail'] = function (value) {
    if (!value) return chatAction('homeExecClose');
  };
  A.opLiveStop = function (d) {
    const run = homeModels().live.runs.find(function (x) {
      return x.key === d.k;
    });
    if (!run) return;
    dialog({
      kind: 'opLiveStop',
      args: { name: run.actions.name, command: run.actions.cmd, activity: run.actions.activity },
      on: function () {
        return chatAction('opLiveStop', d);
      },
    });
  };
  A.cancelHoldWait = function (d) {
    return chatAction('cancelHoldWait', d);
  };
  PDL_GUARDS['live.stop'] = function (ctx) {
    return ctx.cancel && ctx.cancel.state !== 'cancelable' ? ctx.cancel.reason : '';
  };
  A.goThread = function (d) {
    return chatAction('thread', { id: d.id || d.k }).then(function (result) {
      if (result !== false) go('chat');
    });
  };
  A.sourceOpen = function (d) {
    CS.lb = null;
    return A.goThread({ id: d.t });
  };
  SET_AFTER['ws.hbItem'] = function () {
    return chatAction('boardSelect');
  };
  SET_AFTER['ws.hbView'] = SET_AFTER['ws.hbItem'];
  SET_AFTER['ws.boardV'] = function () {
    return chatAction('boardBrowse');
  };
  CHANGES.wsExtSec = function (e) {
    S.ws.extSec = e.target.value;
    return chatAction('boardBrowse');
  };
  A.wsExtImport = function (d) {
    return chatAction('wsExtImport', d);
  };
  A.wsImportProject = function () {
    dialog({
      kind: 'wsImportProject',
      on: function () {
        return chatAction('boardImportProject', {
          name: val('dlg-n'),
          path: val('dlg-p'),
          backlog: val('dlg-b'),
          description: val('dlg-d'),
        });
      },
    });
  };
  const openBoardDialog = A.dialog;
  A.dialog = async function (d) {
    if (d.kind === 'vote')
      return dialog({
        kind: 'vote',
        args: { question: d.question || '' },
        on: function () {
          return A.voteStart(this);
        },
      });
    if (!['intent', 'triage', 'reflux', 'clarification', 'slice', 'hbSelfClaim', 'frame'].includes(d.kind))
      return openBoardDialog(d);
    if (d.kind === 'hbSelfClaim') return A.hbClaimDialog(d);
    if (d.kind === 'frame') {
      const fields = boardModels().boardFrame,
        owner = boardModels().boardFrameId;
      return dialog({
        kind: 'frame',
        args: fields,
        on: function () {
          return chatAction('boardFrameSave', {
            id: owner,
            values: JSON.stringify(
              Object.fromEntries(
                ['sponsor', 'motivation', 'successMetric', 'constraints', 'currentWorkflow', 'provenanceMap'].map(
                  function (k, i) {
                    return [k, val('dlg-q' + i)];
                  },
                ),
              ),
            ),
          });
        },
      });
    }
    if (d.kind === 'triage') {
      const card = projectData('board').external.detail.cards.find(function (c) {
        return c.id === d.cardId;
      });
      return dialog({
        kind: 'triage',
        args: Object.assign({}, d, { values: card.triage || {}, hasValues: !!card.triage }),
      });
    }
    return A[d.kind](d);
  };
  A.intent = function (d) {
    dialog({ kind: 'intent', args: d });
  };
  A.intentSave = function (d) {
    const keys = [
        'actor',
        'contextTrigger',
        'goal',
        'objectState',
        'successSignal',
        'nonGoal',
        'sourceTag',
        'sourceDetail',
        'decisionOwner',
        'confidence',
        'originalText',
      ],
      body = Object.fromEntries(
        keys.map(function (k) {
          return [k, val('intent-' + k)];
        }),
      ),
      required = keys.filter(function (k) {
        return k !== 'sourceTag';
      });
    if (
      required.some(function (k) {
        return !body[k].trim();
      })
    ) {
      dialog({ kind: 'intent', args: Object.assign({}, d, { values: body, hasValues: true }) });
      dlgNeed(
        S.dialog,
        required.map(function (k) {
          return 'intent-' + k;
        }),
      );
      return false;
    }
    body.confidence = +body.confidence;
    return chatAction('wsIntentSave', { projectId: d.projectId, body: JSON.stringify(body) });
  };
  A.triageSave = function (d) {
    const keys = ['clarity', 'groundedness', 'necessity', 'coupling'],
      body = Object.fromEntries(
        keys.map(function (k) {
          return [k, val('triage-' + k)];
        }),
      );
    body.sizeBand = val('triage-sizeBand');
    if (
      keys.some(function (k) {
        return !body[k].trim();
      })
    ) {
      dialog({ kind: 'triage', args: Object.assign({}, d, { values: body, hasValues: true }) });
      dlgNeed(
        S.dialog,
        keys.map(function (k) {
          return 'triage-' + k;
        }),
      );
      return false;
    }
    keys.forEach(function (k) {
      body[k] = +body[k];
    });
    return chatAction('wsTriageSave', { projectId: d.projectId, cardId: d.cardId, body: JSON.stringify(body) });
  };
  A.reflux = function (d) {
    let dd;
    dialog({
      kind: 'reflux',
      on: function () {
        if (dlgNeed(dd, ['reflux-title', 'reflux-insight', 'reflux-evidence'])) return false;
        return chatAction('wsRefluxSave', {
          projectId: d.projectId,
          body: JSON.stringify(
            Object.fromEntries(
              ['category', 'title', 'insight', 'evidence'].map(function (k) {
                return [k, val('reflux-' + k)];
              }),
            ),
          ),
        });
      },
    });
    dd = S.dialog;
  };
  A.clarification = function (d) {
    let dd;
    dialog({
      kind: 'clarification',
      on: function () {
        const op = picked('clarification-op');
        if (op === 'answer' && dlgNeed(dd, ['clarification-answer'])) return false;
        return chatAction('wsClarifySave', {
          projectId: d.projectId,
          id: d.id,
          op: op,
          answer: val('clarification-answer'),
        });
      },
    });
    dd = S.dialog;
  };
  A.slice = function (d) {
    const x = d.id
        ? projectData('board').external.detail.slices.find(function (x) {
            return x.id === d.id;
          })
        : {},
      values = Object.assign(
        {
          name: '',
          description: '',
          actor: '',
          workflow: '',
          verifiableOutcome: '',
          sliceType: 'learning',
          status: 'planned',
        },
        x,
        { cardIds: x.cardIds || [] },
      );
    let dd;
    dialog({
      kind: 'slice',
      args: { editing: !!d.id, values: values },
      on: function () {
        if (
          dlgNeed(
            dd,
            ['name', 'description', 'actor', 'workflow', 'verifiableOutcome'].map(function (k) {
              return 'slice-' + k;
            }),
          )
        )
          return false;
        const body = Object.fromEntries(
          ['name', 'description', 'actor', 'workflow', 'verifiableOutcome', 'cardIds', 'sliceType', 'status'].map(
            function (k) {
              return [k, val('slice-' + k)];
            },
          ),
        );
        body.cardIds = body.cardIds
          .split(',')
          .map(function (v) {
            return v.trim();
          })
          .filter(Boolean);
        if (d.id) delete body.sliceType;
        else delete body.status;
        return chatAction('wsSliceSave', { projectId: d.projectId, id: d.id, body: JSON.stringify(body) });
      },
    });
    dd = S.dialog;
  };
  A.hbClaimDialog = async function (d) {
    await chatAction('boardDialog', Object.assign({}, d, { kind: 'hbSelfClaim' }));
    const source = projectData('board'),
      item = source.items.find(function (it) {
        return it.id === d.k;
      });
    return dialog({ kind: 'hbSelfClaim', args: Object.assign({}, d, { title: item.title }) });
  };
  VM.hbClaimForm = function () {
    const source = projectData('board'),
      req = source.dialog;
    return {
      values: {},
      hasValues: false,
      cats: projectChatData().cats.map(function (c) {
        return { id: c.id, name: c.displayName, handle: c.mentionPatterns[0] || '' };
      }),
      scope: '',
      f: req && req.args.f,
      k: req && req.args.k,
      title: req
        ? source.items.find(function (it) {
            return it.id === req.args.k;
          }).title
        : '',
    };
  };
  A.hbClaimSave = function (d) {
    const values = Object.fromEntries(
      ['catId', 'why', 'plan', 'requestedPhase'].map(function (k) {
        return [k, val('claim-' + k)];
      }),
    );
    if (!values.catId || !values.why || !values.plan) {
      dialog({
        kind: 'hbSelfClaim',
        args: Object.assign({}, d, {
          values: values,
          hasValues: true,
          scope: values.catId ? projectData('board').dialog.scopes[values.catId] : '',
        }),
      });
      dlgNeed(S.dialog, ['claim-catId', 'claim-why', 'claim-plan']);
      return false;
    }
    return chatAction('hbSelfClaim', { id: d.k, body: JSON.stringify(values) });
  };
  A.wsTriage = function (d) {
    return A.dialog(Object.assign({ kind: 'triage' }, d));
  };
  CHANGES.hbClaimCat = function (e) {
    S.dialog.args.values = {
      catId: e.target.value,
      why: val('claim-why'),
      plan: val('claim-plan'),
      requestedPhase: val('claim-requestedPhase'),
    };
    S.dialog.args.hasValues = true;
    S.dialog.args.scope = projectData('board').dialog.scopes[e.target.value];
    render(true);
  };
  A.hubSliceOrder = function (d) {
    return chatAction('hubSliceOrder', {
      projectId: boardModels().hubPanel.ext.projectId,
      keys: JSON.stringify(d.keys),
    });
  };
  A.featOpen = function (d) {
    S.ws.boardV = 'list';
    S.folds['row:hub'] = d.k;
    S.ws.hbItem = '';
    render(true);
  };
  ENT.hbItem = {
    get: function (id) {
      return boardModels().boardItems.find(function (x) {
        return x.id === String(id).split('/').pop();
      });
    },
    set: function (item, field, v) {
      return chatAction('hbLease', { k: item.id, v: v });
    },
  };
  SET_AFTER['ws.zoomBy'] = function (value) {
    const n = Number(value);
    S.ws.zoom = n === 0 ? 1 : Math.max(0.3, Math.min(1.5, S.ws.zoom + n * 0.2));
    if (n === 0) S.ws.pan = [0, 0];
  };
  A.wsPan = function (d) {
    S.ws.pan = [-d.x, -d.y];
  };
  A.hbSuggest = function (d) {
    const item = boardModels().boardItems.find(function (it) {
      return it.id === d.k;
    });
    let dd;
    dialog({
      kind: 'hbSuggest',
      args: { title: item.title },
      on: function () {
        if (dlgNeed(dd, ['dlg-cat', 'dlg-why', 'dlg-plan'])) return false;
        return chatAction(
          'hbSuggest',
          Object.assign({}, d, { cat: val('dlg-cat'), why: val('dlg-why'), plan: val('dlg-plan') }),
        );
      },
    });
    dd = S.dialog;
  };
  A.hbApprove = function (d) {
    return chatAction('hbApprove', d);
  };
  A.hbReject = function (d) {
    dialog({
      kind: 'hbReject',
      on: function () {
        return chatAction('hbReject', Object.assign({}, d, { note: val('dlg-note') }));
      },
    });
  };
  A.feat = function () {
    dialog({ kind: 'feat' });
  };
  A.featSave = function () {
    const values = { title: val('dlg-tt'), summary: val('dlg-s'), priority: val('dlg-p'), tags: val('dlg-g') };
    if (!values.title || !values.summary) {
      dialog({ kind: 'feat', args: { values: values, hasValues: true } });
      dlgNeed(S.dialog, ['dlg-tt', 'dlg-s']);
      return false;
    }
    return chatAction('boardCreate', values);
  };

  A.wsImportBacklog = function () {
    dialog({
      kind: 'wsImportBacklog',
      on: function () {
        return chatAction('wsImportBacklog');
      },
    });
  };
  CHANGES.opDutySave = function (e) {
    return A.opDutySave(Object.assign({}, e.target.dataset, { v: e.target.value }));
  };
  CHANGES.opDomCat = function (e) {
    return A.opDomCat(e.target.dataset);
  };
  A.opDutySave = function (d) {
    return chatAction('opDutySave', d);
  };
  A.opDomCat = function (d) {
    return chatAction('opDomCat', { k: d.k, v: val('op-dom-' + d.k, true) });
  };
  CHANGES.wsOpsSec = function (e) {
    S.ws.opsView = e.target.value;
    S.ws.rtView = null;
    return chatAction('opsBrowse');
  };
  CHANGES.wsToolCat = function (e) {
    S.ws.toolCat = e.target.value;
    return chatAction('opsBrowse');
  };
  CHANGES.wsToolType = function (e) {
    S.ws.toolType = e.target.value;
    return chatAction('opsBrowse');
  };
  CHANGES.wsToolRange = function (e) {
    S.ws.toolRange = +e.target.value;
    return chatAction('opsBrowse');
  };
  ['ws.lbRange', 'ws.obsV', 'ws.rtPage'].forEach(function (path) {
    SET_AFTER[path] = function () {
      return chatAction('opsBrowse');
    };
  });
  ['ws.rtView', 'ws.rtTab'].forEach(function (path) {
    SET_AFTER[path] = function () {
      S.ws.rtPage = 1;
      return chatAction('opsBrowse');
    };
  });
  SET_AFTER['ws.gov'] = function () {
    return chatAction('opsGovSelection');
  };
  INPUTS.opsGovSkills = function (e) {
    S.ws.gov.sk = e.target.value;
    return chatAction('opsGovSelection');
  };
  CHANGES.wsBrakeMin = function (e) {
    return chatAction('opsBrakeSet', { k: 'thresholdMinutes', v: e.target.value });
  };
  [
    'opsBrakeSet',
    'brakeCheckin',
    'opEvalRun',
    'filmSync',
    'evoSubset',
    'wsGovPrev',
    'wsGovApply',
    'wsScan',
    'wsRescue',
  ].forEach(function (name) {
    A[name] = function (d) {
      return chatAction(name, d);
    };
  });
  A.brakeShow = function (ev) {
    const form = {
      kind: 'brakeAsk',
      args: { minutes: ev.minutes, level: ev.level, bypassDisabled: ev.bypassDisabled },
      on: function () {
        const choice = picked('brake-choice');
        const reason = ev.bypassDisabled ? '' : val('dlg-in');
        if (choice === 'continue' && !reason.trim()) {
          throw new Error(tc('hub.detail.reason'));
        }
        if (ev.preview) return;
        return chatPort.action('brakeCheckin', { choice: choice, reason: reason });
      },
    };
    dialog(form);
  };
  api.on('brake:show', A.brakeShow);
  A.wsBrakePreview = function () {
    A.brakeShow({ level: 1, minutes: projectOps().opsBrakeSettings.thresholdMinutes, preview: true });
  };
  A.govOpen = function (d) {
    S.ws.govPath = d.v;
    S.ws.gov = {};
    const at = navFocusC();
    return chatAction('opsGovSelection').then(function () {
      navOpen({ f: navTop(at).f, a: { gov: d.v }, into: at, push: true });
    });
  };
  ['rpReview', 'rpArch'].forEach(function (field) {
    SET_AFTER['ws.' + field] = function (value) {
      return chatAction('routingPolicySet', { field: field, value: value });
    };
  });
  VM.cafeWsOps = function () {
    return projectOps().cafeWsOps;
  };
  VM.theater = function () {
    if (!projectData('replay')) return null;
    const m = replayModels().theater;
    if (!m) return null;
    return Object.assign({}, m, { items: m.items.map(chatMessageVM) });
  };
  function evoRows(values) {
    return values.map(function (x) {
      return { title: x };
    });
  }

  function evoPreparationVM(p) {
    if (!p.preparation) return null;
    const sections = p.preparation.sections,
      result = {};
    const current = function (key) {
      return sections[key].current;
    };
    const map = current('object_map'),
      success = current('success_contract'),
      measurement = current('measurement_plan'),
      baseline = current('baseline_diagnosis');
    const body = function (submission) {
      return submission && submission.submission ? submission.submission.body : null;
    };
    const source = function (submission) {
      return submission && submission.messageId
        ? { source: true, linkKind: 'message', threadId: submission.threadId, messageId: submission.messageId }
        : null;
    };
    const objectBody = body(map);
    result.objectMap = objectBody
      ? {
          goal: objectBody.goalStatement === p.program.displayName ? '' : objectBody.goalStatement,
          summary: objectBody.summary !== objectBody.goalStatement ? objectBody.summary : '',
          revision: map.ref.version,
          nextAction: objectBody.nextAction,
          unknowns: evoRows(objectBody.unknowns),
          source: source(map),
          items: objectBody.items.map(function (item) {
            const decision = item.decision,
              input = decision && decision.responsibility && decision.responsibility.input;
            return {
              id: item.itemId,
              title: item.label,
              choiceState: decision ? decision.state : '',
              choice: decision,
              decider: decision && decision.responsibility ? decision.responsibility.kind : null,
              approvalAnchor: input || null,
              status: item.modifiability.state,
              scope: item.scope,
              why: item.why,
              modifiability: item.modifiability,
              nextAction: item.nextAction,
              sources: (map.evidenceSources || [])
                .filter(function (e) {
                  return e.sourceKey === item.itemId;
                })
                .flatMap(function (e) {
                  return e.refs
                    .filter(function (r) {
                      return r.status === 'available' && r.threadId && r.messageId;
                    })
                    .map(function (r) {
                      return { source: true, linkKind: 'message', threadId: r.threadId, messageId: r.messageId };
                    });
                })
                .concat(
                  input
                    ? [
                        {
                          choiceSource: true,
                          linkKind: 'message',
                          threadId: input.threadId,
                          messageId: input.messageId,
                        },
                      ]
                    : [],
                ),
            };
          }),
        }
      : { items: [], unknowns: [], unavailable: true };
    const successBody = body(success);
    result.success = successBody
      ? {
          summary: successBody.summary,
          revision: success.ref.version,
          source: source(success),
          criteria: successBody.criteria.map(function (c) {
            return {
              id: c.criterionId,
              text: c.label,
              title: c.label,
              sub: c.utilityClaim !== c.label ? c.utilityClaim : '',
              evidenceRefs: c.gtSourceKeys,
              observationUnit: c.observationUnit,
              estimator: c.estimator,
              counterexample: c.counterexample,
              validityBounds: c.validityBounds,
              nextAction: c.nextAction,
            };
          }),
        }
      : { criteria: [], unavailable: true };
    const measureBody = body(measurement);
    result.measurement = measureBody
      ? {
          summary: measureBody.summary,
          revision: measurement.ref.version,
          source: source(measurement),
          gtSources: measureBody.gtSources.map(function (g) {
            return {
              title: g.label,
              sub: g.validity.detail,
              collection: g.collection,
              validity: g.validity,
              missingOrDisputed: g.missingOrDisputed,
              sources: (measurement.evidenceSources || [])
                .filter(function (e) {
                  return e.sourceKey === g.sourceKey;
                })
                .flatMap(function (e) {
                  return e.refs
                    .filter(function (r) {
                      return r.status === 'available' && r.threadId && r.messageId;
                    })
                    .map(function (r) {
                      return { source: true, linkKind: 'message', threadId: r.threadId, messageId: r.messageId };
                    });
                }),
            };
          }),
          conditions: measureBody.conditions.map(function (c) {
            return { title: c.label, sub: c.scope, modifiability: c.modifiability };
          }),
          comparison: measureBody.comparison,
          unknowns: evoRows(measureBody.unknowns),
        }
      : { gtSources: [], conditions: [], comparison: [], unknowns: [], unavailable: true };
    const baselineBody = body(baseline);
    result.baseline = baselineBody
      ? {
          summary: baselineBody.summary,
          source: source(baseline),
          facts: baselineBody.facts.map(function (f) {
            return { title: f.label, sub: f.limitation };
          }),
          explanations: baselineBody.competingExplanations.map(function (e) {
            return { title: e.hypothesis, sub: e.discriminatingNextStep };
          }),
        }
      : { unavailable: true, facts: [], explanations: [] };
    return result;
  }

  const evolutionStages = [
    'constituting',
    'instrumenting',
    'observing',
    'evaluating',
    'attributing',
    'awaiting_intervention',
    'awaiting_approval',
    'writing_back',
    'revalidating',
    'deciding',
  ];
  function evolutionSource(ref, label, href) {
    const u = href && /^\/thread\//.test(href) ? new URL(href, 'https://owner.invalid') : null;
    return {
      title: label,
      ref: ref,
      linkKind: u ? 'message' : href && /^https?:\/\//.test(href) ? 'url' : 'none',
      threadId: u && decodeURIComponent(u.pathname.slice('/thread/'.length)),
      messageId: u && (u.searchParams.get('messageId') || u.searchParams.get('message')),
      url: href,
    };
  }
  function evolutionUseVM(p, raw) {
    if (!raw || !raw.catalog) return { unavailable: true, versions: [], receipts: [], observations: [], unknowns: [] };
    const catalog = raw.catalog,
      selected = raw.selected,
      current = raw.versions.filter(function (v) {
        return v.sourceCurrent;
      }),
      parent = current.length === 1 && current[0].parents.length === 1 ? current[0].parents[0] : null,
      title = function (ref) {
        const v = catalog.versions.find(function (v) {
          return projectRefIdentity(v.versionRef) === projectRefIdentity(ref);
        });
        return { title: v && v.title, hasTitle: !!(v && v.title) };
      };
    return {
      unavailable: false,
      receipt:
        selected &&
        selected.uses.find(function (u) {
          return u.use === 'applied';
        }),
      currentTitles: raw.versions
        .filter(function (v) {
          return v.adopted;
        })
        .map(function (v) {
          return { title: v.title, hasTitle: !!v.title };
        }),
      selected: !!selected,
      selectedTitle: selected ? title(selected.versionRef) : null,
      diff: raw.diff ? raw.diff.summary : '',
      receipts: selected
        ? selected.uses.map(function (u) {
            return Object.assign(evolutionSource(u.receiptRef, '', u.ownerHref), {
              use: u.use,
              receipt: u,
              occurredAt: Date.parse(u.occurredAt),
            });
          })
        : [],
      observations: selected
        ? selected.evidence.map(function (e) {
            return Object.assign(evolutionSource(e.evidenceRef, e.label, e.ownerHref), {
              evidence: true,
              hasTitle: !!e.label,
              status: e.status,
              verified: e.status === 'verified',
            });
          })
        : [],
      rollback: parent ? { programId: p.program.programId, versionRef: JSON.stringify(parent) } : null,
      versions: catalog.versions.map(function (v) {
        return {
          title: v.title,
          hasTitle: !!v.title,
          programId: p.program.programId,
          versionRef: JSON.stringify(v.versionRef),
          parentRef: v.parentEdges.map(function (e) {
            return e.parentVersionRef;
          }),
        };
      }),
      unknowns: catalog.blockers || [],
    };
  }
  function evolutionDetail(models) {
    const id = S.ws.evoId,
      p = models.evolutionOwner;
    if (!p) return { unavailable: true };
    const program = p.program,
      reading = S.ws.evoReading[id],
      view = reading.view,
      actualStage = evolutionStages.indexOf(program.stage),
      stage = reading.stage == null ? actualStage : +reading.stage;
    const preparation = evoPreparationVM(p),
      exploration = models.evolutionExploration,
      use = evolutionUseVM(p, models.evolutionAssets),
      change = p.lineage && p.lineage.current;
    const d = {
      id: id,
      name: program.displayName,
      hasName: !!program.displayName,
      unavailable: false,
      cycle: program.cycle,
      view: view,
      sub: p.origin ? p.origin.title : '',
      paused: program.lifecycle === 'paused',
      notice: reading.notice,
      lifecycle: {
        mutable: program.lifecycle === 'active' || program.lifecycle === 'paused',
        revision: program.sequence,
        canPause: program.lifecycle === 'active',
        canResume: program.lifecycle === 'paused',
      },
      stage: stage,
      actualStage: actualStage,
      owner: p,
      preparation: preparation,
      exploration: exploration,
      use: use,
      useReceipt: use.receipt,
      progressRequest: {
        owner: p.origin ? p.origin.createdByCatId : null,
        canRequest:
          program.lifecycle === 'active' &&
          program.stage !== 'awaiting_approval' &&
          !!p.origin &&
          !!p.origin.createdByCatId,
        deliveryState: reading.progressReceipt ? reading.progressReceipt.status : '',
      },
      renaming: !!S.renaming && S.renaming.entity === 'evo' && S.renaming.id === id,
    };
    d.judge = {
      change: {
        proposalRef: change ? change.proposalRef : null,
        expectedRevision: program.sequence,
        status: change ? change.status : '',
        stage: program.stage,
        refs: change || null,
        receipt: change ? change.outcomeReceiptRef || change.interventionReceiptRef || null : null,
        notice: reading.notice,
        canDecide: models.evolutionCanDecide,
        canReview: !!change && !!p.origin,
        canSync:
          program.lifecycle === 'active' &&
          !!change &&
          (change.status === 'pending' || ['writing_back', 'revalidating'].indexOf(program.stage) >= 0),
      },
      headline: p.attribution ? p.attribution.headline : '',
      evidence: p.attribution
        ? p.attribution.evidence.map(function (e) {
            return evolutionSource(e, e.label);
          })
        : [],
      competing: p.attribution
        ? p.attribution.competingAttributions.concat(p.attribution.notAssessedLayers).map(function (e) {
            return { title: e.label };
          })
        : [],
      unknowns: p.attribution
        ? evoRows(
            p.attribution.whyNotChange.concat(
              p.attribution.gate.blockers.map(function (b) {
                return b.label;
              }),
            ),
          )
        : [],
      eyes: p.observation
        ? p.observation.connectedEyes.map(function (e) {
            return evolutionSource(e.ownerSurfaceRef, e.sourceKind, e.ownerHref);
          })
        : [],
      gaps: p.observation
        ? p.observation.gaps.map(function (e) {
            return { title: e.message };
          })
        : [],
      nextEvaluation:
        p.observation && p.observation.nextEvaluationAt ? Date.parse(p.observation.nextEvaluationAt) : null,
      decide: reading.decision,
    };
    d.hist = {
      preparation: p.preparation
        ? Object.values(p.preparation.sections).flatMap(function (s) {
            return s.history.concat(s.current ? [s.current] : []).map(function (entry) {
              return {
                ref: entry.ref,
                revision: entry.ref.version,
                state: entry.status,
                sourceAnchor: entry.messageId ? { threadId: entry.threadId, messageId: entry.messageId } : null,
                canOpen: !!entry.messageId,
                title: entry.submission ? entry.submission.title : '',
                submission: entry.submission,
                section: entry.section,
              };
            });
          })
        : [],
      versions: use.versions,
      rounds: p.cycles.map(function (c) {
        return { cycle: c.cycle, decision: c.decision, at: c.closedAt || c.openedAt };
      }),
    };
    return d;
  }
  VM.cafeWsEvo = function () {
    const models = projectEvolution(),
      m = models.cafeWsEvo;
    if (!m) return null;
    return Object.assign({}, m, { detail: S.ws.evoId ? evolutionDetail(models) : null });
  };

  ENT.evo = {
    get: function () {
      return projectEvolution().evolutionOwner.program;
    },
    name: 'displayName',
    inline: 'evo-name',
    rename: function (program, value) {
      return chatPort.action('evolutionRename', { programId: program.programId, v: value });
    },
  };
  ['evoLifecycle', 'evoChangeSync', 'wsEvoDecide', 'evoRequest'].forEach(function (name) {
    A[name] = function (d) {
      return chatAction(name, d);
    };
  });
  A.wsEvoApprove = function () {
    const p = projectEvolution().evolutionOwner;
    return A.msgJump({ t: p.origin.threadId });
  };
  CHANGES.cafeSel = function (e) {
    if (e.target.id === 'evo-decide') {
      S.ws.evoReading[S.ws.evoId].decision = e.target.value;
      render(true);
    } else return chatAction('evoSelect', { field: e.target.id, v: e.target.value });
  };
  INPUTS.evoRequest = function (e) {
    return chatAction('evoDraft', { v: e.target.value });
  };
  A.evoPublication = function (d) {
    return chatAction('evoPublication', d);
  };
  A.wsEvoNew = function () {
    const threadId = S.route === 'chat' ? S.thread : null;
    if (!threadId) return;
    const operationId = crypto.randomUUID();
    const form = {
      kind: 'wsEvoNew',
      on: function () {
        if (dlgNeed(form, ['dlg-in'])) return false;
        return chatPort.action('evolutionNew', { threadId: threadId, operationId: operationId, v: val('dlg-in') });
      },
    };
    dialog(form);
  };

  A.theater = function (d) {
    S.theater = { thread: d.id || S.thread, storyId: d.storyId };
    return chatAction('replayOpen', { id: S.theater.thread, ...(d.storyId ? { storyId: d.storyId } : {}) });
  };
  A.rpPlay = function () {
    return chatAction('rpPlay');
  };
  VM.replay = function () {
    if (!projectData('replay')) return { load: 'loading', sources: [], source: 'thread', player: null };
    const model = replayModels();
    return Object.assign({}, model.theater.rp, { load: model.theater.load, player: model.theater.player });
  };
  CHANGES.rpSpeed = function (e) {
    return chatAction('rpSpeed', { v: e.target.value });
  };
  CHANGES.rpSource = function (e) {
    return A.rpSource({ v: e.target.value });
  };
  A.rpSource = function (d) {
    return chatAction('rpSource', d);
  };
  INPUTS.rpSeek = function (e) {
    return chatAction('rpSeek', { v: e.target.value });
  };
  [
    ['at', 'rpSeek'],
    ['skip', 'rpSkip'],
    ['mode', 'rpMode'],
  ].forEach(function (pair) {
    SET_AFTER['s.rp.' + pair[0]] = function (value) {
      return chatAction(pair[1], { v: value });
    };
  });
  SET_AFTER['s.theater'] = function (value) {
    if (!value) return chatAction('replayClose');
  };

  let replaySurface = '';
  onRender(function () {
    if (chatPort.exportMids !== undefined) return;
    const guide = !!S.popOn.guide,
      active = guide || S.theater || S.route === 'ws.replay' || (S.panel === 'replay' && space() === panelSpace()),
      id = guide ? 'guide' : active ? (S.theater ? S.theater.thread : S.thread) : '';
    if (id === replaySurface) return;
    replaySurface = id;
    return chatAction(
      guide ? 'guideOpen' : id ? 'replayOpen' : 'replayClose',
      guide
        ? { language: S.lang }
        : id
          ? Object.assign({ id: id }, S.theater && S.theater.storyId ? { storyId: S.theater.storyId } : {})
          : {},
    );
  });
  ['ws.sigView', 'ws.tlDays'].forEach(function (path) {
    SET_AFTER[path] = function () {
      return chatAction('signalBrowse');
    };
  });
  ['St', 'Tier', 'Src'].forEach(function (key) {
    CHANGES['wsSig' + key] = function (e) {
      S.ws['sig' + key] = e.target.value;
      return chatAction('signalBrowse');
    };
  });
  INPUTS.wsSigQ = function (e) {
    S.ws.sigQ = e.target.value;
    return chatAction('signalBrowse');
  };
  A.wsView = function (d) {
    if (d.k === 'works-t') return chatAction('worksScope', { v: d.v });
  };
  CHANGES.wkGroup = function (e) {
    S.ws.wk.group = e.target.value;
    render(true);
  };
  CHANGES.wkCat = function (e) {
    S.ws.wk.cat = e.target.value;
    render(true);
  };
  INPUTS.wkQ = function (e) {
    S.wkQ = e.target.value;
    render(true);
  };
  FORMS.wsSigQ = function () {
    return chatAction('signalBrowse');
  };
  ENT.sig = {
    get: function (id) {
      return projectSignals().signalArticles.find(function (a) {
        return a.id === id;
      });
    },
    status: 'status',
    set: function (a, field, v) {
      return chatAction('signalStatus', { id: a.id, v: v });
    },
    confirm: function (a) {
      return { kind: 'wsSigDel' };
    },
    remove: function (a) {
      return chatPort.action('signalDelete', { id: a.id });
    },
  };
  ENT.src = {
    get: function (id) {
      return id === '*'
        ? {
            id: '*',
            enabled: projectSignals().signalSources.every(function (s) {
              return s.enabled;
            }),
          }
        : projectSignals().signalSources.find(function (s) {
            return s.id === id;
          });
    },
    status: 'enabled',
    set: function (s, field, v) {
      return chatAction('signalSourceStatus', { id: s.id, enabled: v });
    },
  };

  A.wsFetch = function (d) {
    return chatAction('wsFetch', d);
  };
  PANELS.signals = function () {
    return pdlView(navArg('sub') ? 'signal.article' : 'cafe.ws.signals');
  };
  VM.cafeWsSignals = function () {
    return projectSignals().cafeWsSignals;
  };
  SET_AFTER['ws.pod'] = function () {
    return chatAction('signalPod');
  };
  CHANGES.sigNote = function (e) {
    return chatAction('sigNote', { id: e.target.dataset.id, v: e.target.value });
  };
  SET_AFTER['ws.playAll'] = function () {
    return chatAction('signalPlayback');
  };
  A.wsSigRefresh = function (d) {
    return chatAction('wsSigRefresh', d);
  };
  A.wsPodGen = function (d) {
    return chatAction('wsPodGen', d);
  };
  A.wsDiscuss = function (d) {
    return chatAction('wsDiscuss', d).then(function (result) {
      if (result !== false) return A.goThread({ id: projectSignals().signalDiscussion.id });
    });
  };
  ENT.sigLink = {
    get: function (id) {
      return { id: id, k: S.ws.sigDetail };
    },
    add: function (values, d) {
      return chatPort.action('signalLink', { k: d.k, v: values.v });
    },
    remove: function (item) {
      return chatPort.action('signalLink', { k: item.k, v: item.id, op: 'remove' });
    },
  };
  ENT.sigTag = {
    add: function (values, d) {
      return chatPort.action('signalTag', { k: d.k, v: values.v });
    },
  };
  ENT.sigSet = {
    add: function (values, d) {
      return chatPort.action('signalCollection', { k: d.k, v: values.v, op: 'create' });
    },
  };
  CHANGES.wsSetJoin = function (e) {
    if (e.target.value) return chatAction('signalCollection', { k: S.ws.sigDetail, v: e.target.value });
  };

  document.addEventListener('focusout', function (e) {
    const id = e.target.dataset && e.target.dataset.wsNote;
    if (id) return chatAction('signalNote', { k: id, v: e.target.value });
  });
  A.wsSigBatch = function (d) {
    if (d.v !== 'del') return chatAction('signalBatch', d);
    dialog({
      kind: 'wsSigBatchDel',
      args: { count: Object.values(S.ws.sigSel).filter(Boolean).length },
      on: function () {
        return chatAction('signalBatch', d);
      },
    });
  };
  A.wsSigBatchTag = function () {
    let dd = {
      kind: 'wsSigBatchTag',
      args: { count: Object.values(S.ws.sigSel).filter(Boolean).length },
      on: function () {
        if (dlgNeed(dd, ['dlg-in'])) return false;
        return chatAction('signalBatchTag', { v: val('dlg-in') });
      },
    };
    dialog(dd);
    dd = S.dialog;
  };
  function teamReading() {
    return S.ws.teamByThread[S.thread] || (S.ws.teamByThread[S.thread] = { q: '', f: 'all' });
  }
  INPUTS.wsTeamQ = function (e) {
    teamReading().q = e.target.value;
    return chatAction('teamBrowse');
  };
  CHANGES.wsTeamF = function (e) {
    teamReading().f = e.target.value;
    return chatAction('teamBrowse');
  };
  SET_AFTER['ws.teamV'] = function () {
    return chatAction('teamBrowse');
  };
  A.wsSim = function (d) {
    return chatAction('refresh', { k: d.k });
  };
  A.viewRetry = function (d) {
    return d.v === 'cafe.memory' ? chatAction('cafeMemRetry') : A.wsSim(d);
  };
  FORMS.wsSignal = function (form) {
    return chatAction('routingSignalMark', {
      subject: form.dataset.subj,
      state: ['scarce', 'degraded', 'unavailable'][chosenIndex('ws-sig-st2')],
      duration: [3600000, 14400000, 86400000, 604800000][chosenIndex('ws-sig-dur')],
      reason: val('ws-sig-why'),
      note: val('ws-sig-note'),
    });
  };
  ENT.assert = {
    get: function (id) {
      return { id: id };
    },
    set: function (item, field, v) {
      return chatAction('routingSignalClose', { id: item.id, op: v });
    },
  };
  ENT.pref = {
    get: function (id) {
      return projectTeam().teamPreferences.find(function (p) {
        return p.preferenceId === id;
      });
    },
    confirmOn: ['retired'],
    confirm: function () {
      return { kind: 'routingPreferenceRetire' };
    },
    set: function (p) {
      return chatPort.action('routingPreferenceRetire', { id: p.preferenceId, reason: val('dlg-reason') });
    },
  };

  VM.exec = function () {
    if (!projectData('workbench')) return null;
    const model = workbenchModels().exec;
    if (!model) return null;
    const sub = navArg('sub');
    if (sub && model.externalDetail && model.externalDetail.sessionId === sub)
      return { load: model.load, externalDetail: model.externalDetail };
    if (sub) return model.run && model.run.id === sub ? { load: model.load, run: model.run } : { load: 'loading' };
    const out = Object.assign({}, model);
    delete out.run;
    delete out.externalDetail;
    ['now', 'past'].forEach(function (key) {
      out[key] = out[key].map(function (row) {
        return Object.assign({}, row);
      });
    });
    return out;
  };
  VM.cafeWsTeam = function () {
    return projectTeam().cafeWsTeam;
  };
  const git = VM.git;
  VM.git = function () {
    const model = git();
    return model
      ? Object.assign({}, model, {
          groups: model.groups.map(function (group) {
            return Object.assign({}, group, {
              items: group.items.map(function (row) {
                return Object.assign({}, row);
              }),
            });
          }),
        })
      : null;
  };
  const memory = VM.cafeMemory;
  VM.cafeMemory = function () {
    const model = memory();
    return model ? Object.assign({}, model, navArg('detail') ? { all: null } : { detail: null }) : null;
  };
  SET_AFTER['wc.wt'] = function (v) {
    S.ws.dir = '';
    return chatAction('worktree', { v: v });
  };
  SET_AFTER['wc.pane'] = function () {
    return chatAction('terminal:select');
  };
  A.tmReconnect = function () {
    return chatAction('tmReconnect');
  };
  A.opsEnvSet = function (d) {
    return chatAction('opsEnvSet', d);
  };
  A.filmImport = function () {
    PLATFORM.pickFile('application/json,.json', async function (file) {
      let document;
      try {
        document = JSON.parse(await file.text());
      } catch (error) {
        toast(tc('films.invalidFile'));
        return;
      }
      return chatAction('filmImport', { document: document, operationId: crypto.randomUUID() });
    });
  };
  let filmRegistrationDraft = null;
  CHANGES.filmMapping = async function (e) {
    const draft = filmRegistrationDraft;
    try {
      draft.mapping = JSON.parse(await e.target.files[0].text());
      draft.error = '';
    } catch (error) {
      draft.error = error.message;
      fieldErr('film-mapping', tc('films.invalidFile'));
    }
  };
  A.filmRegister = function () {
    filmRegistrationDraft = { mapping: null, error: '', attempt: crypto.randomUUID() };
    dialog({ kind: 'filmRegister' });
  };
  VM.filmRegisterForm = function () {
    return {
      values: {},
      hasValues: false,
      worktrees: workbenchModels().worktrees.map(function (w) {
        return [w.id, w.branch];
      }),
    };
  };
  A.filmRegisterSave = function () {
    const draft = filmRegistrationDraft,
      values = { title: val('film-title'), path: val('film-path'), worktree: val('film-worktree') };
    if (!values.title || !values.path || draft.error) {
      dialog({ kind: 'filmRegister', args: { values: values, hasValues: true } });
      filmRegistrationDraft = draft;
      if (draft.error) fieldErr('film-mapping', tc('films.invalidFile'));
      else dlgNeed(S.dialog, ['film-title', 'film-path']);
      return false;
    }
    return chatPort.action('filmRegister', {
      project: filmModels().filmOwner,
      worktreeId: values.worktree,
      path: values.path,
      title: values.title,
      mapping: draft.mapping,
      attempt: draft.attempt,
    });
  };
  FORMS.pvGo = function () {
    return chatAction('pvGo', { v: val('pv-url') });
  };
  A.pvRetry = function () {
    return chatAction('pvRetry');
  };
  A.pvNav = function (d) {
    return framePost('preview', {
      source: 'cat-cafe-preview',
      type: 'navigate',
      op: d.v === 'fwd' ? 'forward' : d.v,
    });
  };
  A.pvShot = function () {
    return chatAction('pvShot').then(function (result) {
      const url = previewModels().previewReceipt;
      if (result !== false && url) toast(tc('common.done') + ' · ' + url);
    });
  };
  A.pvFrameMessage = function (data, frame, event) {
    return chatAction('pvFrameMessage', { event: event }, frame);
  };
  SET_AFTER['pv.active'] = function () {
    return chatAction('pvTabSelect');
  };
  ENT.pvTab = {
    fields: [],
    get: function (id) {
      return { id: id };
    },
    add: function () {
      return chatPort.action('pvTabAdd', {});
    },
    remove: function (item) {
      return chatPort.action('pvTabClose', { id: item.id });
    },
  };
  ENT.pvLog = {
    coll: function () {
      return previewModels().previewState.console;
    },
    after: function () {
      return chatAction('pvLogClear');
    },
  };
  treeMatch('iframe[data-frame-on-message="pvFrameMessage"]', function (frame) {
    return chatPort.action('previewFrame', {}, frame);
  });
  onRender(function () {
    if (chatPort.exportMids !== undefined) return;
    const worksPage = S.route === 'works',
      worksState = S.ws.wk;
    if (worksState && worksState.page !== worksPage) chatAction('worksPage', { v: String(worksPage) });
  });
  ENT.term = {
    get: function () {
      return { id: terminalModels().terminal.mineId };
    },
    confirm: function () {
      return { kind: 'tmClose' };
    },
    remove: function (item) {
      return chatPort.action('terminal:close', { id: item.id });
    },
  };
  SET_AFTER['wc.qMode'] = function () {
    return chatAction('fileSearch', { q: S.ws.q });
  };
  ['cs.m.cat', 'cs.m.view', 'cs.m.limits.{family}'].forEach(function (path) {
    SET_AFTER[path] = function () {
      return chatAction('memoryBrowse');
    };
  });
  ['win', 'lib', 'rel.{v}', 'brakeRange', 'brakeWord', 'brakeSel', 'type', 'depth', 'limit'].forEach(function (key) {
    SET_AFTER['cs.m.' + key] = function () {
      return chatAction('memoryBrowse');
    };
  });
  SET_AFTER['cs.m.docLimits.{id}'] = function (_, d) {
    return chatAction('libraryDocumentsMore', { id: d.id });
  };
  SET_AFTER['cs.m.node'] = function () {
    return chatAction('memoryGraphNode');
  };

  SET_AFTER['cs.m.more'] = function () {
    return chatAction('memoryRecallMore');
  };
  SET_AFTER['cs.m.curation.enabled'] = function (v) {
    return chatAction('memoryCuration', { v: v });
  };
  FORMS.cafeGraph = function () {
    return chatAction('memoryGraph', { q: val('mem-gq') });
  };
  // arriving with a query (the chat find's 记忆 handoff) runs the memory search
  SET_AFTER['cs.m.searched'] = function (v) {
    CS.m.q = v;
    return chatAction('memorySearch', { q: v });
  };
  FORMS.cafeMemQ = function () {
    return chatAction('memorySearch', { q: CS.m.q });
  };
  INPUTS.cafeMemLimit = function (e) {
    const count = Number(e.target.value);
    if (!Number.isInteger(count) || count < 1 || count > 20) {
      fieldErr('mem-limit', tc('workspaceOwners.limitError'));
      return;
    }
    CS.m.limit = count;
    return chatAction('memoryBrowse');
  };

  A.semanticService = function (d) {
    const service = projectMemory().memoryServices.find(function (s) {
      return s.id === d.id;
    });
    dialog({
      kind: 'semanticService',
      args: {
        id: service.id,
        port: service.port,
        models: service.prerequisites ? service.prerequisites.models : [],
        selectedModel: service.selectedModel,
      },
      on: function () {
        return chatAction('cafeSvc', {
          id: service.id,
          op: 'reconfigure',
          port: val('dlg-port'),
          model: val('dlg-model'),
        });
      },
    });
  };
  const libraryFields = {
    'lib-type': 'kind',
    'lib-name': 'name',
    'lib-disp': 'displayName',
    'lib-root': 'root',
    'lib-vis': 'sensitivity',
  };
  const modalOpen = A.open,
    modalSubmit = FORMS.cafeModal;
  const libraryValues = function () {
    return { name: val('lib-name'), displayName: val('lib-disp'), root: val('lib-root') };
  };
  A.open = function (d, el) {
    if (d.kind !== 'modal' || d.v !== 'lib') return modalOpen(d, el);
    CS.modal = { kind: 'lib', scan: false };
    return chatAction('libraryOpen');
  };
  MODALS.lib = function () {
    const f = projectMemory().memoryLibraryForm;
    return {
      vm: {
        type: f.draft.kind,
        vis: f.draft.sensitivity,
        scan: f.scan,
        created: !!f.created,
        indexStatus: f.created ? f.created.status : '',
      },
      error: f.error,
      submitDisabled: f.busy || !f.scan || !f.scan.safe,
      submit: !f.created,
    };
  };
  SET_AFTER['cs.modal.scan'] = function () {
    return chatAction('libraryScan', libraryValues());
  };
  FORMS.cafeModal = function () {
    return CS.modal && CS.modal.kind === 'lib' ? chatAction('libraryCreate', libraryValues()) : modalSubmit();
  };
  ENT.memCand = {
    get: function (id) {
      return { id: id };
    },
    set: function (item, field, v) {
      return chatPort.action('memoryLibraryDecide', { id: item.id, v: v });
    },
  };

  ENT.coll = {
    get: function (id) {
      return { id: id };
    },
    set: function (item) {
      return chatPort.action('memoryCollection', { id: item.id, op: 'archive' });
    },
  };
  A.cafeMemRebuild = function (d) {
    return d.v === 'all' ? chatAction('cafeMemRebuild', d) : chatAction('memoryCollection', { id: d.v, op: 'rebuild' });
  };
  A.cafeMemWarm = function (d) {
    return chatAction('cafeMemWarm', d);
  };
  ['taste', 'profile', 'person', 'entity', 'event'].forEach(function (key) {
    SET_AFTER['cs.m.limits.' + key] = function () {
      return chatAction('memoryBrowse');
    };
  });
  INPUTS.wcQ = function (e) {
    return chatAction('fileSearch', { q: e.target.value });
  };
  INPUTS.fileDraft = function (e) {
    return chatPort.action('fileDraft', { id: e.target.dataset.id, content: e.target.value });
  };
  formDraft('file', {
    dirty: function () {
      return projectData('workbench') && workbenchModels().fileDraftDirty;
    },
    drop: function () {
      return chatPort.action('fileDrop');
    },
  });
  INPUTS.execQ = function (e) {
    return chatAction('execSearch', { q: e.target.value });
  };
  INPUTS.cafeMemQ = function (e) {
    CS.m.q = e.target.value;
    render(true);
  };

  A.wsFile = function (d) {
    const data = { p: String(d.p).replace(/:\d+(-\d+)?$/, ''), w: d.w || S.ws.wt };
    if (data.p && data.p.startsWith('/')) {
      const owner = workbenchModels()
        .worktrees.filter(function (w) {
          return data.p.startsWith(w.root + '/');
        })
        .sort(function (a, b) {
          return b.root.length - a.root.length;
        })[0];
      if (!owner) {
        toast('文件所属工作区尚未登记');
        return Promise.resolve(false);
      }
      data.p = data.p.slice(owner.root.length + 1);
      data.w = owner.id;
    }
    return chatAction('fileOpen', data).then(function (result) {
      if (result !== false) {
        rtOpen('panel', projectFileKey(data), { preview: !!d.preview });
        render(true);
        return true;
      }
      return false;
    });
  };
  A.fileOpen = function (d) {
    return A.wsFile({ p: d.v || d.p, w: d.w });
  };
  REGION_TABS.panel.afterSwitch = function (key) {
    if (!panelScoped(key)) S.lastPanel = key;
    const data = projectFiles[key],
      model = data && workbenchModels().filePage;
    if (data && (!model || model.filePath !== data.p || model.worktreeId !== data.w)) chatAction('fileOpen', data);
  };
  REGION_TABS.panel.restore = function (key) {
    if (projectFiles[key]) projectFileKey(projectFiles[key]);
  };
  A.wsSub = function (d) {
    const at = (ACT_FROM && trigChain(ACT_FROM).lc) || navFocusC(),
      frame = navTop(at).f,
      sk = frame === d.k || frame === 'ws.' + d.k ? at : navTabKey('panel', d.k);
    if (d.k === 'signals')
      return chatAction('signalOpen', { id: d.v }).then(function (result) {
        if (result !== false)
          navOpen({
            f: navTop(sk).f,
            a: { sub: d.v },
            into: sk,
            push: true,
          });
      });
    if (d.k === 'evolution')
      return chatAction(
        'evolutionOpen',
        Object.assign({ id: d.v }, d.versionRef === undefined ? {} : { versionRef: d.versionRef }),
      ).then(function (result) {
        if (result !== false)
          navOpen({
            f: navTop(sk).f,
            a: { sub: d.v },
            into: sk,
            push: true,
          });
      });
    if (d.k === 'exec')
      return chatAction('execOpen', d).then(function (result) {
        if (result !== false) navOpen({ f: navTop(sk).f, a: { sub: d.v }, into: sk, push: true });
      });
    return navOpen({
      f: navTop(sk).f,
      a: { sub: d.v || null },
      into: sk,
      push: true,
    });
  };
  A.traceMsg = function (d) {
    return A.msgJump({ mid: d.k });
  };
  A.evoVersion = function (d) {
    return A.wsSub({ k: 'evolution', v: d.programId, versionRef: d.versionRef });
  };
  A.runOpen = function (d) {
    ENGINE_PARTS.openTab('panel', 'exec');
    return A.wsSub({ k: 'exec', v: d.k });
  };
  A.externalSession = function (d) {
    const sk = navFocusC();
    return chatAction('externalSessionOpen', d).then(function (result) {
      if (result !== false)
        navOpen({
          f: navTop(sk).f,
          a: { sub: d.sessionId },
          into: sk,
          push: true,
        });
    });
  };
  A.runtimeExternalMore = function (d) {
    return chatAction('runtimeExternalMore', d);
  };
  A.memOpen = function (d) {
    const sk = navFocusC();
    return chatAction('memoryOpen', d).then(function (result) {
      if (result !== false && d.family === 'document' && projectMemory().memoryRecallSources.length > 1)
        return A.menu(
          { menu: 'recallSources', anchor: CS.m.recallAnchor, sources: projectMemory().memoryRecallSources },
          ACT_FROM,
        );
      if (result !== false)
        navOpen({
          f: 'memory',
          a: { detail: { id: d.id, family: d.family } },
          into: sk,
          push: true,
        });
    });
  };
  A.recallSource = function (d) {
    return A.memOpen({ family: 'document', id: d.anchor, collection: d.collection });
  };

  A.wcCreate = function (d) {
    dialog({ kind: 'wcCreate', args: { k: d.k } });
  };
  A.wcCreateSave = function (d) {
    if (!val('dlg-in')) {
      dialog({ kind: 'wcCreate', args: d });
      dlgNeed(S.dialog, ['dlg-in']);
      return false;
    }
    return chatAction('fileCreate', { kind: d.k, path: (S.ws.dir || '') + val('dlg-in') });
  };
  ENT.path = {
    get: function (path) {
      return { path: path, name: path.split('/').pop() };
    },
    title: function () {
      return { kind: 'wcRename' };
    },
    rename: function (item, value) {
      return chatPort.action('fileRename', { path: item.path, v: value });
    },
    confirm: function (item) {
      return { kind: 'wcDelete', args: { name: item.name } };
    },
    remove: function (item) {
      return chatPort.action('fileDelete', { path: item.path });
    },
  };
  A.wcUpload = function () {
    PLATFORM.pickFile('', function (file) {
      chatAction('fileUpload', { file: file });
    });
  };

  [
    'fileAction',
    'fileEdit',
    'fileSave',
    'fileCancel',
    'fileConflict',
    'recallEventsMore',
    'cafeBrakesMore',
    'cafeSvc',
    'wsRiskDetect',
    'hbReclaim',
    'wsRec',
    'transcriptCorrect',
    'meetingShare',
    'meetingAdvisoryMode',
    'meetingDnd',
    'voiceSession',
    'voicePlayback',
    'liveCall',
    'liveCallText',
    'liveShare',
    'svcInstall',
    'workReview',
    'workReviewPrepare',
    'workReviewPick',
    'workReviewEdit',
    'workReviewAdd',
    'workReviewReanchor',
    'workReviewDiscuss',
    'workReviewLocate',
    'reviewJudge',
    'reviewMarkupEdit',
    'contentModify',
    'contentModificationRead',
    'contentModificationCancel',
    'processTalkRead',
    'stCompress',
    'sessionRestore',
    'documentListen',
    'workTextReply',
    'cafeMemRetry',
    'cafeRwRetry',
    'personClaimRetire',
    'assetCanonRead',
    'assetCanonMore',
    'assetCanonReplace',
    'assetCanonUpdate',
    'filmRefresh',
    'filmAssetPreview',
    'filmPreview',
    'signalSegment',
  ].forEach(function (name) {
    A[name] = function (d) {
      return chatAction(name, d);
    };
  });
  ['personClaimSave', 'personEventSave', 'profileSave', 'memoryRecordSave'].forEach(function (name) {
    A[name] = function (d) {
      return Promise.resolve(chatPort.action(name, d)).then(function () {
        render(true);
        return true;
      });
    };
  });
  A.personForget = function (d) {
    if (d.confirmed === true) return chatPort.action('personForget', d);
    dialog({
      kind: 'memoryForget',
      args: { person: true },
      on: async function () {
        if (!ticked('dlg-ck')) throw new Error(tc('chat.notifications.requireAcknowledgment'));
        await A.personForget(Object.assign({}, d, { confirmed: true }));
        navStale();
        navBack(navFocusC());
      },
    });
  };
  A.workOpen = function (d) {
    const widget = (reviewsModels().widgetWorks || []).find(function (row) {
      return row.id === (d.id || d.k);
    });
    if (widget) {
      let key = Object.keys(projectWorks).find(function (k) {
        return projectWorks[k] === widget.id;
      });
      if (!key) key = 'work:' + Object.keys(projectWorks).length;
      projectWorks[key] = widget.id;
      PANEL_VIEWS[key] = [widget.title, 'code', '', 'work', widget.id];
      return chatAction('workOpen', { id: widget.id }).then(function (result) {
        if (result !== false) rtOpen('panel', key);
      });
    }
    return chatAction('workOpen', d);
  };
  PANELS.work = function () {
    return pdlView('page.work');
  };
  A.cafeWidgetRetry = function (d) {
    return chatAction('cafeWidgetRetry', d);
  };

  A.cafeWorkSrc = function (d) {
    const id = projectWorks['work:' + d.i];
    return chatAction('cafeWorkSrc', id ? { id: id } : {}).then(function (result) {
      if (result !== false) {
        CS.lb = null;
        go('chat');
      }
      return result;
    });
  };
  ENT.session = {
    get: function (id) {
      return { id: id };
    },
    remove: function (x) {
      return chatAction('sessionSeal', { k: x.id });
    },
  };
  ENT.sealed = {
    get: function (id) {
      return { id: id };
    },
    set: function (x) {
      return chatAction('sessionRestore', { id: x.id });
    },
  };
  CHANGES.voiceCaptureSource = function (e) {
    return chatAction('voiceCaptureSource', { v: e.target.value });
  };
  CHANGES.workReviewRound = function (e) {
    return chatAction('workReviewPrepare', { round: e.target.value });
  };
  CHANGES.workReviewCompare = function (e) {
    return A.workReviewCompare({ round: e.target.value });
  };
  A.workReviewCompare = function (d) {
    return chatAction('workReviewCompare', d);
  };
  CHANGES.processTalk = function (e) {
    return chatAction('processTalk', { v: e.target.value });
  };
  CHANGES.wcReviewTarget = function (e) {
    S.ws.review.target = e.target.value;
    render(true);
  };
  CHANGES.wcReviewMode = function (e) {
    S.ws.review.mode = e.target.value;
    render(true);
  };
  INPUTS.wcReviewIn = function (e) {
    S.ws.review[e.target.id.slice('wc-rv-'.length)] = e.target.value;
  };
  A.wcReviewStart = function () {
    const choices = workbenchModels().git.nativeTargets;
    if (choices.length <= 1) return chatAction('wcReviewStart');
    dialog({
      kind: 'nativeReviewTarget',
      args: { choices: choices },
      on: function () {
        return chatAction('wcReviewStart', { catId: val('native-review-cat') });
      },
    });
  };
  CHANGES.cafeSel = function (e) {
    if (e.target.id === 'mem-sort') {
      CS.m.sort = e.target.value;
      render(true);
    }
    if (e.target.id === 'mem-src' || e.target.id === 'mem-who') {
      CS.m[e.target.id === 'mem-src' ? 'src' : 'who'] = e.target.value;
      return chatAction('memoryBrowse');
    }
    if (e.target.id.indexOf('cand-') === 0)
      return chatAction('memoryLibraryTarget', { id: e.target.id.slice(5), v: e.target.value });
    if (e.target.id === 'mem-type' || e.target.id === 'mem-depth') {
      CS.m[e.target.id.slice(4)] = e.target.value;
      return chatAction('memoryBrowse');
    }
    if (CS.modal && CS.modal.kind === 'lib' && libraryFields[e.target.id]) {
      const value = e.target.value;
      return chatAction('libraryDraft', { field: libraryFields[e.target.id], v: value });
    }
  };
  INPUTS.workReviewText = function (e) {
    return chatAction('workReviewText', { v: e.target.value });
  };
  INPUTS.workReviewTime = function (e) {
    return chatAction('workReviewTime', { id: e.target.id, v: e.target.value });
  };
  INPUTS.contentModifyPrompt = function (e) {
    CS.contentModification.prompt = e.target.value;
  };
  INPUTS.sttPrompt = function (e) {
    return chatAction('voiceSetting', { kind: 'prompt', v: e.target.value });
  };
  CHANGES.sttLang = function (e) {
    return chatAction('voiceSetting', { kind: 'language', v: e.target.value });
  };
  ENT.svc = {
    get: function (id) {
      return projectVoice().voice.svc[+id];
    },
    status: 'state',
    confirmOn: ['none'],
    confirm: function (service) {
      return { kind: 'serviceUninstall', args: { name: service.name } };
    },
    set: function (x, k, v) {
      const args = { id: x.key, op: v === 'none' ? 'uninstall' : v === 'running' ? 'start' : 'stop' };
      return v === 'none' ? chatPort.action('voiceService', args) : chatAction('voiceService', args);
    },
  };
  ENT.voiceTerm = {
    get: function (id) {
      return { id: id };
    },
    remove: function (x) {
      return chatAction('voiceTerm', { op: 'remove', id: x.id });
    },
    add: function () {
      return chatAction('voiceTerm', { op: 'add', from: val('term-wrong'), to: val('term-right') });
    },
  };
  A.termEditSave = function () {
    return chatAction('voiceTerm', {
      op: 'edit',
      id: CS.voice.termEdit,
      from: val('te-a'),
      to: val('te-b'),
    }).then(function () {
      CS.voice.termEdit = null;
    });
  };
  ENT.reviewAnnotation = {
    get: function (id) {
      return { id: id };
    },
    status: 'state',
    set: function (x, k, v) {
      return chatAction('reviewAnnotation', { id: x.id, v: v });
    },
  };
  ENT.workspaceAnnotation = {
    get: function (id) {
      return { id: id };
    },
    status: 'state',
    set: function (x, k, v) {
      return chatAction('workspaceAnnotation', { id: x.id, v: v });
    },
  };
  ENT.personClaim = {
    get: function (id) {
      return { id: id };
    },
    set: function (x) {
      return chatAction('personClaimRetire', { id: x.id });
    },
  };

  A.profileOpening = function (d) {
    const pending = Promise.resolve()
      .then(function () {
        return chatPort.action('profileOpening', d);
      })
      .then(function (value) {
        render(true);
        return value;
      })
      .catch(function (error) {
        if (error.message === 'memoryOwners.opening.invalid') throw new Error(tc('memoryOwners.opening.invalid'));
        throw error;
      });
    if (d.op === 'cancel')
      return pending.catch(function (error) {
        if (error.name !== 'PdlReadError') toast(error.message, null, 'danger');
        return false;
      });
    return pending;
  };
  A.cafeMemAct = function (d) {
    if (d.op === 'opening') {
      const profile = projectMemory().cafeMemory.detail.profile,
        opening = profile.openingReference;
      let dd = {
        kind: 'memoryEdit',
        args: {
          recordKind: 'opening',
          values: { asOf: opening.asOf },
          excerpts: opening.excerpts.map(function (item, i) {
            return { id: 'memory-excerpt' + i, kind: item.kind, model: item.model, value: item.text };
          }),
        },
        on: function () {
          if (
            dlgNeed(
              dd,
              dd.fields
                .filter(function (f) {
                  return f.req;
                })
                .map(function (f) {
                  return f.id;
                }),
            )
          )
            return false;
          return A.profileOpening({
            op: 'edit',
            id: d.id,
            expectedRevision: d.expectedRevision,
            asOf: val('mem-edit-asOf'),
            texts: opening.excerpts.map(function (_, i) {
              return val('memory-excerpt' + i);
            }),
          });
        },
      };
      dialog(dd);
      dd = S.dialog;
      return;
    }
    if (d.op === 'forget')
      return dialog({
        kind: 'memoryForget',
        args: { person: false },
        on: function () {
          if (!ticked('dlg-ck')) throw new Error(tc('common.required'));
          return chatAction('cafeMemAct', d);
        },
      });
    return chatAction('cafeMemAct', d).then(function (result) {
      const edit = projectMemory().memoryEdit;
      if (result === false || !edit) return;
      let dd;
      dialog({
        kind: 'memoryEdit',
        args: edit,
        on: function () {
          const values = {};
          Object.keys(edit.values).forEach(function (key) {
            values[key] = val('mem-edit-' + key);
          });
          edit.quotes.forEach(function (q, i) {
            values['quote' + i] = val(q.id);
          });
          if (
            dlgNeed(
              dd,
              dd.fields
                .filter(function (f) {
                  return f.req;
                })
                .map(function (f) {
                  return f.id;
                }),
            )
          )
            return false;
          return chatAction('memoryEditSave', { values: JSON.stringify(values) });
        },
      });
      dd = S.dialog;
    });
  };
  ENT.task = {
    get: function (id) {
      return { id: id };
    },
    status: 'status',
    set: function (x) {
      return chatAction('taskStatus', { id: x.id });
    },
  };
  A.task = function () {
    dialog({ kind: 'task' });
  };
  VM.taskForm = function () {
    return { values: {}, hasValues: false, members: chatRead('members') };
  };
  A.taskSave = function () {
    const values = { title: val('dlg-in'), why: val('dlg-why'), owner: val('dlg-who') };
    if (!values.title) {
      dialog({ kind: 'task', args: { values: values, hasValues: true } });
      dlgNeed(S.dialog, ['dlg-in']);
      return false;
    }
    return chatAction('taskCreate', values);
  };
  const previousPop = VM.chatPop;
  VM.chatPop = function () {
    return Object.assign({}, previousPop(), {
      voice: CS.pop && CS.pop.kind === 'voice' ? projectVoice().composerVoice : null,
      sel:
        CS.pop && CS.pop.kind === 'textsel'
          ? {
              work: !CS.pop.mid,
              mid: CS.pop.mid || '',
              canForward: !!CS.pop.mid && !CS.pop.work && !CS.pop.source,
              canAnnotate: true,
            }
          : null,
    });
  };
  VM.mediaPreview = function () {
    return reviewsModels().workPreview || projectChat(projectChatData(), CS, chatDataSnapshot).mediaPreview;
  };
  VM.work = function () {
    const id = projectWorks[PV.tabKey],
      widget =
        id &&
        (reviewsModels().widgetWorks || []).find(function (row) {
          return row.id === id;
        });
    if (id) return widget ? Object.assign({}, widget, { i: PV.tabKey.slice(5) }) : null;
    return reviewsModels().workPreview
      ? reviewsModels().work
      : projectChat(projectChatData(), CS, chatDataSnapshot).mediaPreview;
  };
  A.workDownload = function () {
    const model = VM.mediaPreview();
    return A.download({ source: model.source, name: model.title });
  };
  A.workFileQuote = function (d) {
    return chatAction('workFileQuote', d);
  };
  A.workOpenFile = function (d) {
    CS.lb = null;
    return A.wsFile({ p: d.path, w: d.worktreeId, preview: true });
  };
  A.workTextAnnotate = function (d) {
    return chatAction('workTextAnnotate', d).then(function (result) {
      if (result === false) return false;
      CS.f['an-text'] = '';
      (CS.modal = {
        kind: 'anno',
        onSubmit: function () {
          return A.workTextSave({ body: val('an-text') });
        },
      }),
        render(true);
      focusField('an-text');
      return result;
    });
  };
  A.workTextSave = function (d) {
    return chatPort.action('workTextSave', d);
  };
  A.filmMark = function (d) {
    return chatAction('filmMark', d).then(function (result) {
      if (result !== false) {
        CS.pop = null;
        go('chat');
      }
      return result;
    });
  };
  VM.voteDialog = function () {
    return { question: '', options: '', anonymous: false, timeout: 120 };
  };
  A.voteStart = async function (d) {
    const current = d,
      question = val('vote-question'),
      raw = val('vote-options'),
      options = raw
        .split(/\r?\n/)
        .map(function (v) {
          return v.trim();
        })
        .filter(Boolean),
      timeout = +val('vote-timeout');
    if (!question || !raw) {
      fieldErr(!question ? 'vote-question' : 'vote-options', tc('common.required'));
      return false;
    }
    if (
      options.length < 2 ||
      options.length > 20 ||
      options.some(function (v) {
        return v.length > 100;
      })
    ) {
      fieldErr('vote-options', tc('placement.optionsHelp'));
      return false;
    }
    if (!Number.isInteger(timeout) || timeout < 10 || timeout > 600) {
      fieldErr('vote-timeout', tc('placement.timeout'));
      return false;
    }
    return api.post(
      '/api/threads/' + encodeURIComponent(S.thread) + '/vote/start',
      {},
      {
        question: question,
        options: options,
        anonymous: current.fields.find(function (f) {
          return f.id === 'vote-anonymous';
        }).checked,
        timeoutSec: timeout,
      },
    );
  };
  A.cafeSel = function (d) {
    const selection = CS.pop;
    if (!selection) return;
    if (selection.source && ['ctx', 'quote', 'anno'].includes(d.v)) {
      if (d.v === 'anno')
        return (
          (CS.modal = {
            kind: 'anno',
            onSubmit: function () {
              return chatPort.action('cliQuote', { comment: val('an-text') });
            },
          }),
          render(true)
        );
      return chatAction('cliQuote').then(function () {
        focusField('chat-input');
      });
    }
    if (selection.mid && !selection.source) {
      const args = { op: d.v, selection: JSON.stringify(selection.selection) };
      if (d.v === 'fwd') return A.modal({ v: 'forward', mid: selection.mid, selection: selection.selection });
      if (d.v === 'anno')
        return (
          (CS.modal = {
            kind: 'anno',
            quote: selection.text,
            onSubmit: function () {
              return chatPort.action('messageQuote', Object.assign({}, args, { comment: val('an-text') }));
            },
          }),
          render(true)
        );
      return chatAction('messageQuote', args).then(function (result) {
        if (result !== false) focusField('chat-input');
      });
    }
    if (selection.film && (d.v === 'ctx' || d.v === 'anno')) return A.filmMark(selection.film);
    if (d.v === 'ctx') return A.workFileQuote({ quote: selection.text });
    if (d.v === 'anno') return A.workTextAnnotate({ id: selection.work, quote: selection.text });
  };
  document.addEventListener('mouseup', function () {
    setTimeout(function () {
      const s = window.getSelection();
      if (!s || s.isCollapsed || !s.rangeCount) return;
      const node = s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement,
        cliBox = node.closest('[data-key]'),
        cliMid = node.closest('[data-mid]'),
        cliLeaf =
          cliMid &&
          cliBox &&
          chatRead('chatStream').items.find(function (m) {
            return m.mid === cliMid.dataset.mid;
          }),
        cli =
          cliLeaf &&
          cliLeaf.exec &&
          cliLeaf.exec.groups
            .flatMap(function (g) {
              return g.items;
            })
            .flatMap(function (r) {
              return r.details || [];
            })
            .find(function (r) {
              return r.key === cliBox.dataset.key && r.source;
            }),
        messageBody = node.closest('.cafe-m .msg-body, .cafe-m .bubble'),
        body = cli
          ? cliBox
          : messageBody || node.closest('[data-view="file.body"] .vw-md, [data-view="file.body"] .vw-code'),
        source = documentModels().documentSource;
      if (
        !body ||
        (!messageBody && !cli && !source) ||
        (messageBody && (CS.multi || chatPort.exportMids !== undefined))
      )
        return;
      const text = s.toString().trim();
      if (!text) return;
      const rect = s.getRangeAt(0).getBoundingClientRect();
      const read = cli
        ? chatAction('cliSelection', { mid: cliMid.dataset.mid, source: JSON.stringify(cli.source) }, body)
        : messageBody
          ? chatAction('messageSelection', { mid: messageBody.closest('[data-mid]').dataset.mid }, body)
          : Promise.resolve();
      read.then(function (result) {
        if (result === false) return;
        spotOpen('selection', body, rect, function (spot) {
          if (!messageBody && !cli) CS.pop = { kind: 'textsel', text: text, work: source.work };
          popAnchor('chat.pop', spot);
          render(true);
        });
      });
    }, 0);
  });
  const workCurrent = VM.work;
  VM.work = function () {
    const model = workCurrent(),
      canon = canonModels().canonReference;
    return model
      ? Object.assign({}, model, {
          canon:
            !!canon &&
            !!model.canonReference &&
            canon.contentRef === model.canonReference.contentRef &&
            canon.ownerRevision === model.canonReference.ownerRevision,
        })
      : null;
  };
  const clips = VM.cafeWsClips;
  VM.cafeWsClips = function () {
    const model = clips();
    return model ? Object.assign({}, model, { project: !!navArg('sub') }) : null;
  };
  function filmSelectedMedia(media) {
    return media && CS.pop && CS.pop.mediaId === media.id
      ? Object.assign({}, media, { marks: (media.marks || []).concat([CS.pop.selection]) })
      : media;
  }
  const film = VM.filmProject;
  VM.filmProject = function () {
    const model = film(),
      canon = canonModels().canonReference;
    if (!model) return null;
    const media = [model.media, model.comparison].map(filmSelectedMedia);
    return Object.assign({}, model, {
      media: media[0],
      comparison: media[1],
      compareGroup: model.compareGroup
        ? Object.assign({}, model.compareGroup, {
            points: model.compareGroup.points,
          })
        : null,
      canon:
        !!canon &&
        !!model.reference &&
        canon.contentRef === model.reference.contentRef &&
        canon.ownerRevision === model.reference.ownerRevision,
    });
  };
  const filmPreview = VM.filmPreview;
  VM.filmPreview = function () {
    const model = filmPreview();
    return model ? Object.assign({}, model, { media: filmSelectedMedia(model.media) }) : null;
  };
  A.filmOpen = function (d) {
    const sk = navTabKey('panel', 'clips');
    return chatAction('filmOpen', d).then(function (result) {
      if (result !== false) navOpen({ f: navTop(sk).f, a: { sub: d.id }, into: sk, push: true });
    });
  };
  CHANGES.filmScreening = function (e) {
    return chatAction('filmScreening', { v: e.target.value });
  };
  CHANGES.filmCompare = function (e) {
    return chatAction('filmCompare', { v: e.target.value });
  };
  A.filmOpinionCompare = function (d) {
    return chatAction('filmOpinionCompare', d);
  };
  A.filmOpinionShow = function (d) {
    return chatAction('filmOpinionShow', d).then(function (result) {
      if (result !== false) ENGINE_PARTS.openTab('panel', 'clips');
    });
  };
  A.filmSelect = function (d, el) {
    CS.pop = {
      kind: 'textsel',
      text: filmModels().filmOwner.document.title,
      work: true,
      film: d,
      mediaId: d.mediaId,
      selection: d,
    };
    popAnchor('chat.pop', el);
    render(true);
  };
  A.filmOpinionSource = function (d) {
    return A.msgJump({ t: d.thread, mid: d.mid });
  };
  A.filmReopen = function (d) {
    const data = filmModels(),
      args = {
        project: data.filmOwner.contentRef,
        revision: data.filmReviewRevision,
        id: d.id,
        operationId: crypto.randomUUID(),
      };
    dialog({
      kind: 'filmReopen',
      args: args,
      on: function () {
        if (!val('film-reason')) {
          fieldErr('film-reason', tc('common.required'));
          return false;
        }
        return chatAction('filmReopen', Object.assign({}, args, { reason: val('film-reason') }));
      },
    });
  };
  CHANGES.filmAssetVersion = function (e) {
    return chatAction('filmAssetVersion', { id: e.target.id.slice('film-asset-'.length), v: e.target.value });
  };
  A.filmDownload = function () {
    const model = filmModels().filmPreview;
    return A.download({ source: model.url, name: model.title });
  };
  INPUTS.assetCanonReason = function (e) {
    S.ws.canon.reason = e.target.value;
  };
  ENT.canonAsset = {
    get: function (id) {
      return { id: id };
    },
    status: 'status',
    set: function (item, k, v) {
      return chatAction('canonAssetStatus', { id: item.id, v: v });
    },
  };
  A.workSelect = function (d) {
    CS.lb.selection = {
      x: +d.x,
      y: +d.y,
      ...(d.width ? { width: +d.width, height: +d.height } : {}),
      ...(d.at !== undefined ? { at: +d.at } : {}),
    };
    CS.lb.words = '';
    render(true);
  };
  INPUTS.mediaSelectionWords = function (e) {
    CS.lb.words = e.target.value;
  };
  A.mediaSelectionSave = function () {
    return chatAction('mediaSelectionSave');
  };
  SET_AFTER['cs.lb'] = function (value) {
    if (!value) return chatAction('workClose');
  };
  let locatedReview = null;
  onRender(function () {
    const review = reviewsModels().mediaReview,
      location = review && review.location;
    if (location && review.media && review.media.src && locatedReview !== location.key) {
      A.mediaSeek(location);
      locatedReview = location.key;
    }
  });
}
