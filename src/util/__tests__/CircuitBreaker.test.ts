import { describe, test, expect } from "bun:test";
import { createServicePolicy } from "../CircuitBreaker.js";

function transientConnectionError(): Error {
  const error = new Error("connect ECONNREFUSED");
  (error as NodeJS.ErrnoException).code = "ECONNREFUSED";
  return error;
}

function transientTimeoutError(): Error {
  const error = new Error("request timeout after 5000ms");
  (error as NodeJS.ErrnoException).code = "ETIMEDOUT";
  return error;
}

function configurationError(): Error {
  return new Error("Neo4j connection pool configuration invalid");
}

describe("CircuitBreaker", () => {
  test("opens after consecutive failures and recovers on success", async () => {
    const policy = createServicePolicy({
      name: "test",
      consecutiveFailures: 2,
      maxRetries: 1,
      halfOpenAfterMs: 20,
      timeoutMs: 100,
    });

    await expect(policy.execute(async () => {
      throw transientConnectionError();
    })).rejects.toThrow();

    await expect(policy.execute(async () => {
      throw transientConnectionError();
    })).rejects.toThrow();

    expect(policy.state).toBe("open");

    await new Promise((resolve) => setTimeout(resolve, 30));

    const value = await policy.execute(async () => "ok");
    expect(value).toBe("ok");
    expect(policy.state).toBe("closed");
  });

  test("does not retry non-transient errors", async () => {
    let callCount = 0;
    const policy = createServicePolicy({
      name: "test-non-transient",
      consecutiveFailures: 5,
      maxRetries: 3,
      timeoutMs: 100,
    });

    await expect(
      policy.execute(async () => {
        callCount++;
        throw configurationError();
      })
    ).rejects.toThrow("configuration");

    // Non-transient should not be retried — called only once
    expect(callCount).toBe(1);
  });

  test("treats ECONNRESET as transient", async () => {
    let callCount = 0;
    const policy = createServicePolicy({
      name: "test-reset",
      consecutiveFailures: 5,
      maxRetries: 2,
      timeoutMs: 100,
    });

    await expect(
      policy.execute(async () => {
        callCount++;
        const err = new Error("connection reset");
        (err as NodeJS.ErrnoException).code = "ECONNRESET";
        throw err;
      })
    ).rejects.toThrow();

    // Should retry 2 times + 1 initial = 3 total calls
    expect(callCount).toBe(3);
  });

  test("treats timeout errors as transient", async () => {
    let callCount = 0;
    const policy = createServicePolicy({
      name: "test-timeout",
      consecutiveFailures: 5,
      maxRetries: 2,
      timeoutMs: 100,
    });

    await expect(
      policy.execute(async () => {
        callCount++;
        throw transientTimeoutError();
      })
    ).rejects.toThrow();

    expect(callCount).toBe(3);
  });

  test("isTransient does not match 'connection pool configuration' (too broad)", async () => {
    let callCount = 0;
    const policy = createServicePolicy({
      name: "test-config",
      consecutiveFailures: 5,
      maxRetries: 3,
      timeoutMs: 100,
    });

    await expect(
      policy.execute(async () => {
        callCount++;
        throw new Error("connection pool configuration invalid");
      })
    ).rejects.toThrow();

    // Should NOT retry — "connection pool configuration" is not transient
    expect(callCount).toBe(1);
  });

  test("state change handler fires on break and reset", async () => {
    const states: string[] = [];
    const policy = createServicePolicy({
      name: "test-events",
      consecutiveFailures: 2,
      maxRetries: 1,
      halfOpenAfterMs: 20,
      timeoutMs: 100,
    });

    policy.onStateChange((state) => {
      states.push(state);
    });

    // Break the circuit
    await policy.execute(async () => { throw transientConnectionError(); }).catch(() => {});
    await policy.execute(async () => { throw transientConnectionError(); }).catch(() => {});

    expect(states).toContain("open");

    // Wait for half-open
    await new Promise((resolve) => setTimeout(resolve, 30));

    // Succeed to reset
    await policy.execute(async () => "ok");
    expect(states).toContain("closed");
  });

  test("name property returns configured name", () => {
    const policy = createServicePolicy({ name: "my-service" });
    expect(policy.name).toBe("my-service");
  });

  test("initial state is closed", () => {
    const policy = createServicePolicy({ name: "fresh" });
    expect(policy.state).toBe("closed");
  });
});
