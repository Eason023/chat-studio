import { getDB } from "@/lib/db"
import {
  dedupeIntelligentMemoryEntries,
  normalizeIntelligentMemoryKey,
  normalizeIntelligentMemoryValue,
} from "@/lib/intelligent-memory"
import type {
  IntelligentGlobalMemory,
  IntelligentGlobalMemoryCategory,
  IntelligentGlobalMemoryEntry,
} from "@/lib/types"
import { makeId } from "@/lib/utils"

const GLOBAL_MEMORY_META_KEY = "intelligent-global-memory"
const CATEGORY_LIMITS: Record<IntelligentGlobalMemoryCategory, number> = {
  userFeatures: 12,
  instructionMemory: 12,
  recentEvents: 10,
}

function sanitizeEntry(value: unknown): IntelligentGlobalMemoryEntry | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null
  }

  const record = value as Record<string, unknown>
  const key = normalizeIntelligentMemoryKey(record.key)
  const memoryValue = normalizeIntelligentMemoryValue(record.value)

  if (!key || !memoryValue) {
    return null
  }

  const updatedAt =
    typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt)
      ? record.updatedAt
      : Date.now()

  return {
    id:
      typeof record.id === "string" && record.id.trim()
        ? record.id.trim()
        : makeId(),
    key,
    value: memoryValue,
    updatedAt,
  }
}

function sanitizeEntries(
  value: unknown,
  category: IntelligentGlobalMemoryCategory
): IntelligentGlobalMemoryEntry[] {
  if (!Array.isArray(value)) {
    return []
  }

  return dedupeIntelligentMemoryEntries(
    value
      .map(sanitizeEntry)
      .filter((entry): entry is IntelligentGlobalMemoryEntry => Boolean(entry)),
    category
  ).slice(0, CATEGORY_LIMITS[category])
}

export function createEmptyGlobalMemory(): IntelligentGlobalMemory {
  return {
    userFeatures: [],
    instructionMemory: [],
    recentEvents: [],
    updatedAt: Date.now(),
  }
}

export function sanitizeGlobalMemory(value: unknown): IntelligentGlobalMemory {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return createEmptyGlobalMemory()
  }

  const memory = value as Record<string, unknown>

  return {
    userFeatures: sanitizeEntries(memory.userFeatures, "userFeatures"),
    instructionMemory: sanitizeEntries(
      memory.instructionMemory,
      "instructionMemory"
    ),
    recentEvents: sanitizeEntries(memory.recentEvents, "recentEvents"),
    updatedAt:
      typeof memory.updatedAt === "number" && Number.isFinite(memory.updatedAt)
        ? memory.updatedAt
        : Date.now(),
  }
}

export async function loadIntelligentGlobalMemoryFromDB(): Promise<IntelligentGlobalMemory> {
  const db = await getDB()
  const record = await db.get("meta", GLOBAL_MEMORY_META_KEY)

  return sanitizeGlobalMemory(record?.value)
}

export async function saveIntelligentGlobalMemoryToDB(
  memory: IntelligentGlobalMemory
): Promise<void> {
  const db = await getDB()
  await db.put("meta", {
    key: GLOBAL_MEMORY_META_KEY,
    value: sanitizeGlobalMemory(memory),
  })
}
