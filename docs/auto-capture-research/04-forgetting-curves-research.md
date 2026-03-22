# Forgetting Curves and Memory Decay Algorithms for AI Agent Memory Systems

**Research Date:** 2026-03-22
**Purpose:** Evaluate and document forgetting curve algorithms suitable for relevance scoring in ping-mem's memory decay system.

---

## 1. Ebbinghaus Forgetting Curve

### Original Formula

Hermann Ebbinghaus (1885) modeled memory retention as:

```
R = e^(-t/S)
```

**Variables:**
- `R` — Retrievability (retention), range [0, 1]; probability of successfully recalling the item
- `t` — Time elapsed since learning/last reinforcement (in consistent units: hours, days)
- `S` — Memory Stability; the time constant controlling decay speed. Higher S = slower decay. Represents "memory strength."

**Interpretation:** When `t = S`, retention drops to `e^(-1) ≈ 0.368` (36.8%). This is the half-strength point, not the half-life.

**True half-life** (where R = 0.5): `t_half = S × ln(2) ≈ 0.693 × S`

### Key Empirical Findings

- Without reinforcement, ~50–70% of new information is lost within 24 hours.
- The decay rate slows over time — information that persists past ~1 week becomes significantly more stable.
- Individual differences (prior knowledge, emotional salience, sleep, stress) affect S significantly.

### Adapting R = e^(-t/S) for AI Memory Relevance Scoring

The original formula models human recall probability. For AI agent memory, the adaptation shifts from "will the agent recall this?" to "how relevant/valuable is this memory right now?":

**Adapted interpretation:**
- `R` → **relevance decay multiplier** [0, 1] applied to a base importance score
- `t` → time since memory was **created** or **last accessed** (last-access is preferred; it resets on retrieval)
- `S` → **stability parameter** per memory category (tuned, not learned from data)

**Adapted formula for a memory item:**

```
decay_score(t, S) = exp(-t / S)
```

**Combined relevance score:**

```
final_score = base_importance × decay_score(t, S) × access_boost(n, t_last)
```

Where:
- `base_importance` ∈ [0, 1] — LLM-assigned or rule-based importance at creation time
- `t` — hours since last access (reset on retrieval)
- `S` — stability constant for the memory's category (see Section 4)
- `access_boost` — multiplier reflecting access frequency and recency (see Section 3)

### Recommended Default Stability Values (S, in hours)

| Memory Category | S (hours) | Rationale |
|----------------|-----------|-----------|
| Observations / ephemeral notes | 72 (3 days) | Short-lived context |
| Learned facts / semantic knowledge | 720 (30 days) | Moderate persistence |
| User preferences | 2160 (90 days) | Slow-changing |
| Decisions / reasoning records | 4320 (180 days) | Long-lived |
| Pinned / core identity | ∞ (never decays) | Permanent |

---

## 2. Spaced Repetition Algorithms

### 2.1 SM-2 Algorithm (SuperMemo 2)

Developed by Piotr Wozniak for human learning. The core insight: optimal review intervals grow multiplicatively based on demonstrated ease of recall.

**Full Algorithm:**

1. Initialize all items with Ease Factor `EF = 2.5`
2. Intervals:
   - `I(1) = 1` day
   - `I(2) = 6` days
   - `I(n) = round(I(n-1) × EF)` for n > 2
3. After each review, quality `q` is rated 0–5 (5=perfect, 0=complete failure)
4. **Ease Factor update:**
   ```
   EF' = EF + (0.1 - (5 - q) × (0.08 + (5 - q) × 0.02))
   ```
   - `EF_min = 1.3` (floor)
   - q=5: EF increases by +0.1
   - q=4: EF unchanged (net delta ≈ 0)
   - q=3: EF decreases by -0.14
   - q=2: EF decreases by -0.32 (incorrect)
5. If q < 3 (failed): reset repetitions to 0, restart interval sequence. EF unchanged.

**Simplified expansion of the EF formula:**

```
delta_EF = 0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)
         = 0.1 - (5-q)*0.08 - (5-q)^2 * 0.02
```

**Suitability for AI memory:** SM-2 is designed for binary recall (remembered/not). For passive memory decay (no explicit "review" events), it is a poor fit. However, the EF concept maps well to per-category stability: memories that are frequently "used" (retrieved and acted upon) earn higher stability.

### 2.2 Leitner System

A box-based discrete approximation of spaced repetition. Cards live in one of N boxes with increasing review intervals.

**Standard 5-box intervals:**

| Box | Review Interval |
|-----|----------------|
| 1   | Daily           |
| 2   | Every 2 days    |
| 3   | Every 4 days    |
| 4   | Weekly (7 days) |
| 5   | Every 2 weeks   |

**Promotion/Demotion rules:**
- Correct recall → promote to next box (longer interval)
- Incorrect recall → demote to Box 1 regardless of current box

**Suitability for AI memory:** Useful as a **tiered archival model** rather than a decay model. Maps to memory tiers: hot (in-context), warm (fast retrieval), cold (archival). Demotion logic maps to "evict from context if not recently accessed." Not suitable for continuous relevance scoring.

### 2.3 FSRS (Free Spaced Repetition Scheduler)

The state-of-the-art spaced repetition algorithm (2022–present). Based on the DSR model: **D**ifficulty, **S**tability, **R**etievability.

**Core memory state variables:**
- `R` — Retrievability ∈ [0, 1]: probability of successful recall at time t
- `S` — Stability: time in days for R to drop from 1.0 to 0.9 (90%)
- `D` — Difficulty ∈ [1, 10]: inherent hardness of the item

**Forgetting curve (FSRS-4.5 / FSRS-6 power law):**

```
R(t, S) = (1 + FACTOR × t/S)^DECAY
```

Where for FSRS-4.5:
- `DECAY = -0.5`
- `FACTOR = 19/81 ≈ 0.2346` (ensures R(S, S) = 0.9 exactly)

This reduces to:
```
R(t, S) = (1 + (19/81) × (t/S))^(-0.5)
```

Older FSRS-v3 used exponential (equivalent to Ebbinghaus):
```
R(t, S) = 0.9^(t/S)  [= exp(ln(0.9) × t/S)]
```

**Interval calculation** (find t where R = desired retention r):
```
I(r, S) = (S / FACTOR) × (r^(1/DECAY) - 1)
```
For r = 0.9 (default), I = S (the definition of stability).

**Stability increase after successful recall:**
```
S'(D, S, R, G) = S × exp(w8) × (11 - D) × S^(-w9) × (exp(w10 × (1-R)) - 1) × grade_modifier + S
```
Where `grade_modifier` is `w15` for Hard, 1 for Good, `w16` for Easy.

**Post-lapse stability** (after forgetting):
```
S'_f(D, S, R) = w11 × D^(-w12) × ((S+1)^w13 - 1) × exp(w14 × (1-R))
```

**FSRS-6 Default Parameters (21 weights, w0–w20):**
```
[0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001,
 1.8722, 0.1666, 0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014,
 1.8729, 0.5425, 0.0912, 0.0658, 0.1542]
```

**FSRS-4.5 Default Parameters (17 weights):**
```
[0.4872, 1.4003, 3.7145, 13.8206, 5.1618, 1.2298, 0.8975, 0.031,
 1.6474, 0.1367, 1.0461, 2.1072, 0.0793, 0.3246, 1.587, 0.2272, 2.8755]
```

**Suitability for AI memory:**

| Algorithm | Best for |
|-----------|----------|
| SM-2 | When explicit review events exist (e.g., user marks memory as "used") |
| FSRS | When access events generate quality grades; production-grade if trainable |
| Ebbinghaus simple | Passive time-only decay; no access history needed |
| Leitner | Tiered storage/eviction model, not continuous scoring |

**Recommendation for ping-mem:** Use the **FSRS forgetting curve formula** `R(t,S) = (1 + FACTOR × t/S)^DECAY` for the decay function (it is empirically validated to outperform the pure exponential), combined with an **access-weighted stability boost** (Section 3). Full FSRS requires training data per-memory; a simplified version with fixed S per category and FSRS's power-law curve is the practical middle ground.

---

## 3. Access-Weighted Decay

### Core Concept

Pure time decay penalizes memories that are important but happen to be old. Access patterns are a genuine signal of relevance. The combination:

```
score = base_relevance × decay(t, S) × boost(n, t_last_access)
```

### Decay Function

Using the FSRS power-law (better fit than pure exponential):

```python
DECAY = -0.5
FACTOR = 19.0 / 81.0  # ≈ 0.2346

def decay(t_hours, S_hours):
    """
    t_hours: hours since last access
    S_hours: stability constant for this memory category
    Returns: multiplier in (0, 1]
    """
    t_days = t_hours / 24.0
    S_days = S_hours / 24.0
    return (1 + FACTOR * (t_days / S_days)) ** DECAY
```

Alternative: simple exponential (Ebbinghaus, easier in SQL):

```python
def decay_exp(t_hours, S_hours):
    import math
    return math.exp(-t_hours / S_hours)
```

### Access Boost Function

Following ACT-R base-level learning and the reinforcement principle:

**ACT-R base-level activation (simplified):**
```
B_i = ln(sum over j of t_j^(-d))
```
Where `t_j` is time since the j-th access and `d ≈ 0.5` is the decay rate.

**Practical approximation for SQL (logarithmic boost):**

```
access_boost(n, t_last_hours) = 1 + α × ln(1 + n) × decay(t_last_hours, S_access)
```

**Variables:**
- `n` — total access count for this memory
- `t_last_hours` — hours since the most recent access
- `α` — boost weight coefficient (recommended: `0.3`)
- `S_access` — stability for the access boost decay (recommended: `168` hours = 1 week)
  - This ensures recent accesses boost more than old ones

**Alternative: LangChain's approach (simpler):**

```
access_boost = 1 + (1 - decay_rate)^hours_since_last_access
```

Where `decay_rate = 0.01` (default), applied hourly. LangChain resets `last_accessed_at` on every retrieval.

### Combined Formula

```
final_score(memory) =
    base_importance
    × (1 + FACTOR × t_since_last_access_days / S_category_days)^DECAY
    × (1 + 0.3 × ln(1 + access_count) × exp(-t_since_last_access_hours / 168))
```

### Recommended Default Parameters

| Parameter | Value | Notes |
|-----------|-------|-------|
| `DECAY` (power law) | `-0.5` | FSRS-validated |
| `FACTOR` | `19/81 ≈ 0.2346` | Ensures R(S,S) = 0.9 |
| `α` (access boost weight) | `0.3` | Balance between time and access |
| `S_access` (access boost half-decay) | `168 hours` (7 days) | Recent access matters more |
| LangChain `decay_rate` | `0.01` per hour | Simple exponential alternative |
| Recency weight (Generative Agents) | `0.995` per hour | `0.995^hours` for recency score |

### Generative Agents (Park et al., 2023) Formula

The foundational "Generative Agents" paper uses a 3-component retrieval score:

```
score = w_recency × recency_score
      + w_importance × importance_score
      + w_relevance × relevance_score
```

Where:
- `recency_score = 0.995^hours_since_last_retrieval` (exponential decay)
- `importance_score` ∈ [0, 1] — LLM-assigned at creation time, normalized 1–10 → [0,1]
- `relevance_score` ∈ [0, 1] — cosine similarity to query embedding
- All three scores are min-max normalized to [0, 1] before weighting
- Weights typically equal (1/3 each) or tuned per deployment

---

## 4. Practical SQLite Implementation

### Schema Design

```sql
CREATE TABLE memories (
    id              TEXT PRIMARY KEY,
    content         TEXT NOT NULL,
    category        TEXT NOT NULL DEFAULT 'observation',
    -- 'observation' | 'decision' | 'preference' | 'fact' | 'core'

    base_importance REAL NOT NULL DEFAULT 0.5,
    -- LLM-assigned score [0.0, 1.0] at creation time

    stability_hours REAL NOT NULL DEFAULT 720.0,
    -- Per-category time constant S (in hours). NULL = use category default.

    is_pinned       INTEGER NOT NULL DEFAULT 0,
    -- 1 = never decay, always return with full score

    access_count    INTEGER NOT NULL DEFAULT 0,
    created_at      REAL NOT NULL DEFAULT (unixepoch('now')),
    last_accessed_at REAL NOT NULL DEFAULT (unixepoch('now')),
    -- Store as Unix timestamps (seconds since epoch)

    embedding       BLOB,
    -- Optional: for vector similarity scoring
    metadata        TEXT  -- JSON blob for extra fields
);

CREATE INDEX idx_memories_category ON memories(category);
CREATE INDEX idx_memories_last_accessed ON memories(last_accessed_at);
CREATE INDEX idx_memories_is_pinned ON memories(is_pinned);
```

### Category-Based Default Stability

```sql
CREATE TABLE memory_category_config (
    category        TEXT PRIMARY KEY,
    stability_hours REAL NOT NULL,
    -- Time constant S in hours
    description     TEXT
);

INSERT INTO memory_category_config VALUES
    ('observation',  72,    'Ephemeral notes, transient context'),
    ('fact',         720,   'Learned facts, semantic knowledge'),
    ('preference',   2160,  'User preferences, slow-changing'),
    ('decision',     4320,  'Decisions, reasoning records'),
    ('core',         999999,'Core identity, permanent');
```

### Decay Score Computed at Query Time

**Option A: Exponential decay (Ebbinghaus) — simpler SQL:**

```sql
-- Query with exponential decay score
-- t = hours since last access
-- S = stability_hours from memory or category config

SELECT
    m.id,
    m.content,
    m.base_importance,
    CASE
        WHEN m.is_pinned = 1 THEN 1.0
        ELSE m.base_importance
             * exp(- (unixepoch('now') - m.last_accessed_at) / 3600.0
                   / COALESCE(m.stability_hours,
                              (SELECT stability_hours
                               FROM memory_category_config
                               WHERE category = m.category),
                              720.0))
             * (1.0 + 0.3
                    * ln(1.0 + m.access_count)
                    * exp(- (unixepoch('now') - m.last_accessed_at) / 3600.0
                           / 168.0))
    END AS decay_score
FROM memories m
ORDER BY decay_score DESC
LIMIT 20;
```

**Option B: FSRS power-law decay — more accurate:**

```sql
-- FSRS power-law: R(t,S) = (1 + 0.2346 * t_days/S_days)^(-0.5)
-- SQLite does not have a power() function with fractional exponents natively,
-- but: x^(-0.5) = 1.0 / sqrt(x)

SELECT
    m.id,
    m.content,
    CASE
        WHEN m.is_pinned = 1 THEN m.base_importance
        ELSE m.base_importance
             * (1.0 / sqrt(
                    1.0 + (19.0/81.0)
                        * ((unixepoch('now') - m.last_accessed_at) / 86400.0)
                        / (COALESCE(m.stability_hours,
                                    (SELECT stability_hours
                                     FROM memory_category_config
                                     WHERE category = m.category),
                                    720.0) / 24.0)
               ))
             * (1.0 + 0.3
                    * ln(1.0 + m.access_count)
                    * exp(- (unixepoch('now') - m.last_accessed_at)
                           / 3600.0 / 168.0))
    END AS decay_score
FROM memories m
ORDER BY decay_score DESC
LIMIT 20;
```

**Note on SQLite math functions:** `exp()`, `ln()`, `sqrt()` are available in SQLite 3.35+ (released 2021) via the built-in math functions extension. Verify with `SELECT sqlite_version()`. If unavailable, precompute scores in application code.

### Updating Access Count on Retrieval

```sql
-- Call after every memory retrieval
UPDATE memories
SET
    access_count     = access_count + 1,
    last_accessed_at = unixepoch('now')
WHERE id = ?;
```

### Batch Decay Job (Periodic Cleanup)

For large stores, a periodic job is better than always computing at query time:

```sql
-- Add a stored decay_score column updated by batch job
ALTER TABLE memories ADD COLUMN cached_decay_score REAL DEFAULT 1.0;

-- Batch update (run hourly or daily via background job)
UPDATE memories
SET cached_decay_score =
    CASE
        WHEN is_pinned = 1 THEN base_importance
        ELSE base_importance
             * (1.0 / sqrt(
                    1.0 + (19.0/81.0)
                        * ((unixepoch('now') - last_accessed_at) / 86400.0)
                        / (stability_hours / 24.0)
               ))
             * (1.0 + 0.3
                    * ln(1.0 + access_count)
                    * exp(-(unixepoch('now') - last_accessed_at) / 3600.0 / 168.0))
    END
WHERE is_pinned = 0 OR cached_decay_score IS NULL;

-- Index on cached score for fast retrieval
CREATE INDEX idx_memories_decay_score ON memories(cached_decay_score DESC);
```

### Performance Considerations for 100K+ Entries

1. **Compute-at-query vs cached:** At 100K rows, computing decay at query time with `exp()` and `sqrt()` adds ~5–10ms per full-table scan. Acceptable for most use cases. For sub-millisecond retrieval, use the cached column updated by a background job.

2. **Index strategy:**
   - Index on `(is_pinned, cached_decay_score DESC)` for fast top-N retrieval
   - Index on `(category, last_accessed_at)` for category-filtered queries
   - Index on `(last_accessed_at)` for eviction/pruning jobs
   - Avoid indexing `decay_score` as a generated column — the formula references `unixepoch('now')` which is non-deterministic and SQLite will reject it as a generated column expression

3. **WAL mode:** Enable Write-Ahead Logging for concurrent reads during batch updates:
   ```sql
   PRAGMA journal_mode = WAL;
   PRAGMA synchronous = NORMAL;
   ```

4. **Eviction policy:** Prune memories where `cached_decay_score < 0.01` AND `is_pinned = 0` to keep the table bounded:
   ```sql
   DELETE FROM memories
   WHERE is_pinned = 0
     AND cached_decay_score < 0.01
     AND access_count < 3;
   -- Keep even very old memories if accessed frequently (access_count >= 3)
   ```

5. **Partitioning by category:** For very large stores, consider separate tables per category with different update frequencies (ephemeral observations pruned daily, decisions kept indefinitely).

### Handling Pinned Memories

Pinned memories bypass all decay computation:

```sql
-- Mark as pinned (never decays)
UPDATE memories SET is_pinned = 1 WHERE id = ?;

-- Query always returns pinned memories first, then decayed
SELECT id, content, decay_score FROM (
    SELECT id, content, base_importance AS decay_score, 0 AS sort_order
    FROM memories WHERE is_pinned = 1

    UNION ALL

    SELECT id, content,
        base_importance * (1.0 / sqrt(
            1.0 + (19.0/81.0)
                * ((unixepoch('now') - last_accessed_at) / 86400.0)
                / (stability_hours / 24.0)
        )) AS decay_score,
        1 AS sort_order
    FROM memories WHERE is_pinned = 0
)
ORDER BY sort_order, decay_score DESC
LIMIT 50;
```

---

## 5. Prior Art in AI Memory Systems

### 5.1 MemGPT / Letta

**Architecture:** Draws from OS virtual memory management. Two-tier model:
- **Core Memory (Tier 1 = "RAM"):** Always in the LLM's context window. Small blocks: `human` (facts about the user), `persona` (agent identity), `system` (current task). Editable via tool calls.
- **Archival/Recall Memory (Tier 2 = "Disk"):** External storage. Archival = long-term fact storage (vector search). Recall = conversation history (sequential/temporal search).

**Key insight:** The agent itself manages memory movement via function calls (`core_memory_append`, `archival_memory_insert`, `archival_memory_search`). No automatic decay — the agent decides what to remember.

**Filesystem baseline:** Letta benchmarked a pure-filesystem approach (CLAUDE.md-style markdown files) achieving 74% on the LoCoMo long-context memory benchmark — competitive with complex systems.

**Decay:** MemGPT/Letta does not implement time-based decay natively. Memory relevance is determined by agent judgment and vector similarity, not temporal scoring.

### 5.2 LangChain TimeWeightedVectorStoreRetriever

**Scoring formula:**

```python
# From LangChain source
score = (1.0 - decay_rate) ** hours_passed
# Then adds importance and vector similarity on top
combined_score = decay_score + importance_score + vector_relevance_score
```

**Parameters:**
- `decay_rate = 0.01` (default) — applied per hour
- `last_accessed_at` — updated on every retrieval (reset clock on access)
- `other_score_keys` — additional metadata scores (e.g., `importance`) added to decay score

**Half-life:** With `decay_rate = 0.01`, score halves when `(0.99)^hours = 0.5` → `hours = ln(0.5)/ln(0.99) ≈ 69 hours ≈ 2.9 days`.

**Note:** LangChain's formula `(1-rate)^t` is mathematically equivalent to `exp(-t × rate)` for small rates (first-order approximation). For `rate = 0.01`, the difference is negligible.

### 5.3 Generative Agents (Park et al., 2023)

**Memory stream:** Flat list of observations with timestamps. Three retrieval signals equally weighted:

```
retrieval_score = (1/3) × recency + (1/3) × importance + (1/3) × relevance
```

- **Recency:** `0.995^hours_since_last_retrieval` — very slow decay (half-life ≈ 138 hours ≈ 5.8 days)
- **Importance:** LLM rates 1–10 at creation time ("How important is this memory on a scale of 1-10?"), normalized to [0,1]
- **Relevance:** Cosine similarity to current query embedding
- All scores normalized to [0,1] via min-max before combining

**Memory consolidation (reflection):** Agents periodically synthesize observations into higher-level "insights" (semantic memories), which are stored as new memory objects with higher importance scores.

### 5.4 Memoripy

Open-source Python library with explicit decay and reinforcement:

```python
# Decay formula (Ebbinghaus-inspired with ACT-R reinforcement)
adjusted_decay_rate = base_decay_rate / (1 + 0.3 * reinforcement_count)
confidence = initial_confidence * exp(-adjusted_decay_rate * hours_since_reinforced)
```

**Key behaviors:**
- Each retrieval increments `reinforcement_count` and resets `last_reinforced`
- Higher access count → lower effective decay rate (memories get more stable with use)
- Configurable `base_decay_rate` per memory type

### 5.5 widemem

Production-oriented memory layer with:
- Importance scoring: LLM assigns 1–10 at extraction time
- Retrieval: weighted mix of similarity + importance + recency
- Decay types: configurable `exponential | linear | step`
- YMYL (You Must Yield Longer) domains (medical, financial, legal): higher importance floors + decay immunity

### 5.6 OpenClaw Memory Search

```
decayedScore = score × exp(-λ × ageInDays)
where λ = ln(2) / halfLifeDays
```

**Default half-life:** 30 days (score halves every 30 days).

**Pipeline:** `Vector + Keyword → Weighted Merge → Temporal Decay → Sort → MMR → Top-K`

**Evergreen bypass:** Named memory files (MEMORY.md, non-dated files) skip decay entirely — equivalent to the `is_pinned` pattern.

### 5.7 ACT-R Base-Level Learning

The cognitive architecture ACT-R provides the most theoretically grounded formula for access-weighted decay:

```
B_i = ln( sum_{j=1}^{n} t_j^(-d) )
```

**Variables:**
- `B_i` — base-level activation of memory chunk i
- `n` — number of times memory has been accessed
- `t_j` — time (in seconds) since the j-th access
- `d` — decay parameter, typically `d = 0.5`

**Practical approximation** (Anderson & Lebiere, 1998):

```
B_i ≈ ln(n / ((1-d) × t_n^(1-d)))
     = ln(n) - ln(1-d) - (1-d) × ln(t_n)
```

Where `t_n` is the total age of the memory (time since first creation).

**Retrieval probability** given activation threshold τ and noise σ:

```
P(retrieve) = 1 / (1 + exp((τ - B_i) / σ))
```

Typical values: `τ = -0.5`, `σ = 0.25`.

**ACT-R is the gold standard for theoretically sound access-weighted decay** but is computationally expensive for 100K+ memories due to the sum over all past accesses.

---

## 6. Algorithm Comparison Summary

| Algorithm | Decay Model | Access-Weighted | Trainable | SQL-Friendly | Best Use Case |
|-----------|------------|-----------------|-----------|--------------|---------------|
| Ebbinghaus R=e^(-t/S) | Exponential | No | No (manual S) | Yes (exp()) | Simple time-only decay |
| FSRS power-law | Power law | Via S update | Yes (gradient descent) | Yes (1/sqrt()) | Best validated accuracy |
| SM-2 | Interval-based | Yes (EF) | Implicit | No (stateful) | Explicit review events |
| Leitner | Step/discrete | Yes (promotion) | No | Yes (integer box) | Tiered eviction |
| ACT-R BLL | Power sum | Yes (all accesses) | Partial (d) | No (sum over history) | Theoretically ideal |
| LangChain TW | Exponential | Via last_access | No | Yes | Simple production use |
| Generative Agents | Exponential (0.995^h) | Via last_retrieval | No | Yes | Balanced 3-factor scoring |
| Memoripy | Exp + reinforcement | Yes (count) | No | Partial | Reinforcement-focused |

---

## 7. Recommended Design for ping-mem

### Formula

```
final_score(m, query) =
    α × relevance(m, query)        -- vector/semantic similarity [0,1]
    + β × importance(m)            -- base_importance [0,1]
    + γ × recency_score(m)         -- decay of time since last access [0,1]
    + δ × access_boost(m)          -- frequency boost [0, ~1.5]
```

With `α + β + γ + δ = 1` (normalize weights to sum to 1 after access_boost scaling).

**Recommended starting weights:** `α=0.4, β=0.25, γ=0.25, δ=0.10`

### Recency Score

```
recency_score = (1 + (19/81) × (hours_since_access / 24) / stability_days)^(-0.5)
```

Or for simpler deployment:
```
recency_score = exp(-hours_since_access / stability_hours)
```

### Access Boost

```
access_boost = ln(1 + access_count) / ln(1 + MAX_ACCESS_COUNT)
```
(Normalized log so max is 1.0; `MAX_ACCESS_COUNT` ≈ 100)

### Category Stability Defaults

```
observation:  S = 72h  (3 days)
fact:         S = 720h (30 days)
preference:   S = 2160h (90 days)
decision:     S = 4320h (180 days)
pinned/core:  S = ∞ (bypass decay entirely)
```

### Implementation Priority

1. **Phase 1 (Simple):** Exponential decay with `exp()` at query time. No cached scores. Works to ~10K memories with acceptable latency.
2. **Phase 2 (Scalable):** Add `cached_decay_score` column updated by a background job. Add index. Scales to 1M+ memories.
3. **Phase 3 (Accurate):** Per-memory stability that increases on access (FSRS-inspired). Requires storing access history or approximating via access_count.

---

## References

- [Forgetting curve - Wikipedia](https://en.wikipedia.org/wiki/Forgetting_curve)
- [SuperMemo SM-2 Algorithm](https://super-memory.com/english/ol/sm2.htm)
- [FSRS Algorithm - open-spaced-repetition/awesome-fsrs Wiki](https://github.com/open-spaced-repetition/awesome-fsrs/wiki/The-Algorithm)
- [A technical explanation of FSRS - Expertium's Blog](https://expertium.github.io/Algorithm.html)
- [The FSRS Algorithm - stackwild.hashnode.dev](https://stackwild.hashnode.dev/the-fsrs-free-spaced-repetition-scheduler-algorithm)
- [LangChain TimeWeightedVectorStoreRetriever API](https://api.python.langchain.com/en/latest/retrievers/langchain.retrievers.time_weighted_retriever.TimeWeightedVectorStoreRetriever.html)
- [Generative Agents: Interactive Simulacra of Human Behavior (Park et al., 2023)](https://dl.acm.org/doi/fullHtml/10.1145/3586183.3606763)
- [MemGPT: Towards LLMs as Operating Systems (arxiv 2310.08560)](https://arxiv.org/abs/2310.08560)
- [Agent Memory: How to Build Agents that Learn and Remember - Letta](https://www.letta.com/blog/agent-memory)
- [memoripy - GitHub](https://github.com/caspianmoon/memoripy)
- [widemem - HuggingFace Forums](https://discuss.huggingface.co/t/widemem-open-source-memory-layer-for-llms-with-importance-scoring-decay-and-conflict-resolution/174269)
- [OpenClaw Memory Docs](https://openclawlab.com/en/docs/concepts/memory/)
- [ACT-R Unit 4: Base-Level Learning](http://act-r.psy.cmu.edu/wordpress/wp-content/themes/ACT-R/tutorials/unit4.htm)
- [Memory in the Age of AI Agents (arxiv 2512.13564)](https://arxiv.org/abs/2512.13564)
- [SQLite Generated Columns](https://sqlite.org/gencol.html)
- [Local-First RAG: Using SQLite for AI Agent Memory - PingCAP](https://www.pingcap.com/blog/local-first-rag-using-sqlite-ai-agent-memory-openclaw/)
