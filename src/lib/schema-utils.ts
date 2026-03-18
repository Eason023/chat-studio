import type { ChatMessage, JsonSchemaDraft } from "@/lib/types"
import { buildJsonSchema } from "@/lib/provider"
import { makeId } from "@/lib/utils"

export function createEmptySchemaDraft(): JsonSchemaDraft {
  return {
    title: "ResponseSchema",
    fields: [],
  }
}

export function ensureSchemaDraft(
  draft?: JsonSchemaDraft
): JsonSchemaDraft {
  return draft ?? createEmptySchemaDraft()
}

export function createEmptySchemaField() {
  return {
    id: makeId(),
    name: "",
    type: "string" as const,
    required: false,
    description: "",
    enumValues: [],
  }
}

export function getSchemaPreview(draft?: JsonSchemaDraft) {
  return buildJsonSchema(ensureSchemaDraft(draft))
}

function stripJsonCodeFence(text: string) {
  const trimmed = text.trim()

  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (fenced) {
    return fenced[1].trim()
  }

  return trimmed
}

export function tryParseStructuredText(text: string): unknown | null {
  const cleaned = stripJsonCodeFence(text)
  if (!cleaned) return null

  try {
    return JSON.parse(cleaned)
  } catch {
    return null
  }
}

export function getMessagePlainText(message: ChatMessage) {
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
}
