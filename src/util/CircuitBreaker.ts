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
  /** Reset internal circuit state to CLOSED without replacing the outer object. */
  reset(): void;
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

  const consecutiveFailures = opts.consecutiveFailures ?? 5;
  const halfOpenAfterMs = opts.halfOpenAfterMs ?? 30_000;
  const maxRetries = opts.maxRetries ?? 3;
  const timeoutMs = opts.timeoutMs ?? 15_000;

  let breaker = circuitBreaker(transientOnly, {
    halfOpenAfter: halfOpenAfterMs,
    breaker: new ConsecutiveBreaker(consecutiveFailures),
  });

  let retryPolicy = retry(transientOnly, {
    maxAttempts: maxRetries,
    backoff: new ExponentialBackoff({ initialDelay: 250, maxDelay: 10_000 }),
  });

  let timeoutPolicy = timeout(timeoutMs, TimeoutStrategy.Aggressive);
  let policy = wrap(retryPolicy, breaker, timeoutPolicy);

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


  const updateStateAndNotify = (newState: ServiceState) => {
    currentState = newState;
    notifyHandlers(newState);
  };

  /** Wire breaker event listeners to update currentState and notify handlers. */
  function wireBreakerEvents(): void {
    breaker.onBreak(() => {
      updateStateAndNotify("open");
    });

    breaker.onHalfOpen(() => {
      updateStateAndNotify("half-open");
    });

    breaker.onReset(() => {
      updateStateAndNotify("closed");
    });
  }

  wireBreakerEvents();

  return {
    execute: <T>(fn: () => Promise<T>) => policy.execute(fn),
    name: opts.name,
    get state() {
      return currentState;
    },
    onStateChange: (handler: (state: ServiceState) => void) => {
      handlers.add(handler);
    },
    reset(): void {
      // Create fresh internal circuit components — the outer ServicePolicy
      // object identity stays the same, so in-flight callers holding a reference
      // to this ServicePolicy will use the new internals on their next execute().
      breaker = circuitBreaker(transientOnly, {
        halfOpenAfter: halfOpenAfterMs,
        breaker: new ConsecutiveBreaker(consecutiveFailures),
      });
      retryPolicy = retry(transientOnly, {
        maxAttempts: maxRetries,
        backoff: new ExponentialBackoff({ initialDelay: 250, maxDelay: 10_000 }),
      });
      timeoutPolicy = timeout(timeoutMs, TimeoutStrategy.Aggressive);
      policy = wrap(retryPolicy, breaker, timeoutPolicy);

      // Re-wire breaker event listeners to the new breaker instance.
      wireBreakerEvents();

      // Reset state to closed and notify all handlers.
      updateStateAndNotify("closed");
    },
  };
}
