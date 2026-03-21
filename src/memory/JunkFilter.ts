/**
 * JunkFilter — fast heuristic quality gate for memory saves.
 * Rejects junk content before it reaches the EventStore.
 *
 * @module memory/JunkFilter
 */

export interface JunkFilterResult {
  junk: boolean;
  reason?: string;
}

const FILLER_EXACT = new Set([
  "test", "testing", "asdf", "asdfjkl", "hello", "hello world",
  "foo", "bar", "baz", "lorem ipsum", "todo", "tbd", "n/a", "na",
  "xxx", "yyy", "zzz", "abc", "123", "qwerty",
]);

export class JunkFilter {
  isJunk(value: string): JunkFilterResult {
    // 1. Empty or all-whitespace
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return { junk: true, reason: "empty content" };
    }

    // 2. Too short
    if (trimmed.length < 10) {
      return { junk: true, reason: "too short (< 10 chars)" };
    }

    // 3. Generic filler (exact match, case-insensitive)
    if (FILLER_EXACT.has(trimmed.toLowerCase())) {
      return { junk: true, reason: "generic filler" };
    }

    // 4. Bare URL with no context
    const urlOnly = /^https?:\/\/\S+$/i;
    if (urlOnly.test(trimmed)) {
      return { junk: true, reason: "bare URL without context" };
    }

    // 5. Repetitive content — single char > 60%
    const charCounts = new Map<string, number>();
    for (const ch of trimmed) {
      charCounts.set(ch, (charCounts.get(ch) ?? 0) + 1);
    }
    for (const [, count] of charCounts) {
      if (count / trimmed.length > 0.6) {
        return { junk: true, reason: "repetitive content" };
      }
    }

    // 6. Repetitive words — single word > 60% of word count
    const words = trimmed.toLowerCase().split(/\s+/);
    if (words.length >= 3) {
      const wordCounts = new Map<string, number>();
      for (const w of words) {
        wordCounts.set(w, (wordCounts.get(w) ?? 0) + 1);
      }
      for (const [, count] of wordCounts) {
        if (count / words.length > 0.6) {
          return { junk: true, reason: "repetitive content" };
        }
      }
    }

    return { junk: false };
  }
}
