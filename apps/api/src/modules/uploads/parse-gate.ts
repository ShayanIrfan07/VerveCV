export type ParseGateFailureReason = "QUEUE_FULL" | "QUEUE_TIMEOUT" | "ABORTED";

export class ParseGateError extends Error {
  readonly reason: ParseGateFailureReason;

  constructor(reason: ParseGateFailureReason, message: string) {
    super(message);
    this.name = "ParseGateError";
    this.reason = reason;
  }
}

export interface ParseGateOptions {
  maxQueue?: number;
  maxWaitMs?: number;
}

export interface ParseGateRunOptions {
  signal?: AbortSignal;
  maxWaitMs?: number;
}

interface Waiter {
  settled: boolean;
  grant: () => void;
  cleanup: () => void;
}

export const DEFAULT_PARSE_MAX_QUEUE = 16;
export const DEFAULT_PARSE_QUEUE_TIMEOUT_MS = 5_000;

export class ParseGate {
  private active = 0;
  private readonly waiting: Waiter[] = [];
  private readonly maxQueue: number;
  private readonly maxWaitMs: number;

  constructor(
    private readonly limit: number,
    options: ParseGateOptions = {},
  ) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error("Parse concurrency must be a positive integer");
    }
    const maxQueue = options.maxQueue ?? DEFAULT_PARSE_MAX_QUEUE;
    if (!Number.isInteger(maxQueue) || maxQueue < 0) {
      throw new Error("Parse maxQueue must be a non-negative integer");
    }
    const maxWaitMs = options.maxWaitMs ?? DEFAULT_PARSE_QUEUE_TIMEOUT_MS;
    if (!Number.isInteger(maxWaitMs) || maxWaitMs < 1) {
      throw new Error("Parse maxWaitMs must be a positive integer");
    }
    this.maxQueue = maxQueue;
    this.maxWaitMs = maxWaitMs;
  }

  get activeCount(): number {
    return this.active;
  }

  get queuedCount(): number {
    return this.waiting.length;
  }

  get concurrencyLimit(): number {
    return this.limit;
  }

  get maxQueueSize(): number {
    return this.maxQueue;
  }

  get maxWaitTimeMs(): number {
    return this.maxWaitMs;
  }

  async run<T>(
    work: (signal: AbortSignal) => Promise<T>,
    options: ParseGateRunOptions = {},
  ): Promise<T> {
    const externalSignal = options.signal;
    if (externalSignal?.aborted) {
      throw new ParseGateError("ABORTED", "Parse request was cancelled.");
    }

    const waitMs = options.maxWaitMs ?? this.maxWaitMs;
    if (!Number.isInteger(waitMs) || waitMs < 1) {
      throw new Error("Parse maxWaitMs must be a positive integer");
    }

    await this.acquire(waitMs, externalSignal);

    const runController = new AbortController();
    const onAbort = (): void => {
      runController.abort();
    };
    externalSignal?.addEventListener("abort", onAbort, { once: true });

    try {
      if (externalSignal?.aborted) {
        runController.abort();
        throw new ParseGateError("ABORTED", "Parse request was cancelled.");
      }
      return await work(runController.signal);
    } finally {
      externalSignal?.removeEventListener("abort", onAbort);
      this.release();
    }
  }

  private acquire(maxWaitMs: number, signal: AbortSignal | undefined): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }

    if (this.waiting.length >= this.maxQueue) {
      return Promise.reject(new ParseGateError("QUEUE_FULL", "Parse queue is full."));
    }

    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;

      const onAbort = (): void => {
        if (waiter.settled) {
          return;
        }
        waiter.settled = true;
        this.removeWaiter(waiter);
        waiter.cleanup();
        reject(new ParseGateError("ABORTED", "Parse request was cancelled."));
      };

      const waiter: Waiter = {
        settled: false,
        grant: () => {
          resolve();
        },
        cleanup: () => {
          if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
          }
          signal?.removeEventListener("abort", onAbort);
        },
      };

      timer = setTimeout(() => {
        if (waiter.settled) {
          return;
        }
        waiter.settled = true;
        this.removeWaiter(waiter);
        waiter.cleanup();
        reject(new ParseGateError("QUEUE_TIMEOUT", "Timed out waiting for a parse slot."));
      }, maxWaitMs);

      signal?.addEventListener("abort", onAbort, { once: true });

      if (signal?.aborted) {
        onAbort();
        return;
      }

      this.waiting.push(waiter);
    });
  }

  private removeWaiter(target: Waiter): void {
    const index = this.waiting.indexOf(target);
    if (index !== -1) {
      this.waiting.splice(index, 1);
    }
  }

  private release(): void {
    this.active -= 1;
    while (this.waiting.length > 0 && this.active < this.limit) {
      const next = this.waiting.shift();
      if (!next || next.settled) {
        continue;
      }
      next.settled = true;
      next.cleanup();
      this.active += 1;
      next.grant();
    }
  }
}
