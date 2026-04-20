import type {
  IntelligentGlobalMemoryCategory,
  IntelligentGlobalMemoryEntry,
} from "@/lib/types"

export const GLOBAL_MEMORY_ENTRY_LIMIT = 32
export const GLOBAL_MEMORY_VALUE_CHAR_LIMIT = 420

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

export function dedupeIntelligentMemoryEntries(
  entries: IntelligentGlobalMemoryEntry[],
  _category?: IntelligentGlobalMemoryCategory
) {
  void _category

  const dedupedByKey = new Map<string, IntelligentGlobalMemoryEntry>()

  for (const entry of [...entries].sort((left, right) => right.updatedAt - left.updatedAt)) {
    if (!entry.key || !entry.value) {
      continue
    }

    const normalizedKey = entry.key.toLowerCase()
    if (dedupedByKey.has(normalizedKey)) {
      continue
    }

    dedupedByKey.set(normalizedKey, entry)
  }

  return Array.from(dedupedByKey.values()).slice(0, GLOBAL_MEMORY_ENTRY_LIMIT)
}
