/**
 * Neo4j Client Wrapper for Graphiti Integration
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
  public readonly params: Record<string, unknown> | undefined;

  constructor(
    message: string,
    query: string,
    params?: Record<string, unknown>,
    code?: string,
    cause?: Error
  ) {
    super(message, code, cause);
    this.name = "Neo4jQueryError";
    this.query = query;
    this.params = params ?? undefined;
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
  private connected = false;

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
  }

  /**
   * Establish connection to Neo4j database
   *
   * @throws {Neo4jConnectionError} If connection fails
   */
  async connect(): Promise<void> {
    if (this.connected && this.driver !== null) {
      return;
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
      this.connected = true;
    } catch (error) {
      this.driver = null;
      this.connected = false;

      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const errorCode =
        error instanceof Error && "code" in error
          ? String(error.code)
          : undefined;

      throw new Neo4jConnectionError(
        `Failed to connect to Neo4j at ${this.config.uri}: ${errorMessage}`,
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
      await this.driver.close();
      this.driver = null;
      this.connected = false;
    }
  }

  /**
   * Check if client is connected to Neo4j
   */
  isConnected(): boolean {
    return this.connected && this.driver !== null;
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
    const session = this.getSession(neo4j.session.READ);

    try {
      const result = await session.run(cypher, params);

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
    } finally {
      await session.close();
    }
  }

  /**
   * Execute a write query and return result summary
   *
   * @param cypher - Cypher query string
   * @param params - Query parameters
   * @returns First record from result or query summary info
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
    const session = this.getSession(neo4j.session.WRITE);

    try {
      const result = await session.run(cypher, params);

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
    } finally {
      await session.close();
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
    const session = this.getSession(neo4j.session.WRITE);

    try {
      return await work(session);
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
    } finally {
      await session.close();
    }
  }

  /**
   * Verify database connectivity with a simple query
   *
   * @returns true if connected and responsive
   */
  async ping(): Promise<boolean> {
    if (!this.isConnected()) {
      return false;
    }

    try {
      await this.executeQuery("RETURN 1 as ping");
      return true;
    } catch {
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
  const maxConnectionPoolSize = maxPoolSizeStr
    ? parseInt(maxPoolSizeStr, 10)
    : DEFAULT_MAX_POOL_SIZE;

  return new Neo4jClient({
    uri,
    username,
    password,
    database,
    maxConnectionPoolSize,
  });
}
