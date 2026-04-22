import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export type ProjectInventoryScope = "registered" | "all";

const DEFAULT_CONTAINER_PROJECTS_ROOT = "/projects";
const DATA_VOLUME_REGISTERED_PROJECTS_PATH = "/data/registered-projects.txt";

function normalizePath(input: string): string {
  return input.replace(/\\/g, "/").replace(/\/+$/, "");
}

function resolveRegisteredProjectsPath(): string {
  const configured = process.env.PING_MEM_REGISTERED_PROJECTS_PATH;
  if (configured && configured.trim().length > 0) {
    return path.resolve(configured.trim());
  }
  if (fs.existsSync(DATA_VOLUME_REGISTERED_PROJECTS_PATH)) {
    return DATA_VOLUME_REGISTERED_PROJECTS_PATH;
  }
  return path.join(os.homedir(), ".ping-mem", "registered-projects.txt");
}

function resolveConfiguredHostProjectsRoot(): string | null {
  const configured = process.env.PING_MEM_HOST_PROJECTS_ROOT;
  if (configured && configured.trim().length > 0) {
    return normalizePath(path.resolve(configured.trim()));
  }
  return null;
}

function inferHostProjectsRoot(entries: string[], containerProjectsRoot: string): string | null {
  const hostEntries = entries
    .map((entry) => normalizePath(path.resolve(entry)))
    .filter((entry) => path.isAbsolute(entry) && !entry.startsWith(`${containerProjectsRoot}/`) && entry !== containerProjectsRoot);

  if (hostEntries.length === 0) {
    return null;
  }

  if (hostEntries.length === 1) {
    return normalizePath(path.dirname(hostEntries[0]!));
  }

  const commonSegments = hostEntries
    .map((entry) => entry.split("/").filter(Boolean))
    .reduce<string[]>((shared, current, index) => {
      if (index === 0) {
        return current;
      }
      const next: string[] = [];
      const limit = Math.min(shared.length, current.length);
      for (let i = 0; i < limit; i += 1) {
        const sharedSegment = shared[i];
        const currentSegment = current[i];
        if (sharedSegment === undefined || currentSegment === undefined || sharedSegment !== currentSegment) {
          break;
        }
        next.push(sharedSegment);
      }
      return next;
    }, []);

  if (commonSegments.length === 0) {
    return null;
  }

  return normalizePath(`/${commonSegments.join("/")}`);
}

function resolveContainerProjectsRoot(): string {
  const configured = process.env.PING_MEM_CONTAINER_PROJECTS_ROOT;
  if (configured && configured.trim().length > 0) {
    return normalizePath(configured.trim());
  }
  return DEFAULT_CONTAINER_PROJECTS_ROOT;
}

function parseRegisteredProjectsFile(contents: string): string[] {
  return contents
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function translateHostPathToContainerPath(projectPath: string, hostRoot: string, containerRoot: string): string | null {
  if (projectPath === hostRoot) {
    return containerRoot;
  }
  if (!projectPath.startsWith(`${hostRoot}/`)) {
    return null;
  }
  const relative = projectPath.slice(hostRoot.length + 1);
  return normalizePath(path.posix.join(containerRoot, relative));
}

export function loadRegisteredProjectRoots(): Set<string> | null {
  const registeredProjectsPath = resolveRegisteredProjectsPath();
  if (!fs.existsSync(registeredProjectsPath)) {
    return null;
  }

  const containerProjectsRoot = resolveContainerProjectsRoot();
  const parsedEntries = parseRegisteredProjectsFile(fs.readFileSync(registeredProjectsPath, "utf-8"));
  const hostProjectsRoot =
    resolveConfiguredHostProjectsRoot()
    ?? inferHostProjectsRoot(parsedEntries, containerProjectsRoot)
    ?? normalizePath(path.join(os.homedir(), "Projects"));
  const registered = new Set<string>();

  for (const entry of parsedEntries) {
    const resolved = normalizePath(path.resolve(entry));
    registered.add(resolved);

    const translated = translateHostPathToContainerPath(resolved, hostProjectsRoot, containerProjectsRoot);
    if (translated) {
      registered.add(translated);
    }
  }

  return registered;
}

export function filterProjectsToRegisteredRoots<T extends { rootPath: string }>(
  projects: T[],
  registeredRoots: Set<string> | null,
): T[] {
  if (!registeredRoots || registeredRoots.size === 0) {
    return projects;
  }

  return projects.filter((project) => registeredRoots.has(normalizePath(project.rootPath)));
}
