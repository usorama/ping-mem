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
