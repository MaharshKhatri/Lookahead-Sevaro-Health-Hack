/**
 * A single async mutex around every store mutation (Session 6 spec): commands,
 * event appends, clock moves and resets run one at a time, in arrival order.
 */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => T | Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    // Keep the chain alive whatever fn does; callers still see their own rejection.
    this.tail = next.catch(() => undefined);
    return next;
  }
}
