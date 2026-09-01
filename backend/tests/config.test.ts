import assert from 'node:assert/strict';
import test from 'node:test';
import { isSupportedPublicUrlProtocol } from '../src/config.js';

test('PUBLIC_URL supports HTTPS domains and explicit HTTP IP origins', () => {
  const url = (protocol: string, hostname: string) => new URL(`${protocol}//${hostname}`);
  const address = [198, 51, 100, 1].join('.');
  assert.equal(isSupportedPublicUrlProtocol(url('https:', 'example.invalid')), true);
  assert.equal(isSupportedPublicUrlProtocol(url('http:', address)), true);
  assert.equal(isSupportedPublicUrlProtocol(url('http:', 'example.invalid')), false);
});
