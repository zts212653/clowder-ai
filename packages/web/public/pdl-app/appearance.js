/* UI preferences use the original local store; uploaded image files and custom themes have a server owner. */
'use strict';
// Custom themes are kept in the owner's preferences on the host, so clearing the browser keeps them.
THEME_DOCS = {
  read: function () {
    return api.get('/api/config/console-themes').then(function (r) {
      return r.themes;
    });
  },
  write: function (themes) {
    return api.post('/api/config/console-themes', {}, { themes: themes });
  },
};
// Theme packages live in the host: the zip is uploaded, unpacked and stored per theme id; one package is read by id.
const THEME_PACK_URL = '/api/console-themes/packages';
function themeDownload(action, args) {
  return chatAction(action, args).then(function (file) {
    A.download(file);
    file.release();
    return file.name;
  });
}
THEME_PACKS = {
  list: function () {
    return api.get(THEME_PACK_URL).then(function (r) {
      return r.packages;
    });
  },
  read: function (id) {
    return api.get(THEME_PACK_URL + '/' + encodeURIComponent(id));
  },
  install: function (file) {
    const body = new FormData();
    body.append('file', file);
    return api.post(THEME_PACK_URL, {}, body);
  },
  remove: function (id) {
    return api.post(THEME_PACK_URL + '/' + encodeURIComponent(id), { method: 'DELETE' }, {});
  },
  export: function (id) {
    return themeDownload('themePackExport', { id: id });
  },
  exportCustom: function (theme) {
    return themeDownload('themeCustomExport', { theme: theme });
  },
};
function bindAppearance() {
  let images = [],
    legacy = null,
    feedback = '';
  S.layout = store.get('layout', 'three');
  async function readLegacy() {
    try {
      legacy = await api.get('/api/config/chat-background');
      dataOk('chatBackgrounds');
    } catch (error) {
      legacy = null;
      dataError('chatBackgrounds', error);
    }
    render(true);
  }
  api.on('sources:needed', function (diff) {
    if (diff.added.indexOf('chatBackgrounds') >= 0) settleHold(readLegacy());
  });
  onStart('data', async function () {
    try {
      images = (await api.get('/api/config/chat-background/images')).images;
      dataOk('backgroundImages');
    } catch (error) {
      images = [];
      dataError('backgroundImages', error);
    }
  });
  VM.chatBackgrounds = function () {
    if (projectionNeeded) projectionNeeded.add('chatBackgrounds');
    return legacy;
  }; /* v2 consumes it; default theme intentionally does not. */
  APP_CLASS.push(function () {
    return S.layout === 'two' ? 'layout-two' : '';
  });
  VM.theme = function () {
    return {
      mode: S.tweaks.theme,
      palette: S.tweaks.skin,
      style: S.style,
      inRail: pdlInRail('appearance'),
      layout: S.layout,
      density: S.tweaks.compact ? 'compact' : 'comfort',
    };
  };
  // A theme's own accent: a custom theme's edited value (not the current theme's), then its palette's value.
  function themeAccent(theme) {
    const own = ((((theme.full || {}).tokens || {})[theme.palette] || {}).light || {}).accent;
    const src = THEME_SRC.packs()
      .concat(THEME_SRC.own())
      .find((x) => x.id === theme.palette);
    return (
      own ||
      (src && (src.values.light || {}).accent) ||
      (BUILTIN_THEMES.find((x) => x.id === theme.palette) || {}).accent
    );
  }
  VM.themeThemes = function () {
    const current = pdlThemes();
    const row = function (theme, kind) {
      return {
        id: theme.id,
        name: theme.name,
        n: theme.n,
        kind: kind,
        source: theme.src,
        version: theme.base && theme.base.v,
        palette: theme.palette,
        accent: themeAccent(theme),
        active: current.active === theme.id,
        custom: kind === 'custom',
        package: kind === 'package',
        pack: theme.theme,
      };
    };
    return {
      items: PDL_SYS_THEMES.map(function (theme) {
        return row(theme, 'system');
      })
        .concat(
          pdlPackThemes().map(function (theme) {
            return row(theme, 'pack');
          }),
        )
        .concat(
          pdlThemePacks().map(function (theme) {
            return row(theme, 'package');
          }),
        )
        .concat(
          current.customs.map(function (theme) {
            return row(theme, 'custom');
          }),
        ),
      archived: store.get('pdl-archive-v1', []).map(function (archive) {
        return { key: archive.key, version: archive.base.v, tried: !!archive.tried };
      }),
    };
  };
  PAGES.appearance = function () {
    return pdlView('page.theme');
  };

  SET_AFTER['s.tweaks.theme'] = function () {
    store.set('tweaks', S.tweaks);
  };
  A.themeFlip = function () {
    S.tweaks.theme = stIsDark() ? 'light' : 'dark';
    store.set('tweaks', S.tweaks);
    applyThemeVals();
    render(true);
  };
  CHANGES.layoutPick = function (event) {
    S.layout = event.target.value;
    store.set('layout', S.layout);
    render(true);
  };
  CHANGES.densityPick = function (event) {
    S.tweaks.compact = event.target.value === 'compact';
    store.set('tweaks', S.tweaks);
    render(true);
  };
  CHANGES.stylePick = function (event) {
    const patch = {};
    patch[event.target.dataset.k] = event.target.value;
    styleSet(patch);
  };
  ENT.style = {
    get: function () {
      return Object.assign({}, S.style);
    },
    set: function (row, field, value) {
      const patch = {};
      patch[field] = value;
      styleSet(patch);
    },
  };
  RESETS.style = {
    get: function () {
      return (S.pdlDoc && S.pdlDoc.full.style) || {};
    },
    set: function (value) {
      if (JSON.stringify(value) === JSON.stringify(RESETS.style.get())) return;
      pdlDocEdit(function (full) {
        full.style = value;
      });
      applyStyle();
    },
    def: function () {
      return {};
    },
    text: function () {
      return tc('theme.resetNotice.toast');
    },
  };
  matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', applyStyle);
  VM.themeBg = function (prefix) {
    prefix = prefix || '';
    return {
      ids: { home: prefix + 'bg-home', homeOp: prefix + 'bg-home-op', file: prefix + 'bg-file' },
      home: S.bg.home,
      homeTr: 100 - S.bg.homeTr,
      full: images.length >= 20,
      feedback: feedback,
      presets: images.map(function (image) {
        return { v: image.id, name: image.name };
      }),
    };
  };
  function imageAssets() {
    images.forEach(function (image) {
      ASSET_LAYERS.user[image.id] = { type: 'image', mime: image.mime, name: image.name, src: api.file(image.source) };
    });
  }
  onStart('late', function () {
    imageAssets();
  });
  CHANGES.bgPick = function (event) {
    feedback = '';
    bgSet({ home: event.target.value });
    render(true);
  };
  INPUTS.bgOp = function (event) {
    BG_LIVE = { homeTr: 100 - Number(event.target.value) };
    render(true);
  };
  document.addEventListener('change', function (event) {
    if (event.target.dataset.input !== 'bgOp' || !BG_LIVE) return;
    const patch = BG_LIVE;
    BG_LIVE = null;
    bgSet(patch);
    render(true);
  });
  async function bgAdd(files) {
    feedback = '';
    if (images.length + files.length > 20) feedback = tc('themeBackground.limit');
    else if (
      files.some(function (file) {
        return file.size > 20 * 1024 * 1024;
      })
    )
      feedback = tc('themeBackground.tooLarge');
    if (feedback) {
      render(true);
      return;
    }
    try {
      const added = [];
      for (const file of files) {
        const body = new FormData();
        body.append('file', file);
        const image = await api.post('/api/config/chat-background/images', {}, body);
        images.push(image);
        imageAssets();
        added.push(image.id);
      }
      bgSet({ home: added[0] });
    } catch (error) {
      feedback = error.message || tc('themeBackground.saveFailed');
    }
    render(true);
  }
  A.bgUpload = function () {
    PLATFORM.pickFiles('image/*', bgAdd);
  };
  A.bgRemove = async function (data) {
    feedback = '';
    try {
      const receipt = await chatPort.action('appearanceDeleteImage', { id: data.id });
      images = receipt.images;
      if (S.bg.home === data.id) bgSet({ home: 'none' });
      delete ASSET_LAYERS.user[data.id];
    } catch (error) {
      feedback = error.message || tc('themeBackground.saveFailed');
    }
    render(true);
  };
}
