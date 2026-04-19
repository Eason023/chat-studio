import {
  getIntelligentBackendCapabilities,
  getLlmApiKey,
  getOpenAiCompatibleBaseUrl,
  type IntelligentModeConfig,
  loadIntelligentConfig,
} from "@/lib/intelligent-config"
import { callMcpTool, listMcpTools, type McpTool } from "@/lib/mcp-client"
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

type ProviderMessage = {
  role: "system" | "user" | "assistant"
  content: string | ProviderRequestContentPart[]
}

type UnknownRecord = Record<string, unknown>

type ProviderRequestContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }

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
}

type StepToolDecision = {
  action: "call_tool" | "finalize"
  briefStatus: string
  toolName?: string
  toolArguments?: Record<string, unknown>
  finalSummary?: string
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
const STEP_TOOL_DECISION_MAX_TOKENS = 900
const GLOBAL_MEMORY_MAX_TOKENS = 420
const INSTANT_THRESHOLD = 40
const MULTI_STEP_THRESHOLD = 58
const HIGH_CONTEXT_THRESHOLD = 60
const MEDIUM_CONTEXT_THRESHOLD = 40
const CONTEXTUAL_HISTORY_WINDOW = 8
const MEDIUM_HISTORY_WINDOW = 4
const LOW_HISTORY_WINDOW = 2
const SESSION_CAPSULE_HISTORY_WINDOW = 6
const SESSION_CAPSULE_CHAR_LIMIT = 1400
const MAX_STEP_TOOL_CALLS = 4
const GLOBAL_MEMORY_VALUE_CHAR_LIMIT = 280
const GLOBAL_MEMORY_CATEGORY_LIMITS: Record<
  IntelligentGlobalMemoryCategory,
  number
> = {
  userFeatures: 12,
  instructionMemory: 12,
  recentEvents: 10,
}
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

function normalizeMemoryText(value: unknown, maxLength = GLOBAL_MEMORY_VALUE_CHAR_LIMIT) {
  if (typeof value !== "string") {
    return ""
  }

  const compact = value.replace(/\s+/g, " ").trim()
  if (!compact) {
    return ""
  }

  return compact.length > maxLength ? `${compact.slice(0, maxLength)}...` : compact
}

function normalizeMemoryKey(value: unknown) {
  return normalizeMemoryText(value, 72)
}

function mergeGlobalMemoryEntries(
  value: unknown,
  category: IntelligentGlobalMemoryCategory,
  previousEntries: IntelligentGlobalMemoryEntry[] = []
) {
  if (!Array.isArray(value)) {
    return previousEntries
  }

  const previousByKey = new Map(
    previousEntries.map((entry) => [entry.key.toLowerCase(), entry])
  )
  const deduped = new Map<string, { key: string; value: string }>()

  for (const item of value) {
    if (!isRecord(item)) {
      continue
    }

    const key = normalizeMemoryKey(item.key)
    const memoryValue = normalizeMemoryText(item.value)

    if (!key || !memoryValue) {
      continue
    }

    deduped.set(key.toLowerCase(), {
      key,
      value: memoryValue,
    })
  }

  return Array.from(deduped.values())
    .slice(0, GLOBAL_MEMORY_CATEGORY_LIMITS[category])
    .map((entry) => {
      const previous = previousByKey.get(entry.key.toLowerCase())

      return {
        id: previous?.id ?? createGlobalMemoryEntryId(),
        key: entry.key,
        value: entry.value,
        updatedAt: Date.now(),
      }
    })
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
    userFeatures: mergeGlobalMemoryEntries(
      value.userFeatures,
      "userFeatures",
      previous.userFeatures
    ),
    instructionMemory: mergeGlobalMemoryEntries(
      value.instructionMemory,
      "instructionMemory",
      previous.instructionMemory
    ),
    recentEvents: mergeGlobalMemoryEntries(
      value.recentEvents,
      "recentEvents",
      previous.recentEvents
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

function formatGlobalMemorySection(
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
    formatGlobalMemorySection("User Features", memory?.userFeatures ?? []),
    formatGlobalMemorySection(
      "Instruction Memory",
      memory?.instructionMemory ?? []
    ),
    formatGlobalMemorySection("Recent Events", memory?.recentEvents ?? []),
  ].join("\n\n")
}

function buildGlobalMemoryContext(memory?: IntelligentGlobalMemory | null) {
  if (!hasGlobalMemory(memory)) {
    return ""
  }

  const lines = [
    "Cross-session global memory.",
    "Use this as durable background context, but let the current request override stale memory when they conflict.",
    "",
    "User features:",
    ...(memory?.userFeatures.length
      ? memory.userFeatures.map((entry) => `- ${entry.key}: ${entry.value}`)
      : ["- none"]),
    "",
    "Instruction memory:",
    ...(memory?.instructionMemory.length
      ? memory.instructionMemory.map((entry) => `- ${entry.key}: ${entry.value}`)
      : ["- none"]),
    "",
    "Recent events:",
    ...(memory?.recentEvents.length
      ? memory.recentEvents.map((entry) => `- ${entry.key}: ${entry.value}`)
      : ["- none"]),
  ]

  return lines.join("\n")
}

function buildLeadingSystemMessage(args: {
  base: string
  globalMemory?: IntelligentGlobalMemory | null
}): ProviderMessage {
  const sections = [
    args.base.trim(),
    buildGlobalMemoryContext(args.globalMemory),
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

function buildAnalysisResponseFormat() {
  return buildJsonSchemaResponseFormat("intelligent_analysis", {
    type: "object",
    description:
      "Structured routing analysis for the latest user request in Intelligent Mode.",
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
          "Short stable label for the memory item, such as preferred_language or active_project.",
      },
      value: {
        type: "string",
        description:
          "The memory content itself. Keep it concise, specific, and reusable.",
      },
    },
    required: ["key", "value"],
    additionalProperties: false,
  })

  return buildJsonSchemaResponseFormat("global_memory", {
    type: "object",
    description:
      "Cross-session durable memory. Omit low-confidence or low-value items instead of storing them.",
    properties: {
      userFeatures: {
        type: "array",
        description:
          "Only stable, distinctive user facts or enduring preferences the user clearly cares about and that will likely matter again. Leave empty when nothing truly qualifies.",
        items: memoryEntrySchema(
          "One durable user feature worth remembering across many future sessions."
        ),
      },
      instructionMemory: {
        type: "array",
        description:
          "Only recurring instructions or response preferences the user strongly values and is likely to expect again. Leave empty when uncertain.",
        items: memoryEntrySchema(
          "One durable instruction or response preference that should keep influencing future sessions."
        ),
      },
      recentEvents: {
        type: "array",
        description:
          "Only active cross-session context, ongoing work, or temporary priorities worth carrying forward. Order newest first and keep at most 10 items, replacing older events with newer ones when necessary.",
        items: memoryEntrySchema(
          "One current event or ongoing context item that may matter in near-future sessions."
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

function buildStepToolDecisionResponseFormat(toolNames: string[]) {
  return buildJsonSchemaResponseFormat("step_tool_decision", {
    type: "object",
    description:
      "The next action for an internal step. Use call_tool only when one of the provided MCP tools is genuinely needed.",
    properties: {
      action: {
        type: "string",
        enum: ["call_tool", "finalize"],
        description:
          "Choose call_tool to invoke one MCP tool now, or finalize when the step can conclude without another tool call.",
      },
      briefStatus: {
        type: "string",
        description:
          "One short sentence describing the current step progress for orchestration UI.",
      },
      toolName: {
        type: "string",
        enum: toolNames,
        description:
          "The MCP tool to call next. Required when action is call_tool.",
      },
      toolArguments: {
        type: "object",
        description:
          "JSON arguments for the selected MCP tool. Must match the tool input schema.",
        additionalProperties: true,
      },
      finalSummary: {
        type: "string",
        description:
          "The raw step conclusion to use when action is finalize. Do not include hidden chain-of-thought.",
      },
    },
    required: ["action", "briefStatus"],
    additionalProperties: false,
  })
}

function parseStepToolDecision(
  text: string,
  tools: McpTool[]
): StepToolDecision {
  const parsed = tryParseStructuredText(text)
  const toolNames = new Set(tools.map((tool) => tool.name))

  if (!isRecord(parsed)) {
    return {
      action: "finalize" as const,
      briefStatus: "Finalizing the step without tools.",
      finalSummary: text.trim(),
    }
  }

  const action =
    parsed.action === "call_tool" && toolNames.has(asString(parsed.toolName))
      ? "call_tool"
      : "finalize"
  const briefStatus = asString(
    parsed.briefStatus,
    action === "call_tool"
      ? `Calling MCP tool ${asString(parsed.toolName, "tool")}.`
      : "Finalizing the step."
  )

  if (action === "call_tool") {
    return {
      action,
      briefStatus,
      toolName: asString(parsed.toolName),
      toolArguments: isRecord(parsed.toolArguments) ? parsed.toolArguments : {},
    }
  }

  return {
    action,
    briefStatus,
    finalSummary: asString(parsed.finalSummary, text.trim()),
  }
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

function buildAnalysisMessages(args: {
  mode: IntelligentModeConfig
  history: IntelligentChatHistoryMessage[]
  globalMemory?: IntelligentGlobalMemory
  tools?: McpTool[]
}) {
  return [
    buildLeadingSystemMessage({
      base: createContextualLaneSystemPrompt(args.mode),
      globalMemory: args.globalMemory,
    }),
    ...toProviderMessages(args.history),
    {
      role: "user" as const,
      content: [
        createAnalysisSystemPrompt(),
        args.tools?.length
          ? `Available MCP tools:\n${formatMcpToolsForPrompt(args.tools)}`
          : "No MCP tools are available for this request.",
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
}) {
  return [
    buildLeadingSystemMessage({
      base: createContextualLaneSystemPrompt(args.mode),
      globalMemory: args.globalMemory,
    }),
    ...toProviderMessages(args.history),
    {
      role: "user" as const,
      content: [
        createPlannerSystemPrompt(args.analysis),
        `Latest user request: ${args.latestUserSummary}`,
        args.tools?.length
          ? `Available MCP tools:\n${formatMcpToolsForPrompt(args.tools)}`
          : "No MCP tools are available for this request.",
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
}) {
  return [
    buildLeadingSystemMessage({
      base: createContextualLaneSystemPrompt(args.mode),
      globalMemory: args.globalMemory,
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

function createAnalysisSystemPrompt() {
  return [
    "Current orchestration phase: analysis router.",
    "Analyze the latest user request and the surrounding conversation.",
    DIFFICULTY_RUBRIC,
    CONTEXT_RUBRIC,
    "Return JSON only. Do not use markdown fences.",
    'Required JSON shape: {"difficultyScore":0-100,"contextDependencyScore":0-100,"shouldUseMultiStep":boolean,"recommendedStepCount":1-4,"taskType":"string","analysisSummary":"string"}',
    "Choose multi-step only when it materially improves quality.",
    "Prefer instant replies for straightforward factual questions, simple rewriting, direct explanations, and short follow-up requests.",
    "Use higher contextDependencyScore when the answer depends on earlier conversation details.",
  ].join(" ")
}

function createContextualLaneSystemPrompt(mode: IntelligentModeConfig) {
  return [
    `You are the major contextual lane for Chat Studio Intelligent Mode "${mode.label}".`,
    `The current major model is "${mode.majorModel}".`,
    "This lane is reserved for phases that depend on prior session context and should preserve a stable prompt prefix.",
    "Treat the conversation history as the authoritative session state.",
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

function createStepToolDecisionSystemPrompt(
  mode: IntelligentModeConfig,
  step: PlannedStep
) {
  return [
    `You are deciding whether the internal step "${step.title}" in Chat Studio Intelligent Mode "${mode.label}" should call an MCP tool or finalize.`,
    "Use MCP tools only when they materially help complete the step.",
    "If a tool is not clearly needed, finalize instead of calling a tool.",
    "Never invent tool names or arguments outside the provided tool catalog.",
    "Do not expose hidden chain-of-thought. Return only the structured decision.",
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

async function createStructuredAnalysisCompletion(args: {
  baseUrl: string
  apiKey?: string
  mode: IntelligentModeConfig
  history: IntelligentChatHistoryMessage[]
  globalMemory?: IntelligentGlobalMemory
  tools?: McpTool[]
  model: string
  maxTokens: number
  enableThinking: boolean
  slotId?: number
  signal: AbortSignal
}) {
  const messages = buildAnalysisMessages({
    mode: args.mode,
    history: args.history,
    globalMemory: args.globalMemory,
    tools: args.tools,
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
  model: string
  maxTokens: number
  enableThinking: boolean
  slotId?: number
  signal: AbortSignal
}) {
  const messages = buildPlannerMessages({
    mode: args.mode,
    history: args.history,
    analysis: args.analysis,
    latestUserSummary: args.latestUserSummary,
    globalMemory: args.globalMemory,
    tools: args.tools,
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
    "Do not expose internal planner steps unless they genuinely help the user.",
  ].join(" ")
}

function createGlobalMemorySystemPrompt(mode: IntelligentModeConfig) {
  return [
    `You maintain cross-session global memory for Chat Studio Intelligent Mode "${mode.label}".`,
    "Update the memory so future sessions can recover durable information without replaying old chats.",
    "Use three categories only:",
    "userFeatures: only stable, distinctive facts or enduring preferences the user clearly cares about and that will likely matter again.",
    "instructionMemory: only durable instructions or response preferences the user strongly values and will likely expect again.",
    "recentEvents: only active cross-session context, ongoing projects, or temporary priorities that may matter soon.",
    "Keep the memory compact, high-signal, and non-redundant.",
    "If an item is ordinary, low-confidence, weakly implied, or probably one-off, omit it instead of storing it.",
    "Be conservative: most turns should add little or nothing to userFeatures or instructionMemory.",
    "For recentEvents, keep only the newest 10 items and replace older ones when newer events matter more.",
    "Do not store the entire session summary.",
    "Return JSON only with this exact shape:",
    '{"userFeatures":[{"key":"string","value":"string"}],"instructionMemory":[{"key":"string","value":"string"}],"recentEvents":[{"key":"string","value":"string"}]}',
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
  signal: AbortSignal
}) {
  const headers = buildAuthHeaders(args.apiKey)
  headers.set("Content-Type", "application/json")

  const response = await fetch(
    `${args.baseUrl.replace(/\/$/, "")}/chat/completions`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: args.model,
        stream: false,
        messages: args.messages,
        temperature: args.temperature,
        max_tokens: args.maxTokens,
        ...(typeof args.slotId === "number" ? { id_slot: args.slotId } : {}),
        ...(args.responseFormat
          ? {
              response_format: args.responseFormat,
            }
          : {}),
        chat_template_kwargs: {
          enable_thinking: Boolean(args.enableThinking),
        },
      }),
      signal: args.signal,
    }
  )

  if (!response.ok) {
    const details = await response.text()
    throw new Error(details || "Upstream completion request failed")
  }

  const payload = (await response.json()) as UpstreamCompletionResponse
  const text = extractCompletionText(payload.choices?.[0]?.message)

  if (!text.trim()) {
    throw new Error("Upstream completion returned empty content")
  }

  return {
    text,
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

  const response = await fetch(
    `${args.baseUrl.replace(/\/$/, "")}/chat/completions`,
    {
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
        ...(typeof args.slotId === "number" ? { id_slot: args.slotId } : {}),
        chat_template_kwargs: {
          enable_thinking: Boolean(args.enableThinking),
        },
      }),
      signal: args.signal,
    }
  )

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

function decideRoute(analysis: ProblemAnalysis) {
  const forcedMultiStep =
    analysis.shouldUseMultiStep || analysis.recommendedStepCount > 1

  if (forcedMultiStep && analysis.difficultyScore >= INSTANT_THRESHOLD) {
    return "multi-step" as const
  }

  if (analysis.difficultyScore >= MULTI_STEP_THRESHOLD) {
    return "multi-step" as const
  }

  return "instant" as const
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
}) {
  const historyWindow = getHistoryWindowForDependency(
    args.step.contextDependencyScore
  )
  const isLowContext = args.step.contextDependencyScore < MEDIUM_CONTEXT_THRESHOLD
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
    }),
    ...historyMessages,
    {
      role: "user" as const,
      content: [
        isHighContext
          ? `Current orchestration phase: execute internal step "${args.step.title}".`
          : "",
        `Global analysis summary: ${args.analysis.analysisSummary}`,
        args.sessionSummary
          ? `Session summary from the previous turn:\n${args.sessionSummary}`
          : "",
        `Current step objective: ${args.step.objective}`,
        `Step difficulty score: ${args.step.difficultyScore}/100`,
        `Step context dependency score: ${args.step.contextDependencyScore}/100`,
        !isLowContext ? `Latest user request summary: ${args.latestUserSummary}` : "",
        !isLowContext
          ? `Latest user content:\n${
              typeof partsToProviderContent(args.latestUserContent) === "string"
                ? partsToProviderContent(args.latestUserContent)
                : "The latest request includes multimodal attachments."
            }`
          : "",
        `Prior completed work:\n${priorResultsBlock}`,
        "Return a concise execution summary with the main findings and what should matter to the final synthesis.",
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
  ]
}

function buildStepToolDecisionMessages(args: {
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
  toolUses: StepToolUseRecord[]
}) {
  const historyWindow = getHistoryWindowForDependency(
    args.step.contextDependencyScore
  )
  const isLowContext = args.step.contextDependencyScore < MEDIUM_CONTEXT_THRESHOLD
  const isHighContext =
    args.step.contextDependencyScore >= HIGH_CONTEXT_THRESHOLD
  const slicedHistory = isHighContext
    ? args.history
    : sliceHistoryTail(args.history, historyWindow)
  const historyMessages =
    args.step.contextDependencyScore >= MEDIUM_CONTEXT_THRESHOLD
      ? toProviderMessages(slicedHistory)
      : []

  const priorResultsBlock =
    args.previousResults.length > 0
      ? args.previousResults
          .map(
            (item, index) =>
              `Previous step ${index + 1}: ${item.step.title} (${item.modelId}, ${item.lane})\n${item.summary}`
          )
          .join("\n\n")
      : "No previous step results."
  const toolUseBlock =
    args.toolUses.length > 0
      ? args.toolUses
          .map(
            (item, index) =>
              `Tool call ${index + 1}: ${item.toolName}\nArguments: ${JSON.stringify(
                item.toolArguments,
                null,
                2
              )}\nStatus: ${item.isError ? "error" : "success"}\nResult:\n${truncateContextBlock(
                item.resultText
              )}`
          )
          .join("\n\n")
      : "No MCP tools have been called yet."

  return [
    buildLeadingSystemMessage({
      base: isHighContext
        ? createContextualLaneSystemPrompt(args.mode)
        : createStepToolDecisionSystemPrompt(args.mode, args.step),
      globalMemory: args.globalMemory,
    }),
    ...historyMessages,
    {
      role: "user" as const,
      content: [
        isHighContext
          ? createStepToolDecisionSystemPrompt(args.mode, args.step)
          : "",
        `Global analysis summary: ${args.analysis.analysisSummary}`,
        args.sessionSummary
          ? `Session summary from the previous turn:\n${args.sessionSummary}`
          : "",
        `Current step objective: ${args.step.objective}`,
        `Step difficulty score: ${args.step.difficultyScore}/100`,
        `Step context dependency score: ${args.step.contextDependencyScore}/100`,
        !isLowContext ? `Latest user request summary: ${args.latestUserSummary}` : "",
        !isLowContext
          ? `Latest user content:\n${
              typeof partsToProviderContent(args.latestUserContent) === "string"
                ? partsToProviderContent(args.latestUserContent)
                : "The latest request includes multimodal attachments."
            }`
          : "",
        `Prior completed work:\n${priorResultsBlock}`,
        `Available MCP tools:\n${formatMcpToolsForPrompt(args.tools)}`,
        `Previous MCP tool results:\n${toolUseBlock}`,
        "Choose call_tool only if another MCP tool invocation is genuinely necessary.",
        "Otherwise finalize with the best raw step conclusion you can produce now.",
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
}) {
  const isHighContext =
    args.analysis.contextDependencyScore >= HIGH_CONTEXT_THRESHOLD

  return [
    buildLeadingSystemMessage({
      base: isHighContext
        ? createContextualLaneSystemPrompt(args.mode)
        : createInstantSystemPrompt(args.mode, args.analysis),
      globalMemory: args.globalMemory,
    }),
    ...toProviderMessages(
      isHighContext
        ? args.history
        : sliceHistoryTail(
            args.history,
            getHistoryWindowForDependency(args.analysis.contextDependencyScore)
          )
    ),
    ...(isHighContext
      ? [
          {
            role: "user" as const,
            content: [
              createInstantSystemPrompt(args.mode, args.analysis),
              "Write the final user-facing answer now.",
            ].join("\n\n"),
          },
        ]
      : []),
    ...(args.sessionSummary
      ? [
          {
            role: "user" as const,
            content: `Session summary from the previous turn:\n${args.sessionSummary}`,
          },
        ]
      : []),
  ]
}

function buildSynthesisMessages(args: {
  mode: IntelligentModeConfig
  analysis: ProblemAnalysis
  globalMemory?: IntelligentGlobalMemory
  latestUserSummary: string
  stepResults: StepExecutionResult[]
}) {
  return [
    buildLeadingSystemMessage({
      base: createSynthesisSystemPrompt(args.mode, args.analysis),
      globalMemory: args.globalMemory,
    }),
    {
      role: "user" as const,
      content: [
        `Original request: ${args.latestUserSummary}`,
        `Analysis summary: ${args.analysis.analysisSummary}`,
        "Completed step results:",
        args.stepResults
          .map(
            (result, index) =>
              `${index + 1}. ${result.step.title} (${result.modelId}, ${result.lane}, ${result.reasoningMode})\n${result.summary}`
          )
          .join("\n\n"),
        "Write the final user-facing answer now.",
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
  ]
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
  modelId: string
  lane: "contextual" | "stateless"
  reasoningMode: IntelligentReasoningMode
  slotId?: number
  signal: AbortSignal
  onProgress?: (status: string) => void
}) {
  const aggregatedMetrics: Array<IntelligentPhaseMetrics | undefined> = []
  const toolUses: StepToolUseRecord[] = []
  const responseFormat = buildStepToolDecisionResponseFormat(
    args.tools.map((tool) => tool.name)
  )

  for (let attempt = 0; attempt < MAX_STEP_TOOL_CALLS; attempt += 1) {
    const decisionMessages = buildStepToolDecisionMessages({
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
      toolUses,
    })

    let decisionCompletion

    try {
      decisionCompletion = await createChatCompletion({
        baseUrl: args.baseUrl,
        apiKey: args.apiKey,
        model: args.modelId,
        messages: decisionMessages,
        temperature: ANALYSIS_TEMPERATURE,
        maxTokens: STEP_TOOL_DECISION_MAX_TOKENS,
        enableThinking: args.reasoningMode === "think",
        slotId: args.slotId,
        responseFormat,
        signal: args.signal,
      })
    } catch {
      decisionCompletion = await createChatCompletion({
        baseUrl: args.baseUrl,
        apiKey: args.apiKey,
        model: args.modelId,
        messages: [
          ...decisionMessages,
          {
            role: "user",
            content:
              'Return JSON only with this exact shape: {"action":"call_tool|finalize","briefStatus":"string","toolName":"string","toolArguments":{},"finalSummary":"string"}',
          },
        ],
        temperature: ANALYSIS_TEMPERATURE,
        maxTokens: STEP_TOOL_DECISION_MAX_TOKENS,
        enableThinking: args.reasoningMode === "think",
        slotId: args.slotId,
        signal: args.signal,
      })
    }

    aggregatedMetrics.push(decisionCompletion.metrics)

    const decision = parseStepToolDecision(decisionCompletion.text, args.tools)
    args.onProgress?.(decision.briefStatus)

    if (decision.action === "finalize") {
      return {
        text:
          asString(decision.finalSummary, "").trim() ||
          "Step finalized without additional detail.",
        model: decisionCompletion.model,
        metrics: mergePhaseMetrics(aggregatedMetrics),
      }
    }

    const toolResult = await callMcpTool({
      serverUrl: args.serverUrl,
      toolName: decision.toolName ?? "",
      toolArguments: decision.toolArguments,
      signal: args.signal,
    })

    toolUses.push({
      toolName: decision.toolName ?? "unknown-tool",
      toolArguments: decision.toolArguments ?? {},
      resultText: toolResult.contentText,
      isError: toolResult.isError,
    })

    args.onProgress?.(
      `${decision.toolName ?? "tool"} returned ${
        toolResult.isError ? "an error" : "a result"
      }.`
    )
  }

  return {
    text: [
      `Tool loop limit reached after ${MAX_STEP_TOOL_CALLS} MCP calls.`,
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
  }
}

async function updateGlobalMemory(args: {
  baseUrl: string
  apiKey?: string
  mode: IntelligentModeConfig
  history: IntelligentChatHistoryMessage[]
  previousMemory?: IntelligentGlobalMemory
  latestUserSummary: string
  finalAnswer: string
  stepResults: StepExecutionResult[]
  signal: AbortSignal
  enableThinking: boolean
  slotId?: number
}) {
  const messages: ProviderMessage[] = [
    buildLeadingSystemMessage({
      base: createGlobalMemorySystemPrompt(args.mode),
      globalMemory: args.previousMemory,
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
            availableMcpTools = await listMcpTools(mcpServerUrl, request.signal)

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
            label: "Checking user intent",
            status: "active",
            detail: "Scoring difficulty and context dependency.",
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
          model: mode.majorModel,
          maxTokens: ANALYSIS_MAX_TOKENS,
          enableThinking: analysisReasoningMode === "think",
          slotId: majorContextualSlotId,
          signal: request.signal,
        })

        const analysis = parseProblemAnalysis(analysisCompletion.text, message)
        const route = decideRoute(analysis)

        send({
          type: "phase",
          phase: {
            id: "analysis",
            label: "Checking user intent",
            status: "completed",
            detail: `Difficulty ${analysis.difficultyScore}/100, context ${analysis.contextDependencyScore}/100, route ${route}.`,
            modelId: analysisCompletion.model,
            lane: "contextual",
            reasoningMode: analysisReasoningMode,
            metrics: nativeSlotControlEnabled
              ? analysisCompletion.metrics
              : undefined,
          },
        })

        send({
          type: "meta",
          meta: {
            modeId: mode.id,
            model: analysisCompletion.model,
            route:
              route === "instant"
                ? "instant-major-lane"
                : "multi-step-routed-lanes",
          },
        })

        let instantAnswer = ""

        if (route === "instant") {
          const instantLane =
            analysis.contextDependencyScore >= HIGH_CONTEXT_THRESHOLD
              ? "contextual"
              : "stateless"
          const instantReasoningMode = selectReasoningMode({
            mode,
            modelId: mode.majorModel,
            lane: instantLane,
            difficultyScore: analysis.difficultyScore,
            contextDependencyScore: analysis.contextDependencyScore,
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

          const instantCompletion = await streamChatCompletion({
            baseUrl,
            apiKey,
            model: mode.majorModel,
            temperature: EXECUTION_TEMPERATURE,
            enableThinking: instantReasoningMode === "think",
            slotId:
              analysis.contextDependencyScore >= HIGH_CONTEXT_THRESHOLD
                ? majorContextualSlotId
                : majorStatelessSlotId,
            signal: request.signal,
            messages: buildInstantMessages({
              mode,
              analysis,
              history: body.history,
              globalMemory,
              sessionSummary:
                analysis.contextDependencyScore < HIGH_CONTEXT_THRESHOLD
                  ? sessionSummary
                  : undefined,
            }),
            onToken: (text) => {
              if (!request.signal.aborted) {
                instantAnswer += text
                send({ type: "token", text })
              }
            },
            emitReasoningToOutput: false,
          })

          if (!request.signal.aborted) {
            send({
              type: "phase",
              phase: {
                id: "instant-response",
                label: "Constructing response",
                status: "completed",
                detail: "Instant response completed.",
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
              lane: "contextual",
              difficultyScore: analysis.difficultyScore,
              contextDependencyScore: analysis.contextDependencyScore,
              phaseKind: "summary",
            })

            send({
              type: "phase",
              phase: {
                id: "session-summary",
                label: "Preparing session summary",
                status: "active",
                detail: "Preparing a compact session snapshot for the next user turn.",
                modelId: mode.majorModel,
                lane: "contextual",
                reasoningMode: summaryReasoningMode,
              },
            })

            try {
              const nextSessionSummary = await createNextTurnSessionSummary({
                baseUrl,
                apiKey,
                mode,
                history: body.history,
                analysis,
                latestUserSummary: message,
                finalAnswer: instantAnswer,
                stepResults: [],
                globalMemory,
                signal: request.signal,
                enableThinking: summaryReasoningMode === "think",
                slotId: majorContextualSlotId,
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
                    lane: "contextual",
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
                    status: "error",
                    detail:
                      summaryError instanceof Error
                        ? `${summaryError.message}\n\nFallback summary:\n${fallbackSummary}`
                        : `Fallback summary:\n${fallbackSummary}`,
                    modelId: mode.majorModel,
                    lane: "contextual",
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
              lane: "contextual",
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
                lane: "contextual",
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
                latestUserSummary: message,
                finalAnswer: instantAnswer,
                stepResults: [],
                signal: request.signal,
                enableThinking: globalMemoryReasoningMode === "think",
                slotId: majorContextualSlotId,
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
                    lane: "contextual",
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
                    lane: "contextual",
                    reasoningMode: globalMemoryReasoningMode,
                  },
                })
              }
            }
            send({ type: "done" })
          }

          return
        }

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
          model: mode.majorModel,
          maxTokens: PLANNER_MAX_TOKENS,
          enableThinking: plannerReasoningMode === "think",
          slotId: majorContextualSlotId,
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
                  modelId: selectedExecution.modelId,
                  lane: selectedExecution.lane,
                  reasoningMode: stepReasoningMode,
                  slotId: nativeSlotControlEnabled
                    ? selectedExecution.slotId
                    : undefined,
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
                  }),
                })

          const structuredStepSummary = await createStructuredStepSummary({
            baseUrl,
            apiKey,
            mode,
            step,
            modelId: selectedExecution.modelId,
            lane: selectedExecution.lane,
            slotId: nativeSlotControlEnabled ? selectedExecution.slotId : undefined,
            rawExecutionText: stepCompletion.text.trim(),
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
          }

          stepResults.push(result)

          send({
            type: "phase",
            phase: {
              id: step.id,
              label: step.title,
              status: "completed",
              summary: result.briefSummary,
              detail: normalizePhaseDetail(result.summary),
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
              globalMemory,
              latestUserSummary: message,
              stepResults,
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
            lane: "contextual",
            difficultyScore: analysis.difficultyScore,
            contextDependencyScore: analysis.contextDependencyScore,
            phaseKind: "summary",
          })

          send({
            type: "phase",
            phase: {
              id: "session-summary",
              label: "Preparing session summary",
              status: "active",
              detail: "Preparing a compact session snapshot for the next user turn.",
              modelId: mode.majorModel,
              lane: "contextual",
              reasoningMode: summaryReasoningMode,
            },
          })

          try {
            const nextSessionSummary = await createNextTurnSessionSummary({
              baseUrl,
              apiKey,
              mode,
              history: body.history,
              analysis,
              latestUserSummary: message,
              finalAnswer: synthesisAnswer,
              stepResults,
              globalMemory,
              signal: request.signal,
              enableThinking: summaryReasoningMode === "think",
              slotId: majorContextualSlotId,
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
                  lane: "contextual",
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
                  status: "error",
                  detail:
                    summaryError instanceof Error
                      ? `${summaryError.message}\n\nFallback summary:\n${fallbackSummary}`
                      : `Fallback summary:\n${fallbackSummary}`,
                  modelId: mode.majorModel,
                  lane: "contextual",
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
            lane: "contextual",
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
              lane: "contextual",
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
              latestUserSummary: message,
              finalAnswer: synthesisAnswer,
              stepResults,
              signal: request.signal,
              enableThinking: globalMemoryReasoningMode === "think",
              slotId: majorContextualSlotId,
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
                  lane: "contextual",
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
                  lane: "contextual",
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
