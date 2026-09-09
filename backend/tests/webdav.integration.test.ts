import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import test from 'node:test';
import pg from 'pg';
import sharp from 'sharp';
import { config } from '../src/config.js';

const databaseUrl = process.env.ORIGINVAULT_TEST_DATABASE_URL;
const execFileAsync = promisify(execFile);
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

test('WebDAV preserves original metadata and serves prebuilt/on-demand video posters in every scope', {
  skip: !databaseUrl && 'Set ORIGINVAULT_TEST_DATABASE_URL to a PostgreSQL role with CREATEDB permission',
  timeout: 120_000,
}, async () => {
  const admin = new pg.Client({ connectionString: databaseUrl });
  await admin.connect();
  const databaseName = `originvault_test_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  const connection = new URL(databaseUrl!);
  connection.pathname = `/${databaseName}`;
  const listener = net.createServer().listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = (listener.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  Object.assign(config, {
    postgresHost: connection.hostname, postgresPort: Number(connection.port || 5432), postgresDatabase: databaseName,
    postgresUser: decodeURIComponent(connection.username), postgresPassword: decodeURIComponent(connection.password) || 'integration-password',
    jwtSecret: randomBytes(32).toString('hex'), shareSecret: randomBytes(32).toString('hex'), publicUrl: origin,
  });
  const { db, migrate } = await import('../src/db.js');
  let backend: ReturnType<typeof spawn> | undefined;
  let backendOutput = '';
  try {
    await migrate();
    const userId = randomUUID();
    const storageKey = `dav-${randomUUID()}`;
    const root = path.join(config.dataRoot, storageKey);
    await mkdir(root, { recursive: true });
    await db.query(`INSERT INTO users(id,username,display_name,storage_key,password_hash) VALUES($1,'davtester','DAV tester',$2,'unused')`, [userId, storageKey]);
    // Invalid dates must not keep the maintenance cursor stuck ahead of a repairable legacy row.
    await db.query(`INSERT INTO files(id,user_id,original_name,stored_name,relative_path,mime_type,size_bytes,sha256,extracted_metadata)
      SELECT ('00000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid,$1,'legacy.dat','legacy.dat','legacy-' || n || '.dat',
        'application/octet-stream',0,repeat('a',64),jsonb_build_object('ExifIFD:DateTimeOriginal',CASE WHEN n=1001 THEN '2019:01:02 03:04:05' ELSE '0000:00:00 00:00:00' END)
      FROM generate_series(1,1001) AS n`, [userId]);
    backend = spawn(process.execPath, ['--import', 'tsx', 'tests/integrationServer.ts'], {
      cwd: process.cwd(),
      env: { ...process.env, ORIGINVAULT_TEST_DATABASE_URL: connection.toString(), ORIGINVAULT_TEST_PORT: String(port),
        POSTGRES_DB: databaseName, POSTGRES_USER: config.postgresUser, POSTGRES_PASSWORD: config.postgresPassword,
        JWT_SECRET: config.jwtSecret, SHARE_SECRET: config.shareSecret, PUBLIC_URL: origin, LOG_LEVEL: 'error' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    backend.stdout?.on('data', (chunk) => { backendOutput += chunk.toString(); });
    backend.stderr?.on('data', (chunk) => { backendOutput += chunk.toString(); });
    let ready = false;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (backend.exitCode !== null) throw new Error(`Backend stopped during startup: ${backendOutput}`);
      ready = await fetch(`${origin}/api/health`).then(async (response) => { await response.text(); return response.ok; }).catch(() => false);
      if (ready) break;
      await delay(50);
    }
    assert.ok(ready, backendOutput);
    const repaired = await db.query(`SELECT original_created_at FROM files WHERE relative_path='legacy-1001.dat'`);
    assert.equal(repaired.rows[0].original_created_at.toISOString(), '2019-01-02T03:04:05.000Z');
    await db.query(`DELETE FROM files WHERE relative_path LIKE 'legacy-%'`);

    const { signToken } = await import('../src/auth.js');
    const sessionHeaders = { authorization: `Bearer ${signToken({ id: userId, username: 'davtester', authVersion: 0 })}`, 'content-type': 'application/json' };
    const request = async (url: string, init: RequestInit, status: number) => {
      const response = await fetch(`${origin}${url}`, { ...init, headers: { connection: 'close', ...init.headers } });
      if (response.status !== status) assert.fail(`${init.method ?? 'GET'} ${url}: ${response.status} ${await response.text()}\n${backendOutput}`);
      return response;
    };
    const makeToken = async (access = 'readwrite', folderId: string | null = null) => {
      const response = await request('/api/webdav/tokens', { method: 'POST', headers: sessionHeaders, body: JSON.stringify({ name: 'integration', access, folderId }) }, 201);
      const payload = await response.json() as { token: string };
      return { authorization: `Bearer ${payload.token}` };
    };
    const dav = await makeToken();
    const getRow = async (relativePath: string) => (await db.query('SELECT * FROM files WHERE user_id=$1 AND relative_path=$2 AND trashed_at IS NULL', [userId, relativePath])).rows[0];
    const photoPath = path.join(config.dataRoot, 'fixture.jpg');
    await writeFile(photoPath, await sharp({ create: { width: 800, height: 600, channels: 3, background: '#3c725e' } }).jpeg().toBuffer());
    await execFileAsync('exiftool', ['-overwrite_original', '-DateTimeOriginal=2018:07:01 12:34:56', '-OffsetTimeOriginal=+09:00', '-Make=OriginVault', '-Model=Metadata fixture', photoPath]);
    const photoBytes = await readFile(photoPath);
    const originalModified = '2021-02-03T04:05:06.000Z';
    const uploaded = await request('/webdav/photo.jpg', { method: 'PUT', headers: { ...dav, 'content-type': 'application/octet-stream', 'x-oc-mtime': String(Date.parse(originalModified) / 1000) }, body: photoBytes }, 201);
    assert.equal(uploaded.headers.get('x-oc-mtime'), 'accepted');
    let photo = await getRow('photo.jpg');
    assert.equal(photo.sha256, sha(photoBytes));
    assert.equal(photo.mime_type, 'image/jpeg');
    assert.equal(photo.original_created_at.toISOString(), '2018-07-01T03:34:56.000Z');
    assert.equal(photo.client_last_modified.toISOString(), originalModified);
    assert.equal(photo.extracted_metadata['IFD0:Make'], 'OriginVault');
    assert.equal(photo.extracted_metadata['ExifIFD:DateTimeOriginal'], '2018:07:01 12:34:56');
    assert.equal(photo.extracted_metadata['System:FileName'], undefined);
    const propfind = await request('/webdav/photo.jpg', { method: 'PROPFIND', headers: { ...dav, depth: '0' } }, 207);
    const initialProperties = await propfind.text();
    assert.match(initialProperties, /2018-07-01T03:34:56.000Z/);
    assert.match(initialProperties, /Wed, 03 Feb 2021 04:05:06 GMT/);

    const patchBody = (properties: string) => `<d:propertyupdate xmlns:d="DAV:" xmlns:m="urn:schemas-microsoft-com:"><d:set><d:prop>${properties}</d:prop></d:set></d:propertyupdate>`;
    const patchHeaders = { ...dav, 'content-type': 'application/xml' };
    const updatedModified = '2022-06-07T08:09:10.123Z';
    const patched = await request('/webdav/photo.jpg', { method: 'PROPPATCH', headers: patchHeaders,
      body: patchBody(`<m:Win32LastModifiedTime>${updatedModified}</m:Win32LastModifiedTime><m:Win32CreationTime>2021-01-01T00:00:00Z</m:Win32CreationTime>`) }, 207);
    assert.doesNotMatch(await patched.text(), /403|409|424/);
    photo = await getRow('photo.jpg');
    assert.equal(photo.client_last_modified.toISOString(), updatedModified);
    assert.equal(photo.original_created_at.toISOString(), '2018-07-01T03:34:56.000Z');
    assert.equal(photo.extracted_metadata['WebDAV:CreationDate'], '2021-01-01T00:00:00.000Z');
    assert.deepEqual(await readFile(path.join(root, 'photo.jpg')), photoBytes);
    assert.ok(Math.abs((await stat(path.join(root, 'photo.jpg'))).mtimeMs - Date.parse(updatedModified)) < 2);
    const rejected = await request('/webdav/photo.jpg', { method: 'PROPPATCH', headers: patchHeaders,
      body: patchBody('<d:getlastmodified>2030-01-01T00:00:00Z</d:getlastmodified><d:getetag>changed</d:getetag>') }, 207);
    assert.match(await rejected.text(), /424 Failed Dependency/);
    assert.equal((await getRow('photo.jpg')).client_last_modified.toISOString(), updatedModified);
    const readOnly = await makeToken('read');
    await request('/webdav/photo.jpg', { method: 'PROPPATCH', headers: { ...readOnly, 'content-type': 'application/xml' }, body: patchBody('<d:creationdate>2030-01-01T00:00:00Z</d:creationdate>') }, 403);

    // MOVE must preserve indexed source timestamps rather than replace them with current filesystem times.
    await utimes(path.join(root, 'photo.jpg'), new Date(), new Date());
    await request('/webdav/photo.jpg', { method: 'MOVE', headers: { ...dav, destination: `${origin}/webdav/moved.jpg` } }, 201);
    const moved = await getRow('moved.jpg');
    assert.equal(moved.client_last_modified.toISOString(), updatedModified);
    assert.equal(moved.original_created_at.toISOString(), photo.original_created_at.toISOString());
    assert.deepEqual(moved.extracted_metadata, photo.extracted_metadata);
    assert.deepEqual(Buffer.from(await (await request('/webdav/moved.jpg', { headers: dav }, 200)).arrayBuffer()), photoBytes);
    await request('/webdav/folder', { method: 'MKCOL', headers: dav }, 201);
    await request('/webdav/moved.jpg', { method: 'MOVE', headers: { ...dav, destination: `${origin}/webdav/folder/moved.jpg` } }, 201);
    await request('/webdav/folder', { method: 'MOVE', headers: { ...dav, destination: `${origin}/webdav/renamed` } }, 201);
    assert.equal((await getRow('renamed/moved.jpg')).client_last_modified.toISOString(), updatedModified);
    const folder = (await db.query('SELECT id FROM folders WHERE user_id=$1 AND relative_path=$2', [userId, 'renamed'])).rows[0];
    const scoped = await makeToken('readwrite', folder.id);
    await request('/webdav/', { method: 'PROPPATCH', headers: { ...scoped, 'content-type': 'application/xml' },
      body: patchBody('<d:creationdate>2000-01-01T00:00:00Z</d:creationdate><d:getlastmodified>2003-01-01T00:00:00Z</d:getlastmodified>') }, 207);
    const scopedProperties = await (await request('/webdav/', { method: 'PROPFIND', headers: { ...scoped, depth: '0' } }, 207)).text();
    assert.match(scopedProperties, /2000-01-01T00:00:00.000Z/);
    assert.match(scopedProperties, /Wed, 01 Jan 2003 00:00:00 GMT/);

    // Unknown client mtime stays unknown; a later PROPPATCH supplies it without changing bytes.
    await request('/webdav/plain.txt', { method: 'PUT', headers: { ...dav, 'content-type': 'application/octet-stream' }, body: 'original text' }, 201);
    assert.equal((await getRow('plain.txt')).client_last_modified, null);
    await request('/webdav/plain.txt', { method: 'PROPPATCH', headers: { ...scoped, 'content-type': 'application/xml' },
      body: patchBody('<d:creationdate>2030-01-01T00:00:00Z</d:creationdate>') }, 404);
    await request('/webdav/plain.txt', { method: 'PROPPATCH', headers: patchHeaders,
      body: patchBody('<d:creationdate>2001-01-01T00:00:00Z</d:creationdate><d:getlastmodified>2002-01-01T00:00:00Z</d:getlastmodified>') }, 207);
    assert.equal((await getRow('plain.txt')).original_created_at.toISOString(), '2001-01-01T00:00:00.000Z');
    await request('/webdav/renamed/moved.jpg', { method: 'PUT', headers: { ...dav, 'content-type': 'image/jpeg' }, body: await sharp({ create: { width: 20, height: 10, channels: 3, background: '#c49322' } }).png().toBuffer() }, 204);
    const replaced = await getRow('renamed/moved.jpg');
    assert.equal(replaced.mime_type, 'image/png', 'byte-derived MIME wins over a wrong client Content-Type');
    assert.equal(replaced.original_created_at, null);
    assert.equal(replaced.client_last_modified, null);
    assert.equal(replaced.extracted_metadata['IFD0:Make'], undefined, 'replacement must not retain metadata from old bytes');

    const moviePath = path.join(config.dataRoot, 'fixture.mp4');
    await execFileAsync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-t', '0.4', '-c:v', 'libx264', '-threads', '2', '-metadata', 'creation_time=2020-04-03T02:01:00Z', moviePath]);
    const movieBytes = await readFile(moviePath);
    await request('/webdav/movie.mp4', { method: 'PUT', headers: { ...dav, 'content-type': 'application/octet-stream' }, body: movieBytes }, 201);
    const movie = await getRow('movie.mp4');
    assert.equal(movie.sha256, sha(movieBytes));
    assert.equal(movie.mime_type, 'video/mp4');
    assert.equal(movie.original_created_at.toISOString(), '2020-04-03T02:01:00.000Z');
    assert.ok(movie.extracted_metadata['QuickTime:Duration'] > 0);
    const posterPath = path.join(config.dataRoot, '.originvault-thumbnails/v1', movie.sha256.slice(0, 2), `${movie.sha256}.video.jpg`);
    assert.equal((await sharp(posterPath).metadata()).format, 'jpeg', 'WebDAV PUT prepares the poster before responding');
    const ticket = async (trashed = false) => {
      const response = await request(`/api/${trashed ? 'trash/files' : 'files'}/${movie.id}/preview-ticket`, { method: 'POST', headers: sessionHeaders }, 201);
      return (await response.json() as { url: string }).url;
    };
    const privateUrl = await ticket();
    await rm(posterPath);
    const posterResponse = await request(privateUrl, {}, 200);
    assert.equal(posterResponse.headers.get('content-type'), 'image/jpeg');
    const poster = Buffer.from(await posterResponse.arrayBuffer());
    assert.equal((await sharp(poster).metadata()).width, 512);
    const part = await request(privateUrl, { headers: { range: 'bytes=0-31' } }, 206);
    const first = Buffer.from(await part.arrayBuffer());
    const rest = await request(privateUrl, { headers: { range: 'bytes=32-', 'if-range': part.headers.get('etag')! } }, 206);
    assert.deepEqual(Buffer.concat([first, Buffer.from(await rest.arrayBuffer())]), poster);
    const head = await request(privateUrl, { method: 'HEAD' }, 200);
    assert.equal(Number(head.headers.get('content-length')), poster.length);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    const share = await (await request('/api/shares', { method: 'POST', headers: sessionHeaders, body: JSON.stringify({ type: 'file', id: movie.id }) }, 201)).json() as { id: string; url: string };
    const shareToken = new URL(share.url).pathname.split('/').at(-1)!;
    const publicUrl = `/api/public/shares/${shareToken}/files/${movie.id}/thumbnail`;
    await rm(posterPath);
    assert.equal((await request(publicUrl, {}, 200)).headers.get('content-type'), 'image/jpeg');
    await request(`/api/shares/${share.id}`, { method: 'DELETE', headers: sessionHeaders }, 204);
    await request(publicUrl, {}, 404);
    await request(`/api/files/${movie.id}`, { method: 'DELETE', headers: sessionHeaders }, 200);
    await rm(posterPath);
    const trashUrl = await ticket(true);
    assert.equal((await request(trashUrl, {}, 200)).headers.get('content-type'), 'image/jpeg');
    const download = await (await request(`/api/trash/files/${movie.id}/download-ticket`, { method: 'POST', headers: sessionHeaders }, 201)).json() as { url: string };
    assert.deepEqual(Buffer.from(await (await request(download.url, {}, 200)).arrayBuffer()), movieBytes);
  } finally {
    if (backend && backend.exitCode === null) {
      const exited = once(backend, 'exit');
      backend.kill('SIGTERM');
      const timeout = setTimeout(() => backend!.kill('SIGKILL'), 5000);
      await exited;
      clearTimeout(timeout);
    }
    await db.end();
    await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    await admin.end();
  }
});
