import Database from 'better-sqlite3';

const [file, library, write] = process.argv.slice(2);
const observer = new Database(':memory:');
observer.loadExtension(library);
const free = Boolean(observer.prepare('SELECT memory_read_window_test_external_lock(?) free').get(file).free);
observer.close();
let writer;
if (write === 'write') {
  const db = new Database(file, { timeout: 0 });
  try {
    db.exec("BEGIN EXCLUSIVE; UPDATE lock_probe SET value='changed'; COMMIT");
    writer = 'committed';
  } catch (error) {
    if (error.code !== 'SQLITE_BUSY') throw error;
    writer = 'busy';
  } finally {
    db.close();
  }
}
console.log(JSON.stringify({ lock: free ? 'free' : 'busy', writer }));
