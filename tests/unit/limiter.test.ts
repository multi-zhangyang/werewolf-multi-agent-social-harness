/**
 * Activation-limiter checks: pins the process-wide provider backpressure pool
 * — bounded concurrency, FIFO waiting, idempotent release and abort semantics.
 * No model calls.
 */
import { strict as assert } from "node:assert";
import { it } from "vitest";
import { ActivationLimiter, limiterFromEnv } from "../../src/society/activation-limiter";
import { LiveConnectionRegistry } from "../../src/server/context";

function check(name: string, fn: () => void | Promise<void>): void {
  it(name, fn);
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

check("rejects non-positive pool sizes", () => {
  assert.throws(() => new ActivationLimiter(0), /positive integer/);
  assert.throws(() => new ActivationLimiter(1.5), /positive integer/);
});

check("permits up to max concurrent activations and queues the rest in FIFO order", async () => {
  const limiter = new ActivationLimiter(2);
  const holder1 = await limiter.acquire();
  const holder2 = await limiter.acquire();
  const acquired: string[] = [];
  const a = limiter.acquire().then((release) => { acquired.push("a"); return release; });
  const b = limiter.acquire().then((release) => { acquired.push("b"); return release; });
  const c = limiter.acquire().then((release) => { acquired.push("c"); return release; });
  await tick();
  assert.equal(limiter.concurrency(), 2, "exactly two active");
  assert.equal(limiter.pending(), 3, "all three wait behind the full pool");
  assert.deepEqual(acquired, [], "none jumped the queue");
  holder1();
  await tick();
  assert.deepEqual(acquired, ["a"], "first waiter gets the first free slot");
  holder2();
  await tick();
  assert.deepEqual(acquired, ["a", "b"], "second waiter follows");
  (await a)();
  await tick();
  assert.deepEqual(acquired, ["a", "b", "c"], "third waiter follows in order");
  (await b)(); (await c)();
});

check("release is idempotent and wakes exactly one waiter", async () => {
  const limiter = new ActivationLimiter(1);
  const first = await limiter.acquire();
  let secondResolved = false;
  void limiter.acquire().then((release) => { secondResolved = true; release(); });
  await tick();
  assert.equal(secondResolved, false, "second waits while the pool is full");
  first();
  first(); // double release must not over-credit the pool
  await tick();
  assert.equal(secondResolved, true, "release wakes the waiter");
  assert.equal(limiter.concurrency(), 0, "pool drains back to zero");
  assert.equal(limiter.pending(), 0, "queue drains");
});

check("abort while waiting rejects with ACTIVATION_ABORTED and frees the queue slot", async () => {
  const limiter = new ActivationLimiter(1);
  const holder = await limiter.acquire();
  const controller = new AbortController();
  const waiting = limiter.acquire(controller.signal).then(
    () => "acquired",
    (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))
  );
  await tick();
  controller.abort();
  const message = await waiting;
  assert.match(message, /ACTIVATION_ABORTED/);
  assert.equal(limiter.pending(), 0, "aborted waiter left the queue");
  const successor = limiter.acquire();
  assert.equal(limiter.pending(), 1, "a new waiter queues normally");
  holder();
  const release = await successor;
  release();
});

check("graceful shutdown waiting resolves on lease release and is bounded on a stuck lease", async () => {
  const limiter = new ActivationLimiter(1);
  const release = await limiter.acquire();
  const draining = limiter.waitForIdle(500);
  await tick();
  release();
  assert.equal(await draining, true, "lease release wakes the shutdown waiter");

  const stuck = await limiter.acquire();
  assert.equal(await limiter.waitForIdle(25), false, "shutdown grace expires instead of hanging forever");
  stuck();
  assert.equal(await limiter.waitForIdle(25), true, "pool is idle after the final release");
});

check("graceful shutdown closes every tracked SSE stream and forgets released streams", () => {
  const registry = new LiveConnectionRegistry();
  const chunks: string[] = [];
  let firstEnded = false;
  let releasedEnded = false;
  registry.track({
    get writableEnded() { return firstEnded; },
    write(chunk) { chunks.push(chunk); },
    end() { firstEnded = true; }
  });
  const release = registry.track({
    get writableEnded() { return releasedEnded; },
    write() { throw new Error("released SSE must not be touched"); },
    end() { releasedEnded = true; }
  });
  release();

  assert.equal(registry.count(), 1);
  registry.closeAll();
  assert.equal(firstEnded, true, "tracked SSE is ended before provider draining");
  assert.equal(releasedEnded, false, "already released SSE is ignored");
  assert.deepEqual(chunks, [": society shutdown\n\n"]);
  assert.equal(registry.count(), 0);
});

check("limiterFromEnv parses the size with sane bounds and a default", () => {
  assert.equal(limiterFromEnv({ SOCIETY_MAX_CONCURRENT_ACTIVATIONS: "16" }).maxConcurrent, 16);
  assert.equal(limiterFromEnv({}).maxConcurrent, 8);
  assert.equal(limiterFromEnv({ SOCIETY_MAX_CONCURRENT_ACTIVATIONS: "0" }).maxConcurrent, 8, "zero falls back");
  assert.equal(limiterFromEnv({ SOCIETY_MAX_CONCURRENT_ACTIVATIONS: "9999" }).maxConcurrent, 8, "oversized falls back");
});
