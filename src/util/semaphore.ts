export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly max: number) {
    // max < 1 would make `active < max` permanently false in acquire(): every caller
    // queues forever and no slot is ever released — a silent deadlock. Fail loudly at
    // construction (startup) instead.
    if (!Number.isInteger(max) || max < 1) {
      throw new Error(`Semaphore max must be an integer >= 1, got ${max}`);
    }
  }

  async run<T>(fn: () => Promise<T> | T): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      next(); // hand the slot directly to the next waiter (active stays the same)
    } else {
      this.active--;
    }
  }
}
