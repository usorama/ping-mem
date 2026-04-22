import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  filterProjectsToRegisteredRoots,
  loadRegisteredProjectRoots,
} from "../registered-projects.js";

describe("registered project helpers", () => {
  const originalRegisteredProjectsPath = process.env.PING_MEM_REGISTERED_PROJECTS_PATH;
  const originalHostProjectsRoot = process.env.PING_MEM_HOST_PROJECTS_ROOT;
  const originalContainerProjectsRoot = process.env.PING_MEM_CONTAINER_PROJECTS_ROOT;

  let tempDir: string;
  let registeredProjectsPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ping-mem-registered-projects-"));
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

  test("loads host paths and translated container paths from the registered-projects file", () => {
    fs.writeFileSync(
      registeredProjectsPath,
      [
        "# Registered projects",
        "/Users/tester/Projects/ping-mem",
        "/Users/tester/Projects/understory",
      ].join("\n"),
    );

    const roots = loadRegisteredProjectRoots();

    expect(roots).not.toBeNull();
    expect(roots?.has("/Users/tester/Projects/ping-mem")).toBe(true);
    expect(roots?.has("/projects/ping-mem")).toBe(true);
    expect(roots?.has("/Users/tester/Projects/understory")).toBe(true);
    expect(roots?.has("/projects/understory")).toBe(true);
  });

  test("filters project rows to the registered set when roots are available", () => {
    fs.writeFileSync(
      registeredProjectsPath,
      "/Users/tester/Projects/ping-mem\n/Users/tester/Projects/understory\n",
    );

    const filtered = filterProjectsToRegisteredRoots(
      [
        { rootPath: "/projects/ping-mem", projectId: "p1" },
        { rootPath: "/projects/understory", projectId: "p2" },
        { rootPath: "/projects/rankforge-wt/ruff-cleanup", projectId: "p3" },
      ],
      loadRegisteredProjectRoots(),
    );

    expect(filtered.map((project) => project.projectId)).toEqual(["p1", "p2"]);
  });

  test("returns all projects when the registry file is missing", () => {
    const projects = [
      { rootPath: "/projects/ping-mem", projectId: "p1" },
      { rootPath: "/projects/rankforge-wt/ruff-cleanup", projectId: "p2" },
    ];

    expect(filterProjectsToRegisteredRoots(projects, loadRegisteredProjectRoots())).toEqual(projects);
  });
});
