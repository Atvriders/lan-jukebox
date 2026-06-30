export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    const result = this.tail.then(() => fn());
    // Keep the chain alive even if fn rejects, so the lock always releases.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
