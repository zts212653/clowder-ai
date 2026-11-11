'use strict';
function bindThreadSettings() {
  const select = CHANGES.cafeSel;
  function featureOptions() {
    const board = projectData('board');
    return [].concat(
      board
        ? board.featureIds
            .filter(function (row) {
              return row.featureId;
            })
            .map(function (row) {
              const item = board.items.find(function (item) {
                return item.id === row.id;
              });
              return { v: row.id, name: item.title };
            })
        : [],
    );
  }
  MODALS.feature = function (m) {
    const thread = sidebarData().threads.find(function (t) {
        return t.id === (m.id || S.thread);
      }),
      value = CS.f['ft-sel'] != null ? CS.f['ft-sel'] : thread.backlogItemId || '';
    return {
      vm: { opts: featureOptions(), cur: value },
      submit: function () {
        return chatPort.action('threadFeatureSave', { id: thread.id, value: value }).then(function () {
          CS.f['ft-sel'] = null;
        });
      },
    };
  };
  A.threadSettings = async function (d) {
    const id = d.id || chatPort.threadId,
      path = '/api/threads/' + encodeURIComponent(id);
    try {
      const values = await Promise.all([
        api.get(path + '/goal'),
        api.get(path + '/native-status'),
        api.get(path + '/members/effort'),
        api.get(path + '/members/speed'),
      ]);
      CS.modal = {
        kind: 'tset',
        id: id,
        open: d.v2 || 'goal',
        goal: values[0],
        goalCatId: values[0].nativeTargets.length ? values[0].nativeTargets[0].catId : '',
        native: values[1],
        efforts: values[2].members,
        speeds: values[3].members,
        sel: {},
        error: '',
      };
      CS.f['ts-goal'] = values[0].goal ? values[0].goal.objective : '';
      (
        sidebarData().threads.find(function (t) {
          return t.id === id;
        }).labels || []
      ).forEach(function (label) {
        CS.modal.sel[label] = true;
      });
      render(true);
    } catch (error) {
      dataError('thread-settings', error);
    }
  };
  MODALS.tset = function (m) {
    const t = sidebarData().threads.find(function (t) {
        return t.id === m.id;
      }),
      goal = m.goal.goal,
      owner = sidebarOwner(),
      labels = owner ? owner.labels : [];
    return {
      vm: {
        id: m.id,
        name: t.title,
        path: t.projectPath,
        pinned: !!t.pinned,
        feats: featureOptions(),
        feat: t.backlogItemId || '',
        disp: { id: m.id, record: 'follow' },
        open: m.open,
        goal: CS.f['ts-goal'],
        targets: m.goal.nativeTargets.map(function (r) {
          return r.catId;
        }),
        goalCatId: m.goalCatId,
        goalSub: goal ? goal.objective : '',
        goalSynced:
          !!goal &&
          goal.sync.state === 'synced' &&
          CS.f['ts-goal'] === goal.objective &&
          (!m.goalCatId || m.goalCatId === goal.sync.catId),
        runtime: m.native,
        runtimeLabel: '',
        cats: chatRead('memberSettings').cats.map(function (c) {
          return c.id;
        }),
        cat: CS.f['ts-cat'] || '',
        think: m.efforts.map(function (r) {
          return {
            catId: r.catId,
            name: r.displayName,
            id: 'ts-th-' + r.catId,
            options: r.options.map(function (v) {
              return { v: v };
            }),
            value: r.override === null ? '' : r.override,
          };
        }),
        speed: m.speeds.map(function (r) {
          return {
            catId: r.catId,
            name: r.displayName,
            id: 'ts-speed-' + r.catId,
            options: r.options.map(function (v) {
              return { v: v };
            }),
            value: r.override === null ? '' : r.override,
          };
        }),
        strategy: [],
        tags: labels.map(function (l) {
          return { id: l.id, name: l.name, tint: l.color, on: !!m.sel[l.id] };
        }),
        tagSub: t.labels || [],
        tint: CS.f['tag-tint'],
      },
    };
  };
  CHANGES.cafeSel = async function (e) {
    if (e.target.id === 'ts-feat') {
      const m = CS.modal;
      m.error = '';
      try {
        await chatPort.action('threadFeatureSave', { id: m.id, value: e.target.value });
      } catch (error) {
        m.error = error.message;
      }
      render(true);
      return;
    }
    if (e.target.id !== 'ts-goal-cat') return select(e);
    CS.modal.goalCatId = e.target.value;
    render(true);
  };
  CHANGES.cafeTsThink = async function (e) {
    const m = CS.modal;
    m.error = '';
    try {
      await chatPort.action('threadEffortSave', { threadId: m.id, id: e.target.dataset.catId, value: e.target.value });
      m.efforts = (await api.get('/api/threads/' + encodeURIComponent(m.id) + '/members/effort')).members;
    } catch (error) {
      m.error = error.message;
    }
    render(true);
  };
  CHANGES.cafeTsSpeed = async function (e) {
    const m = CS.modal;
    m.error = '';
    try {
      await chatPort.action('threadSpeedSave', { threadId: m.id, id: e.target.dataset.catId, value: e.target.value });
      m.speeds = (await api.get('/api/threads/' + encodeURIComponent(m.id) + '/members/speed')).members;
    } catch (error) {
      m.error = error.message;
    }
    render(true);
  };
  A.cafeTsGoal = async function (d) {
    const m = CS.modal,
      path = '/api/threads/' + encodeURIComponent(m.id);
    m.error = '';
    try {
      if (d.v === 'reset') {
        m.goal = await api.get(path + '/goal');
        CS.f['ts-goal'] = m.goal.goal ? m.goal.goal.objective : '';
      } else {
        const goal = m.goal.goal;
        if (goal && CS.f['ts-goal'] === goal.objective)
          await api.post(
            path + '/goal/reconcile',
            {},
            Object.assign({ mode: 'retry' }, d.catId ? { catId: d.catId } : {}),
          );
        else
          await chatPort.action('threadGoalSave', {
            threadId: m.id,
            value: JSON.stringify({
              objective: CS.f['ts-goal'],
              status: goal ? goal.status : 'active',
              tokenBudget: goal ? goal.tokenBudget : null,
              ...(d.catId ? { catId: d.catId } : {}),
            }),
          });
        m.goal = await api.get(path + '/goal');
        m.native = await api.get(path + '/native-status');
      }
    } catch (error) {
      m.error = error.message;
    }
    render(true);
  };
  A.cafeTsTags = async function (d) {
    const m = CS.modal;
    if (d.v === 'save')
      await chatAction('sidebarLabels', {
        id: m.id,
        value: JSON.stringify(
          Object.keys(m.sel).filter(function (id) {
            return m.sel[id];
          }),
        ),
      });
    else {
      m.sel = {};
      (
        sidebarData().threads.find(function (t) {
          return t.id === m.id;
        }).labels || []
      ).forEach(function (id) {
        m.sel[id] = true;
      });
    }
    render(true);
  };
}
