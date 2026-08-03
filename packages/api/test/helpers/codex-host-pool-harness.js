import { CodexAppServerHostPool } from '../../dist/domains/cats/services/agents/providers/CodexAppServerHostPool.js';

export class FakeConnection {
  constructor(host) {
    this.host = host;
    this.closeCalls = 0;
    this.terminateCalls = 0;
    this.writes = [];
  }

  async *read() {}

  async write(message) {
    this.writes.push(message);
  }

  async close() {
    this.closeCalls++;
  }

  async terminate() {
    this.terminateCalls++;
  }
}

export class FakeHost {
  constructor(id, launch) {
    this.id = id;
    this.launch = launch;
    this.alive = true;
    this.closeCalls = 0;
    this.connections = [];
  }

  get isAlive() {
    return this.alive;
  }

  async close() {
    this.closeCalls++;
    this.alive = false;
  }
}

export function createHarness(config = {}) {
  const hosts = [];
  let nextSocketId = 1;
  const pool = new CodexAppServerHostPool(
    {
      idleTtlMs: 60_000,
      maxWarmHosts: 16,
      ...config,
    },
    {
      createSocketDirectory: () => `/private/tmp/codex-host-test-${nextSocketId++}`,
      removeSocketDirectory: async () => {},
      spawnHost: async (launch) => {
        const host = new FakeHost(`host-${hosts.length + 1}`, launch);
        hosts.push(host);
        return host;
      },
      connectHost: async (host) => {
        const connection = new FakeConnection(host);
        host.connections.push(connection);
        return connection;
      },
    },
  );
  return { pool, hosts };
}

export function sessionOptions(overrides = {}) {
  return {
    command: '/opt/homebrew/bin/codex',
    args: ['app-server', '--stdio', '--config', 'model="gpt-test"'],
    cwd: '/workspace/project',
    env: {
      HOME: '/home/user',
      CAT_CAFE_INVOCATION_ID: 'invocation-secret-id',
      CAT_CAFE_CALLBACK_TOKEN: 'callback-secret-token',
      CAT_CAFE_THREAD_ID: 'thread-secret-id',
    },
    invocationId: 'invocation-secret-id',
    ...overrides,
  };
}
