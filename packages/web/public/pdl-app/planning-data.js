/* Planning/work content VMs project only the console's held owner data. */
'use strict';
function boardReplaySources() {
  const source = projectData('board'),
    first = new Map();
  source.items.forEach(function (item) {
    const id = source.featureIds.find(function (entry) {
      return entry.id === item.id;
    }).featureId;
    if (id !== 'Untagged' && !first.has(id)) first.set(id, item);
  });
  return Array.from(first, function (entry) {
    return { v: entry[0], kind: 'feature', id: entry[0], name: entry[1].title.replace(/^\[F\d+\]\s*/i, '') };
  });
}
function boardDialogDefinition() {
  const source = projectData('board'),
    request = source.dialog;
  return request ? { args: request.args, scopes: request.scopes } : null;
}
function boardModels() {
  const source = projectData('board'),
    data = projectChatData(),
    ui = S.ws,
    { items, read, projects, projectsLoad, external, riskResults, sop, browsing } = source;
  const ids = new Map(
      source.featureIds.map(function (r) {
        return [r.id, r.featureId];
      }),
    ),
    grouped = new Map(),
    identity = function (id) {
      const c = data.cats.find(function (c) {
        return c.id === id;
      });
      return c
        ? { id: c.id, name: c.displayName, handle: c.mentionPatterns[0] || '' }
        : { id: id, name: id, handle: '' };
    };
  items.forEach(function (item) {
    const id = ids.get(item.id);
    if (!grouped.has(id)) grouped.set(id, []);
    grouped.get(id).push(item);
  });
  const groups = Array.from(grouped, function (pair) {
    const id = pair[0],
      entries = pair[1],
      done = entries.every(function (x) {
        return x.status === 'done';
      }),
      state = done
        ? 'done'
        : entries.some(function (x) {
              return x.status === 'suggested';
            })
          ? 'suggested'
          : entries.some(function (x) {
                return ['approved', 'dispatched'].includes(x.status);
              })
            ? 'dispatched'
            : 'open',
      dependencies = {
        from: Array.from(
          new Set(
            entries.flatMap(function (x) {
              return x.dependencies ? x.dependencies.evolvedFrom : [];
            }),
          ),
        ),
        block: Array.from(
          new Set(
            entries.flatMap(function (x) {
              return x.dependencies ? x.dependencies.blockedBy : [];
            }),
          ),
        ),
        rel: Array.from(
          new Set(
            entries.flatMap(function (x) {
              return x.dependencies ? x.dependencies.related : [];
            }),
          ),
        ),
      };
    return {
      id: id,
      entries: entries,
      done: done,
      state: state,
      dependencies: dependencies,
      name: entries[0].title.replace(/^\[F\d+\]\s*/i, ''),
      threads: source.threads.filter(function (t) {
        return (
          entries.some(function (i) {
            return i.id === t.backlogItemId;
          }) ||
          (id !== 'Untagged' && t.title && t.title.toUpperCase().includes(id))
        );
      }),
    };
  });
  const feats = groups
    .filter(function (f) {
      return !f.done;
    })
    .map(function (f) {
      const selected = f.entries.find(function (it) {
          return it.id === ui.hbItem;
        }),
        workflow = selected && sop.id === selected.id ? sop.value : null,
        view = ui.hbView || 'sug';
      let sel = null;
      if (selected) {
        const it = selected,
          s = it.suggestion,
          l = it.lease,
          target = source.threads.find(function (t) {
            return t.id === it.dispatchedThreadId;
          }),
          cat = s ? identity(s.catId) : null;
        sel = {
          f: f.id,
          k: it.id,
          id: f.id + '/' + it.id,
          view: view,
          sum: view === 'sug' ? it.summary : '',
          state: it.status,
          createdBy: it.createdBy,
          creatorName: identity(it.createdBy).name,
          dispatched: it.status === 'dispatched',
          suggestion: s
            ? {
                catName: cat.name,
                catHandle: cat.handle,
                why: s.why,
                plan: s.plan,
                phase: s.requestedPhase,
                status: s.status,
                decided: s.status !== 'pending',
                by: s.decidedBy,
                at: s.decidedAt,
                timestamp: typeof s.decidedAt === 'number',
                note: s.note,
                hasNote: !!s.note,
              }
            : null,
          thread: it.dispatchedThreadId,
          hasThread: !!it.dispatchedThreadId,
          threadTitle: target ? target.title : it.dispatchedThreadId,
          leaseData: l
            ? {
                name: identity(l.ownerCatId).name,
                exp: l.expiresAt,
                beat: l.lastHeartbeatAt,
                beatTimestamp: typeof l.lastHeartbeatAt === 'number',
                hasMinutes: false,
              }
            : null,
          canSuggest: it.status === 'open',
          canApprove: it.status === 'suggested',
          canRetry: it.status === 'approved',
          hasLease: it.status === 'dispatched' && !!l && l.state === 'active',
          canSelfClaim: ['open', 'suggested', 'approved'].includes(it.status),
          canReclaim: !!l && l.state === 'active' && l.expiresAt <= Date.now(),
          sop: workflow
            ? {
                stage: source.sopDefinition.stages.findIndex(function (s) {
                  return s.id === workflow.stage;
                }),
                checks: Object.entries(workflow.checks).map(function (c) {
                  return { label: c[0], state: c[1] };
                }),
                at: workflow.updatedAt,
                by: identity(workflow.updatedBy).name,
                batonName: identity(workflow.batonHolder).name,
                batonHandle: identity(workflow.batonHolder).handle,
                skill: workflow.nextSkill,
                focus: workflow.resumeCapsule.currentFocus,
              }
            : null,
          threadsId: 'hub-th-' + f.id,
          threads:
            view === 'threads'
              ? f.threads.map(function (t) {
                  return { id: t.id, title: t.title, who: t.participants.map(identity), time: t.lastActiveAt };
                })
              : [],
        };
      }
      return {
        id: f.id,
        state: f.state,
        code: f.id,
        untagged: f.id === 'Untagged',
        name: f.name,
        threads: f.threads.length,
        doneCount: f.entries.filter(function (it) {
          return it.status === 'done';
        }).length,
        totalCount: f.entries.length,
        deps: Object.entries(f.dependencies).flatMap(function (d) {
          return d[1].map(function (id) {
            return { kind: d[0], id: id, known: grouped.has(id) };
          });
        }),
        get phases() {
          const doc = source.docs[f.id];
          return doc && doc.value
            ? doc.value.phases.map(function (p) {
                return {
                  label: p.name,
                  hasPct: !!p.acs.length,
                  pct: p.acs.length
                    ? Math.round(
                        (p.acs.filter(function (a) {
                          return a.done;
                        }).length /
                          p.acs.length) *
                          100,
                      )
                    : null,
                  criteria: p.acs.map(function (a) {
                    return a.text;
                  }),
                };
              })
            : [];
        },
        listId: 'hub-items-' + f.id,
        items: f.entries.map(function (it) {
          const l = it.lease && it.lease.state === 'active' ? it.lease : null;
          return {
            id: it.id,
            selected: it.id === ui.hbItem,
            state: it.status,
            t: it.title,
            pri: it.priority,
            lease: l ? l.ownerCatId : null,
            leaseName: l ? identity(l.ownerCatId).name : '',
            leaseExpiry: l && l.expiresAt,
            hasLeaseExpiryMinutes: false,
          };
        }),
        sel: sel,
      };
    });
  const nodes = groups.filter(function (f) {
      return (
        f.id !== 'Untagged' &&
        (ui.depScope === 'all' ||
          (ui.depScope === 'active'
            ? !f.done
            : Object.values(f.dependencies).some(function (x) {
                return x.length;
              }) ||
              groups.some(function (g) {
                return Object.values(g.dependencies).some(function (x) {
                  return x.includes(f.id);
                });
              })))
      );
    }),
    edges = nodes.flatMap(function (f) {
      return Object.entries(f.dependencies).flatMap(function (d) {
        return d[1]
          .filter(function (id) {
            return nodes.some(function (n) {
              return n.id === id;
            });
          })
          .map(function (id) {
            return { from: id, to: f.id, kind: d[0] };
          });
      });
    }),
    node = groups.find(function (f) {
      return f.id === ui.node;
    });
  const project = projects.find(function (p) {
      return ui.boardV === 'x:' + p.id;
    }),
    detail = project && external.id === project.id ? external.detail : null,
    section = ui.extSec || 'intent';
  let ext = null;
  if (detail) {
    const rows = {
      intent: detail.cards.map(function (c) {
        return {
          id: c.id,
          cardId: c.id,
          projectId: project.id,
          canTriage: true,
          title: c.goal,
          sourceDetail: c.sourceDetail,
          triage: c.triage,
        };
      }),
      features: detail.items.map(function (i) {
        return { id: i.id, title: i.title, sub: i.summary };
      }),
      dispatch: detail.digests.map(function (d) {
        return { id: d.id, title: d.summary, blocked: d.status === 'blocked' };
      }),
      risk: detail.riskSummary
        ? Object.entries(detail.riskSummary.signals)
            .map(function (s) {
              return { id: s[0], risk: s[0], count: s[1] };
            })
            .concat(
              riskResults && riskResults.projectId === project.id
                ? riskResults.risks.map(function (r) {
                    return {
                      id: riskResults.cardId + ':' + r.signal,
                      risk: r.signal,
                      sub: r.evidence,
                      severity: r.severity,
                    };
                  })
                : [],
            )
        : [],
      clarify: detail.resolutions.map(function (r) {
        return {
          id: r.id,
          title: r.question,
          sub: r.answer,
          canAnswer: r.status === 'open',
          projectId: project.id,
          questionState: r.status,
        };
      }),
      slice: detail.slices
        .slice()
        .sort(function (a, b) {
          return a.order - b.order;
        })
        .map(function (r) {
          return {
            id: r.id,
            title: r.name,
            description: r.description,
            verifiableOutcome: r.verifiableOutcome,
            projectId: project.id,
            canEditSlice: true,
            sliceState: r.status,
          };
        }),
      reflux: detail.patterns.map(function (r) {
        return {
          id: r.id,
          projectId: project.id,
          canDeleteReflux: true,
          title: r.title,
          insight: r.insight,
          evidence: r.evidence,
          category: r.category,
        };
      }),
    };
    ext = {
      projectId: project.id,
      canSlice: section === 'slice',
      canIntent: section === 'intent',
      canReflux: section === 'reflux',
      name: project.id,
      path: project.sourcePath,
      backlog: project.backlogPath,
      cur: section,
      intent: section === 'intent',
      health: section === 'health',
      cards: detail.riskSummary ? detail.riskSummary.totalCards : detail.cards.length,
      risks: detail.riskSummary && detail.riskSummary.cardsWithRisks,
      untriaged: detail.cards.filter(function (c) {
        return !c.triage;
      }).length,
      hasRows: section !== 'health',
      rows: rows[section] || [],
    };
  }
  return {
    replaySources: boardReplaySources(),
    boardDialog: boardDialogDefinition(),
    boardBrowsing: browsing,
    boardItems: items,
    boardCats: data.cats.map(function (c) {
      return identity(c.id);
    }),
    boardFrame: detail ? detail.frame : null,
    boardFrameId: project && project.id,
    hubPanel: {
      load:
        projectsLoad ||
        (project
          ? external.id === project.id
            ? external.load
            : 'loading'
          : read.load || (ui.hbView === 'sop' && ui.hbItem ? (sop.id === ui.hbItem ? sop.load : 'loading') : '')),
      view: ui.boardV,
      projects: projects.map(function (p) {
        return { target: 'x:' + p.id, name: p.name };
      }),
      counts: Object.fromEntries(
        ['suggested', 'dispatched', 'done'].map(function (st) {
          return [
            st,
            items.filter(function (i) {
              return i.status === st;
            }).length,
          ];
        }),
      ),
      feats: feats,
      done: groups
        .filter(function (f) {
          return f.done;
        })
        .map(function (f) {
          return { id: f.id, name: f.name, n: f.entries.length };
        }),
      ext: ext,
      deps:
        ui.boardV === 'deps'
          ? {
              scope: ui.depScope,
              nodes: nodes.length,
              edges: edges.length,
              graph: {
                zoom: ui.zoom,
                offset: ui.pan,
                nodes: nodes.map(function (f) {
                  return { id: f.id, name: f.name, state: f.state, selected: ui.node === f.id, done: f.done };
                }),
                edges: edges,
              },
              node: node
                ? {
                    id: node.id,
                    name: node.name,
                    status: node.state,
                    from: node.dependencies.from,
                    hasFrom: !!node.dependencies.from.length,
                    block: node.dependencies.block,
                    hasBlock: !!node.dependencies.block.length,
                    rel: node.dependencies.rel,
                    hasRel: !!node.dependencies.rel.length,
                  }
                : null,
            }
          : null,
    },
  };
}
function scheduleModels() {
  const source = projectData('schedule'),
    ui = S.ws,
    facts = new Map(
      source.calendarFacts.map(function (f) {
        return [f.id, f];
      }),
    ),
    selected = ui.scheduleDate,
    date = new Date(selected),
    mode = ui.scheduleMode,
    dates = function (r) {
      return facts.get(r.envelope.subjectRef).dates;
    },
    row = function (r) {
      return {
        id: r.envelope.subjectRef,
        title: facts.get(r.envelope.subjectRef).title,
        owner: r.work && r.work.ownerCatId,
        state: r.brief.current.state,
        summary: r.work && r.work.progress ? r.work.progress.summary : '',
        dates: dates(r).map(function (d) {
          return { field: d.role, value: d.value };
        }),
        hasWork: !!r.work,
        threadId: r.work && r.work.threadId,
        unknown: !r.work,
      };
    },
    shift = function (n) {
      if (mode === 'week') return new Date(date.getFullYear(), date.getMonth(), date.getDate() + n * 7, 12).getTime();
      return new Date(
        date.getFullYear(),
        date.getMonth() + n,
        Math.min(date.getDate(), new Date(date.getFullYear(), date.getMonth() + n + 1, 0).getDate()),
        12,
      ).getTime();
    };
  return {
    schedule: {
      load: source.error ? 'error' : source.loading && !source.confirmed ? 'loading' : '',
      mode: mode,
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      selectedTitle: selected,
      previous: shift(-1),
      next: shift(1),
      today: Date.now(),
      partial: source.partial,
      calendar: {
        anchor: selected,
        value: selected,
        today: Date.now(),
        mode: mode,
        marks: source.ownerReads.flatMap(function (r) {
          return dates(r).map(function (d) {
            return { at: d.value };
          });
        }),
        act: 'set',
        args: { path: 'ws.scheduleDate', cast: 'num' },
      },
      items: source.ownerReads
        .filter(function (r) {
          return dates(r).some(function (d) {
            return new Date(d.value).toDateString() === date.toDateString();
          });
        })
        .map(row),
      undated: source.ownerReads
        .filter(function (r) {
          return !dates(r).length;
        })
        .map(row),
    },
  };
}
function previewModels() {
  const source = projectData('preview'),
    ui = S.pv,
    tab = ui.tabs.find(function (t) {
      return t.id === ui.active;
    }),
    entries = source.console,
    counts = function (level) {
      return entries.filter(function (e) {
        return level === 'all' || e.level === level;
      }).length;
    };
  return {
    previewState: Object.assign({}, ui, { console: entries, warn: source.warn }),
    previewReceipt: source.receipt,
    preview: {
      load: source.gateway.load || (!(tab && tab.port) ? source.discovered.load : ''),
      discovered: source.discovered.services,
      host: tab ? 'localhost' : '',
      port: tab && tab.port,
      path: tab && tab.path,
      tabs: ui.tabs.map(function (t) {
        return {
          k: t.id,
          on: t.id === ui.active,
          host: 'localhost',
          port: t.port,
          path: t.path,
          framework: t.framework,
        };
      }),
      src: source.src,
      page: !!(tab && tab.port),
      down: !!(tab && tab.port && source.health.key === source.threadId + ':' + tab.port && !source.health.reachable),
      warn: source.warn,
      connection: source.hmr,
      noShot: !source.src || !source.ready || source.capturing,
      consoleOpen: ui.consoleOpen,
      noClear: !entries.length,
      filter: ui.filter,
      counts: { all: counts('all'), warn: counts('warn'), error: counts('error') },
      log: {
        total: entries.length,
        entries: entries
          .filter(function (e) {
            return ui.filter === 'all' || e.level === ui.filter;
          })
          .map(function (e) {
            return { level: e.level, args: e.args, timestamp: e.timestamp };
          }),
      },
    },
  };
}
function replayGuideActors() {
  const team = projectData('replay').guideTeam;
  return Object.fromEntries(
    Object.entries(team).map(function (entry) {
      const id = entry[0],
        actor = entry[1];
      return [
        'guide:' + id,
        { id: 'guide:' + id, name: actor.name, handle: '', avatarPath: actor.avatar, role: actor.role },
      ];
    }),
  );
}
function replayModels() {
  const snapshot = projectData('replay'),
    data = projectChatData(),
    ui = CS,
    read = snapshot,
    { thread, source, guideScript, guideHtml, guideLanguage } = snapshot,
    { engine, events } = snapshot,
    current = engine.currentIndex,
    messages = snapshot.messages;
  const first = new Map();
  snapshot.features.forEach(function (feature) {
    if (feature.featureId !== 'Untagged' && !first.has(feature.featureId)) first.set(feature.featureId, feature);
  });
  const featureSources = Array.from(first, function (entry) {
    return { v: entry[0], kind: 'feature', id: entry[0], name: entry[1].title.replace(/^\[F\d+\]\s*/i, '') };
  });
  const guideActors = replayGuideActors();
  const nodes = projectChat(
    Object.assign(Object.create(data), {
      threadId: thread ?? data.threadId,
      messages,
      questions: {},
      proposals: {},
      schedules: {},
      outputs: {},
      queue: [],
      executions: [],
    }),
    { ...ui, viewCat: null, multi: false },
  ).chatStream.items;
  const state = {
    source,
    at: current,
    on: engine.state === 'playing' || read.typingMs !== null,
    speed: String(engine.speed),
    skip: engine.adaptivePacing,
    mode: engine.displayMode,
  };
  const model = {
    replayState: state,
    replayChapters: snapshot.chapters.map((c) => ({ ...c, time: (c.timestamp - events[0].timestamp) / 1000 })),
    theater: {
      title:
        source === 'thread'
          ? (data.threads.find((t) => t.id === thread)?.title ?? thread)
          : featureSources.find((feature) => feature.v === source)?.name,
      rp: {
        source,
        sources: [{ v: 'thread', kind: 'thread' }, ...featureSources],
        annotation:
          snapshot.storyId && events.length
            ? {
                storyId: snapshot.storyId,
                at: snapshot.eventTimes[current],
                error: snapshot.annotations.storyId === snapshot.storyId ? snapshot.annotations.error : '',
                items:
                  snapshot.annotations.storyId === snapshot.storyId && snapshot.annotations.value
                    ? snapshot.annotations.value.annotations.map((annotation) => ({
                        id: annotation.id,
                        title: annotation.content,
                        at: annotation.at,
                      }))
                    : [],
              }
            : null,
      },
      load: read.load,
      items: nodes,
      empty: !read.load && !events.length,
      player: !events.length
        ? null
        : {
            scrub: {
              segs: events.map(function (e, i) {
                return { from: i, to: i, speaker: { role: e.role, catId: e.catId } };
              }),
              idle: events.flatMap(function (e, i) {
                return e.idleSkipMs ? [{ from: Math.max(0, i - 1), to: i }] : [];
              }),
              cur: current,
              max: Math.max(1, events.length - 1),
              count: events.length,
            },
            note:
              events[current] && events[current].idleSkipMs && engine.adaptivePacing
                ? { unit: 'minutes', amount: Math.round(events[current].idleSkipMs / 60000) }
                : null,
            playing: state.on,
            ended: engine.state === 'ended',
            speed: state.speed,
            skip: state.skip,
            faithful: state.mode === 'faithful',
            time: {
              at: engine.elapsedMs / 1000,
              total: engine.totalDurationMs / 1000,
              count: current + 1,
              totalCount: events.length,
            },
            chapters: snapshot.chapters.map(function (c) {
              return { time: (c.timestamp - events[0].timestamp) / 1000, kind: c.kind, i: c.eventIndex };
            }),
          },
    },
  };
  const stage =
    guideScript
      .slice(0, current + 1)
      .reverse()
      .find((event) => event.artifact)?.artifact ?? 'waiting';
  return {
    ...model,
    guideActors,
    guide:
      source === 'guide'
        ? {
            ...model.theater,
            preview: {
              html: guideHtml,
              message: { type: 'clowder-onboarding-stage', version: 1, stage, language: guideLanguage },
            },
          }
        : null,
  };
}
