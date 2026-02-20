import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { BM25Store } from "../BM25Store.js";
import { Database } from "bun:sqlite";

describe("BM25Store", () => {
  let db: Database;
  let store: BM25Store;

  beforeEach(() => {
    db = new Database(":memory:");
    store = new BM25Store(db);
  });

  afterEach(() => {
    db.close();
  });

  it("should persist a document to SQLite", () => {
    store.addDocument("mem-1", "session-1", "hello world test", new Date());
    const docs = store.loadAll();
    expect(docs.length).toBe(1);
    expect(docs[0].memoryId).toBe("mem-1");
  });

  it("should survive a reload cycle", () => {
    store.addDocument("mem-1", "s1", "typescript memory system", new Date());
    store.addDocument("mem-2", "s1", "rust embedding pipeline", new Date());

    // Create new store from same DB (simulates restart)
    const store2 = new BM25Store(db);
    const docs = store2.loadAll();
    expect(docs.length).toBe(2);
  });

  it("should remove a document", () => {
    store.addDocument("mem-1", "s1", "content", new Date());
    store.removeDocument("mem-1");
    const docs = store.loadAll();
    expect(docs.length).toBe(0);
  });

  it("should handle empty database", () => {
    const docs = store.loadAll();
    expect(docs.length).toBe(0);
  });
});
