import { describe, test, expect } from "bun:test";
import { createServicePolicy } from "../CircuitBreaker.js";

function transientConnectionError(): Error {
  const error = new Error("connect ECONNREFUSED");
  (error as NodeJS.ErrnoException).code = "ECONNREFUSED";
  return error;
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
});
