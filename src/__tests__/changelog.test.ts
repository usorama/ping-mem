import { describe, it, expect } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "../..");
const changelogPath = join(ROOT, "CHANGELOG.md");

describe("CHANGELOG.md", () => {
  it("exists at repo root", () => {
    expect(existsSync(changelogPath)).toBe(true);
  });

  it("follows Keep a Changelog format", () => {
    const content = readFileSync(changelogPath, "utf-8");
    expect(content).toContain("# Changelog");
    expect(content).toContain("Keep a Changelog");
    expect(content).toContain("Semantic Versioning");
  });

  it("documents version 1.0.0 with categorized changes", () => {
    const content = readFileSync(changelogPath, "utf-8");
    expect(content).toMatch(/## \[1\.0\.0\]/);
    expect(content).toContain("### Added");
    expect(content).toContain("### Fixed");
    expect(content).toContain("### Changed");
  });

  it("has version headers using ## format", () => {
    const content = readFileSync(changelogPath, "utf-8");
    const versionHeaders = content.match(/^## \[.+\]/gm);
    expect(versionHeaders).not.toBeNull();
    expect(versionHeaders!.length).toBeGreaterThanOrEqual(1);
  });
});
