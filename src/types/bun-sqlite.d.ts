/**
 * Type declarations for bun:sqlite
 */

declare module "bun:sqlite" {
  export class Database {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): Statement;
    transaction(fn: () => void): () => void;
    close(): void;
  }

  export class Statement {
    run(params?: Record<string, any>): void;
    get(params?: Record<string, any>): any;
    all(params?: Record<string, any>): any[];
  }
}
