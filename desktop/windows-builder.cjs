// Windows' offline installer/portable layout already owns all runtime resources.
// The Electron shell must not carry a second copy under resources/.
// Keep only UI-relevant Chromium locale packs (saves ~39 MB uncompressed).
const { build, version } = require('./package.json');
module.exports = {
  ...build,
  electronLanguages: ['en-US', 'en-GB', 'zh-CN', 'zh-TW', 'ja'],
  extraMetadata: { ...build.extraMetadata, version: process.env.CATCAFE_VERSION || version },
  extraResources: [],
  win: { ...build.win, extraResources: [] },
};
