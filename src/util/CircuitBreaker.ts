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
import { createLogger } from "./logger.js";

const log = createLogger("CircuitBreaker");

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

  // AbortError is thrown by TimeoutStrategy.Aggressive when the timeout fires.
  // Treat it as transient so it retries rather than opening the breaker immediately.
  if (err.name === "AbortError") {
    return true;
  }

  const errnoCode = (err as NodeJS.ErrnoException).code;
  if (errnoCode === "ECONNREFUSED" || errnoCode === "ETIMEDOUT" || errnoCode === "ECONNRESET") {
    return true;
  }

  const message = err.message.toLowerCase();
  return (
    message.includes("timeout") ||
    message.includes("connection refused") ||
    message.includes("connection reset") ||
    message.includes("socket hang up")
  );
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
  // Use a Set to prevent duplicate handler registrations (common with re-initialization).
  const handlers: Set<(state: ServiceState) => void> = new Set();

  const notifyHandlers = (state: ServiceState) => {
    for (const handler of handlers) {
      try {
        handler(state);
      } catch (handlerError) {
        log.warn(`State-change handler threw [${opts.name}]`, {
          state,
          error: handlerError instanceof Error ? handlerError.message : String(handlerError),
        });
      }
    }
  };


  breaker.onBreak(() => {
    currentState = "open";
    notifyHandlers("open");
  });

  breaker.onHalfOpen(() => {
    currentState = "half-open";
    notifyHandlers("half-open");
  });

  breaker.onReset(() => {
    currentState = "closed";
    notifyHandlers("closed");
  });

  return {
    execute: <T>(fn: () => Promise<T>) => policy.execute(fn),
    name: opts.name,
    get state() {
      return currentState;
    },
    onStateChange: (handler: (state: ServiceState) => void) => {
      handlers.add(handler);
    },
  };
}
