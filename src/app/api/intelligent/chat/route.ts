import {
  getIntelligentBackendCapabilities,
  getLlmApiKey,
  getMcpServerAuthToken,
  getOpenAiCompatibleBaseUrl,
  type IntelligentModeConfig,
  loadIntelligentConfig,
} from "@/lib/intelligent-config"
import {
  callMcpTool,
  invalidateMcpSession,
  listMcpTools,
  type McpTool,
} from "@/lib/mcp-client"
import {
  dedupeIntelligentMemoryEntries,
  GLOBAL_MEMORY_VALUE_CHAR_LIMIT,
  getIntelligentSessionMemoryKey,
  normalizeIntelligentMemoryKey,
  normalizeIntelligentMemoryValue,
} from "@/lib/intelligent-memory"
import { tryParseStructuredText } from "@/lib/schema-utils"
import type {
  IntelligentChatHistoryMessage,
  IntelligentChatRequest,
  IntelligentChatStreamEvent,
  IntelligentGlobalMemory,
  IntelligentGlobalMemoryCategory,
  IntelligentGlobalMemoryEntry,
  IntelligentPhaseMetrics,
  IntelligentReasoningMode,
  MessagePart,
} from "@/lib/types"

export const runtime = "nodejs"

let activeIntelligentRequest = false

type UnknownRecord = Record<string, unknown>

type ProviderRequestContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }

type ProviderToolCall = {
  id?: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

type ProviderToolDefinition = {
  type: "function"
  function: {
    name: string
    description: string
    parameters: UnknownRecord
  }
}

type ProviderToolChoice = "none" | "auto" | "required"

type ProviderMessage = {
  role: "system" | "user" | "assistant" | "tool"
  content: string | ProviderRequestContentPart[]
  tool_calls?: ProviderToolCall[]
  tool_call_id?: string
  name?: string
}

type ProviderResponseContentObject = {
  type?: unknown
  text?: unknown
}

type ProviderResponseContentPart = string | ProviderResponseContentObject

type UpstreamStreamingChoice = {
  delta?: {
    content?: unknown
    reasoning_content?: unknown
  }
}

type UpstreamUsage = {
  prompt_tokens?: unknown
  completion_tokens?: unknown
  total_tokens?: unknown
}

type UpstreamTimings = {
  prompt_n?: unknown
  prompt_per_second?: unknown
  predicted_per_second?: unknown
  cache_n?: unknown
}

type UpstreamStreamingChunk = {
  model?: unknown
  choices?: UpstreamStreamingChoice[]
  usage?: UpstreamUsage
  timings?: UpstreamTimings
}

type UpstreamCompletionResponse = {
  model?: unknown
  choices?: Array<{
    message?: {
      content?: unknown
      reasoning_content?: unknown
      reasoning?: unknown
      tool_calls?: unknown
      function_call?: unknown
    }
  }>
  usage?: UpstreamUsage
  timings?: UpstreamTimings
}

type JsonSchemaResponseFormat = {
  type: "json_schema"
  json_schema: {
    name: string
    schema: UnknownRecord
    strict: boolean
  }
}

type ProblemAnalysis = {
  difficultyScore: number
  contextDependencyScore: number
  shouldUseMultiStep: boolean
  recommendedStepCount: number
  taskType: string
  analysisSummary: string
}

type RoutingGate = {
  shouldUseInstant: boolean
  gateSummary: string
}

type PlannedStep = {
  id: string
  title: string
  objective: string
  difficultyScore: number
  contextDependencyScore: number
}

type StepExecutionResult = {
  step: PlannedStep
  modelId: string
  lane: "contextual" | "stateless"
  reasoningMode: IntelligentReasoningMode
  briefSummary: string
  summary: string
  toolUses: StepToolUseRecord[]
}

type StepToolUseRecord = {
  toolName: string
  toolArguments: Record<string, unknown>
  resultText: string
  isError: boolean
}

const ANALYSIS_TEMPERATURE = 0
const EXECUTION_TEMPERATURE = 0.2
const ANALYSIS_MAX_TOKENS = 400
const PLANNER_MAX_TOKENS = 700
const STEP_MAX_TOKENS = 4096
const STEP_SUMMARY_MAX_TOKENS = 1200
const GLOBAL_MEMORY_MAX_TOKENS = 420
const TOOL_RESULT_CONVERSATION_CHAR_LIMIT = 6000
const MULTI_STEP_THRESHOLD = 58
const HIGH_CONTEXT_THRESHOLD = 60
const MEDIUM_CONTEXT_THRESHOLD = 40
const CONTEXTUAL_HISTORY_WINDOW = 8
const MEDIUM_HISTORY_WINDOW = 4
const LOW_HISTORY_WINDOW = 2
const SESSION_CAPSULE_HISTORY_WINDOW = 6
const SESSION_CAPSULE_CHAR_LIMIT = 1400
const MAX_STEP_TOOL_CALLS = 4
const DIFFICULTY_RUBRIC = [
  "Difficulty scoring rubric:",
  "0-20: greetings, simple factual questions, trivial formatting, or direct one-shot requests.",
  "21-40: short explanations, basic summarization, lightweight follow-ups, or straightforward rewrites.",
  "41-60: moderate reasoning, multi-constraint comparisons, or requests that need some structured thought.",
  "61-80: debugging, implementation planning, non-trivial math, code changes, or tasks with several moving parts.",
  "81-100: deep architecture, proof-like reasoning, cross-step synthesis, or hard tasks where failure is costly.",
].join(" ")
const CONTEXT_RUBRIC = [
  "Context dependency scoring rubric:",
  "0-20: fully self-contained; prior turns are unnecessary.",
  "21-40: minor follow-up context helps but is not critical.",
  "41-60: several earlier details matter, but a concise recap could be enough.",
  "61-80: the answer strongly depends on prior code, constraints, or specific conversation state.",
  "81-100: the request is inseparable from prior session context and would likely fail without it.",
].join(" ")

type PhaseKind =
  | "analysis"
  | "summary"
  | "planner"
  | "instant"
  | "step"
  | "synthesis"
  | "memory"

function makeSseChunk(payload: IntelligentChatStreamEvent) {
  return `data: ${JSON.stringify(payload)}\n\n`
}

function getCurrentTimeContext(now = new Date()) {
  return `Current date and time (Asia/Taipei): ${now.toLocaleString(
    "en-US",
    {
      timeZone: "Asia/Taipei",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }
  )}`
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError"
}

function buildAuthHeaders(apiKey?: string) {
  const headers = new Headers()

  if (apiKey?.trim()) {
    headers.set("Authorization", `Bearer ${apiKey.trim()}`)
  }

  return headers
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isProviderContentObject(
  value: ProviderResponseContentPart
): value is ProviderResponseContentObject {
  return typeof value === "object" && value !== null
}

function clampScore(value: unknown, fallback: number) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.min(100, Math.round(value)))
  }

  if (typeof value === "string") {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.min(100, Math.round(parsed)))
    }
  }

  return fallback
}

function clampCount(value: unknown, fallback: number) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(1, Math.min(4, Math.round(value)))
  }

  if (typeof value === "string") {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) {
      return Math.max(1, Math.min(4, Math.round(parsed)))
    }
  }

  return fallback
}

function asString(value: unknown, fallback = "") {
  if (typeof value !== "string") return fallback
  const trimmed = value.trim()
  return trimmed || fallback
}

function asNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }

  if (typeof value === "string") {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }

  return undefined
}

function roundMetric(value: number, digits = 1) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function partToProviderContentPart(
  part: MessagePart
): ProviderRequestContentPart | null {
  if (part.type === "text") {
    return {
      type: "text",
      text: part.text,
    }
  }

  if (part.type === "image" || part.type === "pdf-image") {
    if (!part.url) {
      return null
    }

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
  const mapped = parts
    .map(partToProviderContentPart)
    .filter((part): part is ProviderRequestContentPart => Boolean(part))

  const textOnly = mapped.every((part) => part.type === "text")

  if (textOnly) {
    return mapped.map((part) => part.text).join("\n\n")
  }

  return mapped
}

function toProviderMessages(history: IntelligentChatHistoryMessage[]) {
  return history.map((item) => ({
    role: item.role,
    content: partsToProviderContent(item.content),
  }))
}

function createGlobalMemoryEntryId() {
  return `mem-${crypto.randomUUID()}`
}

function sanitizeMemoryEntries(
  value: unknown,
  previousEntries: IntelligentGlobalMemoryEntry[] = [],
  category: IntelligentGlobalMemoryCategory,
  limit: number
) {
  if (!Array.isArray(value)) {
    return previousEntries
  }

  const previousByKey = new Map(
    previousEntries.map((entry) => [entry.key.toLowerCase(), entry])
  )

  const parsedEntries = value
    .map((item) => {
      if (!isRecord(item)) {
        return null
      }

      const key = normalizeIntelligentMemoryKey(item.key)
      const memoryValue = normalizeIntelligentMemoryValue(
        item.value,
        GLOBAL_MEMORY_VALUE_CHAR_LIMIT
      )

      if (!key || !memoryValue) {
        return null
      }

      const previous = previousByKey.get(key.toLowerCase())

      return {
        id: previous?.id ?? createGlobalMemoryEntryId(),
        key,
        value: memoryValue,
        updatedAt: Date.now(),
      } satisfies IntelligentGlobalMemoryEntry
    })
    .filter((entry): entry is IntelligentGlobalMemoryEntry => Boolean(entry))

  const nextByKey = new Map(
    previousEntries.map((entry) => [entry.key.toLowerCase(), entry])
  )

  for (const entry of parsedEntries) {
    nextByKey.set(entry.key.toLowerCase(), entry)
  }

  return dedupeIntelligentMemoryEntries(
    Array.from(nextByKey.values()),
    category
  ).slice(
    0,
    limit
  )
}

function sanitizeGlobalMemory(
  value: unknown,
  previousMemory?: IntelligentGlobalMemory
): IntelligentGlobalMemory {
  const previous = previousMemory ?? {
    userFeatures: [],
    instructionMemory: [],
    recentEvents: [],
    updatedAt: Date.now(),
  }

  if (!isRecord(value)) {
    return previous
  }

  return {
    userFeatures: sanitizeMemoryEntries(
      value.userFeatures,
      previous.userFeatures,
      "userFeatures",
      12
    ),
    instructionMemory: sanitizeMemoryEntries(
      value.instructionMemory,
      previous.instructionMemory,
      "instructionMemory",
      12
    ),
    recentEvents: sanitizeMemoryEntries(
      value.recentEvents,
      previous.recentEvents,
      "recentEvents",
      10
    ),
    updatedAt: Date.now(),
  }
}

function parseGlobalMemory(
  text: string,
  previousMemory?: IntelligentGlobalMemory
): IntelligentGlobalMemory {
  const parsed = tryParseStructuredText(text)

  return sanitizeGlobalMemory(parsed, previousMemory)
}

function hasGlobalMemory(memory?: IntelligentGlobalMemory | null) {
  if (!memory) {
    return false
  }

  return (
    memory.userFeatures.length > 0 ||
    memory.instructionMemory.length > 0 ||
    memory.recentEvents.length > 0
  )
}

function formatGlobalMemoryEntries(
  title: string,
  entries: IntelligentGlobalMemoryEntry[]
) {
  if (entries.length === 0) {
    return `### ${title}\n- None`
  }

  return [
    `### ${title}`,
    ...entries.map((entry) => `- **${entry.key}**: ${entry.value}`),
  ].join("\n")
}

function formatGlobalMemoryDetail(memory?: IntelligentGlobalMemory | null) {
  if (!hasGlobalMemory(memory)) {
    return "Global memory updated. No durable entries are currently stored."
  }

  return [
    formatGlobalMemoryEntries("User Features", memory?.userFeatures ?? []),
    formatGlobalMemoryEntries(
      "Instruction Memory",
      memory?.instructionMemory ?? []
    ),
    formatGlobalMemoryEntries("Recent Events", memory?.recentEvents ?? []),
  ].join("\n\n")
}

function buildGlobalMemoryContext(
  memory?: IntelligentGlobalMemory | null,
  currentSessionKey?: string
) {
  if (!hasGlobalMemory(memory)) {
    return ""
  }

  const filteredUserFeatures = (memory?.userFeatures ?? []).filter(
    (entry) => entry.key !== currentSessionKey
  )
  const filteredInstructionMemory = (memory?.instructionMemory ?? []).filter(
    (entry) => entry.key !== currentSessionKey
  )
  const filteredRecentEvents = (memory?.recentEvents ?? []).filter(
    (entry) => entry.key !== currentSessionKey
  )

  if (
    filteredUserFeatures.length === 0 &&
    filteredInstructionMemory.length === 0 &&
    filteredRecentEvents.length === 0
  ) {
    return ""
  }

  const lines = [
    "Cross-session memory bank.",
    "Each memory tier uses session-keyed entries. The current session key is excluded from this prefix because its details already live in the active session context.",
    "",
    "User Features:",
    ...(filteredUserFeatures.length
      ? filteredUserFeatures.map((entry) => `- ${entry.key}: ${entry.value}`)
      : ["- none"]),
    "",
    "Instruction Memory:",
    ...(filteredInstructionMemory.length
      ? filteredInstructionMemory.map((entry) => `- ${entry.key}: ${entry.value}`)
      : ["- none"]),
    "",
    "Recent Events:",
    ...(filteredRecentEvents.length
      ? filteredRecentEvents.map((entry) => `- ${entry.key}: ${entry.value}`)
      : ["- none"]),
  ]

  return lines.join("\n")
}

function buildLeadingSystemMessage(args: {
  base: string
  globalMemory?: IntelligentGlobalMemory | null
  currentSessionKey?: string
  tools?: McpTool[]
}): ProviderMessage {
  const sections = [
    args.base.trim(),
    buildGlobalMemoryContext(args.globalMemory, args.currentSessionKey),
    args.tools?.length
      ? `Available MCP tools:\n${formatMcpToolsForPrompt(args.tools)}`
      : "",
  ].filter((section) => section && section.trim().length > 0)

  return {
    role: "system",
    content: sections.join("\n\n"),
  }
}

function summarizeMessagePart(part: MessagePart) {
  if (part.type === "text") {
    return part.text.trim()
  }

  if (part.type === "image") {
    return `[Image: ${part.name ?? "uploaded image"}]`
  }

  if (part.type === "pdf-image") {
    return `[PDF page ${part.page}: ${part.name ?? "uploaded pdf"}]`
  }

  return "[Structured JSON preview]"
}

function formatMessagePartsForPrompt(parts: MessagePart[]) {
  const blocks = parts.map(summarizeMessagePart).filter(Boolean)
  return blocks.length > 0 ? blocks.join("\n\n") : "(empty)"
}

function buildFallbackTurnSessionSummary(
  history: IntelligentChatHistoryMessage[],
  latestUserSummary: string
) {
  const recentHistory = sliceHistoryTail(history, SESSION_CAPSULE_HISTORY_WINDOW)
  const lines = recentHistory
    .map((message) => {
      const content = message.content
        .map(summarizeMessagePart)
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()

      if (!content) {
        return ""
      }

      return `${message.role === "user" ? "User" : "Assistant"}: ${content}`
    })
    .filter(Boolean)

  const capsule = [
    `Current problem: ${latestUserSummary}`,
    lines.length > 0 ? "Relevant recent context:" : "",
    ...lines,
  ]
    .filter(Boolean)
    .join("\n")

  if (!capsule) {
    return ""
  }

  return capsule.length > SESSION_CAPSULE_CHAR_LIMIT
    ? `${capsule.slice(0, SESSION_CAPSULE_CHAR_LIMIT)}...`
    : capsule
}

function normalizeTurnSessionSummaryText(
  summaryText: string,
  latestUserSummary: string
) {
  const compact = summaryText.replace(/\s+/g, " ").trim()

  if (!compact) {
    return buildFallbackTurnSessionSummary([], latestUserSummary)
  }

  return compact.length > SESSION_CAPSULE_CHAR_LIMIT
    ? `${compact.slice(0, SESSION_CAPSULE_CHAR_LIMIT)}...`
    : compact
}

function buildJsonSchemaResponseFormat(
  name: string,
  schema: UnknownRecord
): JsonSchemaResponseFormat {
  return {
    type: "json_schema",
    json_schema: {
      name,
      schema,
      strict: true,
    },
  }
}

function buildRoutingGateResponseFormat() {
  return buildJsonSchemaResponseFormat("routing_gate", {
    type: "object",
    description:
      "Very lightweight direct-answer gate for the latest user request in Intelligent Mode.",
    properties: {
      shouldUseInstant: {
        type: "boolean",
        description:
          "True only when the assistant can answer immediately without a multi-step plan.",
      },
      gateSummary: {
        type: "string",
        description:
          "A concise restatement of the user's request and whether direct answer is enough. Keep it to one to three short sentences only.",
      },
    },
    required: ["shouldUseInstant", "gateSummary"],
    additionalProperties: false,
  })
}

function buildAnalysisResponseFormat() {
  return buildJsonSchemaResponseFormat("intelligent_analysis", {
    type: "object",
    description:
      "Detailed problem analysis for a request that has already been routed to the multi-step path.",
    properties: {
      difficultyScore: {
        type: "number",
        description:
          "Overall task difficulty from 0 to 100 based on the provided difficulty rubric.",
      },
      contextDependencyScore: {
        type: "number",
        description:
          "How strongly the request depends on prior session context from 0 to 100 based on the provided context rubric.",
      },
      shouldUseMultiStep: {
        type: "boolean",
        description:
          "True only when a multi-step plan would materially improve answer quality over an instant answer.",
      },
      recommendedStepCount: {
        type: "number",
        description:
          "Recommended number of plan steps from 1 to 4. Keep it small unless decomposition clearly helps.",
      },
      taskType: {
        type: "string",
        description:
          "Short task label such as general, coding, analysis, math, writing, or research.",
      },
      analysisSummary: {
        type: "string",
        description:
          "Compact explanation of what the user is asking and why the chosen route makes sense.",
      },
    },
    required: [
      "difficultyScore",
      "contextDependencyScore",
      "shouldUseMultiStep",
      "recommendedStepCount",
      "taskType",
      "analysisSummary",
    ],
    additionalProperties: false,
  })
}

function buildPlannerResponseFormat() {
  return buildJsonSchemaResponseFormat("step_plan", {
    type: "object",
    description:
      "Minimal useful execution plan for a routed multi-step request.",
    properties: {
      steps: {
        type: "array",
        description:
          "Ordered plan steps. Keep the count minimal and do not create unnecessary steps.",
        items: {
          type: "object",
          description: "One planned step in execution order.",
          properties: {
            id: {
              type: "string",
              description:
                "Stable step identifier such as step-1, step-2, or step-3.",
            },
            title: {
              type: "string",
              description: "Short user-readable step title.",
            },
            objective: {
              type: "string",
              description:
                "What this step must accomplish so later steps can continue.",
            },
            difficultyScore: {
              type: "number",
              description:
                "Step difficulty from 0 to 100 for model and reasoning routing.",
            },
            contextDependencyScore: {
              type: "number",
              description:
                "How much this step depends on prior session context from 0 to 100.",
            },
          },
          required: [
            "id",
            "title",
            "objective",
            "difficultyScore",
            "contextDependencyScore",
          ],
          additionalProperties: false,
        },
      },
    },
    required: ["steps"],
    additionalProperties: false,
  })
}

function buildGlobalMemoryResponseFormat() {
  const memoryEntrySchema = (description: string) => ({
    type: "object",
    description,
    properties: {
      key: {
        type: "string",
        description:
          "Session hash key for this memory entry.",
      },
      value: {
        type: "string",
        description:
          "Concise memory snapshot for that session within this memory tier.",
      },
    },
    required: ["key", "value"],
    additionalProperties: false,
  })

  return buildJsonSchemaResponseFormat("global_memory", {
    type: "object",
    description:
      "Three-tier cross-session memory bank. Each tier contains session-keyed entries.",
    properties: {
      userFeatures: {
        type: "array",
        description:
          "Only unusually important, stable user facts or enduring preferences the user clearly cares about, represented as session-keyed entries. Do not restate facts that are already captured elsewhere in this same tier.",
        items: memoryEntrySchema(
          "One user-features entry keyed by the session hash that established it."
        ),
      },
      instructionMemory: {
        type: "array",
        description:
          "Only durable response instructions or preferences the user strongly values and would likely want preserved across sessions, represented as session-keyed entries. Do not create near-duplicate paraphrases of existing entries.",
        items: memoryEntrySchema(
          "One instruction-memory entry keyed by the session hash that established it."
        ),
      },
      recentEvents: {
        type: "array",
        description:
          "Ongoing work, active deliverables, blockers, or temporary priorities, represented as session-keyed entries. Keep this freshest and shortest. Never store greetings, timestamps, pleasantries, or trivial turn-by-turn chatter.",
        items: memoryEntrySchema(
          "One recent-events entry keyed by the session hash that established it."
        ),
      },
    },
    required: ["userFeatures", "instructionMemory", "recentEvents"],
    additionalProperties: false,
  })
}

function summarizeSchemaForPrompt(value: unknown, maxLength = 500) {
  try {
    const text = JSON.stringify(value, null, 2)
    if (!text) {
      return "{}"
    }

    return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text
  } catch {
    return "{}"
  }
}

function formatMcpToolsForPrompt(tools: McpTool[]) {
  if (tools.length === 0) {
    return "No MCP tools are available for this request."
  }

  return tools
    .map((tool, index) =>
      [
        `${index + 1}. ${tool.name}`,
        `Description: ${tool.description}`,
        `Input schema: ${summarizeSchemaForPrompt(tool.inputSchema ?? {})}`,
      ].join("\n")
    )
    .join("\n\n")
}

function buildProviderTools(tools: McpTool[]): ProviderToolDefinition[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description || "No tool description provided.",
      parameters: isRecord(tool.inputSchema) ? tool.inputSchema : { type: "object" },
    },
  }))
}

function normalizeProviderToolCall(value: unknown): ProviderToolCall | null {
  if (!isRecord(value)) {
    return null
  }

  const functionRecord = isRecord(value.function) ? value.function : value
  const name = asString(functionRecord.name)
  if (!name) {
    return null
  }

  const rawArguments = functionRecord.arguments
  let serializedArguments = ""

  if (typeof rawArguments === "string") {
    serializedArguments = rawArguments
  } else if (typeof rawArguments !== "undefined") {
    try {
      serializedArguments = JSON.stringify(rawArguments)
    } catch {
      serializedArguments = ""
    }
  }

  return {
    id: asString(value.id) || undefined,
    type: "function",
    function: {
      name,
      arguments: serializedArguments,
    },
  }
}

function extractCompletionToolCalls(
  message:
    | {
        tool_calls?: unknown
        function_call?: unknown
      }
    | undefined
) {
  if (!message) {
    return []
  }

  const normalized: ProviderToolCall[] = []

  if (Array.isArray(message.tool_calls)) {
    for (const item of message.tool_calls) {
      const nextCall = normalizeProviderToolCall(item)
      if (nextCall) {
        normalized.push(nextCall)
      }
    }
  }

  if (normalized.length > 0) {
    return normalized
  }

  const singleFunctionCall = normalizeProviderToolCall(message.function_call)
  return singleFunctionCall ? [singleFunctionCall] : []
}

function parseToolArgumentsText(argumentsText: string) {
  if (!argumentsText.trim()) {
    return {}
  }

  try {
    const parsed = JSON.parse(argumentsText) as unknown
    return isRecord(parsed) ? parsed : {}
  } catch {
    return null
  }
}

function summarizeToolArgumentsForStatus(
  toolArguments?: Record<string, unknown>,
  maxLength = 140
) {
  if (!toolArguments || Object.keys(toolArguments).length === 0) {
    return ""
  }

  try {
    const text = JSON.stringify(toolArguments)
    if (!text) {
      return ""
    }

    return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text
  } catch {
    return ""
  }
}

function buildToolCallStatus(
  toolName: string,
  toolArguments?: Record<string, unknown>
) {
  const argumentSummary = summarizeToolArgumentsForStatus(toolArguments)

  if (argumentSummary) {
    return `Calling MCP tool "${toolName}" to gather grounded evidence. Args: ${argumentSummary}`
  }

  return `Calling MCP tool "${toolName}" to gather grounded evidence.`
}

function buildToolResultStatus(toolName: string, isError: boolean) {
  return isError
    ? `MCP tool "${toolName}" returned an error. Adjusting the step with the failure details.`
    : `MCP tool "${toolName}" returned data. Folding the result into the current step.`
}

function formatToolUsesForPhaseDetail(toolUses: StepToolUseRecord[]) {
  if (toolUses.length === 0) {
    return ""
  }

  return [
    "MCP tool usage:",
    ...toolUses.map((item, index) => {
      const argumentSummary = summarizeToolArgumentsForStatus(
        item.toolArguments,
        180
      )

      return `${index + 1}. ${item.toolName} (${item.isError ? "error" : "success"})${
        argumentSummary ? ` - ${argumentSummary}` : ""
      }`
    }),
  ].join("\n")
}

function summarizeToolUsesForPhaseSummary(toolUses: StepToolUseRecord[]) {
  if (toolUses.length === 0) {
    return ""
  }

  if (toolUses.length === 1) {
    return `Used MCP tool ${toolUses[0]?.toolName ?? "tool"}.`
  }

  return `Used ${toolUses.length} MCP tools.`
}

function mergePhaseMetrics(
  metricsList: Array<IntelligentPhaseMetrics | undefined>
): IntelligentPhaseMetrics | undefined {
  const metrics = metricsList.filter(
    (item): item is IntelligentPhaseMetrics => Boolean(item)
  )

  if (metrics.length === 0) {
    return undefined
  }

  const sum = (values: Array<number | undefined>) =>
    values.reduce<number | undefined>((total, value) => {
      if (typeof value !== "number") {
        return total
      }

      return (total ?? 0) + value
    }, undefined)

  const average = (values: Array<number | undefined>) => {
    const numeric = values.filter((value): value is number => typeof value === "number")
    if (numeric.length === 0) {
      return undefined
    }

    return roundMetric(
      numeric.reduce((total, value) => total + value, 0) / numeric.length
    )
  }

  return {
    promptTokens: sum(metrics.map((item) => item.promptTokens)),
    completionTokens: sum(metrics.map((item) => item.completionTokens)),
    totalTokens: sum(metrics.map((item) => item.totalTokens)),
    cacheTokens: sum(metrics.map((item) => item.cacheTokens)),
    cacheHitRate: average(metrics.map((item) => item.cacheHitRate)),
    ppTps: average(metrics.map((item) => item.ppTps)),
    tgTps: average(metrics.map((item) => item.tgTps)),
  }
}

function trimPersistedSessionSummary(summary?: string | null) {
  if (!summary) {
    return ""
  }

  const compact = summary.replace(/\s+/g, " ").trim()

  if (!compact) {
    return ""
  }

  return compact.length > SESSION_CAPSULE_CHAR_LIMIT
    ? `${compact.slice(0, SESSION_CAPSULE_CHAR_LIMIT)}...`
    : compact
}

function buildPhaseMetrics(args: {
  usage?: UpstreamUsage
  timings?: UpstreamTimings
}): IntelligentPhaseMetrics | undefined {
  const promptProcessedTokens = asNumber(args.timings?.prompt_n)
  const promptTokens = asNumber(args.usage?.prompt_tokens)
  const completionTokens = asNumber(args.usage?.completion_tokens)
  const totalTokens = asNumber(args.usage?.total_tokens)
  const ppTps = asNumber(args.timings?.prompt_per_second)
  const tgTps = asNumber(args.timings?.predicted_per_second)
  const cacheTokens = asNumber(args.timings?.cache_n)

  if (
    typeof promptTokens !== "number" &&
    typeof completionTokens !== "number" &&
    typeof totalTokens !== "number" &&
    typeof ppTps !== "number" &&
    typeof tgTps !== "number" &&
    typeof cacheTokens !== "number"
  ) {
    return undefined
  }

  return {
    promptTokens:
      typeof promptTokens === "number" ? Math.round(promptTokens) : undefined,
    completionTokens:
      typeof completionTokens === "number"
        ? Math.round(completionTokens)
        : undefined,
    totalTokens:
      typeof totalTokens === "number" ? Math.round(totalTokens) : undefined,
    ppTps: typeof ppTps === "number" ? roundMetric(ppTps) : undefined,
    tgTps: typeof tgTps === "number" ? roundMetric(tgTps) : undefined,
    cacheTokens:
      typeof cacheTokens === "number" ? Math.round(cacheTokens) : undefined,
    cacheHitRate:
      typeof cacheTokens === "number"
        ? typeof promptProcessedTokens === "number" &&
          promptProcessedTokens + cacheTokens > 0
          ? roundMetric(
              (cacheTokens / (promptProcessedTokens + cacheTokens)) * 100
            )
          : typeof promptTokens === "number" && promptTokens > 0
            ? roundMetric((cacheTokens / promptTokens) * 100)
            : undefined
        : undefined,
  }
}

function sliceHistoryTail(
  history: IntelligentChatHistoryMessage[],
  maxMessages: number
) {
  if (history.length <= maxMessages) {
    return history
  }

  return history.slice(history.length - maxMessages)
}

function getHistoryWindowForDependency(contextDependencyScore: number) {
  if (contextDependencyScore >= HIGH_CONTEXT_THRESHOLD) {
    return CONTEXTUAL_HISTORY_WINDOW
  }

  if (contextDependencyScore >= MEDIUM_CONTEXT_THRESHOLD) {
    return MEDIUM_HISTORY_WINDOW
  }

  return LOW_HISTORY_WINDOW
}

function buildRoutingGateMessages(args: {
  mode: IntelligentModeConfig
  history: IntelligentChatHistoryMessage[]
  globalMemory?: IntelligentGlobalMemory
  tools?: McpTool[]
  currentSessionKey?: string
  timeContext?: string
}) {
  return [
    buildLeadingSystemMessage({
      base: createContextualLaneSystemPrompt(args.mode),
      globalMemory: args.globalMemory,
      currentSessionKey: args.currentSessionKey,
      tools: args.tools,
    }),
    ...toProviderMessages(args.history),
    {
      role: "user" as const,
      content: [
        createRoutingGateSystemPrompt(),
        args.timeContext ?? getCurrentTimeContext(),
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
  ]
}

function buildAnalysisMessages(args: {
  mode: IntelligentModeConfig
  history: IntelligentChatHistoryMessage[]
  globalMemory?: IntelligentGlobalMemory
  tools?: McpTool[]
  currentSessionKey?: string
  timeContext?: string
}) {
  return [
    buildLeadingSystemMessage({
      base: createContextualLaneSystemPrompt(args.mode),
      globalMemory: args.globalMemory,
      currentSessionKey: args.currentSessionKey,
      tools: args.tools,
    }),
    ...toProviderMessages(args.history),
    {
      role: "user" as const,
      content: [
        createAnalysisSystemPrompt(),
        args.timeContext ?? getCurrentTimeContext(),
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
  ]
}

function buildPlannerMessages(args: {
  mode: IntelligentModeConfig
  history: IntelligentChatHistoryMessage[]
  analysis: ProblemAnalysis
  latestUserSummary: string
  globalMemory?: IntelligentGlobalMemory
  tools?: McpTool[]
  currentSessionKey?: string
  timeContext?: string
}) {
  return [
    buildLeadingSystemMessage({
      base: createContextualLaneSystemPrompt(args.mode),
      globalMemory: args.globalMemory,
      currentSessionKey: args.currentSessionKey,
      tools: args.tools,
    }),
    ...toProviderMessages(args.history),
    {
      role: "user" as const,
      content: [
        createPlannerSystemPrompt(args.analysis),
        args.timeContext ?? getCurrentTimeContext(),
        `Latest user request: ${args.latestUserSummary}`,
      ].join("\n\n"),
    },
  ]
}

function buildNextTurnSessionSummaryMessages(args: {
  mode: IntelligentModeConfig
  history: IntelligentChatHistoryMessage[]
  analysis: ProblemAnalysis
  latestUserSummary: string
  finalAnswer: string
  stepResults: StepExecutionResult[]
  globalMemory?: IntelligentGlobalMemory
  currentSessionKey?: string
}) {
  return [
    buildLeadingSystemMessage({
      base: createContextualLaneSystemPrompt(args.mode),
      globalMemory: args.globalMemory,
      currentSessionKey: args.currentSessionKey,
    }),
    ...toProviderMessages(args.history),
    {
      role: "user" as const,
      content: [
        createNextTurnSessionSummarySystemPrompt(args.analysis),
        `Latest user request: ${args.latestUserSummary}`,
        `Final assistant answer:\n${args.finalAnswer.trim() || "No visible answer text."}`,
        args.stepResults.length > 0
          ? `Step summaries:\n${args.stepResults
              .map(
                (result, index) =>
                  `${index + 1}. ${result.step.title}\n${result.summary}`
              )
              .join("\n\n")}`
          : "Step summaries: instant route; no intermediate steps.",
      ].join("\n\n"),
    },
  ]
}

function createRoutingGateSystemPrompt() {
  return [
    "Current orchestration phase: direct-answer gate.",
    "Decide whether the latest user request can be answered immediately or should go to the multi-step path.",
    "Keep the judgment lightweight.",
    "Return JSON only. Do not use markdown fences.",
    'Required JSON shape: {"shouldUseInstant":boolean,"gateSummary":"string"}',
    "Prefer instant only for clearly direct, self-contained, low-risk requests.",
    "If the request would benefit from decomposition, careful reasoning, verification, or tool use, choose multi-step by setting shouldUseInstant to false.",
    "gateSummary must be only one to three short sentences.",
    "gateSummary should briefly restate the user's intent and whether direct answer is enough.",
  ].join(" ")
}

function createAnalysisSystemPrompt() {
  return [
    "Current orchestration phase: detailed multi-step analysis.",
    "The request has already been routed away from instant response.",
    "Analyze the task in more depth so planning and model routing can be accurate.",
    DIFFICULTY_RUBRIC,
    CONTEXT_RUBRIC,
    "Return JSON only. Do not use markdown fences.",
    'Required JSON shape: {"difficultyScore":0-100,"contextDependencyScore":0-100,"shouldUseMultiStep":boolean,"recommendedStepCount":1-4,"taskType":"string","analysisSummary":"string"}',
    "Use higher contextDependencyScore when the answer depends on earlier conversation details.",
    "Use recommendedStepCount to reflect the smallest useful decomposition.",
  ].join(" ")
}

function createContextualLaneSystemPrompt(mode: IntelligentModeConfig) {
  return [
    `You are the major contextual lane for Chat Studio Intelligent Mode "${mode.label}".`,
    `The current major model is "${mode.majorModel}".`,
    "This lane is reserved for phases that depend on prior session context and should preserve a stable prompt prefix.",
    "Treat the conversation history as the authoritative session state.",
    "Before answering factual, current, external-state, or verification-sensitive questions, first strongly consider using available tools to ground the answer.",
    "When MCP tools are available and can materially improve factual reliability, verification, or external grounding, prefer tool-assisted work over unsupported recall.",
    "If native tools are present in the API request, invoke them through native tool calling instead of narrating pretend tool usage in plain text.",
    "Follow the final user message for the current orchestration phase.",
    "Do not reveal hidden routing or internal planning unless the final phase explicitly asks for a user-facing answer.",
  ].join(" ")
}

function createPlannerSystemPrompt(analysis: ProblemAnalysis) {
  return [
    "Current orchestration phase: planner.",
    `The request difficulty score is ${analysis.difficultyScore}/100 and the context dependency score is ${analysis.contextDependencyScore}/100.`,
    "Create the smallest useful step plan.",
    "Return JSON only. Do not use markdown fences.",
    'Required JSON shape: {"steps":[{"id":"step-1","title":"string","objective":"string","difficultyScore":0-100,"contextDependencyScore":0-100}]}',
    `Target ${analysis.recommendedStepCount} steps unless fewer are enough.`,
    "Do not create unnecessary steps.",
    "When available MCP tools can reduce hallucination, fetch external facts, or verify the answer, prefer a plan that explicitly leaves room for those tool-backed steps.",
  ].join(" ")
}

function createNextTurnSessionSummarySystemPrompt(analysis: ProblemAnalysis) {
  return [
    "Current orchestration phase: prepare the next-turn session summary.",
    `Current analysis summary: ${analysis.analysisSummary}`,
    "Summarize the current session state so the next user turn can recover what problem is being worked on.",
    "Keep important constraints, code/doc state, attachment context, what changed in this turn, and what would matter if the next turn uses a low-context sub-step.",
    "Do not write a rolling memory. This summary is only a compact snapshot for the next turn.",
    "Return plain text only, concise but information-dense.",
  ].join(" ")
}

function createStepSystemPrompt(mode: IntelligentModeConfig, step: PlannedStep) {
  return [
    `You are executing an internal step for Chat Studio Intelligent Mode "${mode.label}".`,
    `Current step: "${step.title}".`,
    "Produce concise execution notes for orchestration, not the final user-facing answer.",
    "Focus on findings, decisions, and unresolved constraints.",
    "Before concluding the step, strongly consider using available tools whenever they can improve factual reliability or verify external information.",
    "If native tools are available in the API request and they would materially help, call them directly instead of describing pretend searches or pretend tool usage in prose.",
  ].join(" ")
}

function createStepSummarySystemPrompt(mode: IntelligentModeConfig, step: PlannedStep) {
  return [
    `You are summarizing a completed internal step for Chat Studio Intelligent Mode "${mode.label}".`,
    `Current step: "${step.title}".`,
    "Return only the step conclusion, not hidden chain-of-thought.",
    "The structured output must include:",
    "briefSummary: one or two sentences for the orchestration UI.",
    "summary: the full step conclusion that later steps and final synthesis can rely on.",
  ].join(" ")
}

function extractBriefSummaryFromText(text: string) {
  const compact = text.replace(/\s+/g, " ").trim()
  if (!compact) {
    return "Step completed."
  }

  const sentences =
    compact.match(/[^.!?]+[.!?]+/g)?.map((item) => item.trim()).filter(Boolean) ?? []

  if (sentences.length >= 2) {
    return `${sentences[0]} ${sentences[1]}`.trim()
  }

  if (sentences.length === 1) {
    return sentences[0]
  }

  return compact.length > 220 ? `${compact.slice(0, 220).trimEnd()}...` : compact
}

function parseStructuredStepSummary(text: string) {
  const parsed = tryParseStructuredText(text)

  if (isRecord(parsed)) {
    const briefSummary = asString(parsed.briefSummary)
    const summary = asString(parsed.summary)

    if (briefSummary && summary) {
      return {
        briefSummary,
        summary,
      }
    }
  }

  const normalized = text.trim()

  return {
    briefSummary: extractBriefSummaryFromText(normalized),
    summary: normalized || "Step completed without a usable summary.",
  }
}

async function createStructuredRoutingGateCompletion(args: {
  baseUrl: string
  apiKey?: string
  mode: IntelligentModeConfig
  history: IntelligentChatHistoryMessage[]
  globalMemory?: IntelligentGlobalMemory
  tools?: McpTool[]
  currentSessionKey?: string
  model: string
  maxTokens: number
  enableThinking: boolean
  slotId?: number
  timeContext?: string
  signal: AbortSignal
}) {
  const messages = buildRoutingGateMessages({
    mode: args.mode,
    history: args.history,
    globalMemory: args.globalMemory,
    tools: args.tools,
    currentSessionKey: args.currentSessionKey,
    timeContext: args.timeContext,
  })

  try {
    return await createChatCompletion({
      baseUrl: args.baseUrl,
      apiKey: args.apiKey,
      model: args.model,
      messages,
      temperature: ANALYSIS_TEMPERATURE,
      maxTokens: args.maxTokens,
      enableThinking: args.enableThinking,
      slotId: args.slotId,
      responseFormat: buildRoutingGateResponseFormat(),
      signal: args.signal,
    })
  } catch {
    return await createChatCompletion({
      baseUrl: args.baseUrl,
      apiKey: args.apiKey,
      model: args.model,
      messages,
      temperature: ANALYSIS_TEMPERATURE,
      maxTokens: args.maxTokens,
      enableThinking: args.enableThinking,
      slotId: args.slotId,
      signal: args.signal,
    })
  }
}

async function createStructuredAnalysisCompletion(args: {
  baseUrl: string
  apiKey?: string
  mode: IntelligentModeConfig
  history: IntelligentChatHistoryMessage[]
  globalMemory?: IntelligentGlobalMemory
  tools?: McpTool[]
  currentSessionKey?: string
  model: string
  maxTokens: number
  enableThinking: boolean
  slotId?: number
  timeContext?: string
  signal: AbortSignal
}) {
  const messages = buildAnalysisMessages({
    mode: args.mode,
    history: args.history,
    globalMemory: args.globalMemory,
    tools: args.tools,
    currentSessionKey: args.currentSessionKey,
    timeContext: args.timeContext,
  })

  try {
    return await createChatCompletion({
      baseUrl: args.baseUrl,
      apiKey: args.apiKey,
      model: args.model,
      messages,
      temperature: ANALYSIS_TEMPERATURE,
      maxTokens: args.maxTokens,
      enableThinking: args.enableThinking,
      slotId: args.slotId,
      responseFormat: buildAnalysisResponseFormat(),
      signal: args.signal,
    })
  } catch {
    return await createChatCompletion({
      baseUrl: args.baseUrl,
      apiKey: args.apiKey,
      model: args.model,
      messages,
      temperature: ANALYSIS_TEMPERATURE,
      maxTokens: args.maxTokens,
      enableThinking: args.enableThinking,
      slotId: args.slotId,
      signal: args.signal,
    })
  }
}

async function createStructuredPlannerCompletion(args: {
  baseUrl: string
  apiKey?: string
  mode: IntelligentModeConfig
  history: IntelligentChatHistoryMessage[]
  analysis: ProblemAnalysis
  latestUserSummary: string
  globalMemory?: IntelligentGlobalMemory
  tools?: McpTool[]
  currentSessionKey?: string
  model: string
  maxTokens: number
  enableThinking: boolean
  slotId?: number
  timeContext?: string
  signal: AbortSignal
}) {
  const messages = buildPlannerMessages({
    mode: args.mode,
    history: args.history,
    analysis: args.analysis,
    latestUserSummary: args.latestUserSummary,
    globalMemory: args.globalMemory,
    tools: args.tools,
    currentSessionKey: args.currentSessionKey,
    timeContext: args.timeContext,
  })

  try {
    return await createChatCompletion({
      baseUrl: args.baseUrl,
      apiKey: args.apiKey,
      model: args.model,
      messages,
      temperature: ANALYSIS_TEMPERATURE,
      maxTokens: args.maxTokens,
      enableThinking: args.enableThinking,
      slotId: args.slotId,
      responseFormat: buildPlannerResponseFormat(),
      signal: args.signal,
    })
  } catch {
    return await createChatCompletion({
      baseUrl: args.baseUrl,
      apiKey: args.apiKey,
      model: args.model,
      messages,
      temperature: ANALYSIS_TEMPERATURE,
      maxTokens: args.maxTokens,
      enableThinking: args.enableThinking,
      slotId: args.slotId,
      signal: args.signal,
    })
  }
}

function createInstantSystemPrompt(
  mode: IntelligentModeConfig,
  analysis: ProblemAnalysis
) {
  return [
    `You are Chat Studio Intelligent Mode "${mode.label}".`,
    `The current major lane model is "${mode.majorModel}".`,
    `Analysis summary: ${analysis.analysisSummary}`,
    "This request was routed to the instant path.",
    "Answer clearly and directly for the user.",
    "Before answering, strongly consider using available tools whenever they can improve factual reliability or recover current external information.",
    "Do not claim to browse, search, verify, or call tools unless actual tool-grounded results are already present in the provided context.",
    'Never write placeholder narration such as "(searching...)" or "let me look that up" inside the final answer.',
    "Do not reveal internal routing or hidden planning.",
  ].join(" ")
}

function createSynthesisSystemPrompt(
  mode: IntelligentModeConfig,
  analysis: ProblemAnalysis
) {
  return [
    `You are Chat Studio Intelligent Mode "${mode.label}".`,
    `The current major lane model is "${mode.majorModel}".`,
    `Analysis summary: ${analysis.analysisSummary}`,
    "This request was routed to the multi-step path.",
    "Use the completed step results to craft the final answer.",
    "Prefer grounded, tool-backed findings over unsupported recall whenever tool results are available.",
    "If completed steps used MCP tools, rely on those grounded results and present them naturally.",
    "Do not claim to be currently browsing, searching, or calling tools in the user-facing answer.",
    'Never write placeholder narration such as "(searching...)" or "let me look that up" unless the answer is literally quoting prior user text.',
    "Do not expose internal planner steps unless they genuinely help the user.",
  ].join(" ")
}

function createGlobalMemorySystemPrompt(
  mode: IntelligentModeConfig,
  currentSessionKey: string
) {
  return [
    `You maintain cross-session global memory for Chat Studio Intelligent Mode "${mode.label}".`,
    "Update the three-tier session-keyed memory bank so future sessions can recover useful prior-session context without replaying old chats.",
    `The current session key is "${currentSessionKey}".`,
    "Each tier still uses key:value entries where key is a session hash and value is concise memory text.",
    "Update or replace the entry for the current session key inside the appropriate tiers based on the latest turn.",
    "Preserve unrelated session entries unless they are empty, duplicate, stale, or contradicted.",
    "Before adding a new memory for the current session, compare against the existing memory bank. If the same underlying fact, preference, or ongoing event is already captured, keep the existing memory instead of restating it under a new session key.",
    "Use userFeatures only for unusual, stable user facts or enduring preferences the user clearly cares about and would likely want remembered later.",
    "Use instructionMemory only for durable response instructions or preferences the user strongly values and repeatedly expects.",
    "Use recentEvents only for ongoing projects, temporary priorities, active deliverables, blockers, or near-future context that will likely matter again soon.",
    "Be conservative: most turns should add little or nothing to userFeatures or instructionMemory.",
    "If something is ordinary, weakly implied, one-off, or not clearly important to the user, do not store it in userFeatures or instructionMemory.",
    "Do not store greetings, pleasantries, current timestamps, 'user said hi', 'user thanked me', or other trivial turn-local chatter in recentEvents.",
    "Do not store low-signal conversational meta such as the user opening the chat, acknowledging a reply, or making generic small talk.",
    "If the latest turn adds nothing materially worth remembering, leave the current session absent from that tier instead of forcing an entry.",
    "RecentEvents should stay short and fresh; keep at most 10 items there.",
    "Do not duplicate the same session key multiple times inside one tier.",
    "Keep each memory value concise, dense, and useful for future retrieval. Do not paste the whole conversation.",
    "Return JSON only with this exact shape:",
    '{"userFeatures":[{"key":"session-hash","value":"memory text"}],"instructionMemory":[{"key":"session-hash","value":"memory text"}],"recentEvents":[{"key":"session-hash","value":"memory text"}]}',
  ].join(" ")
}

function extractTextFromContent(value: unknown): string {
  if (typeof value === "string") {
    return value.trim()
  }

  if (!Array.isArray(value)) {
    return ""
  }

  return value
    .map((part) => {
      if (typeof part === "string") {
        return part
      }

      if (!isProviderContentObject(part)) {
        return ""
      }

      if (part.type === "text" && typeof part.text === "string") {
        return part.text
      }

      if (typeof part.text === "string") {
        return part.text
      }

      return ""
    })
    .join("\n")
    .trim()
}

function extractCompletionText(
  message:
    | {
        content?: unknown
        reasoning_content?: unknown
        reasoning?: unknown
      }
    | undefined
) {
  if (!message) {
    return ""
  }

  const content = extractTextFromContent(message.content)
  if (content) {
    return content
  }

  const reasoningContent = extractTextFromContent(message.reasoning_content)
  if (reasoningContent) {
    return reasoningContent
  }

  const reasoning = extractTextFromContent(message.reasoning)
  if (reasoning) {
    return reasoning
  }

  return ""
}

async function createChatCompletion(args: {
  baseUrl: string
  apiKey?: string
  model: string
  messages: ProviderMessage[]
  temperature: number
  maxTokens: number
  enableThinking?: boolean
  slotId?: number
  responseFormat?: JsonSchemaResponseFormat
  tools?: ProviderToolDefinition[]
  toolChoice?: ProviderToolChoice
  signal: AbortSignal
}) {
  const headers = buildAuthHeaders(args.apiKey)
  headers.set("Content-Type", "application/json")

  let response: Response

  try {
    response = await fetch(`${args.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: args.model,
        stream: false,
        messages: args.messages,
        temperature: args.temperature,
        max_tokens: args.maxTokens,
        ...(typeof args.slotId === "number"
          ? { id_slot: args.slotId, cache_prompt: true }
          : {}),
        ...(args.responseFormat
          ? {
              response_format: args.responseFormat,
            }
          : {}),
        ...(args.tools?.length
          ? {
              tools: args.tools,
              tool_choice: args.toolChoice ?? "auto",
            }
          : {}),
        chat_template_kwargs: {
          enable_thinking: Boolean(args.enableThinking),
        },
      }),
      signal: args.signal,
    })
  } catch (error) {
    throw new Error(formatUpstreamFetchError("completion", error))
  }

  if (!response.ok) {
    const details = await response.text()
    throw new Error(details || "Upstream completion request failed")
  }

  const payload = (await response.json()) as UpstreamCompletionResponse
  const text = extractCompletionText(payload.choices?.[0]?.message)
  const toolCalls = extractCompletionToolCalls(payload.choices?.[0]?.message)

  if (!text.trim() && toolCalls.length === 0) {
    throw new Error("Upstream completion returned empty content")
  }

  return {
    text,
    toolCalls,
    model:
      typeof payload.model === "string" && payload.model.trim()
        ? payload.model
        : args.model,
    metrics: buildPhaseMetrics({
      usage: payload.usage,
      timings: payload.timings,
    }),
  }
}

async function streamChatCompletion(args: {
  baseUrl: string
  apiKey?: string
  model: string
  messages: ProviderMessage[]
  temperature: number
  enableThinking?: boolean
  slotId?: number
  signal: AbortSignal
  onToken: (text: string) => void
  emitReasoningToOutput?: boolean
}) {
  const headers = buildAuthHeaders(args.apiKey)
  headers.set("Content-Type", "application/json")

  let response: Response

  try {
    response = await fetch(`${args.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: args.model,
        stream: true,
        messages: args.messages,
        temperature: args.temperature,
        stream_options: {
          include_usage: true,
        },
        ...(typeof args.slotId === "number"
          ? { id_slot: args.slotId, cache_prompt: true }
          : {}),
        chat_template_kwargs: {
          enable_thinking: Boolean(args.enableThinking),
        },
      }),
      signal: args.signal,
    })
  } catch (error) {
    throw new Error(formatUpstreamFetchError("streaming", error))
  }

  if (!response.ok || !response.body) {
    const details = await response.text()
    throw new Error(details || "Upstream streaming request failed")
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let resolvedModel = args.model
  let finalMetrics: IntelligentPhaseMetrics | undefined

  try {
    while (true) {
      if (args.signal.aborted) {
        break
      }

      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      let boundaryIndex = buffer.indexOf("\n\n")

      while (boundaryIndex !== -1) {
        const rawEvent = buffer.slice(0, boundaryIndex)
        buffer = buffer.slice(boundaryIndex + 2)

        const lines = rawEvent.split("\n")

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith("data:")) continue

          const data = trimmed.slice(5).trim()
          if (!data || data === "[DONE]") continue

          let chunk: UpstreamStreamingChunk

          try {
            chunk = JSON.parse(data) as UpstreamStreamingChunk
          } catch {
            continue
          }

          if (typeof chunk.model === "string" && chunk.model.trim()) {
            resolvedModel = chunk.model
          }

          const nextMetrics = buildPhaseMetrics({
            usage: chunk.usage,
            timings: chunk.timings,
          })
          if (nextMetrics) {
            finalMetrics = nextMetrics
          }

          const token =
            typeof chunk.choices?.[0]?.delta?.content === "string"
              ? chunk.choices[0].delta.content
              : ""
          const reasoning =
            typeof chunk.choices?.[0]?.delta?.reasoning_content === "string"
              ? chunk.choices[0].delta.reasoning_content
              : ""

          if (token) {
            args.onToken(token)
          } else if (reasoning && args.emitReasoningToOutput) {
            args.onToken(reasoning)
          }
        }

        boundaryIndex = buffer.indexOf("\n\n")
      }
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // ignore
    }
  }

  return {
    model: resolvedModel,
    metrics: finalMetrics,
  }
}

function fallbackRoutingGate(message: string): RoutingGate {
  const heuristic = fallbackProblemAnalysis(message)

  return {
    shouldUseInstant: !heuristic.shouldUseMultiStep,
    gateSummary: heuristic.shouldUseMultiStep
      ? "This request likely needs deeper planning instead of an immediate answer."
      : "This request appears simple enough for a direct answer.",
  }
}

function normalizeGateSummary(summary: string) {
  return summary.replace(/\s+/g, " ").trim()
}

function parseRoutingGate(text: string, message: string): RoutingGate {
  const parsed = tryParseStructuredText(text)

  if (!isRecord(parsed)) {
    return fallbackRoutingGate(message)
  }

  return {
    shouldUseInstant:
      typeof parsed.shouldUseInstant === "boolean"
        ? parsed.shouldUseInstant
        : fallbackRoutingGate(message).shouldUseInstant,
    gateSummary: normalizeGateSummary(
      asString(parsed.gateSummary, fallbackRoutingGate(message).gateSummary)
    ),
  }
}

function fallbackProblemAnalysis(message: string): ProblemAnalysis {
  const lengthScore = Math.min(90, Math.round(message.length / 6))
  const codeLike =
    /```|function|class|error|debug|refactor|algorithm|architecture/i.test(
      message
    )

  const difficultyScore = codeLike ? Math.max(60, lengthScore) : lengthScore
  const shouldUseMultiStep = codeLike || difficultyScore >= MULTI_STEP_THRESHOLD

  return {
    difficultyScore,
    contextDependencyScore: /previous|above|earlier|before|continue/i.test(message)
      ? 70
      : 25,
    shouldUseMultiStep,
    recommendedStepCount: shouldUseMultiStep ? 3 : 1,
    taskType: codeLike ? "complex_reasoning" : "general",
    analysisSummary: shouldUseMultiStep
      ? "The request likely benefits from deliberate decomposition."
      : "The request appears suitable for a direct response.",
  }
}

function parseProblemAnalysis(text: string, message: string): ProblemAnalysis {
  const parsed = tryParseStructuredText(text)

  if (!isRecord(parsed)) {
    return fallbackProblemAnalysis(message)
  }

  return {
    difficultyScore: clampScore(parsed.difficultyScore, 50),
    contextDependencyScore: clampScore(parsed.contextDependencyScore, 40),
    shouldUseMultiStep:
      typeof parsed.shouldUseMultiStep === "boolean"
        ? parsed.shouldUseMultiStep
        : false,
    recommendedStepCount: clampCount(parsed.recommendedStepCount, 2),
    taskType: asString(parsed.taskType, "general"),
    analysisSummary: asString(
      parsed.analysisSummary,
      "The model did not provide a detailed analysis summary."
    ),
  }
}

function messageLikelyNeedsExternalGrounding(message: string) {
  return /latest|current|today|recent|news|official|verify|fact-check|fact check|look up|lookup|search|web|browser|browse|搜尋|查詢|最新|目前|今天|近期|官方|驗證|確認|上網/i.test(
    message
  )
}

function decideRoute(
  gate: RoutingGate,
  latestMessage: string,
  hasMcpTools: boolean
) {
  const shouldForceToolBackedMultiStep =
    hasMcpTools && messageLikelyNeedsExternalGrounding(latestMessage)
  if (shouldForceToolBackedMultiStep) {
    return "multi-step" as const
  }

  return gate.shouldUseInstant ? ("instant" as const) : ("multi-step" as const)
}

function fallbackPlan(message: string, analysis: ProblemAnalysis): PlannedStep[] {
  return [
    {
      id: "step-1",
      title: "Clarify the task",
      objective: `Identify the core request and relevant constraints from: ${message.slice(
        0,
        160
      )}`,
      difficultyScore: Math.max(35, analysis.difficultyScore - 10),
      contextDependencyScore: analysis.contextDependencyScore,
    },
    {
      id: "step-2",
      title: "Work out the solution",
      objective: "Develop the main reasoning or solution approach.",
      difficultyScore: analysis.difficultyScore,
      contextDependencyScore: Math.max(analysis.contextDependencyScore - 10, 20),
    },
    {
      id: "step-3",
      title: "Prepare the final response",
      objective: "Convert the work into a concise user-facing answer.",
      difficultyScore: Math.max(25, analysis.difficultyScore - 20),
      contextDependencyScore: 35,
    },
  ].slice(0, Math.max(2, analysis.recommendedStepCount))
}

function parsePlan(
  text: string,
  message: string,
  analysis: ProblemAnalysis
): PlannedStep[] {
  const parsed = tryParseStructuredText(text)

  if (!isRecord(parsed) || !Array.isArray(parsed.steps)) {
    return fallbackPlan(message, analysis)
  }

  const steps = parsed.steps
    .map((step: unknown, index: number) => {
      if (!isRecord(step)) {
        return null
      }

      const title = asString(step.title, `Step ${index + 1}`)
      const objective = asString(step.objective, title)

      return {
        id: asString(step.id, `step-${index + 1}`),
        title,
        objective,
        difficultyScore: clampScore(step.difficultyScore, analysis.difficultyScore),
        contextDependencyScore: clampScore(
          step.contextDependencyScore,
          analysis.contextDependencyScore
        ),
      }
    })
    .filter((step): step is PlannedStep => Boolean(step))
    .slice(0, 4)

  return steps.length > 0 ? steps : fallbackPlan(message, analysis)
}

function normalizePhaseDetail(text: string) {
  return text.trim()
}

function truncateContextBlock(text: string, maxLength = 2200) {
  const normalized = text.trim()
  if (!normalized) {
    return ""
  }

  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength)}...`
    : normalized
}

function prepareToolResultForConversation(
  toolName: string,
  resultText: string,
  isError: boolean
) {
  const normalized =
    truncateContextBlock(resultText, TOOL_RESULT_CONVERSATION_CHAR_LIMIT) ||
    "Tool returned no text content."

  if (normalized === resultText.trim()) {
    return normalized
  }

  return [
    normalized,
    "",
    `[Tool result truncated for follow-up model calls: ${toolName} (${isError ? "error" : "success"})]`,
  ].join("\n")
}

function formatUpstreamFetchError(
  stage: "completion" | "streaming",
  error: unknown
) {
  if (error instanceof Error) {
    const detail = error.message || "Unknown network error"
    return `Upstream ${stage} network error: ${detail}. This can happen if the backend is unreachable, reset the connection, or rejected an oversized prompt after tool results were added.`
  }

  return `Upstream ${stage} network error. This can happen if the backend is unreachable, reset the connection, or rejected an oversized prompt after tool results were added.`
}

function getModelEntries(mode: IntelligentModeConfig) {
  return Object.entries(mode.models)
    .map(([id, config]) => ({
      id,
      weight: config.weight,
      slots: config.slots,
    }))
    .sort((left, right) => left.weight - right.weight)
}

function selectModelAndLane(
  mode: IntelligentModeConfig,
  difficultyScore: number,
  contextDependencyScore: number
) {
  const entries = getModelEntries(mode)
  const majorEntry =
    entries.find((entry) => entry.id === mode.majorModel) ?? entries[entries.length - 1]
  const maxWeight = entries[entries.length - 1]?.weight ?? majorEntry.weight
  const minWeight = entries[0]?.weight ?? majorEntry.weight

  // High-context phases stay on the major contextual lane so the request can
  // benefit from the same prefix and slot residency instead of hopping models.
  if (contextDependencyScore >= HIGH_CONTEXT_THRESHOLD) {
    return {
      modelId: majorEntry.id,
      lane: "contextual" as const,
      slotId: majorEntry.slots?.contextual,
    }
  }

  let selected = majorEntry

  const targetWeight =
    minWeight + ((maxWeight - minWeight) * difficultyScore) / 100

  selected =
    entries.find((entry) => entry.weight >= targetWeight) ??
    entries[entries.length - 1]

  if (
    majorEntry.weight > selected.weight &&
    contextDependencyScore >= 45 &&
    difficultyScore >= 45
  ) {
    selected = majorEntry
  }

  const slotId =
    selected.slots?.stateless ?? selected.slots?.contextual

  return {
    modelId: selected.id,
    lane: "stateless" as const,
    slotId,
  }
}

function selectReasoningMode(args: {
  mode: IntelligentModeConfig
  modelId: string
  lane: "contextual" | "stateless"
  difficultyScore: number
  contextDependencyScore: number
  phaseKind: PhaseKind
}): IntelligentReasoningMode {
  const selectedWeight =
    args.mode.models[args.modelId]?.weight ??
    args.mode.models[args.mode.majorModel]?.weight ??
    0
  const majorWeight =
    args.mode.models[args.mode.majorModel]?.weight ?? selectedWeight
  const isMajorModel = args.modelId === args.mode.majorModel

  let score = args.difficultyScore
  score += Math.max(0, args.contextDependencyScore - 50) * 0.35

  if (args.lane === "contextual") {
    score += 6
  }

  if (isMajorModel) {
    score += 8
  } else if (selectedWeight < majorWeight) {
    score -= 10
  }

  if (args.phaseKind === "analysis" || args.phaseKind === "planner") {
    score -= 8
  }

  if (args.phaseKind === "memory") {
    score -= 12
  }

  if (!isMajorModel && args.difficultyScore < 82) {
    score -= 8
  }

  if (args.contextDependencyScore >= 78 && isMajorModel) {
    score += 10
  }

  return score >= 74 ? "think" : "instant"
}

function buildStepExecutionMessages(args: {
  mode: IntelligentModeConfig
  history: IntelligentChatHistoryMessage[]
  analysis: ProblemAnalysis
  step: PlannedStep
  previousResults: StepExecutionResult[]
  latestUserContent: MessagePart[]
  latestUserSummary: string
  globalMemory?: IntelligentGlobalMemory
  sessionSummary?: string
  tools?: McpTool[]
  currentSessionKey?: string
  timeContext?: string
}) {
  const historyWindow = getHistoryWindowForDependency(
    args.step.contextDependencyScore
  )
  const isHighContext =
    args.step.contextDependencyScore >= HIGH_CONTEXT_THRESHOLD
  const slicedHistory =
    isHighContext
      ? args.history
      : sliceHistoryTail(args.history, historyWindow)
  const historyMessages =
    args.step.contextDependencyScore >= MEDIUM_CONTEXT_THRESHOLD
      ? toProviderMessages(slicedHistory)
      : []
  const latestUserContentText = formatMessagePartsForPrompt(
    args.latestUserContent
  )

  const priorResultsBlock =
    args.previousResults.length > 0
      ? args.previousResults
          .map(
            (item, index) =>
              `Previous step ${index + 1}: ${item.step.title} (${item.modelId}, ${item.lane})\n${item.summary}`
          )
          .join("\n\n")
      : "No previous step results."

  return [
    buildLeadingSystemMessage({
      base: isHighContext
        ? createContextualLaneSystemPrompt(args.mode)
        : createStepSystemPrompt(args.mode, args.step),
      globalMemory: args.globalMemory,
      currentSessionKey: args.currentSessionKey,
      tools: args.tools,
    }),
    ...historyMessages,
    {
      role: "user" as const,
      content: [
        isHighContext
          ? `Current orchestration phase: execute internal step "${args.step.title}".`
          : "",
        args.timeContext ?? getCurrentTimeContext(),
        `Global analysis summary: ${args.analysis.analysisSummary}`,
        args.sessionSummary
          ? `Session summary from the previous turn:\n${args.sessionSummary}`
          : "",
        `Current step objective: ${args.step.objective}`,
        `Step difficulty score: ${args.step.difficultyScore}/100`,
        `Step context dependency score: ${args.step.contextDependencyScore}/100`,
        `Latest user content:\n${latestUserContentText}`,
        `Prior completed work:\n${priorResultsBlock}`,
        "Return a concise execution summary with the main findings and what should matter to the final synthesis.",
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
  ]
}

function buildInstantMessages(args: {
  mode: IntelligentModeConfig
  analysis: ProblemAnalysis
  history: IntelligentChatHistoryMessage[]
  globalMemory?: IntelligentGlobalMemory
  sessionSummary?: string
  tools?: McpTool[]
  currentSessionKey?: string
  timeContext?: string
}) {
  const isHighContext =
    args.analysis.contextDependencyScore >= HIGH_CONTEXT_THRESHOLD

  return [
    buildLeadingSystemMessage({
      base: isHighContext
        ? createContextualLaneSystemPrompt(args.mode)
        : createInstantSystemPrompt(args.mode, args.analysis),
      globalMemory: args.globalMemory,
      currentSessionKey: args.currentSessionKey,
      tools: args.tools,
    }),
    ...toProviderMessages(
      isHighContext
        ? args.history
        : sliceHistoryTail(
            args.history,
            getHistoryWindowForDependency(args.analysis.contextDependencyScore)
          )
    ),
    {
      role: "user" as const,
      content: [
        isHighContext ? createInstantSystemPrompt(args.mode, args.analysis) : "",
        args.timeContext ?? getCurrentTimeContext(),
        args.sessionSummary
          ? `Session summary from the previous turn:\n${args.sessionSummary}`
          : "",
        "Write the final user-facing answer now.",
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
  ]
}

function buildSynthesisMessages(args: {
  mode: IntelligentModeConfig
  analysis: ProblemAnalysis
  history: IntelligentChatHistoryMessage[]
  lane: "contextual" | "stateless"
  globalMemory?: IntelligentGlobalMemory
  currentSessionKey?: string
  latestUserSummary: string
  stepResults: StepExecutionResult[]
  tools?: McpTool[]
  timeContext?: string
}) {
  const isContextual = args.lane === "contextual"

  return [
    buildLeadingSystemMessage({
      base: isContextual
        ? createContextualLaneSystemPrompt(args.mode)
        : createSynthesisSystemPrompt(args.mode, args.analysis),
      globalMemory: args.globalMemory,
      currentSessionKey: args.currentSessionKey,
      tools: args.tools,
    }),
    ...(isContextual ? toProviderMessages(args.history) : []),
    {
      role: "user" as const,
      content: [
        isContextual ? createSynthesisSystemPrompt(args.mode, args.analysis) : "",
        args.timeContext ?? getCurrentTimeContext(),
        `Original request: ${args.latestUserSummary}`,
        `Analysis summary: ${args.analysis.analysisSummary}`,
        "Completed step results:",
        args.stepResults
          .map(
            (result, index) =>
              `${index + 1}. ${result.step.title} (${result.modelId}, ${result.lane}, ${result.reasoningMode})\n${result.summary}${
                result.toolUses.length > 0
                  ? `\nTools used:\n${result.toolUses
                      .map(
                        (toolUse, toolIndex) =>
                          `${toolIndex + 1}. ${toolUse.toolName} (${toolUse.isError ? "error" : "success"})\n${truncateContextBlock(
                            toolUse.resultText,
                            800
                          )}`
                      )
                      .join("\n\n")}`
                  : ""
              }`
          )
          .join("\n\n"),
        "Write the final user-facing answer now.",
        "Only mention tool-backed facts when they are grounded in the completed step results above.",
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
  ]
}

async function executeInstantWithMcp(args: {
  baseUrl: string
  apiKey?: string
  serverUrl: string
  authToken?: string
  mode: IntelligentModeConfig
  analysis: ProblemAnalysis
  history: IntelligentChatHistoryMessage[]
  globalMemory?: IntelligentGlobalMemory
  sessionSummary?: string
  tools: McpTool[]
  currentSessionKey?: string
  modelId: string
  reasoningMode: IntelligentReasoningMode
  slotId?: number
  timeContext?: string
  signal: AbortSignal
  onProgress?: (status: string) => void
  onToken: (text: string) => void
}) {
  const aggregatedMetrics: Array<IntelligentPhaseMetrics | undefined> = []
  const toolUses: StepToolUseRecord[] = []
  const messages = buildInstantMessages({
    mode: args.mode,
    analysis: args.analysis,
    history: args.history,
    globalMemory: args.globalMemory,
    sessionSummary: args.sessionSummary,
    tools: args.tools,
    currentSessionKey: args.currentSessionKey,
    timeContext: args.timeContext,
  })
  const conversationMessages: ProviderMessage[] = [...messages]
  let candidateFinalText = ""

  for (let attempt = 0; attempt < MAX_STEP_TOOL_CALLS; attempt += 1) {
    const nativeCompletion = await createChatCompletion({
      baseUrl: args.baseUrl,
      apiKey: args.apiKey,
      model: args.modelId,
      messages: conversationMessages,
      temperature: EXECUTION_TEMPERATURE,
      maxTokens: STEP_MAX_TOKENS,
      enableThinking: args.reasoningMode === "think",
      slotId: args.slotId,
      tools: buildProviderTools(args.tools),
      toolChoice: "auto",
      signal: args.signal,
    })

    aggregatedMetrics.push(nativeCompletion.metrics)

    if (!nativeCompletion.toolCalls.length) {
      candidateFinalText = nativeCompletion.text.trim()
      break
    }

    conversationMessages.push({
      role: "assistant",
      content: nativeCompletion.text.trim() || "",
      tool_calls: nativeCompletion.toolCalls,
    })

    for (const toolCall of nativeCompletion.toolCalls) {
      const parsedArguments = parseToolArgumentsText(toolCall.function.arguments)
      let toolArguments: Record<string, unknown> = {}
      let toolResultText = ""
      let toolResultIsError = false

      if (parsedArguments === null) {
        toolResultIsError = true
        toolResultText = [
          `Invalid tool arguments JSON for tool "${toolCall.function.name}".`,
          `Raw arguments: ${toolCall.function.arguments || "(empty)"}`,
        ].join("\n")
      } else {
        toolArguments = parsedArguments
        args.onProgress?.(
          buildToolCallStatus(toolCall.function.name, toolArguments)
        )

        try {
          const toolResult = await callMcpTool({
            serverUrl: args.serverUrl,
            toolName: toolCall.function.name,
            toolArguments,
            authToken: args.authToken,
            signal: args.signal,
          })
          toolResultText = toolResult.contentText
          toolResultIsError = toolResult.isError
        } catch (toolError) {
          toolResultIsError = true
          toolResultText =
            toolError instanceof Error
              ? toolError.message
              : "Native tool call failed."
        }
      }

      toolUses.push({
        toolName: toolCall.function.name,
        toolArguments,
        resultText: toolResultText,
        isError: toolResultIsError,
      })

      args.onProgress?.(
        buildToolResultStatus(toolCall.function.name, toolResultIsError)
      )

      conversationMessages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        name: toolCall.function.name,
        content: prepareToolResultForConversation(
          toolCall.function.name,
          toolResultText,
          toolResultIsError
        ),
      })
    }
  }

  args.onProgress?.(
    toolUses.length > 0
      ? "Constructing the final answer from tool-grounded results."
      : "Constructing the final answer."
  )

  let streamedText = ""

  try {
    const streamedCompletion = await streamChatCompletion({
      baseUrl: args.baseUrl,
      apiKey: args.apiKey,
      model: args.modelId,
      messages: conversationMessages,
      temperature: EXECUTION_TEMPERATURE,
      enableThinking: args.reasoningMode === "think",
      slotId: args.slotId,
      signal: args.signal,
      onToken: (text) => {
        streamedText += text
        args.onToken(text)
      },
      emitReasoningToOutput: false,
    })

    aggregatedMetrics.push(streamedCompletion.metrics)

    return {
      text: streamedText.trim() || candidateFinalText,
      model: streamedCompletion.model,
      metrics: mergePhaseMetrics(aggregatedMetrics),
      toolUses,
    }
  } catch {
    return {
      text: candidateFinalText || "No final answer text was produced.",
      model: args.modelId,
      metrics: mergePhaseMetrics(aggregatedMetrics),
      toolUses,
    }
  }
}

async function createStructuredStepSummary(args: {
  baseUrl: string
  apiKey?: string
  mode: IntelligentModeConfig
  step: PlannedStep
  modelId: string
  lane: "contextual" | "stateless"
  slotId?: number
  rawExecutionText: string
  toolUses?: StepToolUseRecord[]
  analysis: ProblemAnalysis
  signal: AbortSignal
}) {
  const responseFormat = buildJsonSchemaResponseFormat("step_summary", {
    type: "object",
    description:
      "Structured conclusion for one completed internal step. This must not expose hidden chain-of-thought.",
    properties: {
      briefSummary: {
        type: "string",
        description: "One or two sentences for the orchestration UI.",
      },
      summary: {
        type: "string",
        description:
          "The full step conclusion for later steps and final synthesis. Do not include hidden reasoning.",
      },
    },
    required: ["briefSummary", "summary"],
    additionalProperties: false,
  })

  const messages: ProviderMessage[] = [
    buildLeadingSystemMessage({
      base:
        args.lane === "contextual"
          ? createContextualLaneSystemPrompt(args.mode)
          : createStepSummarySystemPrompt(args.mode, args.step),
    }),
    {
      role: "user",
      content: [
        args.lane === "contextual"
          ? createStepSummarySystemPrompt(args.mode, args.step)
          : "",
        `Analysis summary: ${args.analysis.analysisSummary}`,
        `Step objective: ${args.step.objective}`,
        "Convert the raw step work into a clean structured summary.",
        "Do not repeat chain-of-thought, scratch work, or self-talk.",
        args.toolUses?.length
          ? `Actual MCP tool calls completed in this step:\n${args.toolUses
              .map(
                (toolUse, index) =>
                  `${index + 1}. ${toolUse.toolName} (${toolUse.isError ? "error" : "success"})\nArguments: ${JSON.stringify(
                    toolUse.toolArguments
                  )}\nResult:\n${truncateContextBlock(toolUse.resultText, 900)}`
              )
              .join("\n\n")}`
          : "No MCP tools were used in this step.",
        "If tools were used, the summary should clearly capture the grounded findings from those tool results.",
        `Raw step work:\n${args.rawExecutionText}`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
  ]

  try {
    const completion = await createChatCompletion({
      baseUrl: args.baseUrl,
      apiKey: args.apiKey,
      model: args.modelId,
      messages,
      temperature: ANALYSIS_TEMPERATURE,
      maxTokens: STEP_SUMMARY_MAX_TOKENS,
      enableThinking: false,
      slotId: args.slotId,
      responseFormat,
      signal: args.signal,
    })

    return parseStructuredStepSummary(completion.text)
  } catch {
    const fallbackCompletion = await createChatCompletion({
      baseUrl: args.baseUrl,
      apiKey: args.apiKey,
      model: args.modelId,
      messages: [
        ...messages,
        {
          role: "user",
          content:
            'Return JSON only with this exact shape: {"briefSummary":"string","summary":"string"}',
        },
      ],
      temperature: ANALYSIS_TEMPERATURE,
      maxTokens: STEP_SUMMARY_MAX_TOKENS,
      enableThinking: false,
      slotId: args.slotId,
      signal: args.signal,
    })

    return parseStructuredStepSummary(fallbackCompletion.text)
  }
}

async function executeNativeToolLoop(args: {
  baseUrl: string
  apiKey?: string
  serverUrl: string
  authToken?: string
  modelId: string
  messages: ProviderMessage[]
  tools: McpTool[]
  reasoningMode: IntelligentReasoningMode
  slotId?: number
  signal: AbortSignal
  onProgress?: (status: string) => void
  maxTokens?: number
  temperature?: number
  fallbackLabel?: string
}) {
  const aggregatedMetrics: Array<IntelligentPhaseMetrics | undefined> = []
  const toolUses: StepToolUseRecord[] = []
  const providerTools = buildProviderTools(args.tools)
  const conversationMessages: ProviderMessage[] = [...args.messages]

  for (let attempt = 0; attempt < MAX_STEP_TOOL_CALLS; attempt += 1) {
    const nativeCompletion = await createChatCompletion({
      baseUrl: args.baseUrl,
      apiKey: args.apiKey,
      model: args.modelId,
      messages: conversationMessages,
      temperature: args.temperature ?? ANALYSIS_TEMPERATURE,
      maxTokens: args.maxTokens ?? STEP_MAX_TOKENS,
      enableThinking: args.reasoningMode === "think",
      slotId: args.slotId,
      tools: providerTools,
      toolChoice: "auto",
      signal: args.signal,
    })

    aggregatedMetrics.push(nativeCompletion.metrics)

    if (!nativeCompletion.toolCalls.length) {
      const finalText = nativeCompletion.text.trim()
      if (finalText) {
        args.onProgress?.(
          args.fallbackLabel ?? "Finalizing from native tool-calling context."
        )
        return {
          text: finalText,
          model: nativeCompletion.model,
          metrics: mergePhaseMetrics(aggregatedMetrics),
          toolUses,
        }
      }

      break
    }

    conversationMessages.push({
      role: "assistant",
      content: nativeCompletion.text.trim() || "",
      tool_calls: nativeCompletion.toolCalls,
    })

    for (const toolCall of nativeCompletion.toolCalls) {
      const parsedArguments = parseToolArgumentsText(toolCall.function.arguments)
      let toolArguments: Record<string, unknown> = {}
      let toolResultText = ""
      let toolResultIsError = false

      if (parsedArguments === null) {
        toolResultIsError = true
        toolResultText = [
          `Invalid tool arguments JSON for tool "${toolCall.function.name}".`,
          `Raw arguments: ${toolCall.function.arguments || "(empty)"}`,
        ].join("\n")
      } else {
        toolArguments = parsedArguments
        args.onProgress?.(
          buildToolCallStatus(toolCall.function.name, toolArguments)
        )

        try {
          const toolResult = await callMcpTool({
            serverUrl: args.serverUrl,
            toolName: toolCall.function.name,
            toolArguments,
            authToken: args.authToken,
            signal: args.signal,
          })
          toolResultText = toolResult.contentText
          toolResultIsError = toolResult.isError
        } catch (toolError) {
          toolResultIsError = true
          toolResultText =
            toolError instanceof Error
              ? toolError.message
              : "Native tool call failed."
        }
      }

      toolUses.push({
        toolName: toolCall.function.name,
        toolArguments,
        resultText: toolResultText,
        isError: toolResultIsError,
      })

      args.onProgress?.(
        buildToolResultStatus(toolCall.function.name, toolResultIsError)
      )

      conversationMessages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        name: toolCall.function.name,
        content: prepareToolResultForConversation(
          toolCall.function.name,
          toolResultText,
          toolResultIsError
        ),
      })
    }
  }

  return {
    text: [
      `Native tool loop finished without a direct final answer after ${MAX_STEP_TOOL_CALLS} tool rounds.`,
      toolUses.length > 0
        ? toolUses
            .map(
              (item, index) =>
                `${index + 1}. ${item.toolName} (${item.isError ? "error" : "success"})\n${truncateContextBlock(
                  item.resultText,
                  1200
                )}`
            )
            .join("\n\n")
        : "No tool results were collected.",
    ].join("\n\n"),
    model: args.modelId,
    metrics: mergePhaseMetrics(aggregatedMetrics),
    toolUses,
  }
}

async function executeStepWithMcp(args: {
  baseUrl: string
  apiKey?: string
  serverUrl: string
  mode: IntelligentModeConfig
  history: IntelligentChatHistoryMessage[]
  analysis: ProblemAnalysis
  step: PlannedStep
  previousResults: StepExecutionResult[]
  latestUserContent: MessagePart[]
  latestUserSummary: string
  globalMemory?: IntelligentGlobalMemory
  sessionSummary?: string
  tools: McpTool[]
  currentSessionKey?: string
  modelId: string
  lane: "contextual" | "stateless"
  reasoningMode: IntelligentReasoningMode
  authToken?: string
  slotId?: number
  timeContext?: string
  signal: AbortSignal
  onProgress?: (status: string) => void
}) {
  const nativeMessages = buildStepExecutionMessages({
    mode: args.mode,
    history: args.history,
    analysis: args.analysis,
    step: args.step,
    previousResults: args.previousResults,
    latestUserContent: args.latestUserContent,
    latestUserSummary: args.latestUserSummary,
    globalMemory: args.globalMemory,
    sessionSummary: args.sessionSummary,
    tools: args.tools,
    currentSessionKey: args.currentSessionKey,
    timeContext: args.timeContext,
  })
  return executeNativeToolLoop({
    baseUrl: args.baseUrl,
    apiKey: args.apiKey,
    serverUrl: args.serverUrl,
    authToken: args.authToken,
    modelId: args.modelId,
    messages: nativeMessages,
    tools: args.tools,
    reasoningMode: args.reasoningMode,
    slotId: args.slotId,
    signal: args.signal,
    onProgress: args.onProgress,
    maxTokens: STEP_MAX_TOKENS,
    temperature: ANALYSIS_TEMPERATURE,
    fallbackLabel: "Finalizing the step from native tool-calling context.",
  })
}

async function updateGlobalMemory(args: {
  baseUrl: string
  apiKey?: string
  mode: IntelligentModeConfig
  history: IntelligentChatHistoryMessage[]
  previousMemory?: IntelligentGlobalMemory
  currentSessionKey: string
  latestUserSummary: string
  finalAnswer: string
  stepResults: StepExecutionResult[]
  signal: AbortSignal
  enableThinking: boolean
  slotId?: number
}) {
  const messages: ProviderMessage[] = [
    buildLeadingSystemMessage({
      base: createGlobalMemorySystemPrompt(args.mode, args.currentSessionKey),
      globalMemory: args.previousMemory,
      currentSessionKey: args.currentSessionKey,
    }),
    ...toProviderMessages(sliceHistoryTail(args.history, MEDIUM_HISTORY_WINDOW)),
    {
      role: "user",
      content: [
        `Latest user request: ${args.latestUserSummary}`,
        `Final assistant answer:\n${args.finalAnswer.trim() || "No visible answer text."}`,
        args.stepResults.length > 0
          ? `Internal step results:\n${args.stepResults
              .map(
                (result, index) =>
                  `${index + 1}. ${result.step.title} (${result.modelId}, ${result.lane})\n${result.summary}`
              )
              .join("\n\n")}`
          : "Internal step results: instant route; no intermediate steps.",
        "Update the full global memory now. Keep valuable prior entries unless they are stale or contradicted.",
        "Do not create duplicate paraphrases of facts already stored. Prefer no new memory over weak, obvious, or turn-local memories.",
      ].join("\n\n"),
    },
  ]

  let memoryCompletion

  try {
    memoryCompletion = await createChatCompletion({
      baseUrl: args.baseUrl,
      apiKey: args.apiKey,
      model: args.mode.majorModel,
      temperature: ANALYSIS_TEMPERATURE,
      maxTokens: GLOBAL_MEMORY_MAX_TOKENS,
      enableThinking: args.enableThinking,
      slotId: args.slotId,
      responseFormat: buildGlobalMemoryResponseFormat(),
      signal: args.signal,
      messages,
    })
  } catch {
    memoryCompletion = await createChatCompletion({
      baseUrl: args.baseUrl,
      apiKey: args.apiKey,
      model: args.mode.majorModel,
      temperature: ANALYSIS_TEMPERATURE,
      maxTokens: GLOBAL_MEMORY_MAX_TOKENS,
      enableThinking: args.enableThinking,
      slotId: args.slotId,
      signal: args.signal,
      messages,
    })
  }

  return {
    memory: parseGlobalMemory(memoryCompletion.text, args.previousMemory),
    metrics: memoryCompletion.metrics,
    model: memoryCompletion.model,
  }
}

async function createNextTurnSessionSummary(args: {
  baseUrl: string
  apiKey?: string
  mode: IntelligentModeConfig
  history: IntelligentChatHistoryMessage[]
  analysis: ProblemAnalysis
  latestUserSummary: string
  finalAnswer: string
  stepResults: StepExecutionResult[]
  globalMemory?: IntelligentGlobalMemory
  currentSessionKey?: string
  signal: AbortSignal
  enableThinking: boolean
  slotId?: number
}) {
  const summaryCompletion = await createChatCompletion({
    baseUrl: args.baseUrl,
    apiKey: args.apiKey,
    model: args.mode.majorModel,
    temperature: ANALYSIS_TEMPERATURE,
    maxTokens: 320,
    enableThinking: args.enableThinking,
    slotId: args.slotId,
    signal: args.signal,
    messages: buildNextTurnSessionSummaryMessages({
      mode: args.mode,
      history: args.history,
      analysis: args.analysis,
      latestUserSummary: args.latestUserSummary,
      finalAnswer: args.finalAnswer,
      stepResults: args.stepResults,
      globalMemory: args.globalMemory,
      currentSessionKey: args.currentSessionKey,
    }),
  })

  return {
    summary: normalizeTurnSessionSummaryText(
      summaryCompletion.text,
      args.latestUserSummary
    ),
    model: summaryCompletion.model,
    metrics: summaryCompletion.metrics,
  }
}

async function createNextTurnSessionSummaryWithRetry(
  args: Parameters<typeof createNextTurnSessionSummary>[0]
) {
  let lastError: unknown

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await createNextTurnSessionSummary(args)
    } catch (error) {
      lastError = error
      if (attempt === 0 && !args.signal.aborted) {
        await sleep(150)
        continue
      }
    }
  }

  throw lastError
}

export async function POST(request: Request) {
  if (activeIntelligentRequest) {
    return Response.json(
      {
        error:
          "Intelligent mode is currently busy. Only one intelligent request can run at a time in this phase.",
      },
      { status: 409 }
    )
  }

  const baseUrl = getOpenAiCompatibleBaseUrl()
  const apiKey = getLlmApiKey()
  const mcpServerAuthToken = getMcpServerAuthToken()

  if (!baseUrl) {
    return Response.json(
      {
        error:
          "Missing provider base URL. Set OPENAI_COMPAT_BASE_URL or LLAMA_SERVER_BASE_URL in .env.local.",
      },
      { status: 500 }
    )
  }

  const config = await loadIntelligentConfig()
  if (!config) {
    return Response.json(
      { error: "Intelligent mode is not enabled." },
      { status: 400 }
    )
  }

  const body = (await request.json()) as IntelligentChatRequest
  const mode = config.modes[body.modeId]
  const mcpServerUrl = config.mcpServer
  const nativeSlotControlEnabled =
    getIntelligentBackendCapabilities().canUseNativeSlotControl

  if (!mode) {
    return Response.json(
      { error: `Unknown intelligent mode "${body.modeId}".` },
      { status: 400 }
    )
  }

  const message = body.message?.trim()
  if (!message) {
    return Response.json({ error: "Message is required." }, { status: 400 })
  }

  const globalMemory = sanitizeGlobalMemory(body.globalMemory, {
    userFeatures: [],
    instructionMemory: [],
    recentEvents: [],
    updatedAt: Date.now(),
  })
  const majorModelConfig = mode.models[mode.majorModel]
  const majorContextualSlotId = nativeSlotControlEnabled
    ? majorModelConfig?.slots?.contextual
    : undefined
  const majorStatelessSlotId = nativeSlotControlEnabled
    ? majorModelConfig?.slots?.stateless ?? majorContextualSlotId
    : undefined
  const currentSessionKey = getIntelligentSessionMemoryKey(body.conversationId)
  const requestTimeContext = getCurrentTimeContext(new Date())

  const latestHistoryItem = body.history[body.history.length - 1]
  const latestUserContent =
    latestHistoryItem?.role === "user" && Array.isArray(latestHistoryItem.content)
      ? latestHistoryItem.content
      : [
          {
            type: "text" as const,
            text: message,
          },
        ]
  const sessionSummary = trimPersistedSessionSummary(body.sessionSummary)
  const preAnalysisHeuristic = fallbackProblemAnalysis(message)
  const analysisReasoningMode = selectReasoningMode({
    mode,
    modelId: mode.majorModel,
    lane: "contextual",
    difficultyScore: preAnalysisHeuristic.difficultyScore,
    contextDependencyScore: preAnalysisHeuristic.contextDependencyScore,
    phaseKind: "analysis",
  })

  activeIntelligentRequest = true

  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (payload: IntelligentChatStreamEvent) => {
        controller.enqueue(encoder.encode(makeSseChunk(payload)))
      }

      try {
        let availableMcpTools: McpTool[] = []

        if (mcpServerUrl) {
          send({
            type: "phase",
            phase: {
              id: "mcp-tools",
              label: "Loading MCP tools",
              status: "active",
              detail: "Connecting to the configured MCP server and listing tools.",
              modelId: mode.majorModel,
              lane: "contextual",
            },
          })

          try {
            availableMcpTools = await listMcpTools(
              mcpServerUrl,
              request.signal,
              mcpServerAuthToken
            )

            if (!request.signal.aborted) {
              send({
                type: "phase",
                phase: {
                  id: "mcp-tools",
                  label: "Loading MCP tools",
                  status: "completed",
                  summary:
                    availableMcpTools.length > 0
                      ? `Loaded ${availableMcpTools.length} MCP tools.`
                      : "MCP server connected, but no tools were exposed.",
                  detail:
                    availableMcpTools.length > 0
                      ? availableMcpTools
                          .map((tool, index) => `${index + 1}. ${tool.name}`)
                          .join("\n")
                      : "No MCP tools are currently available from the configured server.",
                  modelId: mode.majorModel,
                  lane: "contextual",
                },
              })
            }
          } catch (mcpError) {
            if (!request.signal.aborted) {
              send({
                type: "phase",
                phase: {
                  id: "mcp-tools",
                  label: "Loading MCP tools",
                  status: "error",
                  summary: "MCP server could not be loaded.",
                  detail:
                    mcpError instanceof Error
                      ? mcpError.message
                      : "Failed to connect to the configured MCP server.",
                  modelId: mode.majorModel,
                  lane: "contextual",
                },
              })
            }
          }
        }

        send({
          type: "phase",
          phase: {
            id: "analysis",
            label: "Check user intent",
            status: "active",
            detail: "Running a lightweight gate for instant versus multi-step.",
            modelId: mode.majorModel,
            lane: "contextual",
            reasoningMode: analysisReasoningMode,
          },
        })

        const routingGateCompletion = await createStructuredRoutingGateCompletion({
          baseUrl,
          apiKey,
          mode,
          history: body.history,
          globalMemory,
          tools: availableMcpTools,
          currentSessionKey,
          model: mode.majorModel,
          maxTokens: ANALYSIS_MAX_TOKENS,
          enableThinking: analysisReasoningMode === "think",
          slotId: majorContextualSlotId,
          timeContext: requestTimeContext,
          signal: request.signal,
        })

        const routingGate = parseRoutingGate(routingGateCompletion.text, message)
        const route = decideRoute(
          routingGate,
          message,
          availableMcpTools.length > 0
        )

        send({
          type: "phase",
          phase: {
            id: "analysis",
            label: "Check user intent",
            status: "completed",
            detail: `${routingGate.gateSummary}\n\nRoute: ${route}.`,
            modelId: routingGateCompletion.model,
            lane: "contextual",
            reasoningMode: analysisReasoningMode,
            metrics: nativeSlotControlEnabled
              ? routingGateCompletion.metrics
              : undefined,
          },
        })

        send({
          type: "meta",
          meta: {
            modeId: mode.id,
            model: routingGateCompletion.model,
            route:
              route === "instant"
                ? "instant-major-lane"
                : "multi-step-routed-lanes",
          },
        })

        let instantAnswer = ""
        const instantAnalysis: ProblemAnalysis = {
          ...preAnalysisHeuristic,
          shouldUseMultiStep: false,
          recommendedStepCount: 1,
          analysisSummary: routingGate.gateSummary,
        }

        if (route === "instant") {
          const instantLane =
            instantAnalysis.contextDependencyScore >= HIGH_CONTEXT_THRESHOLD
              ? "contextual"
              : "stateless"
          const instantReasoningMode = selectReasoningMode({
            mode,
            modelId: mode.majorModel,
            lane: instantLane,
            difficultyScore: instantAnalysis.difficultyScore,
            contextDependencyScore: instantAnalysis.contextDependencyScore,
            phaseKind: "instant",
          })

          send({
            type: "phase",
            phase: {
              id: "instant-response",
              label: "Constructing response",
              status: "active",
              detail: `Direct answer via ${mode.majorModel}.`,
              modelId: mode.majorModel,
              lane: instantLane,
              reasoningMode: instantReasoningMode,
            },
          })

          const instantSlotId =
            instantAnalysis.contextDependencyScore >= HIGH_CONTEXT_THRESHOLD
              ? majorContextualSlotId
              : majorStatelessSlotId
          const usingInstantMcp = Boolean(
            mcpServerUrl && availableMcpTools.length > 0
          )

          const instantCompletion =
            usingInstantMcp
              ? await executeInstantWithMcp({
                  baseUrl,
                  apiKey,
                  serverUrl: mcpServerUrl!,
                  authToken: mcpServerAuthToken,
                  mode,
                  analysis: instantAnalysis,
                  history: body.history,
                  globalMemory,
                  sessionSummary:
                    instantAnalysis.contextDependencyScore < HIGH_CONTEXT_THRESHOLD
                      ? sessionSummary
                      : undefined,
                  tools: availableMcpTools,
                  currentSessionKey,
                  modelId: mode.majorModel,
                  reasoningMode: instantReasoningMode,
                  slotId: instantSlotId,
                  timeContext: requestTimeContext,
                  signal: request.signal,
                  onProgress: (status) => {
                    if (request.signal.aborted) {
                      return
                    }

                    send({
                      type: "phase",
                      phase: {
                        id: "instant-response",
                        label: "Constructing response",
                        status: "active",
                        summary: status,
                        detail: status,
                        modelId: mode.majorModel,
                        lane: instantLane,
                        reasoningMode: instantReasoningMode,
                      },
                    })
                  },
                  onToken: (text) => {
                    if (!request.signal.aborted) {
                      instantAnswer += text
                      send({ type: "token", text })
                    }
                  },
                })
              : await streamChatCompletion({
                  baseUrl,
                  apiKey,
                  model: mode.majorModel,
                  temperature: EXECUTION_TEMPERATURE,
                  enableThinking: instantReasoningMode === "think",
                  slotId: instantSlotId,
                  signal: request.signal,
                  messages: buildInstantMessages({
                    mode,
                    analysis: instantAnalysis,
                    history: body.history,
                    globalMemory,
                    sessionSummary:
                      instantAnalysis.contextDependencyScore < HIGH_CONTEXT_THRESHOLD
                        ? sessionSummary
                        : undefined,
                    tools: availableMcpTools,
                    currentSessionKey,
                    timeContext: requestTimeContext,
                  }),
                  onToken: (text) => {
                    if (!request.signal.aborted) {
                      instantAnswer += text
                      send({ type: "token", text })
                    }
                  },
                  emitReasoningToOutput: false,
                })

          const instantToolUses =
            "toolUses" in instantCompletion && Array.isArray(instantCompletion.toolUses)
              ? instantCompletion.toolUses
              : []

          const instantCompletionText =
            "text" in instantCompletion &&
            typeof instantCompletion.text === "string"
              ? instantCompletion.text.trim()
              : ""

          if (usingInstantMcp && !instantAnswer && instantCompletionText) {
            instantAnswer = instantCompletionText
            if (!request.signal.aborted) {
              send({ type: "token", text: instantAnswer })
            }
          }

          if (!usingInstantMcp && instantCompletionText) {
            instantAnswer = instantCompletionText
            if (instantAnswer && !request.signal.aborted) {
              send({ type: "token", text: instantAnswer })
            }
          }

          if (!request.signal.aborted) {
            send({
              type: "phase",
              phase: {
                id: "instant-response",
                label: "Constructing response",
                status: "completed",
                summary: summarizeToolUsesForPhaseSummary(instantToolUses) || undefined,
                detail: normalizePhaseDetail(
                  [
                    instantToolUses.length > 0
                      ? "Instant response completed with native tool use."
                      : "Instant response completed.",
                    formatToolUsesForPhaseDetail(instantToolUses),
                  ]
                    .filter(Boolean)
                    .join("\n\n")
                ),
                modelId: instantCompletion.model,
                lane: instantLane,
                reasoningMode: instantReasoningMode,
                metrics: nativeSlotControlEnabled
                  ? instantCompletion.metrics
                  : undefined,
              },
            })

            const summaryReasoningMode = selectReasoningMode({
              mode,
              modelId: mode.majorModel,
              lane:
                typeof majorStatelessSlotId === "number" ? "stateless" : "contextual",
              difficultyScore: instantAnalysis.difficultyScore,
              contextDependencyScore: instantAnalysis.contextDependencyScore,
              phaseKind: "summary",
            })
            const housekeepingSlotId = nativeSlotControlEnabled
              ? majorStatelessSlotId
              : undefined
            const housekeepingLane =
              typeof housekeepingSlotId === "number" ? "stateless" : "contextual"

            send({
              type: "phase",
              phase: {
                id: "session-summary",
                label: "Preparing session summary",
                status: "active",
                detail: "Preparing a compact session snapshot for the next user turn.",
                modelId: mode.majorModel,
                lane: housekeepingLane,
                reasoningMode: summaryReasoningMode,
              },
            })

            try {
              const nextSessionSummary = await createNextTurnSessionSummaryWithRetry({
                baseUrl,
                apiKey,
                mode,
                history: body.history,
                analysis: instantAnalysis,
                latestUserSummary: message,
                finalAnswer: instantAnswer,
                stepResults: [],
                globalMemory,
                currentSessionKey,
                signal: request.signal,
                enableThinking: summaryReasoningMode === "think",
                slotId: housekeepingSlotId,
              })
              if (!request.signal.aborted) {
                send({
                  type: "phase",
                  phase: {
                    id: "session-summary",
                    label: "Preparing session summary",
                    status: "completed",
                    detail: nextSessionSummary.summary,
                    modelId: nextSessionSummary.model,
                    lane: housekeepingLane,
                    reasoningMode: summaryReasoningMode,
                    metrics: nativeSlotControlEnabled
                      ? nextSessionSummary.metrics
                      : undefined,
                  },
                })
                send({
                  type: "session_summary",
                  summary: {
                    text: nextSessionSummary.summary,
                    updatedAt: Date.now(),
                  },
                })
              }
            } catch (summaryError) {
              const fallbackSummary = buildFallbackTurnSessionSummary(
                body.history,
                message
              )
              if (!request.signal.aborted) {
                send({
                  type: "phase",
                  phase: {
                    id: "session-summary",
                    label: "Preparing session summary",
                    status: "completed",
                    summary: "Used fallback summary after the upstream summary request failed.",
                    detail:
                      summaryError instanceof Error
                        ? `Upstream summary request failed: ${summaryError.message}\n\nFallback summary:\n${fallbackSummary}`
                        : `Fallback summary:\n${fallbackSummary}`,
                    modelId: mode.majorModel,
                    lane: housekeepingLane,
                    reasoningMode: summaryReasoningMode,
                  },
                })
                send({
                  type: "session_summary",
                  summary: {
                    text: fallbackSummary,
                    updatedAt: Date.now(),
                  },
                })
              }
            }

            const globalMemoryReasoningMode = selectReasoningMode({
              mode,
              modelId: mode.majorModel,
              lane: housekeepingLane,
              difficultyScore: instantAnalysis.difficultyScore,
              contextDependencyScore: instantAnalysis.contextDependencyScore,
              phaseKind: "memory",
            })

            send({
              type: "phase",
              phase: {
                id: "global-memory",
                label: "Updating global memory",
                status: "active",
                detail: hasGlobalMemory(globalMemory)
                  ? "Refreshing cross-session memory with the latest turn."
                  : "Creating the first cross-session memory entries.",
                modelId: mode.majorModel,
                lane: housekeepingLane,
                reasoningMode: globalMemoryReasoningMode,
              },
            })

            try {
              const nextGlobalMemory = await updateGlobalMemory({
                baseUrl,
                apiKey,
                mode,
                history: body.history,
                previousMemory: globalMemory,
                currentSessionKey,
                latestUserSummary: message,
                finalAnswer: instantAnswer,
                stepResults: [],
                signal: request.signal,
                enableThinking: globalMemoryReasoningMode === "think",
                slotId: housekeepingSlotId,
              })
              if (!request.signal.aborted) {
                send({
                  type: "phase",
                  phase: {
                    id: "global-memory",
                    label: "Updating global memory",
                    status: "completed",
                    detail: formatGlobalMemoryDetail(nextGlobalMemory.memory),
                    modelId: nextGlobalMemory.model,
                    lane: housekeepingLane,
                    reasoningMode: globalMemoryReasoningMode,
                    metrics: nativeSlotControlEnabled
                      ? nextGlobalMemory.metrics
                      : undefined,
                  },
                })
                send({
                  type: "global_memory",
                  memory: nextGlobalMemory.memory,
                })
              }
            } catch (memoryError) {
              if (!request.signal.aborted) {
                send({
                  type: "phase",
                  phase: {
                    id: "global-memory",
                    label: "Updating global memory",
                    status: "error",
                    detail:
                      memoryError instanceof Error
                        ? memoryError.message
                        : "Failed to update global memory.",
                    modelId: mode.majorModel,
                    lane: housekeepingLane,
                    reasoningMode: globalMemoryReasoningMode,
                  },
                })
              }
            }
            send({ type: "done" })
          }

          return
        }

        send({
          type: "phase",
          phase: {
            id: "problem-analysis",
            label: "Planning solutions",
            status: "active",
            detail: "Scoring difficulty and context dependency for the multi-step path.",
            modelId: mode.majorModel,
            lane: "contextual",
            reasoningMode: analysisReasoningMode,
          },
        })

        const analysisCompletion = await createStructuredAnalysisCompletion({
          baseUrl,
          apiKey,
          mode,
          history: body.history,
          globalMemory,
          tools: availableMcpTools,
          currentSessionKey,
          model: mode.majorModel,
          maxTokens: ANALYSIS_MAX_TOKENS,
          enableThinking: analysisReasoningMode === "think",
          slotId: majorContextualSlotId,
          timeContext: requestTimeContext,
          signal: request.signal,
        })

        const analysis = parseProblemAnalysis(analysisCompletion.text, message)

        send({
          type: "phase",
          phase: {
            id: "problem-analysis",
            label: "Planning solutions",
            status: "completed",
            detail: `Difficulty ${analysis.difficultyScore}/100, context ${analysis.contextDependencyScore}/100. ${analysis.analysisSummary}`,
            modelId: analysisCompletion.model,
            lane: "contextual",
            reasoningMode: analysisReasoningMode,
            metrics: nativeSlotControlEnabled
              ? analysisCompletion.metrics
              : undefined,
          },
        })

        const plannerReasoningMode = selectReasoningMode({
          mode,
          modelId: mode.majorModel,
          lane: "contextual",
          difficultyScore: analysis.difficultyScore,
          contextDependencyScore: analysis.contextDependencyScore,
          phaseKind: "planner",
        })

        send({
          type: "phase",
          phase: {
            id: "planner",
            label: "Planning steps",
            status: "active",
            detail: `Target ${analysis.recommendedStepCount} steps.`,
            modelId: mode.majorModel,
            lane: "contextual",
            reasoningMode: plannerReasoningMode,
          },
        })

        const plannerCompletion = await createStructuredPlannerCompletion({
          baseUrl,
          apiKey,
          mode,
          history: body.history,
          analysis,
          latestUserSummary: message,
          globalMemory,
          tools: availableMcpTools,
          currentSessionKey,
          model: mode.majorModel,
          maxTokens: PLANNER_MAX_TOKENS,
          enableThinking: plannerReasoningMode === "think",
          slotId: majorContextualSlotId,
          timeContext: requestTimeContext,
          signal: request.signal,
        })

        const plannedSteps = parsePlan(plannerCompletion.text, message, analysis)

        send({
          type: "phase",
          phase: {
            id: "planner",
            label: "Planning steps",
            status: "completed",
            detail: plannedSteps.map((step) => step.title).join(" -> "),
            modelId: plannerCompletion.model,
            lane: "contextual",
            reasoningMode: plannerReasoningMode,
            metrics: nativeSlotControlEnabled ? plannerCompletion.metrics : undefined,
          },
        })

        const stepResults: StepExecutionResult[] = []

        for (const step of plannedSteps) {
          if (request.signal.aborted) {
            break
          }

          const selectedExecution = selectModelAndLane(
            mode,
            step.difficultyScore,
            step.contextDependencyScore
          )
          const stepReasoningMode = selectReasoningMode({
            mode,
            modelId: selectedExecution.modelId,
            lane: selectedExecution.lane,
            difficultyScore: step.difficultyScore,
            contextDependencyScore: step.contextDependencyScore,
            phaseKind: "step",
          })

          send({
            type: "phase",
            phase: {
              id: step.id,
              label: step.title,
              status: "active",
              detail: `${step.objective} [${selectedExecution.modelId}, ${selectedExecution.lane}]`,
              modelId: selectedExecution.modelId,
              lane: selectedExecution.lane,
              reasoningMode: stepReasoningMode,
            },
          })

          send({
            type: "meta",
            meta: {
              modeId: mode.id,
              model: selectedExecution.modelId,
              route: `multi-step-step:${selectedExecution.lane}`,
            },
          })

          let stepToolUses: StepToolUseRecord[] = []

          const stepCompletion =
            mcpServerUrl && availableMcpTools.length > 0
              ? await executeStepWithMcp({
                  baseUrl,
                  apiKey,
                  serverUrl: mcpServerUrl,
                  mode,
                  history: body.history,
                  analysis,
                  step,
                  previousResults: stepResults,
                  latestUserContent,
                  latestUserSummary: message,
                  globalMemory,
                  sessionSummary,
                  tools: availableMcpTools,
                  currentSessionKey,
                  modelId: selectedExecution.modelId,
                  lane: selectedExecution.lane,
                  reasoningMode: stepReasoningMode,
                  authToken: mcpServerAuthToken,
                  slotId: nativeSlotControlEnabled
                    ? selectedExecution.slotId
                    : undefined,
                  timeContext: requestTimeContext,
                  signal: request.signal,
                  onProgress: (status) => {
                    if (request.signal.aborted) {
                      return
                    }

                    send({
                      type: "phase",
                      phase: {
                        id: step.id,
                        label: step.title,
                        status: "active",
                        summary: status,
                        detail: status,
                        modelId: selectedExecution.modelId,
                        lane: selectedExecution.lane,
                        reasoningMode: stepReasoningMode,
                      },
                    })
                  },
                })
              : await createChatCompletion({
                  baseUrl,
                  apiKey,
                  model: selectedExecution.modelId,
                  temperature: EXECUTION_TEMPERATURE,
                  maxTokens: STEP_MAX_TOKENS,
                  enableThinking: stepReasoningMode === "think",
                  slotId: nativeSlotControlEnabled
                    ? selectedExecution.slotId
                    : undefined,
                  signal: request.signal,
                  messages: buildStepExecutionMessages({
                    mode,
                    history: body.history,
                    analysis,
                    step,
                    previousResults: stepResults,
                    latestUserContent,
                    latestUserSummary: message,
                    globalMemory,
                    sessionSummary,
                    tools: availableMcpTools,
                    currentSessionKey,
                    timeContext: requestTimeContext,
                  }),
                })

          if ("toolUses" in stepCompletion && Array.isArray(stepCompletion.toolUses)) {
            stepToolUses = stepCompletion.toolUses
          }

          const structuredStepSummary = await createStructuredStepSummary({
            baseUrl,
            apiKey,
            mode,
            step,
            modelId: selectedExecution.modelId,
            lane: selectedExecution.lane,
            slotId:
              nativeSlotControlEnabled && selectedExecution.lane === "stateless"
                ? selectedExecution.slotId
                : nativeSlotControlEnabled
                  ? majorStatelessSlotId
                  : undefined,
            rawExecutionText: stepCompletion.text.trim(),
            toolUses: stepToolUses,
            analysis,
            signal: request.signal,
          })

          const result: StepExecutionResult = {
            step,
            modelId: selectedExecution.modelId,
            lane: selectedExecution.lane,
            reasoningMode: stepReasoningMode,
            briefSummary: structuredStepSummary.briefSummary,
            summary: structuredStepSummary.summary,
            toolUses: stepToolUses,
          }

          stepResults.push(result)

          send({
            type: "phase",
            phase: {
              id: step.id,
              label: step.title,
              status: "completed",
              summary: [
                summarizeToolUsesForPhaseSummary(stepToolUses),
                result.briefSummary,
              ]
                .filter(Boolean)
                .join(" "),
              detail: normalizePhaseDetail(
                [
                  result.summary,
                  formatToolUsesForPhaseDetail(stepToolUses),
                ]
                  .filter(Boolean)
                  .join("\n\n")
              ),
              modelId: stepCompletion.model,
              lane: selectedExecution.lane,
              reasoningMode: stepReasoningMode,
              metrics: nativeSlotControlEnabled ? stepCompletion.metrics : undefined,
            },
          })
        }

        if (request.signal.aborted) {
          return
        }

        const synthesisSelection = selectModelAndLane(
          mode,
          Math.max(analysis.difficultyScore, 60),
          Math.max(analysis.contextDependencyScore, 70)
        )
        const synthesisReasoningMode = selectReasoningMode({
          mode,
          modelId: synthesisSelection.modelId,
          lane: synthesisSelection.lane,
          difficultyScore: Math.max(analysis.difficultyScore, 60),
          contextDependencyScore: Math.max(analysis.contextDependencyScore, 70),
          phaseKind: "synthesis",
        })
        let synthesisAnswer = ""

        send({
          type: "phase",
          phase: {
            id: "synthesis",
            label: "Synthesizing final answer",
            status: "active",
            detail: `Combining ${stepResults.length} completed steps.`,
            modelId: synthesisSelection.modelId,
            lane: synthesisSelection.lane,
            reasoningMode: synthesisReasoningMode,
          },
        })

        send({
          type: "meta",
          meta: {
            modeId: mode.id,
            model: synthesisSelection.modelId,
            route: `multi-step-synthesis:${synthesisSelection.lane}`,
          },
        })

        if (!request.signal.aborted) {
          const synthesisCompletion = await streamChatCompletion({
            baseUrl,
            apiKey,
            model: synthesisSelection.modelId,
            temperature: EXECUTION_TEMPERATURE,
            enableThinking: synthesisReasoningMode === "think",
            slotId: nativeSlotControlEnabled
              ? synthesisSelection.slotId
              : undefined,
            signal: request.signal,
            messages: buildSynthesisMessages({
              mode,
              analysis,
              history: body.history,
              lane: synthesisSelection.lane,
              globalMemory,
              currentSessionKey,
              latestUserSummary: message,
              stepResults,
              tools: availableMcpTools,
              timeContext: requestTimeContext,
            }),
            onToken: (text) => {
              if (!request.signal.aborted) {
                synthesisAnswer += text
                send({ type: "token", text })
              }
            },
            emitReasoningToOutput: false,
          })

          send({
            type: "phase",
            phase: {
              id: "synthesis",
              label: "Synthesizing final answer",
              status: "completed",
              detail: "Multi-step response completed.",
              modelId: synthesisCompletion.model,
              lane: synthesisSelection.lane,
              reasoningMode: synthesisReasoningMode,
              metrics: nativeSlotControlEnabled
                ? synthesisCompletion.metrics
                : undefined,
            },
          })

          const summaryReasoningMode = selectReasoningMode({
            mode,
            modelId: mode.majorModel,
            lane:
              typeof majorStatelessSlotId === "number" ? "stateless" : "contextual",
            difficultyScore: analysis.difficultyScore,
            contextDependencyScore: analysis.contextDependencyScore,
            phaseKind: "summary",
          })
          const housekeepingSlotId = nativeSlotControlEnabled
            ? majorStatelessSlotId
            : undefined
          const housekeepingLane =
            typeof housekeepingSlotId === "number" ? "stateless" : "contextual"

          send({
            type: "phase",
            phase: {
              id: "session-summary",
              label: "Preparing session summary",
              status: "active",
              detail: "Preparing a compact session snapshot for the next user turn.",
              modelId: mode.majorModel,
              lane: housekeepingLane,
              reasoningMode: summaryReasoningMode,
            },
          })

          try {
            const nextSessionSummary = await createNextTurnSessionSummaryWithRetry({
              baseUrl,
              apiKey,
              mode,
              history: body.history,
              analysis,
              latestUserSummary: message,
              finalAnswer: synthesisAnswer,
              stepResults,
              globalMemory,
              currentSessionKey,
              signal: request.signal,
              enableThinking: summaryReasoningMode === "think",
              slotId: housekeepingSlotId,
            })

            if (!request.signal.aborted) {
              send({
                type: "phase",
                phase: {
                  id: "session-summary",
                  label: "Preparing session summary",
                  status: "completed",
                  detail: nextSessionSummary.summary,
                  modelId: nextSessionSummary.model,
                  lane: housekeepingLane,
                  reasoningMode: summaryReasoningMode,
                  metrics: nativeSlotControlEnabled
                    ? nextSessionSummary.metrics
                    : undefined,
                },
              })
              send({
                type: "session_summary",
                summary: {
                  text: nextSessionSummary.summary,
                  updatedAt: Date.now(),
                },
              })
            }
          } catch (summaryError) {
            const fallbackSummary = buildFallbackTurnSessionSummary(
              body.history,
              message
            )

            if (!request.signal.aborted) {
              send({
                type: "phase",
                phase: {
                  id: "session-summary",
                  label: "Preparing session summary",
                  status: "completed",
                  summary: "Used fallback summary after the upstream summary request failed.",
                  detail:
                    summaryError instanceof Error
                      ? `Upstream summary request failed: ${summaryError.message}\n\nFallback summary:\n${fallbackSummary}`
                      : `Fallback summary:\n${fallbackSummary}`,
                  modelId: mode.majorModel,
                  lane: housekeepingLane,
                  reasoningMode: summaryReasoningMode,
                },
              })
              send({
                type: "session_summary",
                summary: {
                  text: fallbackSummary,
                  updatedAt: Date.now(),
                },
              })
            }
          }

          const globalMemoryReasoningMode = selectReasoningMode({
            mode,
            modelId: mode.majorModel,
            lane: housekeepingLane,
            difficultyScore: analysis.difficultyScore,
            contextDependencyScore: analysis.contextDependencyScore,
            phaseKind: "memory",
          })

          send({
            type: "phase",
            phase: {
              id: "global-memory",
              label: "Updating global memory",
              status: "active",
              detail: hasGlobalMemory(globalMemory)
                ? "Refreshing cross-session memory with the latest turn."
                : "Creating the first cross-session memory entries.",
              modelId: mode.majorModel,
              lane: housekeepingLane,
              reasoningMode: globalMemoryReasoningMode,
            },
          })

          try {
            const nextGlobalMemory = await updateGlobalMemory({
              baseUrl,
              apiKey,
              mode,
              history: body.history,
              previousMemory: globalMemory,
              currentSessionKey,
              latestUserSummary: message,
              finalAnswer: synthesisAnswer,
              stepResults,
              signal: request.signal,
              enableThinking: globalMemoryReasoningMode === "think",
              slotId: housekeepingSlotId,
            })

            if (!request.signal.aborted) {
              send({
                type: "phase",
                phase: {
                  id: "global-memory",
                  label: "Updating global memory",
                  status: "completed",
                  detail: formatGlobalMemoryDetail(nextGlobalMemory.memory),
                  modelId: nextGlobalMemory.model,
                  lane: housekeepingLane,
                  reasoningMode: globalMemoryReasoningMode,
                  metrics: nativeSlotControlEnabled
                    ? nextGlobalMemory.metrics
                    : undefined,
                },
              })
              send({
                type: "global_memory",
                memory: nextGlobalMemory.memory,
              })
            }
          } catch (memoryError) {
            if (!request.signal.aborted) {
              send({
                type: "phase",
                phase: {
                  id: "global-memory",
                  label: "Updating global memory",
                  status: "error",
                  detail:
                    memoryError instanceof Error
                      ? memoryError.message
                      : "Failed to update global memory.",
                  modelId: mode.majorModel,
                  lane: housekeepingLane,
                  reasoningMode: globalMemoryReasoningMode,
                },
              })
            }
          }

          send({ type: "done" })
        }
      } catch (error) {
        if (!isAbortError(error) && !request.signal.aborted) {
          send({
            type: "error",
            error:
              error instanceof Error
                ? error.message
                : "Intelligent orchestration failed",
          })
        }
      } finally {
        activeIntelligentRequest = false

        if (mcpServerUrl) {
          invalidateMcpSession(mcpServerUrl)
        }

        try {
          controller.close()
        } catch {
          // ignore
        }
      }
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  })
}
