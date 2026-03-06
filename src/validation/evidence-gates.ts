/**
 * Evidence gate configuration and checker for multi-agent memory.
 *
 * Evidence gates enforce metadata requirements on memory saves.
 * Categories mapped here require specific metadata fields to be present.
 * Enforcement is either "block" (reject save) or "warn" (allow but surface warning).
 *
 * @module validation/evidence-gates
 */

import type { MemoryCategory } from "../types/index.js";

// ============================================================================
// Gate Configuration
// ============================================================================

export interface EvidenceGateRule {
  /** Metadata fields that must be present (non-null, non-empty) */
  required: string[];
  /** "block" rejects the save; "warn" allows but returns warnings */
  enforcement: "block" | "warn";
}

/**
 * Evidence gate rules by memory category.
 * Only categories listed here are gated — unlisted categories pass freely.
 */
export const EVIDENCE_GATES: Record<string, EvidenceGateRule> = {
  decision: {
    required: ["rationale"],
    enforcement: "warn",
  },
  error: {
    required: ["source"],
    enforcement: "warn",
  },
  fact: {
    required: ["source"],
    enforcement: "warn",
  },
  knowledge_entry: {
    required: ["source"],
    enforcement: "warn",
  },
};

// ============================================================================
// Gate Checker
// ============================================================================

export interface EvidenceGateResult {
  passed: boolean;
  warnings: string[];
}

/**
 * Check whether a memory save passes evidence gates.
 *
 * @param category - The memory category (may be undefined for uncategorized saves)
 * @param metadata - The metadata object attached to the memory
 * @param adminBypass - If true, skip all gate checks (for admin agents)
 * @returns Result with pass/fail and any warnings
 */
export function checkEvidenceGate(
  category: MemoryCategory | undefined,
  metadata: Record<string, unknown>,
  adminBypass: boolean = false
): EvidenceGateResult {
  if (adminBypass) {
    return { passed: true, warnings: [] };
  }

  if (!category) {
    return { passed: true, warnings: [] };
  }

  const rule = EVIDENCE_GATES[category];
  if (!rule) {
    return { passed: true, warnings: [] };
  }

  const missing = rule.required.filter((field) => {
    const value = metadata[field];
    return value === undefined || value === null || value === "";
  });

  if (missing.length === 0) {
    return { passed: true, warnings: [] };
  }

  const message = `Evidence gate for "${category}": missing required metadata fields: ${missing.join(", ")}`;

  if (rule.enforcement === "block") {
    return { passed: false, warnings: [message] };
  }

  // enforcement === "warn": allow but surface warning
  return { passed: true, warnings: [message] };
}
