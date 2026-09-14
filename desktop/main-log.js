// Main-process log file for the desktop shell.
//
// Extracted from main.js so that file stays inside the project's 350-line
// production limit once the dynamic-port plumbing was added.
//
// Lives in the user data directory alongside the API and desktop logs, so all
// three are found in one place when diagnosing a startup problem.

const fs = require('node:fs');
const path = require('node:path');

/**
 * Build a logger that appends timestamped lines to <userDataRoot>/data/logs/main.log.
 * Logging must never take the app down, so write failures are swallowed.
 *
 * @returns {{ logFile: string, dbg: (message: string) => void }}
 */
function createMainLogger(userDataRoot) {
  const logDir = path.join(userDataRoot, 'data', 'logs');
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch {}

  const logFile = path.join(logDir, 'main.log');

  const dbg = (message) => {
    const line = `[main ${new Date().toISOString()}] ${message}\n`;
    try {
      fs.appendFileSync(logFile, line);
    } catch {}
  };

  return { logFile, dbg };
}

module.exports = { createMainLogger };
