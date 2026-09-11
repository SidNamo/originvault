import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import test from 'node:test';
import { config } from '../src/config.js';

test('frontend proxy streams uploads, preserves WebDAV and logs correlated failures without share tokens', {
  skip: !process.env.ORIGINVAULT_TEST_NGINX && 'Set ORIGINVAULT_TEST_NGINX=1 with nginx installed',
  timeout: 20_000,
}, async (t) => {
  const upstream = http.createServer((req, res) => {
    res.setHeader('X-Request-ID', req.headers['x-request-id']!);
    if (req.method === 'PROPFIND') {
      res.writeHead(207, { 'content-type': 'application/xml' });
      res.end(`<multistatus>${'x'.repeat(256 * 1024)}</multistatus>`);
      req.resume();
      return;
    }
    if (req.method === 'GET') { res.writeHead(req.url === '/api/health' ? 200 : 422); res.end(); return; }
    assert.equal(req.httpVersion, '1.1');
    let bytes = 0;
    req.on('data', (chunk) => { bytes += chunk.length; upstream.emit('bodyReceived'); });
    req.on('end', () => { res.writeHead(201); res.end(String(bytes)); });
  }).listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(async () => {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });
  const backendPort = (upstream.address() as net.AddressInfo).port;
  const reservation = net.createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = (reservation.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const directory = path.join(config.dataRoot, 'nginx');
  await mkdir(directory, { recursive: true });
  const source = (await readFile(new URL('../../frontend/nginx.conf', import.meta.url), 'utf8'))
    .replace('server backend:4000;', `server 127.0.0.1:${backendPort};`)
    .replace('listen 80;', `listen 127.0.0.1:${port};`)
    // Node child stdio uses sockets rather than Docker's reopenable stdout pipes.
    .replaceAll('/dev/stdout', `${directory}/access.log`)
    .replaceAll('/dev/stderr', `${directory}/error.log`);
  const configPath = path.join(directory, 'nginx.conf');
  await writeFile(configPath, `pid ${directory}/nginx.pid; error_log stderr warn; events {} http {
    client_body_temp_path ${directory}/body; proxy_temp_path ${directory}/proxy; ${source}
  }`);
  await promisify(execFile)('nginx', ['-t', '-e', 'stderr', '-p', directory, '-c', configPath]);
  const nginx = spawn('nginx', ['-e', 'stderr', '-p', directory, '-c', configPath, '-g', 'daemon off; master_process off;'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let errors = '';
  nginx.stdout.on('data', (chunk) => { output += chunk.toString(); });
  nginx.stderr.on('data', (chunk) => { errors += chunk.toString(); });
  const origin = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 50; i++) {
      if (await fetch(`${origin}/api/health`).then(async (res) => { await res.text(); return res.ok; }).catch(() => false)) break;
      if (nginx.exitCode !== null) assert.fail(errors);
      await delay(50);
    }
    for (const [method, url] of [['PUT', '/webdav'], ['PUT', '/webdav/upload.bin'], ['PATCH', '/api/upload-sessions/test'], ['POST', '/api/public/shares/secret/upload']]) {
      const firstBytes = once(upstream, 'bodyReceived', { signal: AbortSignal.timeout(3000) });
      const result = new Promise<{ status: number; bytes: string; id: string }>((resolve, reject) => {
        const req = http.request(`${origin}${url}`, { method, headers: { 'content-type': 'application/octet-stream' } }, (res) => {
          let bytes = '';
          res.setEncoding('utf8').on('data', (chunk) => { bytes += chunk; });
          res.on('end', () => resolve({ status: res.statusCode!, bytes, id: String(res.headers['x-request-id']) }));
        });
        req.on('error', reject);
        req.write('first');
        void firstBytes.then(() => req.end('last'), (error) => { req.destroy(); reject(error); });
      });
      const response = await result;
      assert.equal(response.status, 201);
      assert.equal(response.bytes, '9');
      assert.match(response.id, /^[0-9a-f]{32}$/);
    }
    const listing = await fetch(`${origin}/webdav/large`, { method: 'PROPFIND' });
    assert.equal(listing.status, 207);
    assert.equal((await listing.text()).length, 256 * 1024 + '<multistatus></multistatus>'.length);
    const failed = await fetch(`${origin}/api/public/shares/private-token/files/missing/thumbnail?secret=hidden`);
    assert.equal(failed.status, 422);
    await failed.text();
    await delay(50);
    output += await readFile(path.join(directory, 'access.log'), 'utf8');
    errors += await readFile(path.join(directory, 'error.log'), 'utf8');
    const records = output.trim().split('\n').map((line) => JSON.parse(line));
    assert.ok(records.some((record) => record.method === 'PUT' && record.path === '/webdav/upload.bin' && record.status === 201 && record.upstreamStatus === '201'));
    assert.ok(records.some((record) => record.path === '/api/public/shares/[REDACTED]' && record.status === 422 && record.requestId === failed.headers.get('x-request-id')));
    assert.doesNotMatch(output, /private-token|secret=hidden/);
    assert.doesNotMatch(errors, /buffered to a temporary file/);
  } finally {
    if (nginx.exitCode === null) {
      const stopped = once(nginx, 'exit');
      nginx.kill('SIGQUIT');
      await stopped;
    }
  }
});
