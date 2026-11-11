'use strict';
function bindProfiles() {
  let source = null,
    observations = {},
    load = 'loading';
  async function read() {
    try {
      const values = await Promise.all([api.get('/api/dossier'), api.get('/api/dossier/observations')]);
      source = values[0];
      observations = values[1].observations;
      load = '';
      dataOk('profiles');
    } catch (error) {
      load = 'error';
      dataError('profiles', error);
    }
    await chatDataRender();
  }
  api.on('sources:needed', function (diff) {
    if (diff.added.indexOf('profiles') >= 0) settleHold(read());
  });
  PAGES.profiles = function () {
    return pdlView('page.profiles');
  };

  VM.profiles = function () {
    if (projectionNeeded) projectionNeeded.add('profiles');
    if (!source) return { load: load, models: [] };
    return {
      load: load,
      coverage: source.meta.dossierCoverage,
      total: source.meta.totalCats,
      modelCount: source.meta.totalModels,
      models: source.modelGroups.map(function (group) {
        const profiles = group.cats.filter(function (cat) {
          return cat.dossier;
        }).length;
        return {
          model: group.model,
          profiles: profiles,
          hasProfiles: !!profiles,
          count: group.cats.length,
          cats: group.cats.map(function (cat) {
            const p = cat.dossier,
              obs = observations[cat.catId] || [],
              sig = p && p.routingSignals,
              member = WHO_DATA.member(cat.catId),
              ev = ACCOUNT_STATE.evOpen[cat.catId];
            return {
              id: cat.catId,
              breed: member.breed,
              client: cat.runtime,
              availability: projectMemberAvailability(cat.catId),
              hasProfile: !!p,
              evidenceOpen: !!ev,
              hasBody: !!(p || obs.length || ev),
              body: {
                id: cat.catId,
                p: p ? { ver: p.provenance && p.provenance.version, one: p.oneLiner, l0: p.l0RosterSummary } : null,
                good: sig && sig.peakCapabilities,
                bad: sig && sig.antiSignals,
                sigKey: 'prof-sig-' + cat.catId,
                obs: obs.map(function (o) {
                  return { t: o.content, at: o.createdAt, author: o.author, recent: false };
                }),
                evLoad: '',
                ev: [],
              },
            };
          }),
        };
      }),
    };
  };

  A.profObs = function (d) {
    const member = WHO_DATA.member(d.id);
    dialog({
      kind: 'profileObservation',
      args: { name: member.name, handle: member.handle },
      on: async function () {
        const content = val('obs-in').trim();
        if (!content) throw new Error(tc('common.required'));
        await api.post('/api/dossier/observations', {}, { catId: d.id, content: content });
        await read();
      },
    });
  };
}
