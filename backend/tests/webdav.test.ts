import assert from 'node:assert/strict';
import test from 'node:test';
import { parseWebdavMtime, webdavContentType, webdavHref, webdavPathSegments, webdavQuota } from '../src/webdav.js';

test('WebDAV hrefs use only the /webdav endpoint', () => {
  assert.equal(webdavHref([], true), '/webdav/');
  assert.equal(webdavHref(['photos', 'raw file.jpg'], false), '/webdav/photos/raw%20file.jpg');
  assert.equal(webdavHref(['photos'], true), '/webdav/photos/');
});

test('WebDAV destinations reject the removed /dav endpoint', () => {
  assert.deepEqual(webdavPathSegments('/webdav'), []);
  assert.deepEqual(webdavPathSegments('/webdav/folder%20name/file.txt'), ['folder name', 'file.txt']);
  assert.throws(() => webdavPathSegments('/dav/folder/file.txt'), /inside \/webdav/);
  assert.throws(() => webdavPathSegments('/webdav-other/file.txt'), /inside \/webdav/);
});

test('WebDAV client modification times accept sync-client formats', () => {
  assert.equal(parseWebdavMtime('1700000000')?.toISOString(), '2023-11-14T22:13:20.000Z');
  assert.equal(parseWebdavMtime('1700000000123')?.toISOString(), '2023-11-14T22:13:20.123Z');
  assert.equal(parseWebdavMtime('Tue, 14 Nov 2023 22:13:20 GMT')?.toISOString(), '2023-11-14T22:13:20.000Z');
  assert.equal(parseWebdavMtime('not-a-date'), null);
  assert.equal(parseWebdavMtime(undefined), null);
});

test('WebDAV uses extracted MIME metadata for generic uploads', () => {
  assert.equal(webdavContentType('application/octet-stream', { 'File:MIMEType': 'image/jpeg' }), 'image/jpeg');
  assert.equal(webdavContentType(undefined, { 'File:MIMEType': 'video/mp4' }), 'video/mp4');
  assert.equal(webdavContentType('text/plain; charset=utf-8', { 'File:MIMEType': 'application/octet-stream' }), 'text/plain');
  assert.equal(webdavContentType('application/octet-stream', { 'File:MIMEType': 'invalid' }), 'application/octet-stream');
});

test('WebDAV reports effective usage and available bytes for quota-limited users', () => {
  assert.deepEqual(webdavQuota({ usedBytes: '600', reservedBytes: '50', quotaBytes: '1000' }), {
    usedBytes: '650',
    availableBytes: '350',
  });
  assert.deepEqual(webdavQuota({ usedBytes: '1200', reservedBytes: '0', quotaBytes: '1000' }), {
    usedBytes: '1200',
    availableBytes: '0',
  });
  assert.equal(webdavQuota({ usedBytes: '600', reservedBytes: '0', quotaBytes: null }), null);
});
