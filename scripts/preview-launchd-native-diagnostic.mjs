import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchWithLaunchd, removeLaunchdJob } from './preview-process-launchers.mjs';

if (process.platform !== 'darwin') process.exit(0);
const root = mkdtempSync(join(tmpdir(), 'preview-identity-witness-'));
const label = `com.catcafe.identity-witness.${process.pid}`;
const target = `gui/${process.getuid()}/${label}`;
const program = join(root, 'witness.mjs');
writeFileSync(program, 'setInterval(()=>{},1000);');
const expected = [process.execPath, program, '--test-literal={"a":"space here"}'];
const xml = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
const plist = join(root, 'witness.plist');
writeFileSync(
  plist,
  `<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${expected.map((value) => `<string>${xml(value)}</string>`).join('')}</array><key>RunAtLoad</key><true/></dict></plist>`,
);
try {
  const start = spawnSync('launchctl', ['bootstrap', `gui/${process.getuid()}`, plist], { encoding: 'utf8' });
  if (start.status !== 0) throw Error(start.stderr);
  for (let i = 0; i < 12; i++) {
    const job = spawnSync('launchctl', ['print', target], { encoding: 'utf8' });
    const pid = job.stdout.match(/^\s*pid = (\d+)\s*$/m)?.[1];
    const actual = pid
      ? spawnSync('ps', ['-ww', '-p', pid, '-o', 'lstart=,command='], {
          encoding: 'utf8',
          env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
        }).stdout.trim()
      : null;
    console.log(JSON.stringify({ expected: expected.join(' '), pid, actual }));
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
} finally {
  spawnSync('launchctl', ['bootout', target], { stdio: 'ignore' });
  rmSync(root, { recursive: true, force: true });
}

const owned = mkdtempSync(join(tmpdir(), 'preview-lease-witness-'));
const ownProgram = join(owned, 'witness.mjs');
writeFileSync(ownProgram, 'setInterval(()=>{},1000);');
const config = {
  stateDir: owned,
  cwd: owned,
  launchdLabel: `com.catcafe.lease-witness.${process.pid}`,
  plistPath: join(owned, 'lease.plist'),
  logPath: join(owned, 'lease.log'),
  command: [
    process.execPath,
    fileURLToPath(new URL('./preview-process-lease-runner.mjs', import.meta.url)),
    '--expires-at',
    new Date(Date.now() + 5000).toISOString(),
    '--completion-path',
    join(owned, 'completed.json'),
    '--',
    process.execPath,
    ownProgram,
    '--multiline-test=a\nb',
  ],
};
try {
  await launchWithLaunchd(config, {
    onObservation: (observation) => console.log(JSON.stringify({ leaseWitness: observation })),
  });
} finally {
  removeLaunchdJob(config);
  rmSync(owned, { recursive: true, force: true });
}
