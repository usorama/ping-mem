/**
 * Contradiction Detector for ping-mem
 *
 * Uses LLM to detect contradictions between old and new entity descriptions.
 * Only flags contradictions with confidence > 0.7 to minimize false positives.
 */

interface ContradictionDetectorConfig {
  openai: {
    chat: {
      completions: {
        create: (params: unknown) => Promise<{
          choices: Array<{ message: { content: string | null } }>;
        }>;
      };
    };
  };
  model?: string;
  confidenceThreshold?: number;
}

export interface ContradictionResult {
  isContradiction: boolean;
  conflict: string;
  confidence: number;
}

const SYSTEM_PROMPT = `You are a contradiction detector. Compare the old and new descriptions of an entity and determine if they contradict each other.

Return JSON with this exact structure:
{
  "isContradiction": true/false,
  "conflict": "Description of the conflict (empty if no contradiction)",
  "confidence": 0.0-1.0
}

Rules:
- Only flag as contradiction if the statements are genuinely incompatible
- Additions or refinements are NOT contradictions
- Version upgrades are NOT contradictions
- Fundamentally different behaviors or architectures ARE contradictions`;

export class ContradictionDetector {
  private config: ContradictionDetectorConfig;
  private model: string;
  private confidenceThreshold: number;

  constructor(config: ContradictionDetectorConfig) {
    this.config = config;
    this.model = config.model ?? "gpt-4o-mini";
    this.confidenceThreshold = config.confidenceThreshold ?? 0.7;
  }

  async detect(
    entityName: string,
    oldContext: string,
    newContext: string
  ): Promise<ContradictionResult> {
    try {
      const response = await this.config.openai.chat.completions.create({
        model: this.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: `Entity: ${entityName}\n\nPrevious description: ${oldContext}\n\nNew description: ${newContext}`,
          },
        ],
        temperature: 0.1,
        response_format: { type: "json_object" },
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        return { isContradiction: false, conflict: "", confidence: 0 };
      }

      const parsed = JSON.parse(content) as {
        isContradiction?: boolean;
        conflict?: string;
        confidence?: number;
      };

      const confidence = parsed.confidence ?? 0;

      // Only flag as contradiction if confidence meets threshold
      if (parsed.isContradiction && confidence >= this.confidenceThreshold) {
        return {
          isContradiction: true,
          conflict: parsed.conflict ?? "",
          confidence,
        };
      }

      return { isContradiction: false, conflict: "", confidence };
    } catch {
      // Non-blocking: return no contradiction on failure
      return { isContradiction: false, conflict: "", confidence: 0 };
    }
  }
}
