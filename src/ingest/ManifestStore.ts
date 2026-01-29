import * as fs from "fs";
import * as path from "path";
import type { ProjectManifest } from "./types.js";

export class ManifestStore {
  private readonly manifestDirName = ".ping-mem";
  private readonly manifestFileName = "manifest.json";

  getManifestPath(projectDir: string): string {
    return path.join(projectDir, this.manifestDirName, this.manifestFileName);
  }

  load(projectDir: string): ProjectManifest | null {
    const manifestPath = this.getManifestPath(projectDir);
    if (!fs.existsSync(manifestPath)) {
      return null;
    }
    const data = fs.readFileSync(manifestPath, "utf-8");
    return JSON.parse(data) as ProjectManifest;
  }

  save(projectDir: string, manifest: ProjectManifest): void {
    const manifestPath = this.getManifestPath(projectDir);
    const manifestDir = path.dirname(manifestPath);
    if (!fs.existsSync(manifestDir)) {
      fs.mkdirSync(manifestDir, { recursive: true });
    }
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
  }
}
