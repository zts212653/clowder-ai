import { writeSync } from 'node:fs';

writeSync(2, `discarded startup prefix\n${'diagnostic detail\n'.repeat(3000)}native loader fixture failure\n`);
process.exit(17);
