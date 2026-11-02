import Database from 'better-sqlite3';
import * as vec from 'sqlite-vec';
import { prepareFileVectorReadWindow } from '../../dist/domains/memory/file-vector-read-window.js';
import { PassageVectorStore } from '../../dist/domains/memory/PassageVectorStore.js';

const [file, library, ready, release] = process.argv.slice(2);
const db = new Database(file, { readonly: true });
vec.load(db);
const reader = prepareFileVectorReadWindow(db, library);
db.prepare('SELECT memory_read_window_test_control(0,0,?,?,0)').get(ready, release);
const query = Float32Array.from({ length: 32 }, (_, i) => (i + 1) / 32);
const rows = new PassageVectorStore(db, 32, reader).search(query, 2000);
db.close();
process.send({ type: 'result', count: rows.length }, () => process.disconnect());
