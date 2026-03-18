export type ThinkMode = "instant" | "think"
export type OutputMode = "normal" | "json"
export type CompareMode = 1 | 2 | 3

export type JsonSchemaField = {
  id: string
  name: string
  type: "string" | "number" | "boolean" | "array" | "object"
  required: boolean
  description?: string
  enumValues?: string[]
}

export type JsonSchemaDraft = {
  title?: string
  fields: JsonSchemaField[]
}

export type ChatSettingsSnapshot = {
  model: string
  systemPrompt: string
  temperature: number
  thinkMode: ThinkMode
  compareMode: CompareMode
  outputMode: OutputMode
  jsonSchema?: JsonSchemaDraft
}

export type MessagePart =
  | { type: "text"; text: string }
  | { type: "image"; url: string; mimeType?: string }
  | { type: "pdf-image"; url: string; page: number }
  | { type: "json-preview"; value: unknown }

export type MessageMeta = {
  model?: string
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  ppTps?: number
  tgTps?: number
  compareSlot?: 1 | 2 | 3
  finishReason?: string
}

export type ChatMessage = {
  id: string
  role: "user" | "assistant" | "system"
  content: MessagePart[]
  createdAt: number
  meta?: MessageMeta
  parentUserMessageId?: string
  reasoning?: string
}

export type Conversation = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  settings: ChatSettingsSnapshot
  messages: ChatMessage[]
}

export type AttachmentPreview =
  | {
      id: string
      type: "image"
      url: string
      name: string
      mimeType?: string
    }
  | {
      id: string
      type: "pdf-image"
      url: string
      page: number
      name: string
    }