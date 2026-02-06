import { Database, Statement } from "bun:sqlite";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { decryptSecret, encryptSecret, getSecretKey } from "./crypto.js";

export interface AdminStoreConfig {
  dbPath?: string | undefined;
  walMode?: boolean | undefined;
  foreignKeys?: boolean | undefined;
  busyTimeout?: number | undefined;
}

const DEFAULT_CONFIG: Required<AdminStoreConfig> = {
  dbPath: path.join(os.homedir(), ".ping-mem", "admin.db"),
  walMode: true,
  foreignKeys: true,
  busyTimeout: 5000,
};

export interface AdminApiKeyInfo {
  id: string;
  last4: string;
  createdAt: string;
  active: boolean;
}

export interface LLMConfigInput {
  provider: string;
  apiKey: string;
  model?: string | undefined;
  baseUrl?: string | undefined;
}

export interface LLMConfigInfo {
  provider: string;
  model?: string | undefined;
  baseUrl?: string | undefined;
  hasApiKey: boolean;
  updatedAt: string;
}

export interface ProjectRecord {
  projectId: string;
  projectDir: string;
  treeHash?: string | undefined;
  lastIngestedAt?: string | undefined;
}

export class AdminStore {
  private db: Database;
  private config: {
    dbPath: string;
    walMode: boolean;
    foreignKeys: boolean;
    busyTimeout: number;
  };

  private stmtInsertApiKey!: Statement;
  private stmtListApiKeys!: Statement;
  private stmtDeactivateAllKeys!: Statement;
  private stmtDeactivateKey!: Statement;
  private stmtCountKeys!: Statement;
  private stmtFindKeyHash!: Statement;

  private stmtUpsertProject!: Statement;
  private stmtListProjects!: Statement;
  private stmtDeleteProject!: Statement;
  private stmtFindProjectByDir!: Statement;

  private stmtUpsertLLMConfig!: Statement;
  private stmtGetLLMConfig!: Statement;
  private stmtClearLLMConfig!: Statement;

  constructor(config?: AdminStoreConfig | undefined) {
    this.config = { ...DEFAULT_CONFIG, ...config } as typeof this.config;

    if (this.config.dbPath !== ":memory:") {
      const dbDir = path.dirname(this.config.dbPath);
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
      }
    }

    this.db = new Database(this.config.dbPath);
    if (this.config.walMode && this.config.dbPath !== ":memory:") {
      this.db.exec("PRAGMA journal_mode = WAL");
    }
    if (this.config.foreignKeys) {
      this.db.exec("PRAGMA foreign_keys = ON");
    }
    this.db.exec(`PRAGMA busy_timeout = ${this.config.busyTimeout}`);

    this.initializeSchema();
    this.prepareStatements();
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS admin_api_keys (
        id TEXT PRIMARY KEY,
        key_hash TEXT NOT NULL UNIQUE,
        key_last4 TEXT NOT NULL,
        created_at TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS admin_projects (
        project_id TEXT PRIMARY KEY,
        project_dir TEXT NOT NULL,
        tree_hash TEXT,
        last_ingested_at TEXT
      );

      CREATE TABLE IF NOT EXISTS admin_llm_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        provider TEXT NOT NULL,
        api_key_ciphertext TEXT NOT NULL,
        api_key_iv TEXT NOT NULL,
        api_key_tag TEXT NOT NULL,
        model TEXT,
        base_url TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_admin_api_keys_active
        ON admin_api_keys(active, created_at);
      CREATE INDEX IF NOT EXISTS idx_admin_projects_dir
        ON admin_projects(project_dir);
    `);
  }

  private prepareStatements(): void {
    this.stmtInsertApiKey = this.db.prepare(`
      INSERT INTO admin_api_keys (id, key_hash, key_last4, created_at, active)
      VALUES ($id, $key_hash, $key_last4, $created_at, $active)
    `);

    this.stmtListApiKeys = this.db.prepare(`
      SELECT id, key_last4, created_at, active
      FROM admin_api_keys
      ORDER BY created_at DESC
    `);

    this.stmtDeactivateAllKeys = this.db.prepare(
      "UPDATE admin_api_keys SET active = 0"
    );

    this.stmtDeactivateKey = this.db.prepare(
      "UPDATE admin_api_keys SET active = 0 WHERE id = $id"
    );

    this.stmtCountKeys = this.db.prepare(
      "SELECT COUNT(*) as count FROM admin_api_keys"
    );

    this.stmtFindKeyHash = this.db.prepare(
      "SELECT id FROM admin_api_keys WHERE key_hash = $key_hash AND active = 1 LIMIT 1"
    );

    this.stmtUpsertProject = this.db.prepare(`
      INSERT INTO admin_projects (project_id, project_dir, tree_hash, last_ingested_at)
      VALUES ($project_id, $project_dir, $tree_hash, $last_ingested_at)
      ON CONFLICT(project_id) DO UPDATE SET
        project_dir = excluded.project_dir,
        tree_hash = excluded.tree_hash,
        last_ingested_at = excluded.last_ingested_at
    `);

    this.stmtListProjects = this.db.prepare(`
      SELECT project_id, project_dir, tree_hash, last_ingested_at
      FROM admin_projects
      ORDER BY last_ingested_at DESC
    `);

    this.stmtDeleteProject = this.db.prepare(
      "DELETE FROM admin_projects WHERE project_id = $project_id"
    );

    this.stmtFindProjectByDir = this.db.prepare(
      "SELECT project_id, project_dir, tree_hash, last_ingested_at FROM admin_projects WHERE project_dir = $project_dir LIMIT 1"
    );

    this.stmtUpsertLLMConfig = this.db.prepare(`
      INSERT INTO admin_llm_config (id, provider, api_key_ciphertext, api_key_iv, api_key_tag, model, base_url, updated_at)
      VALUES (1, $provider, $api_key_ciphertext, $api_key_iv, $api_key_tag, $model, $base_url, $updated_at)
      ON CONFLICT(id) DO UPDATE SET
        provider = excluded.provider,
        api_key_ciphertext = excluded.api_key_ciphertext,
        api_key_iv = excluded.api_key_iv,
        api_key_tag = excluded.api_key_tag,
        model = excluded.model,
        base_url = excluded.base_url,
        updated_at = excluded.updated_at
    `);

    this.stmtGetLLMConfig = this.db.prepare(
      "SELECT provider, api_key_ciphertext, api_key_iv, api_key_tag, model, base_url, updated_at FROM admin_llm_config WHERE id = 1"
    );

    this.stmtClearLLMConfig = this.db.prepare(
      "DELETE FROM admin_llm_config WHERE id = 1"
    );
  }

  ensureSeedApiKey(rawKey: string): void {
    const count = (this.stmtCountKeys.get() as { count: number }).count;
    if (count > 0) {
      return;
    }
    const { keyHash, last4 } = this.hashApiKey(rawKey);
    this.stmtInsertApiKey.run({
      $id: this.generateUUID(),
      $key_hash: keyHash,
      $key_last4: last4,
      $created_at: new Date().toISOString(),
      $active: 1,
    });
  }

  hasAnyActiveKey(): boolean {
    const count = (this.stmtCountKeys.get() as { count: number }).count;
    return count > 0;
  }

  isApiKeyValid(rawKey: string): boolean {
    const { keyHash } = this.hashApiKey(rawKey);
    const row = this.stmtFindKeyHash.get({ $key_hash: keyHash }) as { id: string } | undefined;
    return Boolean(row?.id);
  }

  createApiKey(options?: { deactivateOld?: boolean }): { key: string; info: AdminApiKeyInfo } {
    const key = this.generateApiKey();
    const { keyHash, last4 } = this.hashApiKey(key);
    const id = this.generateUUID();
    const createdAt = new Date().toISOString();

    if (options?.deactivateOld) {
      this.stmtDeactivateAllKeys.run();
    }

    this.stmtInsertApiKey.run({
      $id: id,
      $key_hash: keyHash,
      $key_last4: last4,
      $created_at: createdAt,
      $active: 1,
    });

    return {
      key,
      info: {
        id,
        last4,
        createdAt,
        active: true,
      },
    };
  }

  listApiKeys(): AdminApiKeyInfo[] {
    const rows = this.stmtListApiKeys.all() as Array<{
      id: string;
      key_last4: string;
      created_at: string;
      active: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      last4: row.key_last4,
      createdAt: row.created_at,
      active: Boolean(row.active),
    }));
  }

  deactivateApiKey(id: string): void {
    this.stmtDeactivateKey.run({ $id: id });
  }

  upsertProject(record: ProjectRecord): void {
    this.stmtUpsertProject.run({
      $project_id: record.projectId,
      $project_dir: record.projectDir,
      $tree_hash: record.treeHash ?? null,
      $last_ingested_at: record.lastIngestedAt ?? null,
    });
  }

  listProjects(): ProjectRecord[] {
    const rows = this.stmtListProjects.all() as Array<{
      project_id: string;
      project_dir: string;
      tree_hash: string | null;
      last_ingested_at: string | null;
    }>;
    return rows.map((row) => ({
      projectId: row.project_id,
      projectDir: row.project_dir,
      treeHash: row.tree_hash ?? undefined,
      lastIngestedAt: row.last_ingested_at ?? undefined,
    }));
  }

  findProjectByDir(projectDir: string): ProjectRecord | null {
    const row = this.stmtFindProjectByDir.get({ $project_dir: projectDir }) as
      | {
          project_id: string;
          project_dir: string;
          tree_hash: string | null;
          last_ingested_at: string | null;
        }
      | undefined;
    if (!row) {
      return null;
    }
    return {
      projectId: row.project_id,
      projectDir: row.project_dir,
      treeHash: row.tree_hash ?? undefined,
      lastIngestedAt: row.last_ingested_at ?? undefined,
    };
  }

  deleteProject(projectId: string): void {
    this.stmtDeleteProject.run({ $project_id: projectId });
  }

  setLLMConfig(input: LLMConfigInput): LLMConfigInfo {
    const key = getSecretKey();
    const encrypted = encryptSecret(input.apiKey, key);
    const updatedAt = new Date().toISOString();

    this.stmtUpsertLLMConfig.run({
      $provider: input.provider,
      $api_key_ciphertext: encrypted.ciphertext,
      $api_key_iv: encrypted.iv,
      $api_key_tag: encrypted.tag,
      $model: input.model ?? null,
      $base_url: input.baseUrl ?? null,
      $updated_at: updatedAt,
    });

    return {
      provider: input.provider,
      model: input.model ?? undefined,
      baseUrl: input.baseUrl ?? undefined,
      hasApiKey: true,
      updatedAt,
    };
  }

  getLLMConfig(): LLMConfigInfo | null {
    const row = this.stmtGetLLMConfig.get() as
      | {
          provider: string;
          api_key_ciphertext: string;
          api_key_iv: string;
          api_key_tag: string;
          model: string | null;
          base_url: string | null;
          updated_at: string;
        }
      | undefined;
    if (!row) {
      return null;
    }
    return {
      provider: row.provider,
      model: row.model ?? undefined,
      baseUrl: row.base_url ?? undefined,
      hasApiKey: true,
      updatedAt: row.updated_at,
    };
  }

  getLLMApiKey(): string | null {
    const row = this.stmtGetLLMConfig.get() as
      | {
          api_key_ciphertext: string;
          api_key_iv: string;
          api_key_tag: string;
        }
      | undefined;
    if (!row) {
      return null;
    }
    const key = getSecretKey();
    return decryptSecret(
      {
        ciphertext: row.api_key_ciphertext,
        iv: row.api_key_iv,
        tag: row.api_key_tag,
      },
      key
    );
  }

  clearLLMConfig(): void {
    this.stmtClearLLMConfig.run();
  }

  close(): void {
    this.db.close();
  }

  private hashApiKey(rawKey: string): { keyHash: string; last4: string } {
    const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
    const last4 = rawKey.slice(-4);
    return { keyHash, last4 };
  }

  private generateUUID(): string {
    const timestamp = Date.now();
    const timestampHex = timestamp.toString(16).padStart(12, "0");
    const randomBytes = crypto.randomBytes(10);
    const randomHex = randomBytes.toString("hex");
    return (
      timestampHex.slice(0, 8) +
      "-" +
      timestampHex.slice(8, 12) +
      "-7" +
      randomHex.slice(0, 3) +
      "-" +
      ((parseInt(randomHex.slice(3, 4), 16) & 0x3) | 0x8).toString(16) +
      randomHex.slice(4, 7) +
      "-" +
      randomHex.slice(7, 19)
    );
  }

  private generateApiKey(): string {
    return crypto.randomBytes(32).toString("hex");
  }
}
