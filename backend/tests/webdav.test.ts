import assert from 'node:assert/strict';
import test from 'node:test';
import { parseWebdavMtime, webdavContentType, webdavHref, webdavPathSegments, webdavQuota } from '../src/webdav.js';
import { parseWebdavDateProperties } from '../src/webdavProperties.js';

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
  assert.equal(webdavContentType('text/plain', { 'File:MIMEType': 'video/mp4' }), 'video/mp4');
});

test('WebDAV date properties honor namespaces and fail unsupported or conflicting updates atomically', () => {
  const body = (properties: string) => `<d:propertyupdate xmlns:d="DAV:" xmlns:m="urn:schemas-microsoft-com:"><d:set><d:prop>${properties}</d:prop></d:set></d:propertyupdate>`;
  const valid = parseWebdavDateProperties(body('<m:Win32LastModifiedTime>Tue, 14 Nov 2023 22:13:20 GMT</m:Win32LastModifiedTime><d:creationdate>2020-01-01T00:00:00Z</d:creationdate>'));
  assert.deepEqual(valid.map((property) => [property.kind, property.value?.toISOString(), property.status]), [
    ['modified', '2023-11-14T22:13:20.000Z', 200], ['created', '2020-01-01T00:00:00.000Z', 200],
  ]);
  assert.deepEqual(parseWebdavDateProperties(body('<d:getlastmodified>2020-01-01T00:00:00Z</d:getlastmodified><d:getetag>changed</d:getetag>')).map((property) => property.status), [424, 403]);
  assert.deepEqual(parseWebdavDateProperties(body('<d:getlastmodified>2020-01-01T00:00:00Z</d:getlastmodified><m:Win32LastModifiedTime>2021-01-01T00:00:00Z</m:Win32LastModifiedTime>')).map((property) => property.status), [409, 409]);
  assert.equal(parseWebdavDateProperties(body('<m:getlastmodified>2020-01-01T00:00:00Z</m:getlastmodified>'))[0]!.status, 403);
  assert.equal(parseWebdavDateProperties(body('<d:creationdate>not a date</d:creationdate>'))[0]!.status, 409);
  assert.throws(() => parseWebdavDateProperties('<!DOCTYPE foo [<!ENTITY x SYSTEM "file:///etc/passwd">]>' + body('<d:creationdate>&x;</d:creationdate>')), /Document types/);
  assert.throws(() => parseWebdavDateProperties(body('<d:creationdate><d:child/></d:creationdate>')), /structure/);
  assert.throws(() => parseWebdavDateProperties(body('<d:creationdate>2020-01-01T00:00:00Z')), /close tag/);
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
