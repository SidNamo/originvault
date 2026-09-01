import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const testRoot = path.join(os.tmpdir(), `originvault-tests-${process.pid}-${randomUUID()}`);

process.env.DATA_ROOT = path.join(testRoot, 'files');
process.env.LOG_DIR = path.join(testRoot, 'logs');

process.once('exit', () => {
  rmSync(testRoot, { recursive: true, force: true });
});
