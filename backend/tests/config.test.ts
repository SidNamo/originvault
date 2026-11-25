import assert from 'node:assert/strict';
import test from 'node:test';
import { isSupportedPublicUrlProtocol, parseOriginConfig } from '../src/config.js';

test('PUBLIC_URL supports HTTPS domains and explicit HTTP IP origins', () => {
  const url = (protocol: string, hostname: string) => new URL(`${protocol}//${hostname}`);
  const address = [198, 51, 100, 1].join('.');
  assert.equal(isSupportedPublicUrlProtocol(url('https:', 'example.invalid')), true);
  assert.equal(isSupportedPublicUrlProtocol(url('http:', address)), true);
  assert.equal(isSupportedPublicUrlProtocol(url('http:', 'example.invalid')), false);
});

test('additional origins keep their ports and do not change the public link origin', () => {
  const primary = 'https://vault.example';
  const lan = 'http://192.168.0.2:1234';
  assert.deepEqual(parseOriginConfig(primary).corsAllowedOrigins, [primary]);
  assert.deepEqual(parseOriginConfig(primary, ` ${lan}/, ${primary}:8443, ${primary}:443 `), {
    publicUrl: primary, corsAllowedOrigins: [primary, lan, `${primary}:8443`],
  });
});

test('invalid additional origins fail configuration rather than widening access', () => {
  for (const value of ['*', 'https://*.example', 'vault.example:8443', 'http://vault.example',
    'http://192.168.0.2:99999', 'https://user@vault.example', 'https://vault.example/path',
    'https://vault.example/?query', 'https://vault.example/#fragment']) {
    assert.throws(() => parseOriginConfig('https://vault.example', value), /CORS_ALLOWED_ORIGINS/, value);
  }
});
