const { spawnSync } = require('node:child_process');
const { realpathSync } = require('node:fs');
const { isAbsolute, join, relative } = require('node:path');

function isLocalDirectoryPath(value) {
  return isAbsolute(value) && (process.platform !== 'win32' || /^[a-z]:[\\/]/i.test(value));
}

/** Compare directory evidence only. A match does not establish ownership. */
function compareRedisDirectory(expected, reply) {
  if (!Array.isArray(reply) || reply.length !== 2 || reply[0] !== 'dir' || typeof reply[1] !== 'string')
    return 'directory_unknown';
  // The Windows Redis build can report its Cygwin drive spelling.
  const reported = process.platform === 'win32' ? reply[1].replace(/^\/cygdrive\/([a-z])\//i, '$1:/') : reply[1];
  if (!isLocalDirectoryPath(reported)) return 'directory_unknown';
  try {
    const expectedPath = realpathSync.native(expected);
    const reportedPath = realpathSync.native(reported);
    return relative(expectedPath, reportedPath) === '' ? 'directory_matches' : 'directory_mismatch';
  } catch {
    return 'directory_unknown';
  }
}

if (require.main === module) {
  const [userData, rawPort, redisCli = 'redis-cli', ...rest] = process.argv.slice(2);
  const port = Number(rawPort);
  if (
    !userData ||
    !isLocalDirectoryPath(userData) ||
    !/^\d+$/.test(rawPort ?? '') ||
    port < 1 ||
    port > 65535 ||
    !redisCli ||
    rest.length
  ) {
    console.error(
      'Usage: node desktop/redis-directory-diagnostic.js <absolute-user-data-directory> <port> [redis-cli]',
    );
    process.exitCode = 2;
  } else {
    const env = { ...process.env };
    delete env.REDISCLI_AUTH;
    const result = spawnSync(
      redisCli,
      ['-h', '127.0.0.1', '-p', String(port), '-2', '--json', 'CONFIG', 'GET', 'dir'],
      {
        env,
        encoding: 'utf8',
        timeout: 1500,
        maxBuffer: 16 * 1024,
        windowsHide: true,
      },
    );
    let reply;
    if (result.status === 0) {
      try {
        reply = JSON.parse(result.stdout);
      } catch {
        // Older redis-cli or an incompatible listener cannot supply directory evidence.
      }
    }
    const status = compareRedisDirectory(join(userData, 'data', 'redis'), reply);
    console.log(JSON.stringify({ port, status }));
  }
}

module.exports = { compareRedisDirectory };
