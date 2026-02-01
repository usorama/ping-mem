export interface FileHashEntry {
  path: string;
  sha256: string;
  bytes: number;
}

export interface ProjectManifest {
  projectId: string;
  rootPath: string;
  treeHash: string;
  files: FileHashEntry[];
  generatedAt: string;
  schemaVersion: number;
}

export interface ProjectScanResult {
  manifest: ProjectManifest;
  hasChanges: boolean;
}

/**
 * Project information returned by listProjects query
 */
export interface ProjectInfo {
  projectId: string;
  rootPath: string;
  treeHash: string;
  filesCount: number;
  chunksCount: number;
  commitsCount: number;
  lastIngestedAt: string; // ISO 8601
}
