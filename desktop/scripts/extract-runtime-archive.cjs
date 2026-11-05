const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { createHash, randomUUID } = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const os = require('node:os');
const { extractWithSystemTar } = require('./native-runtime-extractor.cjs');

const targets = {
  'deploy-api': ['packages/api', 'dist/index.js'],
  'deploy-web': ['packages/web', '.next/BUILD_ID'],
  'deploy-mcp-server': ['packages/mcp-server', 'dist/index.js'],
  electron: ['desktop-dist', 'Clowder AI.exe'],
  'deploy-dependencies': ['node_modules', '.runtime-lock.json'],
};

async function extractRuntimeArchive(
  installRoot,
  archiveName,
  tarImplementation,
  { onProgress = () => {}, intervalMs = 1000, allowLegacy = false, runId = randomUUID(), engine = 'node' } = {},
) {
  const root = path.resolve(installRoot);
  const name = archiveName.replace(/\.tar\.gz$/, '');
  if (!targets[name] || archiveName !== `${name}.tar.gz`) throw new Error('Unknown runtime archive');
  const tar = tarImplementation ?? createRequire(path.join(root, 'node/node_modules/npm/bin/npm-cli.js'))('tar');
  const cwd = path.join(root, targets[name][0]);
  const expectedEntry = path.join(cwd, targets[name][1]);
  let suppliedEntry = false;
  const started = Date.now();
  const cpu = process.cpuUsage();
  const file = path.join(root, 'bundled/archives', archiveName);
  const bytes = fs.statSync(file).size;
  const manifestFile = file + '.json';
  const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : null;
  if (!manifest && !allowLegacy) throw new Error('Missing runtime archive manifest');
  if (
    manifest &&
    (manifest.archive !== archiveName ||
      manifest.bytes !== bytes ||
      !Number.isSafeInteger(manifest.entries) ||
      manifest.entries < 1 ||
      !/^[a-f0-9]{64}$/.test(manifest.sha256))
  )
    throw new Error('Invalid runtime archive manifest');
  const input = fs.createReadStream(file);
  const checksum = createHash('sha256');
  input.on('data', (chunk) => checksum.update(chunk));
  let entries = 0;
  let verifiedEntries = 0;
  let unicodeEntry = false;
  let admissionError;
  const preflight = engine === 'native';
  let phase = engine === 'native' ? 'verify' : 'extract';
  let extractionStarted = preflight ? null : started;
  let lastEntryAt = started;
  const report = (status, extra = {}) => {
    const now = Date.now();
    onProgress({
      runId,
      archive: archiveName,
      status,
      engine,
      phase,
      at: new Date().toISOString(),
      elapsedMs: now - started,
      verifyMs: preflight ? (extractionStarted ?? now) - started : 0,
      extractMs: extractionStarted === null ? 0 : now - extractionStarted,
      entries,
      totalEntries: manifest?.entries ?? null,
      bytesRead: input.bytesRead,
      archiveBytes: bytes,
      progressBasis: preflight ? 'entries' : 'compressed_bytes',
      percent:
        status === 'complete'
          ? 100
          : Math.min(
              99,
              Math.floor(
                preflight
                  ? (entries / Math.max(1, verifiedEntries)) * 100
                  : (input.bytesRead / Math.max(1, bytes)) * 100,
              ),
            ),
      idleMs: now - lastEntryAt,
      cpu: process.cpuUsage(cpu),
      rssBytes: process.memoryUsage().rss,
      priority: os.getPriority(0),
      ...extra,
    });
  };
  fs.mkdirSync(cwd, { recursive: true });
  report('start');
  const timer = setInterval(() => report('progress'), intervalMs);
  try {
    if (engine === 'native') {
      await pipeline(
        input,
        tar.t({
          strict: true,
          onReadEntry: (entry) => {
            const target = path.resolve(cwd, entry.path);
            if ((target !== cwd && !target.startsWith(cwd + path.sep)) || /[\r\n]/.test(entry.path))
              admissionError ??= new Error('Archive entry escapes runtime directory');
            if (!['File', 'Directory'].includes(entry.type))
              admissionError ??= new Error('Unsupported runtime archive entry');
            if ([...entry.path].some((char) => char.charCodeAt(0) > 127)) unicodeEntry = true;
            if (target === expectedEntry && entry.type === 'File') suppliedEntry = true;
            verifiedEntries++;
          },
        }),
      );
      if (admissionError) throw admissionError;
      if (!suppliedEntry) throw new Error(`Incomplete runtime archive: ${name}`);
      if (manifest && (verifiedEntries !== manifest.entries || checksum.digest('hex') !== manifest.sha256))
        throw new Error('Runtime archive integrity mismatch');
      phase = 'extract';
      extractionStarted = Date.now();
      if (unicodeEntry) {
        engine = 'node-unicode';
        report('progress', { reason: 'system_tar_unicode_filename_limitation' });
        await pipeline(
          fs.createReadStream(file),
          tar.x({
            cwd,
            strict: true,
            filter: () => {
              entries++;
              lastEntryAt = Date.now();
              return true;
            },
          }),
        );
      } else {
        await extractWithSystemTar(file, cwd, () => {
          entries++;
          lastEntryAt = Date.now();
        });
      }
      if (entries !== verifiedEntries || !fs.statSync(expectedEntry).isFile())
        throw new Error('Incomplete native extraction');
    } else {
      await pipeline(
        input,
        tar.x({
          cwd,
          strict: true,
          filter: (entry, metadata) => {
            const target = path.resolve(cwd, entry);
            if (target !== cwd && !target.startsWith(cwd + path.sep))
              throw new Error('Archive entry escapes runtime directory');
            if (target === expectedEntry && metadata.type === 'File') suppliedEntry = true;
            entries++;
            lastEntryAt = Date.now();
            return true;
          },
        }),
      );
      if (!suppliedEntry || !fs.statSync(expectedEntry).isFile())
        throw new Error(`Incomplete runtime archive: ${name}`);
      if (manifest && (entries !== manifest.entries || checksum.digest('hex') !== manifest.sha256))
        throw new Error('Runtime archive integrity mismatch');
    }
    report('complete');
  } catch (error) {
    report('failed', { message: error.message, code: error.code });
    throw error;
  } finally {
    clearInterval(timer);
    input.destroy();
  }
}

module.exports = { extractRuntimeArchive };
if (require.main === module) {
  try {
    os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch (error) {
    console.error(`Archive priority: ${error.code}`);
  }
  const [root, name] = process.argv.slice(2);
  const logs = path.join(root, '.installer-logs');
  fs.mkdirSync(logs, { recursive: true });
  const log = path.join(logs, 'extract-runtime.log');
  const runId = randomUUID();
  let lastEvent;
  extractRuntimeArchive(root, name, undefined, {
    engine: process.platform === 'win32' ? 'native' : 'node',
    runId,
    onProgress: (event) => {
      lastEvent = event;
      fs.appendFileSync(log, JSON.stringify(event) + '\n');
      process.stdout.write(
        `EXTRACT|${event.status}|${event.archive}|${event.percent}|${event.entries}|${event.totalEntries ?? 0}|${event.elapsedMs}\n`,
      );
    },
  }).catch((error) => {
    if (lastEvent?.status !== 'failed')
      fs.appendFileSync(
        log,
        JSON.stringify({
          runId,
          archive: name,
          status: 'failed',
          phase: 'preflight',
          at: new Date().toISOString(),
          message: error.message,
        }) + '\n',
      );
    console.error(error.message);
    process.exitCode = 1;
  });
}
