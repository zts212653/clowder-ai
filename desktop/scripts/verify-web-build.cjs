const path = require('node:path');
const { loadDesktopWebConfig } = require('../runtime-web-config');

/** Exercise the runtime admission check before an installer can be compiled. */
function verifyWebBuild(web, expectedRevision, requireWeb) {
  web = path.resolve(web);
  const config = loadDesktopWebConfig(web, requireWeb);
  const revision = config.env.NEXT_PUBLIC_CAT_CAFE_BUILD_REVISION;
  if (!/^[a-f0-9]{40}$/.test(expectedRevision ?? '') || revision !== expectedRevision)
    throw new Error('Packaged Web revision differs from release source; rebuild instead of restamping artifacts');
  return { web: path.resolve(web), revision };
}

if (require.main === module) {
  try {
    const requireBase = process.argv[4] ? path.resolve(process.argv[4]) : undefined;
    const requireWeb = requireBase ? require('node:module').createRequire(requireBase) : undefined;
    console.log(JSON.stringify(verifyWebBuild(process.argv[2], process.argv[3], requireWeb)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { verifyWebBuild };
