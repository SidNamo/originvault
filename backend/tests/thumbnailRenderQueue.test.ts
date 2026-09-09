import assert from 'node:assert/strict';
import test from 'node:test';
import { ThumbnailRenderQueue, ThumbnailRendererBusyError, type ThumbnailRenderJob } from '../src/thumbnailRenderQueue.js';

test('visible requests and promoted backfills run ahead of queued background work', async () => {
  const queue = new ThumbnailRenderQueue(1, 3);
  const hold = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const order: string[] = [];
  const running = queue.run({ priority: 'background' }, async () => {
    started.resolve();
    await hold.promise;
  });
  await started.promise;
  const background = queue.run({ priority: 'background' }, async () => { order.push('background'); });
  const job: ThumbnailRenderJob = { priority: 'background' };
  const promoted = queue.run(job, async () => { order.push('promoted'); });
  const visible = queue.run({ priority: 'interactive' }, async () => { order.push('visible'); });
  job.priority = 'interactive';
  hold.resolve();
  await Promise.all([running, background, promoted, visible]);
  assert.deepEqual(order, ['promoted', 'visible', 'background']);
});

test('render queue bounds pending work and releases slots on failure', async () => {
  const queue = new ThumbnailRenderQueue(1, 1);
  const hold = Promise.withResolvers<void>();
  const running = queue.run({ priority: 'background' }, () => hold.promise);
  const queued = queue.run({ priority: 'interactive' }, async () => { throw new Error('invalid video'); });
  const rejected = assert.rejects(queued, /invalid video/);
  await assert.rejects(queue.run({ priority: 'interactive' }, async () => undefined), ThumbnailRendererBusyError);
  hold.resolve();
  await Promise.all([running, rejected]);
  assert.equal(await queue.run({ priority: 'interactive' }, async () => 'next'), 'next');
});
