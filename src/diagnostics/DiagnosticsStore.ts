import { Database, Statement } from "bun:sqlite";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { createLogger } from "../util/logger.js";
import type {
  DiagnosticRun,
  NormalizedFinding,
  DiagnosticsQueryFilter,
} from "./types.js";

const log = createLogger("DiagnosticsStore");

export interface DiagnosticsStoreConfig {
  dbPath?: string | undefined;
  walMode?: boolean | undefined;
  foreignKeys?: boolean | undefined;
  busyTimeout?: number | undefined;
}

const DEFAULT_CONFIG: {
  dbPath: string;
  walMode: boolean;
  foreignKeys: boolean;
  busyTimeout: number;
} = {
  dbPath: path.join(os.homedir(), ".ping-mem", "diagnostics.db"),
  walMode: true,
  foreignKeys: true,
  busyTimeout: 5000,
};

interface DiagnosticRunRow {
  run_id: string;
  analysis_id: string;
  project_id: string;
  tree_hash: string;
  commit_hash: string | null;
  tool_name: string;
  tool_version: string;
  config_hash: string;
  environment_hash: string | null;
  status: string;
  created_at: string;
  duration_ms: number | null;
  findings_digest: string;
  raw_sarif: string | null;
  metadata: string;
}

interface DiagnosticFindingRow {
  finding_id: string;
  analysis_id: string;
  rule_id: string;
  severity: string;
  message: string;
  file_path: string;
  start_line: number | null;
  start_col: number | null;
  end_line: number | null;
  end_col: number | null;
  chunk_id: string | null;
  fingerprint: string | null;
  symbol_id: string | null;
  symbol_name: string | null;
  symbol_kind: string | null;
  properties: string;
}

export class DiagnosticsStore {
  private db: Database;
  private closed = false;
  private config: {
    dbPath: string;
    walMode: boolean;
    foreignKeys: boolean;
    busyTimeout: number;
  };

  private stmtInsertRun!: Statement;
  private stmtInsertFinding!: Statement;
  private stmtGetLatestRun!: Statement;
  private stmtGetRunByAnalysis!: Statement;
  private stmtGetFindingsByAnalysis!: Statement;
  private stmtGetFindingIdsByAnalysis!: Statement;

  constructor(config?: DiagnosticsStoreConfig | undefined) {
    this.config = {
      dbPath: config?.dbPath ?? DEFAULT_CONFIG.dbPath,
      walMode: config?.walMode ?? DEFAULT_CONFIG.walMode,
      foreignKeys: config?.foreignKeys ?? DEFAULT_CONFIG.foreignKeys,
      busyTimeout: config?.busyTimeout ?? DEFAULT_CONFIG.busyTimeout,
    };

    if (this.config.dbPath !== ":memory:") {
      const dbDir = path.dirname(this.config.dbPath);
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
      }
    }

    this.db = new Database(this.config.dbPath);
    if (this.config.walMode && this.config.dbPath !== ":memory:") {
      this.db.exec("PRAGMA journal_mode = WAL");
      // Diagnostics are acceptance evidence; don't optimize away durability.
      this.db.exec("PRAGMA synchronous = FULL");
      this.db.exec("PRAGMA wal_autocheckpoint = 1000");
    }
    if (this.config.foreignKeys) {
      this.db.exec("PRAGMA foreign_keys = ON");
    }
    const timeout = Math.max(0, Math.min(Number(this.config.busyTimeout) || 5000, 60000));
    this.db.exec(`PRAGMA busy_timeout = ${timeout}`);

    this.initializeSchema();
    this.prepareStatements();
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS diagnostic_runs (
        run_id TEXT PRIMARY KEY,
        analysis_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        tree_hash TEXT NOT NULL,
        commit_hash TEXT,
        tool_name TEXT NOT NULL,
        tool_version TEXT NOT NULL,
        config_hash TEXT NOT NULL,
        environment_hash TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        duration_ms INTEGER,
        findings_digest TEXT NOT NULL,
        raw_sarif TEXT,
        metadata TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS diagnostic_findings (
        finding_id TEXT PRIMARY KEY,
        analysis_id TEXT NOT NULL,
        rule_id TEXT NOT NULL,
        severity TEXT NOT NULL,
        message TEXT NOT NULL,
        file_path TEXT NOT NULL,
        start_line INTEGER,
        start_col INTEGER,
        end_line INTEGER,
        end_col INTEGER,
        chunk_id TEXT,
        fingerprint TEXT,
        symbol_id TEXT,
        symbol_name TEXT,
        symbol_kind TEXT,
        properties TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_runs_project_tree
        ON diagnostic_runs(project_id, tree_hash);
      CREATE INDEX IF NOT EXISTS idx_runs_tool
        ON diagnostic_runs(tool_name, tool_version);
      CREATE INDEX IF NOT EXISTS idx_runs_analysis
        ON diagnostic_runs(analysis_id);
      CREATE INDEX IF NOT EXISTS idx_findings_analysis
        ON diagnostic_findings(analysis_id);
      CREATE INDEX IF NOT EXISTS idx_findings_file
        ON diagnostic_findings(file_path);
      CREATE INDEX IF NOT EXISTS idx_findings_rule
        ON diagnostic_findings(rule_id);
      CREATE INDEX IF NOT EXISTS idx_findings_symbol
        ON diagnostic_findings(symbol_id);

      -- Created here so deleteProject can reference it even when LLM summaries are disabled.
      -- SummaryCache creates the same table with IF NOT EXISTS, so no conflict.
      CREATE TABLE IF NOT EXISTS diagnostic_summaries (
        summary_id TEXT PRIMARY KEY,
        analysis_id TEXT NOT NULL,
        summary_text TEXT NOT NULL,
        llm_model TEXT NOT NULL,
        llm_provider TEXT NOT NULL,
        generated_at TEXT NOT NULL,
        prompt_tokens INTEGER NOT NULL,
        completion_tokens INTEGER NOT NULL,
        cost_usd REAL,
        source_finding_ids TEXT NOT NULL,
        UNIQUE(analysis_id)
      );

      CREATE INDEX IF NOT EXISTS idx_summaries_analysis
        ON diagnostic_summaries(analysis_id);
    `);
  }

  private prepareStatements(): void {
    this.stmtInsertRun = this.db.prepare(`
      INSERT INTO diagnostic_runs (
        run_id, analysis_id, project_id, tree_hash, commit_hash,
        tool_name, tool_version, config_hash, environment_hash,
        status, created_at, duration_ms, findings_digest, raw_sarif, metadata
      ) VALUES (
        $run_id, $analysis_id, $project_id, $tree_hash, $commit_hash,
        $tool_name, $tool_version, $config_hash, $environment_hash,
        $status, $created_at, $duration_ms, $findings_digest, $raw_sarif, $metadata
      )
    `);

    this.stmtInsertFinding = this.db.prepare(`
      INSERT OR IGNORE INTO diagnostic_findings (
        finding_id, analysis_id, rule_id, severity, message, file_path,
        start_line, start_col, end_line, end_col, chunk_id, fingerprint,
        symbol_id, symbol_name, symbol_kind, properties
      ) VALUES (
        $finding_id, $analysis_id, $rule_id, $severity, $message, $file_path,
        $start_line, $start_col, $end_line, $end_col, $chunk_id, $fingerprint,
        $symbol_id, $symbol_name, $symbol_kind, $properties
      )
    `);

    this.stmtGetLatestRun = this.db.prepare(`
      SELECT * FROM diagnostic_runs
      WHERE project_id = $project_id
        AND ($tool_name IS NULL OR tool_name = $tool_name)
        AND ($tool_version IS NULL OR tool_version = $tool_version)
        AND ($tree_hash IS NULL OR tree_hash = $tree_hash)
      ORDER BY created_at DESC
      LIMIT 1
    `);

    this.stmtGetRunByAnalysis = this.db.prepare(`
      SELECT * FROM diagnostic_runs
      WHERE analysis_id = $analysis_id
      LIMIT 1
    `);

    this.stmtGetFindingsByAnalysis = this.db.prepare(`
      SELECT * FROM diagnostic_findings
      WHERE analysis_id = $analysis_id
      ORDER BY file_path ASC, start_line ASC, start_col ASC
    `);

    this.stmtGetFindingIdsByAnalysis = this.db.prepare(`
      SELECT finding_id FROM diagnostic_findings
      WHERE analysis_id = $analysis_id
    `);
  }

  createRunId(): string {
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

  saveRun(run: DiagnosticRun, findings: NormalizedFinding[]): void {
    const insertMany = this.db.transaction(() => {
      this.stmtInsertRun.run({
        $run_id: run.runId,
        $analysis_id: run.analysisId,
        $project_id: run.projectId,
        $tree_hash: run.treeHash,
        $commit_hash: run.commitHash ?? null,
        $tool_name: run.tool.name,
        $tool_version: run.tool.version,
        $config_hash: run.configHash,
        $environment_hash: run.environmentHash ?? null,
        $status: run.status,
        $created_at: run.createdAt,
        $duration_ms: run.durationMs ?? null,
        $findings_digest: run.findingsDigest,
        $raw_sarif: run.rawSarif ?? null,
        $metadata: JSON.stringify(run.metadata ?? {}),
      });

      for (const finding of findings) {
        this.stmtInsertFinding.run({
          $finding_id: finding.findingId,
          $analysis_id: finding.analysisId,
          $rule_id: finding.ruleId,
          $severity: finding.severity,
          $message: finding.message,
          $file_path: finding.filePath,
          $start_line: finding.startLine ?? null,
          $start_col: finding.startColumn ?? null,
          $end_line: finding.endLine ?? null,
          $end_col: finding.endColumn ?? null,
          $chunk_id: finding.chunkId ?? null,
          $fingerprint: finding.fingerprint ?? null,
          $symbol_id: finding.symbolId ?? null,
          $symbol_name: finding.symbolName ?? null,
          $symbol_kind: finding.symbolKind ?? null,
          $properties: JSON.stringify(finding.properties ?? {}),
        });
      }
    });

    insertMany();
  }

  deleteProject(projectId: string): void {
    const stmtDeleteSummaries = this.db.prepare(`
      DELETE FROM diagnostic_summaries
      WHERE analysis_id IN (SELECT analysis_id FROM diagnostic_runs WHERE project_id = $project_id)
    `);
    const stmtDeleteFindings = this.db.prepare(`
      DELETE FROM diagnostic_findings
      WHERE analysis_id IN (SELECT analysis_id FROM diagnostic_runs WHERE project_id = $project_id)
    `);
    const stmtDeleteRuns = this.db.prepare(
      "DELETE FROM diagnostic_runs WHERE project_id = $project_id"
    );

    const deleteMany = this.db.transaction(() => {
      stmtDeleteSummaries.run({ $project_id: projectId });
      stmtDeleteFindings.run({ $project_id: projectId });
      stmtDeleteRuns.run({ $project_id: projectId });
    });
    deleteMany();
  }

  getLatestRun(filter: DiagnosticsQueryFilter): DiagnosticRun | null {
    const row = this.stmtGetLatestRun.get({
      $project_id: filter.projectId,
      $tool_name: filter.toolName ?? null,
      $tool_version: filter.toolVersion ?? null,
      $tree_hash: filter.treeHash ?? null,
    }) as DiagnosticRunRow | undefined;

    return row ? this.rowToRun(row) : null;
  }

  getRunByAnalysisId(analysisId: string): DiagnosticRun | null {
    const row = this.stmtGetRunByAnalysis.get({
      $analysis_id: analysisId,
    }) as DiagnosticRunRow | undefined;

    return row ? this.rowToRun(row) : null;
  }

  listFindings(analysisId: string): NormalizedFinding[] {
    const rows = this.stmtGetFindingsByAnalysis.all({
      $analysis_id: analysisId,
    }) as DiagnosticFindingRow[];

    return rows.map((row) => this.rowToFinding(row));
  }

  diffAnalyses(analysisIdA: string, analysisIdB: string): {
    introduced: string[];
    resolved: string[];
    unchanged: string[];
  } {
    const idsA = this.stmtGetFindingIdsByAnalysis.all({
      $analysis_id: analysisIdA,
    }) as Array<{ finding_id: string }>;
    const idsB = this.stmtGetFindingIdsByAnalysis.all({
      $analysis_id: analysisIdB,
    }) as Array<{ finding_id: string }>;

    const setA = new Set(idsA.map((i) => i.finding_id));
    const setB = new Set(idsB.map((i) => i.finding_id));

    const introduced: string[] = [];
    const resolved: string[] = [];
    const unchanged: string[] = [];

    for (const id of setB) {
      if (!setA.has(id)) {
        introduced.push(id);
      } else {
        unchanged.push(id);
      }
    }

    for (const id of setA) {
      if (!setB.has(id)) {
        resolved.push(id);
      }
    }

    introduced.sort();
    resolved.sort();
    unchanged.sort();

    return { introduced, resolved, unchanged };
  }

  private rowToRun(row: DiagnosticRunRow): DiagnosticRun {
    return {
      runId: row.run_id,
      analysisId: row.analysis_id,
      projectId: row.project_id,
      treeHash: row.tree_hash,
      commitHash: row.commit_hash ?? undefined,
      tool: {
        name: row.tool_name,
        version: row.tool_version,
      },
      configHash: row.config_hash,
      environmentHash: row.environment_hash ?? undefined,
      status: row.status as DiagnosticRun["status"],
      createdAt: row.created_at,
      durationMs: row.duration_ms ?? undefined,
      findingsDigest: row.findings_digest,
      rawSarif: row.raw_sarif ?? undefined,
      metadata: JSON.parse(row.metadata),
    };
  }

  private rowToFinding(row: DiagnosticFindingRow): NormalizedFinding {
    const finding: NormalizedFinding = {
      findingId: row.finding_id,
      analysisId: row.analysis_id,
      ruleId: row.rule_id,
      severity: row.severity as NormalizedFinding["severity"],
      message: row.message,
      filePath: row.file_path,
      properties: JSON.parse(row.properties),
    };

    if (row.start_line !== null) finding.startLine = row.start_line;
    if (row.start_col !== null) finding.startColumn = row.start_col;
    if (row.end_line !== null) finding.endLine = row.end_line;
    if (row.end_col !== null) finding.endColumn = row.end_col;
    if (row.chunk_id !== null) finding.chunkId = row.chunk_id;
    if (row.fingerprint !== null) finding.fingerprint = row.fingerprint;
    if (row.symbol_id !== null) finding.symbolId = row.symbol_id;
    if (row.symbol_name !== null) finding.symbolName = row.symbol_name;
    if (row.symbol_kind !== null) finding.symbolKind = row.symbol_kind;

    return finding;
  }

  /**
   * List diagnostic runs, optionally filtered by project/tool, ordered by created_at DESC.
   */
  listRuns(options?: {
    projectId?: string;
    toolName?: string;
    limit?: number;
  }): DiagnosticRun[] {
    const limit = options?.limit ?? 50;
    // Dynamic SQL — all values are bound via $-params. Never interpolate user input directly.
    let sql = "SELECT * FROM diagnostic_runs WHERE 1=1";
    const params: Record<string, string | number> = { $limit: limit };

    if (options?.projectId) {
      sql += " AND project_id = $project_id";
      params.$project_id = options.projectId;
    }
    if (options?.toolName) {
      sql += " AND tool_name = $tool_name";
      params.$tool_name = options.toolName;
    }

    sql += " ORDER BY created_at DESC LIMIT $limit";

    const rows = this.db.prepare(sql).all(params) as DiagnosticRunRow[];
    return rows.map((row) => this.rowToRun(row));
  }

  /**
   * Get finding counts grouped by analysis ID in a single query.
   * Avoids N+1 when rendering lists of runs with their finding counts.
   */
  getFindingsCounts(
    analysisIds: string[]
  ): Map<string, { total: number; errors: number; warnings: number; notes: number }> {
    const result = new Map<string, { total: number; errors: number; warnings: number; notes: number }>();
    if (analysisIds.length === 0) return result;
    // Cap to prevent unbounded IN clause (SQLite default SQLITE_MAX_VARIABLE_NUMBER = 999)
    if (analysisIds.length > 500) {
      log.warn(`getFindingsCounts: truncating ${analysisIds.length} IDs to 500 (SQLite variable limit)`);
    }
    const cappedIds = analysisIds.slice(0, 500);

    const placeholders = cappedIds.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT analysis_id,
          COUNT(*) as total,
          SUM(CASE WHEN severity = 'error' THEN 1 ELSE 0 END) as errors,
          SUM(CASE WHEN severity = 'warning' THEN 1 ELSE 0 END) as warnings,
          SUM(CASE WHEN severity = 'note' THEN 1 ELSE 0 END) as notes
        FROM diagnostic_findings
        WHERE analysis_id IN (${placeholders})
        GROUP BY analysis_id`
      )
      .all(...cappedIds) as Array<{
      analysis_id: string;
      total: number;
      errors: number;
      warnings: number;
      notes: number;
    }>;

    for (const row of rows) {
      result.set(row.analysis_id, {
        total: row.total,
        errors: row.errors,
        warnings: row.warnings,
        notes: row.notes,
      });
    }

    return result;
  }

  getDatabase(): Database {
    return this.db;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.config.walMode && this.config.dbPath !== ":memory:") {
      try {
        this.db.exec("PRAGMA wal_checkpoint(FULL)");
      } catch {
        // Best-effort only; close still proceeds.
      }
    }
    this.db.close();
  }
}
