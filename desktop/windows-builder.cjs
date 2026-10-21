// Windows' offline installer/portable layout already owns all runtime resources.
// The Electron shell must not carry a second copy under resources/.
const { build } = require('./package.json');
module.exports = { ...build, extraResources: [], win: { ...build.win, extraResources: [] } };
