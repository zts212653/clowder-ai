import Database from 'better-sqlite3';
import { DynamicTaskStore } from '../../src/infrastructure/scheduler/DynamicTaskStore.ts';

const [path, encoded] = process.argv.slice(2);
const { state, definition } = JSON.parse(encoded);
const db = new Database(path);
const store = new DynamicTaskStore(db);
process.send('ready');
process.once('message', () => {
  try {
    store.insert(definition, 'strict', state);
    process.send({ accepted: true });
  } catch (error) {
    process.send({ accepted: false, message: error.message });
  } finally {
    db.close();
    process.disconnect();
  }
});
