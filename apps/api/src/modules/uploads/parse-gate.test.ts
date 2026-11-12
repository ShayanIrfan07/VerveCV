import { describe, expect, it } from "vitest";
import { ParseGate, ParseGateError } from "./parse-gate.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("ParseGate", () => {
  it("validates concurrency, maxQueue, and maxWaitMs options", () => {
    expect(() => new ParseGate(0)).toThrow(/concurrency/i);
    expect(() => new ParseGate(1, { maxQueue: -1 })).toThrow(/maxQueue/i);
    expect(() => new ParseGate(1, { maxWaitMs: 0 })).toThrow(/maxWaitMs/i);
  });

  it("enforces a bounded queue and rejects excess requests immediately with QUEUE_FULL", async () => {
    const gate = new ParseGate(1, { maxQueue: 2, maxWaitMs: 5_000 });
    const blocker = deferred();

    const activeRun = gate.run(() => blocker.promise);
    expect(gate.activeCount).toBe(1);

    const queued1 = gate.run(async () => "q1");
    const queued2 = gate.run(async () => "q2");
    expect(gate.queuedCount).toBe(2);

    await expect(gate.run(async () => "overflow")).rejects.toEqual(
      expect.objectContaining({
        name: "ParseGateError",
        reason: "QUEUE_FULL",
      }),
    );
    expect(gate.queuedCount).toBe(2);

    blocker.resolve();
    await activeRun;
    await expect(Promise.all([queued1, queued2])).resolves.toEqual(["q1", "q2"]);
    expect(gate.activeCount).toBe(0);
    expect(gate.queuedCount).toBe(0);
  });

  it("supports maxQueue: 0 to fail fast whenever all parse slots are occupied", async () => {
    const gate = new ParseGate(1, { maxQueue: 0, maxWaitMs: 1_000 });
    const blocker = deferred();

    const activeRun = gate.run(() => blocker.promise);
    await expect(gate.run(async () => "second")).rejects.toMatchObject({
      reason: "QUEUE_FULL",
    });

    blocker.resolve();
    await activeRun;
    expect(gate.activeCount).toBe(0);
  });

  it("times out queued callers after maxWaitMs without leaking active slots or blocking subsequent tasks", async () => {
    const gate = new ParseGate(1, { maxQueue: 2, maxWaitMs: 25 });
    const blocker = deferred();

    const activeRun = gate.run(() => blocker.promise);
    let timedOutWorkExecuted = false;
    const timedOut = gate.run(async () => {
      timedOutWorkExecuted = true;
      return "should-not-run";
    });

    await expect(timedOut).rejects.toBeInstanceOf(ParseGateError);
    await expect(timedOut).rejects.toMatchObject({ reason: "QUEUE_TIMEOUT" });
    expect(timedOutWorkExecuted).toBe(false);
    expect(gate.queuedCount).toBe(0);
    expect(gate.activeCount).toBe(1);

    blocker.resolve();
    await activeRun;
    expect(gate.activeCount).toBe(0);

    await expect(gate.run(async () => "recovered")).resolves.toBe("recovered");
    expect(gate.activeCount).toBe(0);
  });

  it("cancels pre-aborted and mid-queue callers via AbortSignal without running work or leaking slots", async () => {
    const gate = new ParseGate(1, { maxQueue: 3, maxWaitMs: 5_000 });

    // Pre-aborted signal
    const preAborted = new AbortController();
    preAborted.abort();
    await expect(gate.run(async () => "never", { signal: preAborted.signal })).rejects.toMatchObject({
      reason: "ABORTED",
    });
    expect(gate.activeCount).toBe(0);

    // Mid-queue cancellation while slot is busy
    const blocker = deferred();
    const activeRun = gate.run(() => blocker.promise);

    const cancelController = new AbortController();
    let cancelledRan = false;
    const cancelledWaiter = gate.run(
      async () => {
        cancelledRan = true;
        return "cancelled";
      },
      { signal: cancelController.signal },
    );

    const survivorWaiter = gate.run(async () => "survivor");
    expect(gate.queuedCount).toBe(2);

    cancelController.abort();
    await expect(cancelledWaiter).rejects.toMatchObject({ reason: "ABORTED" });
    expect(cancelledRan).toBe(false);
    expect(gate.queuedCount).toBe(1);

    blocker.resolve();
    await activeRun;
    await expect(survivorWaiter).resolves.toBe("survivor");
    expect(gate.activeCount).toBe(0);
    expect(gate.queuedCount).toBe(0);
  });

  it("propagates AbortSignal into active work when cancelled mid-execution", async () => {
    const gate = new ParseGate(1, { maxQueue: 1, maxWaitMs: 5_000 });
    const controller = new AbortController();
    const started = deferred();
    let observedAbort = false;

    const running = gate.run(
      (signal) =>
        new Promise<string>((_, reject) => {
          started.resolve();
          signal.addEventListener(
            "abort",
            () => {
              observedAbort = true;
              reject(new ParseGateError("ABORTED", "aborted in work"));
            },
            { once: true },
          );
        }),
      { signal: controller.signal },
    );

    await started.promise;
    controller.abort();
    await expect(running).rejects.toMatchObject({ reason: "ABORTED" });
    expect(observedAbort).toBe(true);
    expect(gate.activeCount).toBe(0);
  });
});
