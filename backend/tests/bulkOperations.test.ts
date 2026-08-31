import assert from 'node:assert/strict';
import test from 'node:test';
import { copyDisplayNameCandidate, copyNameCandidate, parseCopySelections } from '../src/bulkOperations.js';

const FILE_ID = '042f76d4-5a8c-4e8f-9650-0a0b22dcc51f';
const FOLDER_ID = '315fa698-160f-4eb7-9494-0c919798b203';

test('copy selections accept grouped ids and use the existing bulk selection validation', () => {
  assert.deepEqual(parseCopySelections({
    files: [FILE_ID, FILE_ID.toUpperCase()],
    folders: [FOLDER_ID],
  }), [
    { type: 'file', id: FILE_ID },
    { type: 'folder', id: FOLDER_ID },
  ]);
  assert.deepEqual(parseCopySelections([
    { type: 'folder', id: FOLDER_ID },
  ]), [
    { type: 'folder', id: FOLDER_ID },
  ]);
  assert.throws(() => parseCopySelections({ files: [FILE_ID] }), /files and folders arrays/);
  assert.throws(() => parseCopySelections({ files: [], folders: [] }), /At least one/);
  assert.throws(() => parseCopySelections({ files: ['not-a-uuid'], folders: [] }), /valid file or folder id/);
});

test('copy name candidates are safe, distinguishable, and preserve file extensions', () => {
  assert.equal(copyNameCandidate('../report?.txt', 0, 'file'), 'report_.txt');
  assert.equal(copyNameCandidate('report.txt', 1, 'file'), 'report (1).txt');
  assert.equal(copyNameCandidate('report.txt', 2, 'file'), 'report (2).txt');
  assert.equal(copyNameCandidate('Photos', 1, 'folder'), 'Photos (1)');

  const longCandidate = copyNameCandidate(`${'a'.repeat(250)}.txt`, 12, 'file');
  assert.equal(longCandidate.length, 255);
  assert.match(longCandidate, / \(12\)\.txt$/);

  const multibyteCandidate = copyNameCandidate(`${'가'.repeat(84)}.txt`, 1, 'file');
  assert.ok(Buffer.byteLength(multibyteCandidate) <= 255);
  assert.match(multibyteCandidate, / \(1\)\.txt$/);
});

test('copied display names stay unchanged unless a collision needs a suffix', () => {
  assert.equal(copyDisplayNameCandidate('original?.jpg', 0), 'original?.jpg');
  assert.equal(copyDisplayNameCandidate('original?.jpg', 2), 'original? (2).jpg');
});
