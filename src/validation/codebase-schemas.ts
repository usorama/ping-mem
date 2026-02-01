/**
 * Zod validation schemas for codebase ingestion tools
 */

import { z } from "zod";

/**
 * Schema for codebase_list_projects input
 */
export const ListProjectsSchema = z.object({
  projectId: z.string().optional(),
  limit: z.number().int().positive().max(1000).optional().default(100),
  sortBy: z
    .enum(["lastIngestedAt", "filesCount", "rootPath"])
    .optional()
    .default("lastIngestedAt"),
});

export type ListProjectsInput = z.infer<typeof ListProjectsSchema>;

/**
 * Schema for project_delete input
 */
export const DeleteProjectSchema = z.object({
  projectDir: z.string()
    .min(1, "projectDir cannot be empty")
    .max(4096, "projectDir path too long")
    .refine(
      (p) => !p.includes(".."),
      { message: "projectDir cannot contain path traversal sequences" }
    ),
});

export type DeleteProjectInput = z.infer<typeof DeleteProjectSchema>;
