import type { ChatMessage, JsonSchemaDraft, MessagePart } from "@/lib/types"

type ProviderContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }

type ProviderMessage = {
  role: "system" | "user" | "assistant"
  content: string | ProviderContentPart[]
}

function partToProviderPart(part: MessagePart): ProviderContentPart | null {
  if (part.type === "text") {
    return {
      type: "text",
      text: part.text,
    }
  }

  if (part.type === "image") {
    return {
      type: "image_url",
      image_url: {
        url: part.url,
      },
    }
  }

  if (part.type === "pdf-image") {
    return {
      type: "image_url",
      image_url: {
        url: part.url,
      },
    }
  }

  if (part.type === "json-preview") {
    return {
      type: "text",
      text: JSON.stringify(part.value, null, 2),
    }
  }

  return null
}

function partsToProviderContent(parts: MessagePart[]) {
  const mapped = parts.map(partToProviderPart).filter(Boolean) as ProviderContentPart[]

  const textOnly = mapped.every((part) => part.type === "text")

  if (textOnly) {
    return mapped.map((part) => part.text).join("\n\n")
  }

  return mapped
}

export function buildProviderMessages(
  systemPrompt: string,
  messages: ChatMessage[]
): ProviderMessage[] {
  const result: ProviderMessage[] = []

  if (systemPrompt.trim()) {
    result.push({
      role: "system",
      content: systemPrompt.trim(),
    })
  }

  for (const message of messages) {
    if (message.role === "system" || message.role === "user" || message.role === "assistant") {
      result.push({
        role: message.role,
        content: partsToProviderContent(message.content),
      })
    }
  }

  return result
}

export function buildJsonSchema(draft?: JsonSchemaDraft) {
  if (!draft || !draft.fields.length) return null

  const properties: Record<string, unknown> = {}
  const required: string[] = []

  for (const field of draft.fields) {
    if (!field.name.trim()) continue

    const schema: Record<string, unknown> = {
      type: field.type,
    }

    if (field.description?.trim()) {
      schema.description = field.description.trim()
    }

    if (field.enumValues?.length) {
      schema.enum = field.enumValues.filter(Boolean)
    }

    if (field.type === "array") {
      schema.items = { type: "string" }
    }

    if (field.type === "object") {
      schema.additionalProperties = true
    }

    properties[field.name.trim()] = schema

    if (field.required) {
      required.push(field.name.trim())
    }
  }

  return {
    name: draft.title?.trim() || "response_schema",
    schema: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
    strict: true,
  }
}
