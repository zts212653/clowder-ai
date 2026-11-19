import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export interface MemoryDataLocations {
  readonly dataDir: string;
  readonly eventDbPath: string;
  readonly globalDbPath: string;
  readonly tasteProjectRoot?: string;
}

export function resolveMemoryDataLocations(config: {
  sqlitePath?: string;
  dataDir?: string;
  globalDbPath?: string;
}): MemoryDataLocations {
  const dataDir = resolve(config.dataDir ?? join(homedir(), '.cat-cafe'));
  const sqlitePath = config.sqlitePath ?? 'evidence.sqlite';
  const eventPath =
    process.env.EVENT_MEMORY_DB ??
    (sqlitePath === ':memory:' ? ':memory:' : join(dirname(resolve(sqlitePath)), 'event-memory.sqlite'));
  const globalPath = config.globalDbPath ?? process.env.GLOBAL_KNOWLEDGE_DB ?? join(dataDir, 'global_knowledge.sqlite');
  return {
    dataDir,
    eventDbPath: eventPath === ':memory:' ? eventPath : resolve(eventPath),
    globalDbPath: globalPath === ':memory:' ? globalPath : resolve(globalPath),
  };
}
