// The parent explicitly releases this private fixture after proving the second
// command is queued. Its lifetime must not depend on how fast Node starts.
function browserBlockerArgs({ runnerPath, logFile, releaseFile }) {
  const script = [
    "const { appendFileSync, existsSync } = require('node:fs')",
    'const [logFile, releaseFile] = process.argv.slice(1, 3)',
    "appendFileSync(logFile, 'blocker:start\\n')",
    'const timer = setInterval(() => {',
    'if (!existsSync(releaseFile)) return',
    "appendFileSync(logFile, 'blocker:end\\n')",
    'clearInterval(timer)',
    '}, 10)',
  ].join(';');
  return [
    runnerPath,
    '--mode',
    'exclusive',
    '--stage',
    'browser',
    '--',
    process.execPath,
    '-e',
    script,
    logFile,
    releaseFile,
  ];
}

module.exports = { browserBlockerArgs };
