import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  collectRuntimePorts,
  DEFAULT_EXCLUDED_PORTS,
  validatePort,
} from '../../../dist/domains/preview/port-validator.js';

describe('validatePort', () => {
  it('allows a normal dev server port', () => {
    const result = validatePort(3847);
    assert.equal(result.allowed, true);
  });

  it('rejects port below 1024', () => {
    const result = validatePort(80);
    assert.equal(result.allowed, false);
    assert.match(result.reason, /range/i);
  });

  it('rejects port 0', () => {
    const result = validatePort(0);
    assert.equal(result.allowed, false);
  });

  it('rejects port above 65535', () => {
    const result = validatePort(70000);
    assert.equal(result.allowed, false);
    assert.match(result.reason, /range/i);
  });

  it('rejects Hub API port (3004)', () => {
    const result = validatePort(3004);
    assert.equal(result.allowed, false);
    assert.match(result.reason, /excluded/i);
  });

  it('rejects Redis port (6399)', () => {
    const result = validatePort(6399);
    assert.equal(result.allowed, false);
  });

  it('rejects Hub frontend port (3003)', () => {
    const result = validatePort(3003);
    assert.equal(result.allowed, false);
  });

  it('rejects MCP port (18888)', () => {
    const result = validatePort(18888);
    assert.equal(result.allowed, false);
  });

  it('rejects Anthropic proxy port (9877)', () => {
    const result = validatePort(9877);
    assert.equal(result.allowed, false);
  });

  it('rejects gateway self port', () => {
    const result = validatePort(4000, { gatewaySelfPort: 4000 });
    assert.equal(result.allowed, false);
    assert.match(result.reason, /gateway/i);
  });

  it('rejects with custom excluded ports', () => {
    const result = validatePort(5555, { excludedPorts: [5555] });
    assert.equal(result.allowed, false);
  });

  it('rejects non-loopback host', () => {
    const result = validatePort(3847, { host: '192.168.1.1' });
    assert.equal(result.allowed, false);
    assert.match(result.reason, /loopback/i);
  });

  it('allows localhost host', () => {
    const result = validatePort(3847, { host: 'localhost' });
    assert.equal(result.allowed, true);
  });

  it('allows 127.0.0.1 host', () => {
    const result = validatePort(3847, { host: '127.0.0.1' });
    assert.equal(result.allowed, true);
  });

  it('allows ::1 host', () => {
    const result = validatePort(3847, { host: '::1' });
    assert.equal(result.allowed, true);
  });

  it('DEFAULT_EXCLUDED_PORTS contains all Clowder AI service ports', () => {
    // Hub frontend (3003) + Hub API (3004) — ports updated to avoid conflicts
    const expected = [3003, 3004, 6398, 6399, 18888, 19999, 9876, 9878, 9879, 9877];
    for (const port of expected) {
      assert.ok(DEFAULT_EXCLUDED_PORTS.includes(port), `Missing excluded port: ${port}`);
    }
  });

  // P1-2: Dynamic port exclusion from runtime env
  it('rejects port matching runtime env API_SERVER_PORT', () => {
    const result = validatePort(3011, { runtimePorts: [3011, 3012] });
    assert.equal(result.allowed, false);
    assert.match(result.reason, /excluded/i);
  });

  it('allows port not in runtime or default exclusion', () => {
    const result = validatePort(5500, { runtimePorts: [3011, 3012] });
    assert.equal(result.allowed, true);
  });

  // Cloud review P1: string port bypasses excludedPorts.includes()
  it('rejects string port that matches excluded port (coercion)', () => {
    const result = validatePort('6399');
    assert.equal(result.allowed, false);
  });

  it('rejects non-numeric string port', () => {
    const result = validatePort('abc');
    assert.equal(result.allowed, false);
  });

  it('coerces valid string port to number and allows', () => {
    const result = validatePort('3847');
    assert.equal(result.allowed, true);
  });
});

describe('collectRuntimePorts', () => {
  const envSnapshot = {};

  afterEach(() => {
    // Restore env vars
    for (const key of [
      'API_SERVER_PORT',
      'FRONTEND_PORT',
      'MCP_SERVER_PORT',
      'PREVIEW_GATEWAY_PORT',
      'REDIS_PORT',
      'VITE_PORT',
    ]) {
      if (envSnapshot[key] !== undefined) {
        process.env[key] = envSnapshot[key];
      } else {
        delete process.env[key];
      }
    }
  });

  it('reads VITE_PORT from env', () => {
    const saved = process.env.VITE_PORT;
    envSnapshot.VITE_PORT = saved;
    process.env.VITE_PORT = '5173';
    const ports = collectRuntimePorts();
    assert.ok(ports.includes(5173), 'collectRuntimePorts should include VITE_PORT');
    if (saved !== undefined) process.env.VITE_PORT = saved;
    else delete process.env.VITE_PORT;
  });

  it('reads multiple env keys', () => {
    for (const key of ['API_SERVER_PORT', 'FRONTEND_PORT', 'VITE_PORT']) {
      envSnapshot[key] = process.env[key];
    }
    process.env.API_SERVER_PORT = '3102';
    process.env.FRONTEND_PORT = '3203';
    process.env.VITE_PORT = '5173';
    const ports = collectRuntimePorts();
    assert.ok(ports.includes(3102));
    assert.ok(ports.includes(3203));
    assert.ok(ports.includes(5173));
  });

  it('ignores invalid env values', () => {
    envSnapshot.VITE_PORT = process.env.VITE_PORT;
    process.env.VITE_PORT = 'notanumber';
    const ports = collectRuntimePorts();
    assert.ok(!ports.includes(Number.NaN));
  });
});
