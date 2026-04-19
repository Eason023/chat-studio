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
  | {
      type: "image"
      attachmentId: string
      url?: string
      mimeType?: string
      name?: string
    }
  | {
      type: "pdf-image"
      attachmentId: string
      page: number
      url?: string
      name?: string
    }
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
      blob: Blob
      previewUrl: string
      name: string
      mimeType?: string
    }
  | {
      id: string
      type: "pdf-image"
      blob: Blob
      previewUrl: string
      page: number
      name: string
    }

export type AttachmentRecord =
  | {
      id: string
      type: "image"
      blob: Blob
      name: string
      mimeType?: string
    }
  | {
      id: string
      type: "pdf-image"
      blob: Blob
      page: number
      name: string
    }

export type IntelligentAttachmentPart = Extract<
  MessagePart,
  { type: "image" | "pdf-image" }
>

export type IntelligentModelSlots = {
  contextual?: number
  stateless?: number
}

export type IntelligentModeSummary = {
  id: string
  label: string
  majorModel: string
  models: Array<{
    id: string
    weight: number
    hasSlots: boolean
    slots?: IntelligentModelSlots
  }>
}

export type IntelligentModesResponse = {
  enabled: boolean
  defaultModeId: string | null
  configFile: string | null
  mcpServerConfigured: boolean
  backend: {
    hasOpenAiCompatibleBaseUrl: boolean
    hasLlamaServerBaseUrl: boolean
    isLlamaServerBackend: boolean
    canUseNativeSlotControl: boolean
  }
  modes: IntelligentModeSummary[]
}

export type IntelligentChatHistoryMessage = {
  role: "user" | "assistant"
  content: MessagePart[]
}

export type IntelligentConversationMessageStatus =
  | "streaming"
  | "completed"
  | "error"
  | "stopped"

export type IntelligentReasoningMode = "instant" | "think"

export type IntelligentPhaseMetrics = {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  ppTps?: number
  tgTps?: number
  cacheTokens?: number
  cacheHitRate?: number
}

export type IntelligentTracePhase = {
  id: string
  label: string
  status: IntelligentPhaseStatus
  summary?: string
  detail?: string
  modelId?: string
  lane?: "contextual" | "stateless"
  reasoningMode?: IntelligentReasoningMode
  metrics?: IntelligentPhaseMetrics
  startedAt: number
  updatedAt: number
}

export type IntelligentMessageProcess = {
  route: string | null
  activeModel: string | null
  phases: IntelligentTracePhase[]
  startedAt: number
  updatedAt: number
}

export type IntelligentConversationMessage = {
  id: string
  role: "user" | "assistant"
  content: string
  attachments?: IntelligentAttachmentPart[]
  createdAt: number
  status: IntelligentConversationMessageStatus
  process?: IntelligentMessageProcess
}

export type IntelligentConversation = {
  id: string
  modeId: string
  title: string
  createdAt: number
  updatedAt: number
  sessionSummary?: string
  sessionSummaryUpdatedAt?: number
  messages: IntelligentConversationMessage[]
}

export type IntelligentGlobalMemoryEntry = {
  id: string
  key: string
  value: string
  updatedAt: number
}

export type IntelligentGlobalMemoryCategory =
  | "userFeatures"
  | "instructionMemory"
  | "recentEvents"

export type IntelligentGlobalMemory = {
  userFeatures: IntelligentGlobalMemoryEntry[]
  instructionMemory: IntelligentGlobalMemoryEntry[]
  recentEvents: IntelligentGlobalMemoryEntry[]
  updatedAt: number
}

export type IntelligentChatRequest = {
  modeId: string
  conversationId?: string
  message: string
  sessionSummary?: string
  globalMemory?: IntelligentGlobalMemory
  history: IntelligentChatHistoryMessage[]
}

export type IntelligentPhaseStatus = "active" | "completed" | "error"

export type IntelligentChatStreamEvent =
  | {
      type: "phase"
      phase: {
        id: string
        label: string
        status: IntelligentPhaseStatus
        summary?: string
        detail?: string
        modelId?: string
        lane?: "contextual" | "stateless"
        reasoningMode?: IntelligentReasoningMode
        metrics?: IntelligentPhaseMetrics
      }
    }
  | {
      type: "token"
      text: string
    }
  | {
      type: "meta"
      meta: {
        modeId: string
        model: string
        route: string
      }
    }
  | {
      type: "done"
    }
  | {
      type: "error"
      error: string
    }
  | {
      type: "session_summary"
      summary: {
        text: string
        updatedAt: number
      }
    }
  | {
      type: "global_memory"
      memory: IntelligentGlobalMemory
    }
