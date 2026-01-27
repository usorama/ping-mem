/**
 * Type declarations for sqlite-vec mock
 * These types match our mock implementation
 */

declare module "sqlite-vec" {
  export function load(db: unknown): void;
  const sqliteVec: {
    load: typeof load;
  };
  export default sqliteVec;
}
