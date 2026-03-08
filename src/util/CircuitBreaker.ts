import {
  ConsecutiveBreaker,
  ExponentialBackoff,
  TimeoutStrategy,
  circuitBreaker,
  handleWhen,
  retry,
  timeout,
  wrap,
} from "cockatiel";

export type ServiceState = "closed" | "open" | "half-open";

export interface ServicePolicy {
  execute<T>(fn: () => Promise<T>): Promise<T>;
  readonly name: string;
  readonly state: ServiceState;
  onStateChange(handler: (state: ServiceState) => void): void;
}

function isTransient(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }

  const errnoCode = (err as NodeJS.ErrnoException).code;
  if (errnoCode === "ECONNREFUSED" || errnoCode === "ETIMEDOUT" || errnoCode === "ECONNRESET") {
    return true;
  }

  const message = err.message.toLowerCase();
  return message.includes("timeout") || message.includes("connection");
}

export function createServicePolicy(opts: {
  name: string;
  consecutiveFailures?: number;
  halfOpenAfterMs?: number;
  maxRetries?: number;
  timeoutMs?: number;
}): ServicePolicy {
  const transientOnly = handleWhen(isTransient);

  const breaker = circuitBreaker(transientOnly, {
    halfOpenAfter: opts.halfOpenAfterMs ?? 30_000,
    breaker: new ConsecutiveBreaker(opts.consecutiveFailures ?? 5),
  });

  const retryPolicy = retry(transientOnly, {
    maxAttempts: opts.maxRetries ?? 3,
    backoff: new ExponentialBackoff({ initialDelay: 250, maxDelay: 10_000 }),
  });

  const timeoutPolicy = timeout(opts.timeoutMs ?? 15_000, TimeoutStrategy.Aggressive);
  const policy = wrap(retryPolicy, breaker, timeoutPolicy);

  let currentState: ServiceState = "closed";
  const handlers: Array<(state: ServiceState) => void> = [];

  breaker.onBreak(() => {
    currentState = "open";
    for (const handler of handlers) {
      handler("open");
    }
  });

  breaker.onHalfOpen(() => {
    currentState = "half-open";
    for (const handler of handlers) {
      handler("half-open");
    }
  });

  breaker.onReset(() => {
    currentState = "closed";
    for (const handler of handlers) {
      handler("closed");
    }
  });

  return {
    execute: <T>(fn: () => Promise<T>) => policy.execute(fn),
    name: opts.name,
    get state() {
      return currentState;
    },
    onStateChange: (handler: (state: ServiceState) => void) => {
      handlers.push(handler);
    },
  };
}
