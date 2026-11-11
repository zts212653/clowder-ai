'use strict';
function bindRules() {
  let source = null,
    manifest = [],
    load = 'loading',
    previewCat = '',
    files = [];
  S.rulesView = 'life';
  S.lifeOpen = null;
  async function read() {
    try {
      const values = await Promise.all([api.get('/api/rules'), api.get('/api/prompt-injection/manifest')]);
      source = values[0];
      manifest = values[1].segments;
      files = source.sharedRules.concat(source.providerGuides, [source.l0Prompts.template]);
      load = '';
      dataOk('rules');
    } catch (error) {
      load = 'error';
      dataError('rules', error);
    }
    await chatDataRender();
  }
  api.on('sources:needed', function (diff) {
    if (diff.added.indexOf('rules') >= 0) settleHold(read());
  });
  PAGES.rules = function () {
    return pdlView('page.rules');
  };

  VM.rules = function () {
    if (projectionNeeded) projectionNeeded.add('rules');
    const stages = [
        'session-start',
        'session-init',
        'turn-build',
        'client-invoke',
        'turn-close',
        'session-close',
        'hook-events',
      ],
      name = stages[S.lifeOpen],
      segments = function (stage) {
        return manifest.filter(function (s) {
          const owner = s.id.startsWith('H')
            ? 'hook-events'
            : s.lifecycleStage === 'per-turn'
              ? 'turn-build'
              : s.lifecycleStage;
          return owner === stage;
        });
      },
      selected = segments(name);
    return {
      load: load,
      view: S.rulesView,
      previewOpts: chatRead('memberSettings').cats.map(function (c) {
        return c.id;
      }),
      previewCat: previewCat,
      flow: stages.map(function (name, i) {
        const list = segments(name);
        return {
          name: name,
          description: '',
          count: list.length,
          selected: i === S.lifeOpen,
          affected: false,
        };
      }),
      stage: name
        ? {
            name: name,
            desc: '',
            count: selected.length,
            where: false,
            scope: null,
            groupKind: name === 'session-init' ? 'init' : selected.length ? 'segments' : null,
            preview: name === 'client-invoke',
            mechanisms: [],
            groups: selected.length
              ? [
                  {
                    caption: name,
                    count: selected.length,
                    items: selected.map(function (s) {
                      return {
                        id: s.id,
                        name: s.name,
                        sub: s.userExplanation,
                        source: s.source,
                        // The theme's kinds: editable / read-only template / hook; other sources keep their own name.
                        kind: s.allowLocalOverride
                          ? 'edit'
                          : s.sourceType === 'template'
                            ? 'tpl'
                            : /hook$/.test(s.sourceType)
                              ? 'hook'
                              : s.sourceType,
                        viewable:
                          s.sourceType === 'template' ||
                          ((s.sourceType === 'hook' || s.sourceType === 'shell-hook') &&
                            !!s.source &&
                            !s.source.endsWith('/')),
                        editable: s.allowLocalOverride,
                        selected: CS.voice.lifeItem === s.id,
                        trigger: s.trigger,
                        purpose: s.purpose,
                      };
                    }),
                  },
                ]
              : [],
          }
        : null,
      files: source
        ? [
            {
              items: files.map(function (f, i) {
                return {
                  k: String(i),
                  title: f.path.split('/').pop(),
                  path: f.path,
                  missing: !f.exists,
                  use: f.consumption.label,
                  lines: f.content.split('\n').length,
                  on: true,
                };
              }),
            },
          ]
        : [],
    };
  };
  VM.l0 = function () {
    if (projectionNeeded) projectionNeeded.add('rules');
    const f = source && source.l0Prompts.template;
    return f ? { path: f.path, text: f.content, lines: f.content.split('\n').length } : null;
  };
  CHANGES.previewCat = function (e) {
    previewCat = e.target.value;
    render(true);
  };
  A.segOpen = async function (d) {
    const s = await api.get('/api/prompt-injection/segment/' + encodeURIComponent(d.id) + '/content');
    const editable = s.allowLocalOverride;
    dialog({
      kind: 'seg',
      args: {
        id: d.id,
        name: manifest.find(function (segment) {
          return segment.id === d.id;
        }).name,
        editable: editable,
        readonly: !editable,
        text: s.content,
        resets: [].concat(
          s.hasOverride ? [{ scope: 'seg.def.' + d.id, previous: false }] : [],
          s.hasBackup ? [{ scope: 'seg.bak.' + d.id, previous: true }] : [],
        ),
      },
      on: async function () {
        if (editable) {
          await chatPort.action('segmentSave', { id: d.id, value: val('seg-text') });
          await read();
        } else return copyText(val('seg-text'));
      },
    });
  };
  const reset = A.reset;
  A.reset = async function (d) {
    if (d.scope.indexOf('seg.') !== 0) return reset(d);
    const id = d.scope.slice(8);
    try {
      if (d.scope.indexOf('seg.def.') === 0) await chatPort.action('segmentReset', { id: id });
      else await api.post('/api/prompt-injection/segment/' + encodeURIComponent(id) + '/restore-backup', {}, {});
      S.dialog = null;
      await read();
    } catch (error) {
      S.dialog.error = error.message;
      render(true);
    }
  };
  A.compiledOpen = async function () {
    const s = await api.get('/api/prompt-injection/compiled-preview', { catId: previewCat }),
      text = [s.systemPrompt, s.dynamicContext, s.bootstrapContext, s.nativePackContext, s.userInput]
        .filter(Boolean)
        .join('\n\n');
    dialog({
      kind: 'compiled',
      args: {
        catId: previewCat,
        identityResolution: s.identityResolution
          ? Object.assign({}, s.identityResolution, {
              fieldSources: Object.entries(s.identityResolution.sources.fields).map(function (entry) {
                return { field: entry[0], source: entry[1] };
              }),
            })
          : null,
        text: text,
        lines: text.split('\n').length,
        chars: text.length,
        when: 'first',
        where: 'sys',
      },
      on: function () {
        return copyText(text);
      },
    });
  };

  A.ruleEdit = function (d) {
    const f = files[+d.k];
    dialog({
      kind: 'ruleEdit',
      args: { title: f.path, path: f.path, text: f.content, readonly: true },
      on: function () {
        return copyText(f.content);
      },
    });
  };
}
