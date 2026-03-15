/**
 * Information retrieval metrics for eval suite
 *
 * Pure functions — no side effects, no I/O.
 *
 * @module eval/metrics
 */

/**
 * Recall@K — fraction of relevant items found in top K results
 *
 * |relevant ∩ retrieved[:k]| / |relevant|
 */
export function recallAtK(
  retrievedIds: readonly string[],
  relevantIds: readonly string[],
  k: number,
): number {
  if (relevantIds.length === 0) return 0;
  if (k <= 0) return 0;

  const relevant = new Set(relevantIds);
  const topK = new Set(retrievedIds.slice(0, k));
  let hits = 0;
  for (const id of topK) {
    if (relevant.has(id)) hits++;
  }
  return hits / relevant.size;
}

/**
 * NDCG@K — Normalized Discounted Cumulative Gain
 *
 * Uses graded relevance scores. DCG = Σ rel_i / log2(i+2) for i in 0..k-1
 * NDCG = DCG / IDCG where IDCG is DCG of ideal ranking.
 */
export function ndcgAtK(
  retrievedIds: readonly string[],
  relevanceScores: Readonly<Record<string, number>>,
  k: number,
): number {
  if (k <= 0) return 0;

  const topK = retrievedIds.slice(0, k);

  // DCG of actual ranking
  let dcg = 0;
  for (let i = 0; i < topK.length; i++) {
    const id = topK[i];
    if (id === undefined) continue;
    const rel = relevanceScores[id] ?? 0;
    dcg += rel / Math.log2(i + 2);
  }

  // IDCG — best possible ranking
  const allRels = Object.values(relevanceScores)
    .sort((a, b) => b - a)
    .slice(0, k);

  let idcg = 0;
  for (let i = 0; i < allRels.length; i++) {
    const rel = allRels[i];
    if (rel === undefined) continue;
    idcg += rel / Math.log2(i + 2);
  }

  return idcg > 0 ? dcg / idcg : 0;
}

/**
 * MRR@K — Mean Reciprocal Rank (for a single query)
 *
 * 1 / rank_of_first_relevant within top K. Returns 0 if none found.
 */
export function mrrAtK(
  retrievedIds: readonly string[],
  relevantIds: readonly string[],
  k: number,
): number {
  if (k <= 0) return 0;

  const relevant = new Set(relevantIds);
  const topK = retrievedIds.slice(0, k);

  for (let i = 0; i < topK.length; i++) {
    const id = topK[i];
    if (id !== undefined && relevant.has(id)) {
      return 1 / (i + 1);
    }
  }
  return 0;
}
