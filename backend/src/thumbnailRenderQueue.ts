export type ThumbnailRenderJob = { priority: 'interactive' | 'background' };

export class ThumbnailRendererBusyError extends Error {}

// A shared job object lets a visible thumbnail promote an already queued backfill.
export class ThumbnailRenderQueue {
  private active = 0;
  private readonly waiting: Array<{
    job: ThumbnailRenderJob;
    resolve: (release: () => void) => void;
  }> = [];

  constructor(private readonly concurrency = 2, private readonly maximumWaiting = 32) {}

  private releaseSlot(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const interactiveIndex = this.waiting.findIndex((entry) => entry.job.priority === 'interactive');
      const next = this.waiting.splice(Math.max(0, interactiveIndex), 1)[0];
      if (next) next.resolve(this.releaseSlot());
      else this.active -= 1;
    };
  }

  private async acquire(job: ThumbnailRenderJob): Promise<() => void> {
    if (this.active < this.concurrency) {
      this.active += 1;
      return this.releaseSlot();
    }
    if (this.waiting.length >= this.maximumWaiting)
      throw new ThumbnailRendererBusyError('Thumbnail renderer is busy');
    return new Promise((resolve) => this.waiting.push({ job, resolve }));
  }

  async run<T>(job: ThumbnailRenderJob, work: () => Promise<T>): Promise<T> {
    const release = await this.acquire(job);
    try {
      return await work();
    } finally {
      release();
    }
  }
}
