/**
 * Type declarations for bun:sqlite mock
 * These types match our mock implementation and replace bun's actual types
 */

declare module "bun:sqlite" {
  export interface RunResult {
    changes: number;
  }

  export class Statement {
    run(...params: unknown[]): RunResult;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  }

  export class Database {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): Statement;
    transaction<T>(fn: () => T): () => T;
    close(): void;
  }
}
