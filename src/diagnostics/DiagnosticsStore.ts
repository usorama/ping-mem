import { Database, Statement } from "bun:sqlite";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import type {
  DiagnosticRun,
  NormalizedFinding,
  DiagnosticsQueryFilter,
} from "./types.js";

export interface DiagnosticsStoreConfig {
  dbPath?: string | undefined;
  walMode?: boolean | undefined;
  foreignKeys?: boolean | undefined;
  busyTimeout?: number | undefined;
}

const DEFAULT_CONFIG: Required<DiagnosticsStoreConfig> = {
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
  properties: string;
}

export class DiagnosticsStore {
  private db: Database;
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
      INSERT INTO diagnostic_findings (
        finding_id, analysis_id, rule_id, severity, message, file_path,
        start_line, start_col, end_line, end_col, chunk_id, fingerprint, properties
      ) VALUES (
        $finding_id, $analysis_id, $rule_id, $severity, $message, $file_path,
        $start_line, $start_col, $end_line, $end_col, $chunk_id, $fingerprint, $properties
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
          $properties: JSON.stringify(finding.properties ?? {}),
        });
      }
    });

    insertMany();
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

    return finding;
  }

  close(): void {
    this.db.close();
  }
}
