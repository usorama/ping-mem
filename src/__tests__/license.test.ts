import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("LICENSE file", () => {
  const rootDir = join(import.meta.dir, "..", "..");
  const content = readFileSync(join(rootDir, "LICENSE"), "utf-8");

  it("exists and contains MIT License header", () => {
    expect(content).toContain("MIT License");
  });

  it("contains correct copyright year and holder", () => {
    expect(content).toContain("2026");
    expect(content).toContain("Ping Gadgets");
  });

  it("package.json license field is MIT", () => {
    const pkg = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf-8"));
    expect(pkg.license).toBe("MIT");
  });
});
