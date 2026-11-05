import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/** Observe the owner's real Redis calls; a selector's name is never evidence of indexed access. */
export async function auditRecoveryRedis(redis) {
  const reads = [];
  const monitor = await redis.monitor();
  monitor.on('monitor', (_at, args, _source, database) => {
    if (Number(database) === (redis.options.db ?? 0))
      reads.push({ command: String(args[0]).toLowerCase(), args: args.slice(1) });
  });
  return {
    reads,
    stop: () => monitor.disconnect(),
    async flush() {
      const marker = `recovery-audit:${randomUUID()}`;
      let listener;
      let timer;
      const seen = new Promise((resolve, reject) => {
        listener = (_at, args) => {
          if (args[0].toLowerCase() === 'echo' && args[1] === marker) resolve();
        };
        timer = setTimeout(() => reject(new Error('Redis recovery audit barrier timed out')), 5_000);
        monitor.on('monitor', listener);
      });
      try {
        await redis.echo(marker);
        await seen;
      } finally {
        clearTimeout(timer);
        monitor.off('monitor', listener);
      }
    },
    assertIndexed() {
      assert.equal(
        reads.some(({ command, args }) => command === 'smembers' && /(?:^|:)all$/.test(String(args[0]))),
        false,
        'recovery must not read SMEMBERS all',
      );
      assert.equal(
        reads.some(({ command }) => command === 'scan' || command === 'keys'),
        false,
        'recovery must not scan the keyspace',
      );
    },
  };
}

/** Capture executed SELECTs and their actual bindings, then ask SQLite about those exact queries. */
export function auditRecoverySqlite(database) {
  const reads = [];
  const db = new Proxy(database, {
    get(target, key) {
      if (key !== 'prepare') {
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (sql) => {
        const statement = target.prepare(sql);
        return new Proxy(statement, {
          get(prepared, method) {
            const value = Reflect.get(prepared, method, prepared);
            if (typeof value !== 'function') return value;
            return (...args) => {
              if (['get', 'all', 'iterate'].includes(method) && /^\s*(?:SELECT|WITH)\b/i.test(sql)) {
                const plan = target.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args);
                reads.push({ sql, plan });
              }
              return Reflect.apply(value, prepared, args);
            };
          },
        });
      };
    },
  });
  return {
    db,
    reads,
    assertIndex(index) {
      assert.ok(reads.length, 'must observe an actual owner read');
      assert.equal(
        reads.some(({ plan }) =>
          plan.some(
            ({ detail }) =>
              /^SCAN\s+[A-Za-z_]/i.test(detail) && !/^SCAN CONSTANT ROW/i.test(detail) && !detail.includes(index),
          ),
        ),
        false,
        'recovery performed an unbounded/full table scan outside its due index',
      );
      assert.ok(
        reads.some(({ plan }) => plan.some(({ detail }) => detail.includes(index))),
        `expected query index ${index}`,
      );
    },
  };
}
