/**
 * Neo4j Client Wrapper for ping-mem Temporal Graph
 *
 * Provides a type-safe, connection-pooled Neo4j client for ping-mem's
 * graph-based memory storage and retrieval operations.
 *
 * @module graph/Neo4jClient
 * @version 1.0.0
 */

import neo4j, {
  Driver,
  Session,
  SessionMode,
  Integer,
  Record as Neo4jRecord,
} from "neo4j-driver";
import { createServicePolicy, type ServicePolicy } from "../util/CircuitBreaker.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("Neo4jClient");

// ============================================================================
// Error Classes
// ============================================================================

/**
 * Base error class for Neo4j client errors
 */
export class Neo4jClientError extends Error {
  public readonly code: string | undefined;
  public override readonly cause: Error | undefined;

  constructor(message: string, code?: string, cause?: Error) {
    super(message);
    this.name = "Neo4jClientError";
    this.code = code ?? undefined;
    this.cause = cause ?? undefined;
    Object.setPrototypeOf(this, Neo4jClientError.prototype);
  }
}

/**
 * Error thrown when connection to Neo4j fails
 */
export class Neo4jConnectionError extends Neo4jClientError {
  constructor(message: string, code?: string, cause?: Error) {
    super(message, code, cause);
    this.name = "Neo4jConnectionError";
    Object.setPrototypeOf(this, Neo4jConnectionError.prototype);
  }
}

/**
 * Error thrown when a query execution fails
 */
export class Neo4jQueryError extends Neo4jClientError {
  public readonly query: string;
  public readonly paramKeys: string[] | undefined;

  constructor(
    message: string,
    query: string,
    params?: Record<string, unknown>,
    code?: string,
    cause?: Error
  ) {
    super(message, code, cause);
    this.name = "Neo4jQueryError";
    // Truncate the stored query to limit log exposure of internal graph schema.
    this.query = query.slice(0, 500);
    this.paramKeys = params ? Object.keys(params) : undefined;
    Object.setPrototypeOf(this, Neo4jQueryError.prototype);
  }
}

// ============================================================================
// Configuration
// ============================================================================

/**
 * Configuration for the Neo4j client
 */
export interface Neo4jClientConfig {
  /** Neo4j connection URI (e.g., 'bolt://localhost:7687') */
  uri: string;
  /** Username for authentication */
  username: string;
  /** Password for authentication */
  password: string;
  /** Database name (default: 'neo4j') */
  database?: string;
  /** Maximum connection pool size (default: 50) */
  maxConnectionPoolSize?: number;
  /** Connection acquisition timeout in milliseconds (default: 60000) */
  connectionAcquisitionTimeout?: number;
  /** Maximum transaction retry time in milliseconds (default: 30000) */
  maxTransactionRetryTime?: number;
  /** Enable encrypted connection (default: false for local, true for aura) */
  encrypted?: boolean;
}

/**
 * Internal configuration type with resolved defaults
 */
interface ResolvedConfig {
  uri: string;
  username: string;
  password: string;
  database: string;
  maxConnectionPoolSize: number;
  connectionAcquisitionTimeout: number;
  maxTransactionRetryTime: number;
  encrypted: boolean | undefined;
}

/**
 * Default configuration values
 */
const DEFAULT_DATABASE = "neo4j";
const DEFAULT_MAX_POOL_SIZE = 50;
const DEFAULT_CONN_ACQ_TIMEOUT = 60000;
const DEFAULT_TX_RETRY_TIME = 30000;

// ============================================================================
// Neo4j Client Implementation
// ============================================================================

/**
 * Neo4j client wrapper providing connection pooling, error handling,
 * and type-safe query execution for Graphiti integration.
 *
 * @example
 * ```typescript
 * const client = new Neo4jClient({
 *   uri: 'bolt://localhost:7687',
 *   username: 'neo4j',
 *   password: 'password'
 * });
 *
 * await client.connect();
 *
 * const results = await client.executeQuery<{ name: string }>(
 *   'MATCH (n:Person) RETURN n.name as name'
 * );
 *
 * await client.disconnect();
 * ```
 */
export class Neo4jClient {
  private driver: Driver | null = null;
  private readonly config: ResolvedConfig;
  private servicePolicy: ServicePolicy;
  private writePolicy: ServicePolicy;

  constructor(config: Neo4jClientConfig) {
    this.config = {
      uri: config.uri,
      username: config.username,
      password: config.password,
      database: config.database ?? DEFAULT_DATABASE,
      maxConnectionPoolSize: config.maxConnectionPoolSize ?? DEFAULT_MAX_POOL_SIZE,
      connectionAcquisitionTimeout:
        config.connectionAcquisitionTimeout ?? DEFAULT_CONN_ACQ_TIMEOUT,
      maxTransactionRetryTime:
        config.maxTransactionRetryTime ?? DEFAULT_TX_RETRY_TIME,
      encrypted: config.encrypted,
    };

    this.servicePolicy = createServicePolicy({
      name: "neo4j",
      consecutiveFailures: 5,
      halfOpenAfterMs: 30_000,
      maxRetries: 2,
      timeoutMs: 15_000,
    });

    this.writePolicy = createServicePolicy({
      name: "neo4j-write",
      consecutiveFailures: 5,
      halfOpenAfterMs: 30_000,
      maxRetries: 0,
      timeoutMs: 15_000,
    });

    // Read/write circuits: log only — do not mutate connected or driver.
    // isConnected() tracks driver liveness; circuit state is exposed via getCircuitState().
    // Keeping connected decoupled from circuit state lets operations reach servicePolicy.execute()
    // so the half-open probe can fire and self-recovery works without manual reconnect.
    this.servicePolicy.onStateChange((state) => {
      if (state === "open") {
        log.error("Read circuit OPEN — Neo4j operations will fail fast", { state });
      } else if (state === "half-open") {
        log.info("Read circuit half-open — attempting recovery", { state });
      } else {
        log.info("Read circuit recovered", { state });
      }
    });
    // Write circuit: log only, do not affect connected flag (reads may still work)
    this.writePolicy.onStateChange((state) => {
      if (state === "open") {
        log.error("Write circuit OPEN — Neo4j write operations will fail fast", { state });
      } else if (state === "half-open") {
        log.info("Write circuit half-open — attempting write recovery", { state });
      } else {
        log.info("Write circuit recovered", { state });
      }
    });
  }

  /**
   * Reset circuit breaker policies to CLOSED state.
   *
   * Called during warm-up (after disconnect/connect) to prevent a stale OPEN
   * circuit from blocking the connectivity roundtrip probe. Post-wake, if the
   * circuit opened on 5 consecutive failures, it stays OPEN until
   * halfOpenAfterMs elapses. resetPolicies() creates fresh circuit objects in
   * CLOSED state so neo4j_roundtrip in the warm-up succeeds immediately.
   *
   * Not for use in normal operation — rely on cockatiel half-open self-recovery
   * instead.
   */
  resetPolicies(): void {
    this.servicePolicy = createServicePolicy({
      name: "neo4j",
      consecutiveFailures: 5,
      halfOpenAfterMs: 30_000,
      maxRetries: 2,
      timeoutMs: 15_000,
    });
    this.writePolicy = createServicePolicy({
      name: "neo4j-write",
      consecutiveFailures: 5,
      halfOpenAfterMs: 30_000,
      maxRetries: 0,
      timeoutMs: 15_000,
    });
    // Re-register onStateChange log handlers on the new policy objects
    this.servicePolicy.onStateChange((state) => {
      if (state === "open") {
        log.error("Read circuit OPEN — Neo4j operations will fail fast", { state });
      } else if (state === "half-open") {
        log.info("Read circuit half-open — attempting recovery", { state });
      } else {
        log.info("Read circuit recovered", { state });
      }
    });
    this.writePolicy.onStateChange((state) => {
      if (state === "open") {
        log.error("Write circuit OPEN — Neo4j write operations will fail fast", { state });
      } else if (state === "half-open") {
        log.info("Write circuit half-open — attempting write recovery", { state });
      } else {
        log.info("Write circuit recovered", { state });
      }
    });
  }

  /**
   * Establish connection to Neo4j database
   *
   * @throws {Neo4jConnectionError} If connection fails
   */
  async connect(): Promise<void> {
    // Return early if a live driver already exists — circuit state does not affect
    // driver liveness, so checking driver !== null is sufficient.
    if (this.driver !== null) {
      return;
    }

    // Validate URI scheme to prevent SSRF credential exfiltration: the driver sends
    // credentials during the handshake, so an attacker-controlled URI would receive them.
    const ALLOWED_NEO4J_SCHEMES = new Set([
      "bolt:", "bolt+s:", "bolt+ssc:",
      "neo4j:", "neo4j+s:", "neo4j+ssc:",
    ]);
    let uriScheme: string;
    try {
      uriScheme = new URL(this.config.uri).protocol;
    } catch {
      // Do not include the raw URI in the error — it may contain embedded credentials.
      throw new Neo4jConnectionError("NEO4J_URI is not a valid URL");
    }
    if (!ALLOWED_NEO4J_SCHEMES.has(uriScheme)) {
      throw new Neo4jConnectionError(
        `NEO4J_URI scheme '${uriScheme}' is not allowed. Use bolt:// or neo4j://`
      );
    }

    try {
      const driverConfig: Record<string, unknown> = {
        maxConnectionPoolSize: this.config.maxConnectionPoolSize,
        connectionAcquisitionTimeout: this.config.connectionAcquisitionTimeout,
        maxTransactionRetryTime: this.config.maxTransactionRetryTime,
      };

      // Only add encrypted if explicitly set
      if (this.config.encrypted !== undefined) {
        driverConfig["encrypted"] = this.config.encrypted;
      }

      this.driver = neo4j.driver(
        this.config.uri,
        neo4j.auth.basic(this.config.username, this.config.password),
        driverConfig
      );

      // Verify connectivity
      await this.driver.verifyConnectivity();
    } catch (error) {
      this.driver = null;

      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const errorCode =
        error instanceof Error && "code" in error
          ? String(error.code)
          : undefined;

      throw new Neo4jConnectionError(
        "Failed to connect to Neo4j — check NEO4J_URI and credentials",
        errorCode,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Close connection to Neo4j database
   */
  async disconnect(): Promise<void> {
    if (this.driver !== null) {
      try {
        await this.driver.close();
      } finally {
        // Clear the driver reference regardless of close() outcome so
        // isConnected() accurately reflects that the client is no longer active.
        this.driver = null;
      }
    }
  }

  /**
   * Check if client is connected to Neo4j
   */
  isConnected(): boolean {
    // Driver liveness is the source of truth; circuit state is separate (see getCircuitState()).
    return this.driver !== null;
  }

  getCircuitState(): "closed" | "open" | "half-open" {
    // Report the worse of read and write circuits so callers see a unified view.
    if (this.servicePolicy.state === "open" || this.writePolicy.state === "open") {
      return "open";
    }
    if (this.servicePolicy.state === "half-open" || this.writePolicy.state === "half-open") {
      return "half-open";
    }
    return "closed";
  }

  /**
   * Get a new session from the driver
   *
   * @param mode - Session mode (READ or WRITE)
   * @throws {Neo4jConnectionError} If not connected
   */
  getSession(mode: SessionMode = neo4j.session.WRITE): Session {
    if (this.driver === null) {
      throw new Neo4jConnectionError(
        "Not connected to Neo4j. Call connect() first."
      );
    }

    return this.driver.session({
      database: this.config.database,
      defaultAccessMode: mode,
    });
  }

  /**
   * Execute a read query and return results
   *
   * @param cypher - Cypher query string
   * @param params - Query parameters
   * @returns Array of result records
   * @throws {Neo4jQueryError} If query execution fails
   *
   * @example
   * ```typescript
   * const users = await client.executeQuery<{ name: string; age: number }>(
   *   'MATCH (u:User) WHERE u.age > $minAge RETURN u.name as name, u.age as age',
   *   { minAge: 21 }
   * );
   * ```
   */
  async executeQuery<T = Record<string, unknown>>(
    cypher: string,
    params?: Record<string, unknown>
  ): Promise<T[]> {
    try {
      const result = await this.servicePolicy.execute(async () => {
        const session = this.getSession(neo4j.session.READ);
        try {
          return await session.run(cypher, params);
        } finally {
          await session.close();
        }
      });

      return result.records.map((record: Neo4jRecord) => {
        const obj: Record<string, unknown> = {};
        record.keys.forEach((key) => {
          const keyStr = String(key);
          obj[keyStr] = this.convertNeo4jValue(record.get(keyStr));
        });
        return obj as T;
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const errorCode =
        error instanceof Error && "code" in error
          ? String(error.code)
          : undefined;

      throw new Neo4jQueryError(
        `Query execution failed: ${errorMessage}`,
        cypher,
        params,
        errorCode,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Execute a write query (CREATE / MERGE / SET / DELETE) and return the result.
   *
   * @param cypher - Cypher query string
   * @param params - Query parameters
   * @returns If the query produces records, returns the **first** record as `T`.
   *   Records after the first are silently discarded — if the query uses RETURN
   *   on multiple rows, use `executeQuery` instead.
   *   If the query produces no records (e.g., a pure DELETE), returns a summary
   *   object with `{ nodesCreated, nodesDeleted, relationshipsCreated,
   *   relationshipsDeleted, propertiesSet }` cast as `unknown as T`.
   *   Callers that need to distinguish between the two cases should check the
   *   shape of the returned value or use `executeQuery` for read operations.
   * @throws {Neo4jQueryError} If query execution fails
   *
   * @example
   * ```typescript
   * const result = await client.executeWrite<{ id: string }>(
   *   'CREATE (u:User {name: $name, age: $age}) RETURN elementId(u) as id',
   *   { name: 'Alice', age: 30 }
   * );
   * ```
   */
  async executeWrite<T = Record<string, unknown>>(
    cypher: string,
    params?: Record<string, unknown>
  ): Promise<T> {
    try {
      const result = await this.writePolicy.execute(async () => {
        const session = this.getSession(neo4j.session.WRITE);
        try {
          return await session.run(cypher, params);
        } finally {
          await session.close();
        }
      });

      // If there are records, return the first one
      if (result.records.length > 0) {
        const record = result.records[0];
        if (record !== undefined) {
          const obj: Record<string, unknown> = {};
          record.keys.forEach((key) => {
            const keyStr = String(key);
            obj[keyStr] = this.convertNeo4jValue(record.get(keyStr));
          });
          return obj as T;
        }
      }

      // Return summary info if no records
      const summary = result.summary;
      const updates = summary.counters.updates();
      return {
        nodesCreated: updates.nodesCreated,
        nodesDeleted: updates.nodesDeleted,
        relationshipsCreated: updates.relationshipsCreated,
        relationshipsDeleted: updates.relationshipsDeleted,
        propertiesSet: updates.propertiesSet,
      } as unknown as T;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const errorCode =
        error instanceof Error && "code" in error
          ? String(error.code)
          : undefined;

      throw new Neo4jQueryError(
        `Write query execution failed: ${errorMessage}`,
        cypher,
        params,
        errorCode,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Execute a query within a transaction
   *
   * @param work - Function containing transaction work
   * @returns Result of the transaction work
   * @throws {Neo4jQueryError} If transaction fails
   */
  async executeTransaction<T>(
    work: (session: Session) => Promise<T>
  ): Promise<T> {
    try {
      return await this.writePolicy.execute(async () => {
        const session = this.getSession(neo4j.session.WRITE);
        try {
          return await work(session);
        } finally {
          await session.close();
        }
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const errorCode =
        error instanceof Error && "code" in error
          ? String(error.code)
          : undefined;

      throw new Neo4jQueryError(
        `Transaction execution failed: ${errorMessage}`,
        "<transaction>",
        undefined,
        errorCode,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Verify database connectivity with a simple query
   *
   * @returns true if connected and responsive
   */
  async ping(): Promise<boolean> {
    // No driver: cannot probe.
    if (this.driver === null) {
      return false;
    }

    try {
      await this.executeQuery("RETURN 1 as ping");
      return true;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.warn("Neo4j ping failed", { error: msg });
      return false;
    }
  }

  /**
   * Get driver instance for advanced operations
   *
   * @throws {Neo4jConnectionError} If not connected
   */
  getDriver(): Driver {
    if (this.driver === null) {
      throw new Neo4jConnectionError(
        "Not connected to Neo4j. Call connect() first."
      );
    }
    return this.driver;
  }

  /**
   * Convert Neo4j Integer and other special types to JavaScript primitives
   */
  private convertNeo4jValue(value: unknown): unknown {
    if (value === null || value === undefined) {
      return value;
    }

    // Handle Neo4j Integer
    if (Integer.isInteger(value)) {
      const intValue = value as Integer;
      // Use toNumber() for safe range, toString() for large values
      if (intValue.inSafeRange()) {
        return intValue.toNumber();
      }
      return intValue.toString();
    }

    // Handle arrays
    if (Array.isArray(value)) {
      return value.map((v: unknown) => this.convertNeo4jValue(v));
    }

    // Handle objects (Node, Relationship, etc.)
    if (typeof value === "object" && value !== null) {
      // Check for Node
      if ("labels" in value && "properties" in value) {
        const node = value as { labels: string[]; properties: Record<string, unknown> };
        return {
          labels: node.labels,
          properties: this.convertNeo4jProperties(node.properties),
        };
      }

      // Check for Relationship
      if ("type" in value && "properties" in value) {
        const rel = value as { type: string; properties: Record<string, unknown> };
        return {
          type: rel.type,
          properties: this.convertNeo4jProperties(rel.properties),
        };
      }

      // Generic object
      const obj: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value)) {
        obj[key] = this.convertNeo4jValue(val);
      }
      return obj;
    }

    return value;
  }

  /**
   * Convert Neo4j properties object
   */
  private convertNeo4jProperties(
    props: Record<string, unknown>
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(props)) {
      result[key] = this.convertNeo4jValue(value);
    }
    return result;
  }
}

/**
 * Create a Neo4j client with the given configuration
 *
 * @param config - Client configuration
 * @returns Configured Neo4jClient instance
 */
export function createNeo4jClient(config: Neo4jClientConfig): Neo4jClient {
  return new Neo4jClient(config);
}

/**
 * Create a Neo4j client from environment variables
 *
 * Environment variables:
 * - NEO4J_URI: Connection URI (required)
 * - NEO4J_USERNAME: Username (required)
 * - NEO4J_PASSWORD: Password (required)
 * - NEO4J_DATABASE: Database name (optional, default: 'neo4j')
 * - NEO4J_MAX_POOL_SIZE: Max connection pool size (optional, default: 50)
 *
 * @returns Configured Neo4jClient instance
 * @throws {Error} If required environment variables are missing
 */
export function createNeo4jClientFromEnv(): Neo4jClient {
  const uri = process.env["NEO4J_URI"];
  const username = process.env["NEO4J_USERNAME"] ?? process.env["NEO4J_USER"];
  const password = process.env["NEO4J_PASSWORD"];

  if (!uri || !username || !password) {
    throw new Error(
      "Missing required environment variables: NEO4J_URI, NEO4J_USERNAME (or NEO4J_USER), NEO4J_PASSWORD"
    );
  }

  const database = process.env["NEO4J_DATABASE"] ?? DEFAULT_DATABASE;
  const maxPoolSizeStr = process.env["NEO4J_MAX_POOL_SIZE"];
  const parsedPoolSize = maxPoolSizeStr ? parseInt(maxPoolSizeStr, 10) : NaN;
  // Guard NaN (non-numeric env var) and non-positive values — fall back to default.
  const maxConnectionPoolSize =
    !Number.isNaN(parsedPoolSize) && parsedPoolSize > 0 ? parsedPoolSize : DEFAULT_MAX_POOL_SIZE;

  return new Neo4jClient({
    uri,
    username,
    password,
    database,
    maxConnectionPoolSize,
  });
}
