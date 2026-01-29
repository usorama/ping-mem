/**
 * DeterministicVectorizer: Hash-based feature vectorization
 *
 * Produces fully deterministic, reproducible vectors without ML models.
 * Uses feature hashing (hashing trick) + TF-IDF style weighting.
 *
 * Benefits:
 * - Bit-for-bit reproducible (same text → same vector, always)
 * - No dependency on external APIs or ML models
 * - Fast and lightweight
 *
 * Trade-offs:
 * - Lower semantic quality than learned embeddings (OpenAI/etc.)
 * - Still useful for keyword/lexical similarity
 */

import * as crypto from "crypto";

export interface DeterministicVectorizerOptions {
  dimensions?: number; // Vector dimensions (default: 768)
  ngramMin?: number; // Minimum ngram length (default: 1)
  ngramMax?: number; // Maximum ngram length (default: 3)
  normalize?: boolean; // L2 normalize vectors (default: true)
}

export class DeterministicVectorizer {
  private readonly dimensions: number;
  private readonly ngramMin: number;
  private readonly ngramMax: number;
  private readonly normalize: boolean;

  constructor(options: DeterministicVectorizerOptions = {}) {
    this.dimensions = options.dimensions ?? 768;
    this.ngramMin = options.ngramMin ?? 1;
    this.ngramMax = options.ngramMax ?? 3;
    this.normalize = options.normalize ?? true;
  }

  /**
   * Generate deterministic vector for text.
   * Same text → same vector, always.
   */
  vectorize(text: string): number[] {
    const tokens = this.tokenize(text);
    const ngrams = this.generateNgrams(tokens);
    const vector = this.hashFeatures(ngrams);

    if (this.normalize) {
      return this.l2Normalize(vector);
    }
    return vector;
  }

  private tokenize(text: string): string[] {
    // Simple whitespace + punctuation tokenization
    // Deterministic: same text → same tokens
    const normalized = text
      .toLowerCase()
      .replace(/[^\w\s]/g, " ") // Replace punctuation with space
      .replace(/\s+/g, " ") // Collapse multiple spaces
      .trim();

    return normalized.split(" ").filter((t) => t.length > 0);
  }

  private generateNgrams(tokens: string[]): string[] {
    const ngrams: string[] = [];

    for (let n = this.ngramMin; n <= this.ngramMax; n++) {
      for (let i = 0; i <= tokens.length - n; i++) {
        const ngram = tokens.slice(i, i + n).join("_");
        ngrams.push(ngram);
      }
    }

    return ngrams;
  }

  private hashFeatures(ngrams: string[]): number[] {
    // Feature hashing: hash each ngram to a vector index
    const vector = new Array<number>(this.dimensions).fill(0);

    for (const ngram of ngrams) {
      const hashValue = this.hashString(ngram);
      const index = Math.abs(hashValue) % this.dimensions;
      const sign = hashValue >= 0 ? 1 : -1;

      // Accumulate weighted features (TF-style)
      vector[index]! += sign;
    }

    return vector;
  }

  private hashString(str: string): number {
    // Deterministic hash: same string → same hash value
    const hash = crypto.createHash("sha256").update(str).digest();

    // Convert first 4 bytes to signed integer
    const value =
      (hash[0]! << 24) | (hash[1]! << 16) | (hash[2]! << 8) | hash[3]!;

    // Convert to signed 32-bit integer
    return value | 0;
  }

  private l2Normalize(vector: number[]): number[] {
    const norm = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
    if (norm === 0) {
      return vector; // Avoid division by zero
    }
    return vector.map((val) => val / norm);
  }
}
