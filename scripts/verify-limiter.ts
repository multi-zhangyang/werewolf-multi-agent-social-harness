/**
 * Activation-limiter checks (run with `npx tsx scripts/verify-limiter.ts`).
 * Pins the process-wide provider backpressure pool (P3): bounded concurrency,
 * FIFO waiting, idempotent release and abort semantics. No model calls.
 */
import { strict as assert } from "node:assert";
import { ActivationLimiter, limiterFromEnv } from "../src/society/activation-limiter";

let passed = 0;
const pending: Array<Promise<void>> = [];
function check(name: string, fn: () => void | Promise<void>): void {
  pending.push(Promise.resolve(fn()).then(() => {
    passed += 1;
    console.log(`  ok  ${name}`);
  }).catch((cause) => {
    console.error(`  FAIL ${name}:`, cause instanceof Error ? cause.message : cause);
    process.exitCode = 1;
  }));
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

async function run(): Promise<void> {
  await check("rejects non-positive pool sizes", () => {
    assert.throws(() => new ActivationLimiter(0), /positive integer/);
    assert.throws(() => new ActivationLimiter(1.5), /positive integer/);
  });

  await check("permits up to max concurrent activations and queues the rest in FIFO order", async () => {
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

  await check("release is idempotent and wakes exactly one waiter", async () => {
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

  await check("abort while waiting rejects with ACTIVATION_ABORTED and frees the queue slot", async () => {
    const limiter = new ActivationLimiter(1);
    const holder = await limiter.acquire();
    const controller = new AbortController();
    const waiting = limiter.acquire(controller.signal).catch((cause: Error) => cause.message);
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

  await check("limiterFromEnv parses the size with sane bounds and a default", () => {
    assert.equal(limiterFromEnv({ SOCIETY_MAX_CONCURRENT_ACTIVATIONS: "16" }).maxConcurrent, 16);
    assert.equal(limiterFromEnv({}).maxConcurrent, 8);
    assert.equal(limiterFromEnv({ SOCIETY_MAX_CONCURRENT_ACTIVATIONS: "0" }).maxConcurrent, 8, "zero falls back");
    assert.equal(limiterFromEnv({ SOCIETY_MAX_CONCURRENT_ACTIVATIONS: "9999" }).maxConcurrent, 8, "oversized falls back");
  });
}

void run().then(async () => {
  await Promise.all(pending);
  console.log(`\nActivation-limiter checks: ${passed} passed.`);
});