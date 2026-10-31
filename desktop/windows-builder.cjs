// Windows' offline installer/portable layout already owns all runtime resources.
// The Electron shell must not carry a second copy under resources/.
const { build, version } = require('./package.json');
module.exports = {
  ...build,
  extraMetadata: { ...build.extraMetadata, version: process.env.CATCAFE_VERSION || version },
  extraResources: [],
  win: { ...build.win, extraResources: [] },
};
