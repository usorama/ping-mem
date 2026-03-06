#!/usr/bin/env bash
set -euo pipefail

DB_PATH="${PING_MEM_DB_PATH:-$HOME/.ping-mem/ping-mem.db}"

echo "Running ping-mem v2 migrations on: $DB_PATH"

# Check if database exists
if [ ! -f "$DB_PATH" ]; then
  echo "Database not found at $DB_PATH — will be created on first server start."
  exit 0
fi

# Run migrations using bun
bun -e "
const Database = require('bun:sqlite');
const db = new Database(process.env.PING_MEM_DB_PATH || process.env.HOME + '/.ping-mem/ping-mem.db');

// agent_quotas table
db.exec(\`CREATE TABLE IF NOT EXISTS agent_quotas (
  agent_id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  admin INTEGER NOT NULL DEFAULT 0,
  ttl_ms INTEGER NOT NULL DEFAULT 86400000,
  expires_at TEXT,
  current_bytes INTEGER NOT NULL DEFAULT 0,
  current_count INTEGER NOT NULL DEFAULT 0,
  quota_bytes INTEGER NOT NULL DEFAULT 10485760,
  quota_count INTEGER NOT NULL DEFAULT 10000,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}'
)\`);

// write_locks table
db.exec(\`CREATE TABLE IF NOT EXISTS write_locks (
  lock_key TEXT PRIMARY KEY,
  holder_id TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}'
)\`);

// agent_id column on events
try {
  db.exec('ALTER TABLE events ADD COLUMN agent_id TEXT');
} catch (e) {
  // Column already exists — safe to ignore
}

// knowledge_entries table
db.exec(\`CREATE TABLE IF NOT EXISTS knowledge_entries (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  solution TEXT NOT NULL,
  symptoms TEXT,
  root_cause TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  agent_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)\`);

// FTS5 virtual table
db.exec(\`CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
  title, solution, symptoms, root_cause, tags,
  content='knowledge_entries',
  content_rowid='rowid'
)\`);

// FTS5 sync triggers
db.exec(\`CREATE TRIGGER IF NOT EXISTS knowledge_ai AFTER INSERT ON knowledge_entries BEGIN
  INSERT INTO knowledge_fts(rowid, title, solution, symptoms, root_cause, tags)
  VALUES (new.rowid, new.title, new.solution, new.symptoms, new.root_cause, new.tags);
END\`);

db.exec(\`CREATE TRIGGER IF NOT EXISTS knowledge_ad AFTER DELETE ON knowledge_entries BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, title, solution, symptoms, root_cause, tags)
  VALUES ('delete', old.rowid, old.title, old.solution, old.symptoms, old.root_cause, old.tags);
END\`);

db.exec(\`CREATE TRIGGER IF NOT EXISTS knowledge_au AFTER UPDATE ON knowledge_entries BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, title, solution, symptoms, root_cause, tags)
  VALUES ('delete', old.rowid, old.title, old.solution, old.symptoms, old.root_cause, old.tags);
  INSERT INTO knowledge_fts(rowid, title, solution, symptoms, root_cause, tags)
  VALUES (new.rowid, new.title, new.solution, new.symptoms, new.root_cause, new.tags);
END\`);

// Performance index
db.exec('CREATE INDEX IF NOT EXISTS idx_knowledge_project_id ON knowledge_entries(project_id)');

console.log('✓ All v2 migrations applied successfully');
db.close();
"
