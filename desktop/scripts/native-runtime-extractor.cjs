const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');

/** Use the OS extractor only after the caller has verified every archive entry. */
function extractWithSystemTar(file, cwd, onEntry) {
  if (process.platform !== 'win32') throw new Error('Native runtime extraction requires Windows');
  return new Promise((resolve, reject) => {
    const child = spawn(
      path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/tar.exe'),
      ['-xvf', file, '-C', cwd],
      {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    try {
      os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
    } catch {
      // Record actual parent priority in the surrounding progress event.
    }
    let partial = '';
    let diagnostic = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      partial += chunk;
      const lines = partial.split(/\r?\n/);
      partial = lines.pop();
      for (const line of lines) {
        if (line.startsWith('x ')) onEntry();
        else diagnostic = (diagnostic + line + '\n').slice(-4000);
      }
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (partial.startsWith('x ')) onEntry();
      if (code === 0) resolve();
      else reject(new Error(`System tar failed (${code ?? signal}): ${diagnostic}${partial}`));
    });
  });
}
module.exports = { extractWithSystemTar };
