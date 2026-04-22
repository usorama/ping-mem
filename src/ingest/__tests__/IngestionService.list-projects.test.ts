import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { IngestionService } from "../IngestionService.js";

describe("IngestionService.listProjects", () => {
  const originalRegisteredProjectsPath = process.env.PING_MEM_REGISTERED_PROJECTS_PATH;
  const originalHostProjectsRoot = process.env.PING_MEM_HOST_PROJECTS_ROOT;
  const originalContainerProjectsRoot = process.env.PING_MEM_CONTAINER_PROJECTS_ROOT;

  let tempDir: string;
  let registeredProjectsPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ping-mem-list-projects-"));
    registeredProjectsPath = path.join(tempDir, "registered-projects.txt");
    process.env.PING_MEM_REGISTERED_PROJECTS_PATH = registeredProjectsPath;
    process.env.PING_MEM_HOST_PROJECTS_ROOT = "/Users/tester/Projects";
    process.env.PING_MEM_CONTAINER_PROJECTS_ROOT = "/projects";
  });

  afterEach(() => {
    if (originalRegisteredProjectsPath === undefined) {
      delete process.env.PING_MEM_REGISTERED_PROJECTS_PATH;
    } else {
      process.env.PING_MEM_REGISTERED_PROJECTS_PATH = originalRegisteredProjectsPath;
    }

    if (originalHostProjectsRoot === undefined) {
      delete process.env.PING_MEM_HOST_PROJECTS_ROOT;
    } else {
      process.env.PING_MEM_HOST_PROJECTS_ROOT = originalHostProjectsRoot;
    }

    if (originalContainerProjectsRoot === undefined) {
      delete process.env.PING_MEM_CONTAINER_PROJECTS_ROOT;
    } else {
      process.env.PING_MEM_CONTAINER_PROJECTS_ROOT = originalContainerProjectsRoot;
    }

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function createService(projects: Array<Record<string, unknown>>) {
    const service = new IngestionService({
      neo4jClient: {} as any,
      qdrantClient: {} as any,
    });

    let lastOptions: Record<string, unknown> | undefined;
    (service as any).codeGraph = {
      listProjects: async (options: Record<string, unknown>) => {
        lastOptions = options;
        return projects;
      },
    };

    return { service, getLastOptions: () => lastOptions };
  }

  test("defaults to the registered project set", async () => {
    fs.writeFileSync(
      registeredProjectsPath,
      "/Users/tester/Projects/ping-mem\n/Users/tester/Projects/understory\n",
    );

    const { service, getLastOptions } = createService([
      { projectId: "p1", rootPath: "/projects/ping-mem" },
      { projectId: "p2", rootPath: "/projects/understory" },
      { projectId: "p3", rootPath: "/projects/rankforge-wt/ruff-cleanup" },
    ]);

    const projects = await service.listProjects({ limit: 100 });

    expect(projects.map((project) => project.projectId)).toEqual(["p1", "p2"]);
    expect(getLastOptions()).toEqual({
      projectId: undefined,
      sortBy: undefined,
      limit: 5000,
    });
  });

  test("returns all projects when scope=all", async () => {
    const { service, getLastOptions } = createService([
      { projectId: "p1", rootPath: "/projects/ping-mem" },
      { projectId: "p2", rootPath: "/projects/rankforge-wt/ruff-cleanup" },
    ]);

    const projects = await service.listProjects({ limit: 2, scope: "all" });

    expect(projects.map((project) => project.projectId)).toEqual(["p1", "p2"]);
    expect(getLastOptions()).toEqual({
      projectId: undefined,
      sortBy: undefined,
      limit: 2,
    });
  });

  test("bypasses the registered filter for explicit projectId lookup", async () => {
    fs.writeFileSync(registeredProjectsPath, "/Users/tester/Projects/ping-mem\n");

    const { service, getLastOptions } = createService([
      { projectId: "stale-worktree", rootPath: "/projects/rankforge-wt/ruff-cleanup" },
    ]);

    const projects = await service.listProjects({ projectId: "stale-worktree" });

    expect(projects.map((project) => project.projectId)).toEqual(["stale-worktree"]);
    expect(getLastOptions()).toEqual({
      projectId: "stale-worktree",
      sortBy: undefined,
      limit: 100,
    });
  });
});
