// Serialized into the owned, initially paused Electron main process. This is
// diagnostic instrumentation; neither the installed files nor normal launches change.
export function installApiObserverBridge(config, host = process) {
  const assert = host.getBuiltinModule('node:assert/strict');
  const fs = host.getBuiltinModule('node:fs');
  const path = host.getBuiltinModule('node:path');
  const { createHash } = host.getBuiltinModule('node:crypto');
  const childProcess = host.getBuiltinModule('node:child_process');
  const canonical = (value) => {
    assert.equal(typeof value, 'string');
    assert.ok(path.isAbsolute(value));
    const resolved = path.resolve(value);
    return host.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const inside = (parent, value) => canonical(value).startsWith(`${canonical(parent)}${path.sep}`);
  assert.ok(Number.isSafeInteger(config.expectedPid) && config.expectedPid > 0);
  assert.equal(host.pid, config.expectedPid, 'Inspector belongs to a different process');
  assert.equal(host.type, 'browser', 'Expected Electron main process');
  assert.equal(canonical(fs.realpathSync(host.execPath)), canonical(fs.realpathSync(config.executable)));
  const install = fs.realpathSync(config.install);
  for (const file of [config.executable, config.nativeNode, config.apiEntry]) {
    assert.ok(inside(install, fs.realpathSync(file)), 'Executable or API entry escaped the installation');
    assert.ok(fs.statSync(file).isFile());
  }
  assert.ok(fs.statSync(config.state).isDirectory());
  assert.ok(fs.statSync(config.evidence).isDirectory());
  for (const file of [config.output, config.receipt]) {
    assert.equal(canonical(fs.realpathSync(path.dirname(file))), canonical(fs.realpathSync(config.evidence)));
    assert.ok(!fs.existsSync(file), 'Diagnostic evidence already exists');
  }
  assert.notEqual(canonical(config.output), canonical(config.receipt));
  assert.ok(Array.isArray(config.sources) && config.sources.length > 0 && config.sources.length <= 2);
  assert.ok(config.sources.some((source) => canonical(source.path) === canonical(config.preload)));
  const verifySources = () => {
    for (const source of config.sources) {
      assert.match(source.sha256, /^[a-f0-9]{64}$/);
      assert.equal(createHash('sha256').update(fs.readFileSync(source.path)).digest('hex'), source.sha256);
    }
  };
  verifySources();
  const original = childProcess.spawn;
  let observed = false;
  childProcess.spawn = function observedSpawn(...originalArgs) {
    const [file, args, options] = originalArgs;
    const target =
      typeof file === 'string' &&
      path.isAbsolute(file) &&
      canonical(file) === canonical(config.nativeNode) &&
      Array.isArray(args) &&
      args.at(-1) === config.apiEntry;
    if (!target) return Reflect.apply(original, this, originalArgs);
    assert.ok(!observed, 'API child already observed');
    assert.equal(canonical(options.cwd), canonical(path.join(config.state, 'project')));
    assert.equal(canonical(options.env.CAT_CAFE_DESKTOP_INSTANCE_ROOT), canonical(config.state));
    verifySources();
    assert.ok(!fs.existsSync(config.output) && !fs.existsSync(config.receipt));
    observed = true;
    const child = Reflect.apply(original, this, [
      file,
      ['--require', config.preload, ...args],
      {
        ...options,
        env: { ...options.env, CAT_CAFE_WINDOWS_PRIVATE_OBSERVER_OUTPUT: config.output },
      },
    ]);
    fs.writeFileSync(
      config.receipt,
      `${JSON.stringify({
        mainPid: host.pid,
        apiPid: child.pid ?? null,
        diagnosticOnly: true,
        installedFilesChanged: false,
        sources: config.sources.map((source) => ({ name: path.basename(source.path), sha256: source.sha256 })),
      })}\n`,
      { flag: 'wx', mode: 0o600 },
    );
    return child;
  };
  return { installed: true, mainPid: host.pid, expectedApiSpawns: 1 };
}
