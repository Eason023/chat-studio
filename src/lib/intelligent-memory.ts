import type {
  IntelligentGlobalMemoryCategory,
  IntelligentGlobalMemoryEntry,
} from "@/lib/types"

export const GLOBAL_MEMORY_ENTRY_LIMIT = 32
export const GLOBAL_MEMORY_VALUE_CHAR_LIMIT = 420

const MEMORY_VALUE_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "at",
  "be",
  "for",
  "from",
  "has",
  "have",
  "her",
  "him",
  "his",
  "i",
  "in",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "or",
  "our",
  "she",
  "that",
  "the",
  "their",
  "them",
  "they",
  "this",
  "to",
  "user",
  "users",
  "was",
  "we",
  "with",
  "you",
  "your",
])

const LOW_VALUE_RECENT_EVENT_PATTERNS = [
  /\b(user|they)\s+(just\s+)?(said|says|greeted|greeting|mentioned)\s+(hi|hello|hey)\b/i,
  /\b(user|they)\s+(just\s+)?(said|mentioned|sent)\s+(thanks|thank you|thx)\b/i,
  /\b(small talk|pleasantries|greeting|greetings)\b/i,
  /\b(user|they)\s+(just\s+)?(checked in|said thanks|said goodbye|asked how you are)\b/i,
]

const LOW_VALUE_RECENT_EVENT_EXACT_VALUES = new Set([
  "hi",
  "hello",
  "hey",
  "good morning",
  "good afternoon",
  "good evening",
  "good night",
  "thanks",
  "thank you",
  "thx",
  "nice to meet you",
  "how are you",
  "user said hi",
  "user said hello",
  "user said hey",
  "user said thanks",
  "user said thank you",
])

export function getIntelligentSessionMemoryKey(sessionId?: string | null) {
  if (!sessionId) {
    return "session-unknown"
  }

  let hash = 2166136261

  for (let index = 0; index < sessionId.length; index += 1) {
    hash ^= sessionId.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }

  return `session-${(hash >>> 0).toString(16).padStart(8, "0")}`
}

export function normalizeIntelligentMemoryKey(value: unknown) {
  if (typeof value !== "string") {
    return ""
  }

  return value.replace(/\s+/g, " ").trim()
}

export function normalizeIntelligentMemoryValue(
  value: unknown,
  maxLength = GLOBAL_MEMORY_VALUE_CHAR_LIMIT
) {
  if (typeof value !== "string") {
    return ""
  }

  const compact = value.replace(/\s+/g, " ").trim()
  if (!compact) {
    return ""
  }

  return compact.length > maxLength ? `${compact.slice(0, maxLength)}...` : compact
}

function normalizeMemoryComparisonText(value: string) {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\b(current|currently|latest|new|ongoing)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function tokenizeMemoryValue(value: string) {
  return normalizeMemoryComparisonText(value)
    .split(" ")
    .filter(
      (token) =>
        token.length >= 3 && !MEMORY_VALUE_STOPWORDS.has(token)
    )
}

function areMemoryValuesNearDuplicate(left: string, right: string) {
  const normalizedLeft = normalizeMemoryComparisonText(left)
  const normalizedRight = normalizeMemoryComparisonText(right)

  if (!normalizedLeft || !normalizedRight) {
    return false
  }

  if (normalizedLeft === normalizedRight) {
    return true
  }

  const leftTokens = Array.from(new Set(tokenizeMemoryValue(left)))
  const rightTokens = Array.from(new Set(tokenizeMemoryValue(right)))

  if (leftTokens.length < 3 || rightTokens.length < 3) {
    return false
  }

  const rightTokenSet = new Set(rightTokens)
  const sharedCount = leftTokens.filter((token) => rightTokenSet.has(token)).length

  const leftCoverage = sharedCount / leftTokens.length
  const rightCoverage = sharedCount / rightTokens.length

  return leftCoverage >= 0.8 && rightCoverage >= 0.8
}

function isLowValueRecentEvent(value: string) {
  const compact = value.replace(/\s+/g, " ").trim()
  if (!compact) {
    return true
  }

  const normalized = compact.toLowerCase()

  if (
    LOW_VALUE_RECENT_EVENT_PATTERNS.some((pattern) => pattern.test(compact))
  ) {
    return true
  }

  if (LOW_VALUE_RECENT_EVENT_EXACT_VALUES.has(normalized)) {
    return true
  }

  return (
    (/\b(user|they)\s+(just\s+)?(said|mentioned|told me|asked)\b/i.test(compact) &&
      /\b(at\s+\d{1,2}(?::\d{2})?|\d{1,2}:\d{2}|today|tonight|this morning|this afternoon|this evening|just now)\b/i.test(
        compact
      ))
  )
}

export function dedupeIntelligentMemoryEntries(
  entries: IntelligentGlobalMemoryEntry[],
  category?: IntelligentGlobalMemoryCategory
) {
  const dedupedByKey = new Map<string, IntelligentGlobalMemoryEntry>()
  const dedupedByMeaning: IntelligentGlobalMemoryEntry[] = []

  for (const entry of [...entries].sort((left, right) => right.updatedAt - left.updatedAt)) {
    if (!entry.key || !entry.value) {
      continue
    }

    if (category === "recentEvents" && isLowValueRecentEvent(entry.value)) {
      continue
    }

    const normalizedKey = entry.key.toLowerCase()
    if (dedupedByKey.has(normalizedKey)) {
      continue
    }

    if (
      dedupedByMeaning.some((existing) =>
        areMemoryValuesNearDuplicate(existing.value, entry.value)
      )
    ) {
      continue
    }

    dedupedByKey.set(normalizedKey, entry)
    dedupedByMeaning.push(entry)
  }

  return dedupedByMeaning.slice(0, GLOBAL_MEMORY_ENTRY_LIMIT)
}
