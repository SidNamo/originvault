import assert from 'node:assert/strict';
import test from 'node:test';
import {
  detectTextEncodingFromBytes,
  isEditableTextFile,
  normalizeEncoding,
  previewKind,
  SUPPORTED_TEXT_ENCODINGS,
} from '../src/filePreview.js';

test('preview classification is case-insensitive and broad', () => {
  assert.equal(isEditableTextFile('SETTINGS.JSON'), true);
  assert.equal(isEditableTextFile('Dockerfile'), true);
  assert.equal(isEditableTextFile('.ENV'), true);
  assert.equal(isEditableTextFile('notes.unknown', 'text/plain'), true);
  assert.equal(previewKind('CAPTIONS.SRT'), 'subtitle');
  assert.equal(previewKind('PHOTO.JPEG'), 'image');
  assert.equal(previewKind('MOVIE.MKV'), 'video');
  assert.equal(previewKind('TRACK.FLAC'), 'audio');
  assert.equal(previewKind('DOCUMENT.PDF'), 'pdf');
  assert.equal(previewKind('archive.ZIP'), 'unsupported');
});

test('the editor exposes unicode and common legacy encodings', () => {
  for (const encoding of [
    'utf-8',
    'utf-16le',
    'utf-16be',
    'euc-kr',
    'cp949',
    'shift_jis',
    'gb18030',
    'windows-1252',
  ])
    assert.ok(SUPPORTED_TEXT_ENCODINGS.includes(encoding as never));
});

test('text encoding normalization and BOM detection are reusable without filesystem access', () => {
  assert.equal(normalizeEncoding('UTF8'), 'utf-8');
  assert.equal(normalizeEncoding('shift-jis'), 'shift_jis');
  assert.deepEqual(detectTextEncodingFromBytes(Buffer.from([0xff, 0xfe, 0x41, 0x00])), {
    encoding: 'utf-16le',
    hasBom: true,
  });
  assert.deepEqual(detectTextEncodingFromBytes(Buffer.from('plain utf-8')), {
    encoding: 'utf-8',
    hasBom: false,
  });
  assert.throws(() => normalizeEncoding('not-an-encoding'), /Unsupported text encoding/);
});
