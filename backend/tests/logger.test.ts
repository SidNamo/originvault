import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('daily log filenames and seven-day retention use UTC calendar dates', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'originvault-logs-'));
  process.env.LOG_DIR = temp;
  const { expiredLogFiles, logger, retentionCutoff, utcDate } = await import('../src/logger.js');
  try {
    const now = new Date('2026-08-10T23:59:59.000Z');
    assert.equal(utcDate(now), '2026-08-10');
    assert.equal(retentionCutoff(7, now), '2026-08-04');
    assert.deepEqual(expiredLogFiles([
      'originvault-2026-08-03.log',
      'originvault-2026-08-04.log',
      'originvault-2026-08-10.log',
      'other.log',
    ], 7, now), ['originvault-2026-08-03.log']);
    logger.info({ event: 'test_info_file_output' }, 'Info file output test');
    await new Promise((resolve) => setTimeout(resolve, 25));
    const logText = await readFile(path.join(temp, `originvault-${utcDate()}.log`), 'utf8');
    assert.match(logText, /"level":"INFO"/);
    assert.match(logText, /"event":"test_info_file_output"/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('an unavailable file sink falls back to stdout without terminating the process', async () => {
  const script = `
    process.env.LOG_DIR = '/dev/null/originvault-logs';
    const { logger } = await import('./src/logger.js');
    logger.info({ event: 'fallback_logger_test' }, 'Fallback logger test');
  `;
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: path.resolve(import.meta.dirname, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /"event":"fallback_logger_test"/);
  assert.match(result.stderr, /"event":"log_file_write_disabled"/);
});
