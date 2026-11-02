import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import pty from 'node-pty';
import { nativeHostEnvironmentFixture as fixture } from './helpers/agy-native-host-environment-fixture.js';

test('native launch supplies host tool environment and XDG/gh roots without changing account HOME', async (t) => {
  const f = await fixture(t, ({ host }) => ({
    NPM_CONFIG_CACHE: join(host, 'custom-cache'),
    MY_BUILD_TOOL_SETTING: 'synthetic-tool-setting',
    SSH_AUTH_SOCK: join(host, 'synthetic-agent.sock'),
    GEMINI_API_KEY: 'synthetic-wrong-account',
    GOOGLE_APPLICATION_CREDENTIALS: '/synthetic/wrong-account.json',
    CAT_CAFE_CALLBACK_TOKEN: 'synthetic-host-token',
    CAT_CAFE_EXECUTION_ID: 'wrong-execution',
    AGY_UNRELATED_SECRET: 'synthetic-provider-override',
    CAT_CAFE_NATIVE_TOOL_HOME: '/synthetic/wrong-tool-home',
    REDIS_URL: 'redis://synthetic-runtime-storage:6399',
    NODE_OPTIONS: '--inspect',
  }));
  writeFileSync(join(f.host, '.config', 'gh', 'config.yml'), 'editor: synthetic-editor\n');
  const observed = JSON.parse(
    execFileSync(
      process.execPath,
      [
        '-e',
        `
    const fs = require('node:fs'), path = require('node:path');
    process.stdout.write(JSON.stringify({
      setting: process.env.MY_BUILD_TOOL_SETTING, cache: process.env.NPM_CONFIG_CACHE,
      agent: process.env.SSH_AUTH_SOCK, xdg: process.env.XDG_CONFIG_HOME,
      gh: process.env.GH_CONFIG_DIR && fs.readFileSync(path.join(process.env.GH_CONFIG_DIR, 'config.yml'), 'utf8')
    }));
  `,
      ],
      { env: f.env, encoding: 'utf8', timeout: 3000 },
    ),
  );
  assert.deepEqual(observed, {
    setting: 'synthetic-tool-setting',
    cache: join(f.host, 'custom-cache'),
    agent: join(f.host, 'synthetic-agent.sock'),
    xdg: join(f.host, '.config'),
    gh: 'editor: synthetic-editor\n',
  });
  assert.equal(f.env.HOME, f.plan.binding.profileHome);
  assert.equal(f.env.GEMINI_HOME, join(f.env.HOME, '.gemini'));
  for (const key of [
    'GEMINI_API_KEY',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'CAT_CAFE_CALLBACK_TOKEN',
    'CAT_CAFE_EXECUTION_ID',
    'AGY_UNRELATED_SECRET',
    'REDIS_URL',
    'NODE_OPTIONS',
  ])
    assert.equal(f.env[key], undefined, key);
  assert.equal(f.env.CAT_CAFE_NATIVE_TOOL_HOME, f.host);
});

test(
  'native Git reads both live host global layers and retains repository precedence',
  { skip: !existsSync('/bin/zsh') },
  async (t) => {
    const f = await fixture(t);
    const xdg = join(f.host, '.config', 'git', 'config');
    const global = join(f.host, '.gitconfig');
    writeFileSync(xdg, '[fixture]\n xdg = visible\n order = xdg\n');
    writeFileSync(global, '[fixture]\n home = visible\n order = home\n');
    assert.equal(f.git('config', '--get', 'fixture.xdg').stdout.trim(), 'visible');
    assert.equal(f.git('config', '--get', 'fixture.home').stdout.trim(), 'visible');
    assert.equal(f.git('config', '--get', 'fixture.order').stdout.trim(), 'home');
    assert.equal(f.git('init', '--quiet').status, 0);
    assert.equal(f.git('config', 'fixture.order', 'repository').status, 0);
    assert.equal(f.git('config', '--get', 'fixture.order').stdout.trim(), 'repository');
    writeFileSync(global, '[fixture]\n home = updated-without-relaunch\n');
    assert.equal(f.git('config', '--get', 'fixture.home').stdout.trim(), 'updated-without-relaunch');
    await f.plan.disposeCredentials();
    assert.equal(existsSync(global), true, 'host configuration outlives the disposable account run');
  },
);

test(
  'native command shell sees the host HOME while the carrier retains its account HOME',
  { skip: !existsSync('/bin/zsh') },
  async (t) => {
    const f = await fixture(t);
    mkdirSync(join(f.host, '.synthetic-tool'));
    writeFileSync(join(f.host, '.synthetic-tool', 'config'), 'host-tool-config');
    writeFileSync(join(f.host, '.synthetic-tool', 'git-config'), '[fixture]\n tilde = host-include\n');
    writeFileSync(join(f.host, '.gitconfig'), '[include]\n path = ~/.synthetic-tool/git-config\n');
    const observed = JSON.parse(
      execFileSync(
        '/bin/zsh',
        [
          '-c',
          'exec "$@"',
          'fixture',
          process.execPath,
          '-e',
          `
      const fs = require('node:fs'), path = require('node:path');
      const file = path.join(process.env.HOME, '.synthetic-tool', 'config');
      const git = require('node:child_process').spawnSync('git', ['config', '--get', 'fixture.tilde'], {encoding: 'utf8'});
      process.stdout.write(JSON.stringify({home: process.env.HOME, account: process.env.GEMINI_HOME,
        config: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null, git: git.stdout.trim()}));
    `,
        ],
        { env: f.env, encoding: 'utf8', timeout: 3000 },
      ),
    );
    assert.equal(observed.home, f.host);
    assert.equal(observed.config, 'host-tool-config');
    assert.equal(observed.git, 'host-include');
    assert.equal(observed.account, join(f.plan.binding.profileHome, '.gemini'));
    assert.equal(f.plan.cliOptions.env.HOME, f.plan.binding.profileHome);
    execFileSync('/bin/zsh', ['-c', 'git config --global fixture.persist host-setting'], {
      env: f.env,
      cwd: f.workspace,
      timeout: 3000,
    });
    assert.match(readFileSync(join(f.host, '.gitconfig'), 'utf8'), /persist = host-setting/);
  },
);

test(
  'native tool HOME handoff preserves explicit and nested shell HOME overrides',
  { skip: !existsSync('/bin/zsh') },
  async (t) => {
    const f = await fixture(t);
    const isolated = join(f.root, 'explicit-tool-home');
    mkdirSync(isolated);
    const explicit = execFileSync(
      '/bin/zsh',
      ['-c', 'print -r -- "$HOME"; print -r -- "${CAT_CAFE_NATIVE_TOOL_HOME:-consumed}"'],
      { env: { ...f.env, HOME: isolated }, encoding: 'utf8', timeout: 3000 },
    );
    assert.equal(explicit, `${isolated}\nconsumed\n`);
    const nested = execFileSync(
      '/bin/zsh',
      ['-c', 'HOME="$1" /bin/zsh -c \'print -r -- "$HOME"\'', 'fixture', isolated],
      { env: f.env, encoding: 'utf8', timeout: 3000 },
    );
    assert.equal(nested.trim(), isolated);
  },
);

test(
  'unattended Git does not start inherited or configured askpass programs',
  { skip: process.platform === 'win32' },
  async (t) => {
    const f = await fixture(t, ({ root }) => ({
      GIT_ASKPASS: join(root, 'askpass'),
      SSH_ASKPASS: join(root, 'askpass'),
    }));
    const helper = join(f.root, 'askpass');
    const marker = join(f.root, 'askpass-called');
    writeFileSync(helper, `#!/bin/sh\nprintf called >> '${marker}'\nexit 1\n`, { mode: 0o700 });
    const result = spawnSync(
      'git',
      ['-c', 'credential.helper=', '-c', `core.askPass=${helper}`, 'credential', 'fill'],
      {
        env: f.env,
        input: 'protocol=https\nhost=fixture.invalid\n\n',
        encoding: 'utf8',
        timeout: 3000,
      },
    );
    assert.equal(result.status, 128, result.stderr);
    assert.equal(existsSync(marker), false, 'Git must not invoke a GUI/terminal askpass helper');
    if (existsSync('/bin/zsh')) {
      for (const file of ['.zshenv', '.zprofile', '.zshrc', '.zlogin'])
        writeFileSync(
          join(f.host, file),
          `export GIT_ASKPASS='${helper}' GIT_TERMINAL_PROMPT=1 GCM_INTERACTIVE=always\n`,
        );
      for (const mode of ['-c', '-lc', '-ic']) {
        const shell = spawnSync('/bin/zsh', [mode, 'exec git -c credential.helper= credential fill'], {
          env: f.env,
          input: 'protocol=https\nhost=fixture.invalid\n\n',
          encoding: 'utf8',
          timeout: 3000,
        });
        assert.equal(shell.status, 128, shell.stderr);
        assert.equal(existsSync(marker), false, `host startup must not reactivate askpass (${mode})`);
      }
    }
  },
);

test(
  'native Git credential helper follows host config without copying credentials into the account',
  { skip: !existsSync('/bin/zsh') },
  async (t) => {
    const f = await fixture(t);
    const helper = join(f.host, 'synthetic-helper.cjs');
    writeFileSync(
      helper,
      "if (process.argv[2] === 'get') process.stdout.write('username=fixture-user\\npassword=fixture-password\\n');\n",
    );
    const quoted = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    const result = spawnSync(
      'git',
      [
        'config',
        '--file',
        join(f.host, '.gitconfig'),
        'credential.helper',
        `!${quoted(process.execPath)} ${quoted(helper)}`,
      ],
      { encoding: 'utf8', timeout: 3000 },
    );
    assert.equal(result.status, 0, result.stderr);
    const read = spawnSync('/bin/zsh', ['-c', 'exec git credential fill'], {
      env: f.env,
      input: 'protocol=https\nhost=fixture.invalid\n\n',
      encoding: 'utf8',
      timeout: 3000,
    });
    assert.equal(read.status, 0, read.stderr);
    assert.match(read.stdout, /username=fixture-user\npassword=fixture-password/);
    assert.equal(existsSync(join(f.plan.binding.profileHome, '.gitconfig')), false);
  },
);

test(
  'native hook retains account protection after the command shell restores host HOME',
  { skip: !existsSync('/bin/zsh') },
  async (t) => {
    const f = await fixture(t);
    const geminiDir = f.plan.cliOptions.args
      .find((arg) => arg.startsWith('--gemini_dir='))
      .slice('--gemini_dir='.length);
    const hooks = JSON.parse(readFileSync(join(geminiDir, 'config', 'hooks.json'), 'utf8'));
    const command = hooks['cat-cafe-native-effect'].PreToolUse[0].hooks[0].command;
    const invoke = (name, args) =>
      JSON.parse(
        execFileSync('/bin/zsh', ['-c', command], {
          env: f.env,
          encoding: 'utf8',
          timeout: 3000,
          input: JSON.stringify({ toolCall: { name, args }, workspacePaths: [f.workspace] }),
        }),
      );
    for (const target of [
      join(f.plan.binding.profileHome, '.gemini/config/hooks.json'),
      join(f.host, '.gemini/config/hooks.json'),
    ])
      assert.equal(invoke('write_to_file', { TargetFile: target }).decision, 'deny', target);
    for (const CommandLine of [
      'printf payload > "$GEMINI_HOME/config/hooks.json"',
      'printf payload > "$HOME/Library/Preferences/com.apple.security.plist"',
      'security import synthetic-keychain-input',
    ])
      assert.equal(invoke('run_command', { CommandLine }).decision, 'deny', CommandLine);
    assert.equal(
      invoke('run_command', { CommandLine: 'printf payload > "$HOME/.synthetic-tool/output"' }).decision,
      'allow',
    );
  },
);

test('native launch preserves explicit tool configuration roots', async (t) => {
  const f = await fixture(t, ({ host }) => ({
    XDG_CONFIG_HOME: join(host, 'custom-config'),
    GH_CONFIG_DIR: join(host, 'custom-gh'),
    XDG_CACHE_HOME: join(host, 'custom-cache'),
    XDG_DATA_HOME: join(host, 'custom-data'),
    XDG_STATE_HOME: join(host, 'custom-state'),
    GIT_CONFIG_GLOBAL: join(host, 'chosen.gitconfig'),
  }));
  for (const [key, suffix] of Object.entries({
    XDG_CONFIG_HOME: 'custom-config',
    GH_CONFIG_DIR: 'custom-gh',
    XDG_CACHE_HOME: 'custom-cache',
    XDG_DATA_HOME: 'custom-data',
    XDG_STATE_HOME: 'custom-state',
    GIT_CONFIG_GLOBAL: 'chosen.gitconfig',
  }))
    assert.equal(f.env[key], join(f.host, suffix), key);
  writeFileSync(f.env.GIT_CONFIG_GLOBAL, '[fixture]\n chosen = explicit\n');
  assert.equal(f.git('config', '--get', 'fixture.chosen').stdout.trim(), 'explicit');
});

test(
  'missing Git credentials fail inside a real terminal instead of waiting for keyboard input',
  { skip: process.platform === 'win32', timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const probe = join(f.root, 'credential-terminal.cjs');
    writeFileSync(
      probe,
      `
      const r = require('node:child_process').spawnSync('git', ['-c', 'credential.helper=', 'credential', 'fill'], {
        input: 'protocol=https\\nhost=fixture.invalid\\n\\n', stdio: ['pipe', 'inherit', 'inherit']
      });
      console.log('credential_status=' + r.status);
    `,
    );
    const observed = await new Promise((resolve) => {
      const child = pty.spawn(process.execPath, [probe], {
        name: 'xterm',
        cols: 120,
        rows: 24,
        cwd: f.workspace,
        env: f.env,
      });
      let output = '',
        timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {}
      }, 3000);
      child.onData((chunk) => {
        output += chunk;
      });
      child.onExit(() => {
        clearTimeout(timer);
        resolve({ timedOut, output });
      });
    });
    assert.equal(observed.error, undefined);
    assert.equal(observed.timedOut, false, `Git waited for a hidden terminal prompt: ${observed.output}`);
    assert.match(observed.output, /terminal prompts disabled/);
    assert.match(observed.output, /credential_status=128/);
  },
);
