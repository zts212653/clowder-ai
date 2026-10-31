const fs = require('node:fs');
const path = require('node:path');
function canonical(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) return undefined;
  try {
    const real = fs.realpathSync(directory);
    return process.platform === 'win32' ? real.toLowerCase() : real;
  } catch {
    return undefined;
  }
}
function installationIdentity(installRoot, userDataRoot) {
  return { installRoot: canonical(installRoot), userDataRoot: canonical(userDataRoot) };
}
function isInstallationShutdownRequest(request, installRoot, userDataRoot) {
  const own = installationIdentity(installRoot, userDataRoot);
  return Boolean(
    own.installRoot &&
      own.userDataRoot &&
      request &&
      canonical(request.installRoot) === own.installRoot &&
      canonical(request.userDataRoot) === own.userDataRoot,
  );
}
module.exports = { installationIdentity, isInstallationShutdownRequest };
