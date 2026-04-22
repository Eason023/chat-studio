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
  recommendedStepCount: number
  taskType: string
  groundingNeed: "low" | "medium" | "high"
  complexityFactors: string[]
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
  needsFullContext: boolean
  groundingNeed: "low" | "medium" | "high"
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

const ANALYSIS_TEMPERATURE = 0.1
const EXECUTION_TEMPERATURE = 0.3
const GATE_MAX_TOKENS = 180
const ANALYSIS_MAX_TOKENS = 520
const PLANNER_MAX_TOKENS = 1400
const STEP_MAX_TOKENS = 8192
const STEP_SUMMARY_MAX_TOKENS = 4096
const GLOBAL_MEMORY_MAX_TOKENS = 420
const TOOL_RESULT_CONVERSATION_CHAR_LIMIT = 8000
const MULTI_STEP_THRESHOLD = 64
const SESSION_CAPSULE_CHAR_LIMIT = 1400
const MAX_STEP_TOOL_CALLS = 4
const USER_FEATURE_MEMORY_LIMIT = 12
const INSTRUCTION_MEMORY_LIMIT = 12
const RECENT_EVENT_MEMORY_LIMIT = 10
const THINKING_DIFFICULTY_FLOOR = 92
const THINKING_SCORE_THRESHOLD = 98
const DIFFICULTY_RUBRIC = [
  "Difficulty scoring rubric:",
  "0-20: greetings, simple factual questions, trivial formatting, or direct one-shot requests.",
  "21-40: short explanations, basic summarization, lightweight follow-ups, or straightforward rewrites.",
  "41-60: moderate reasoning, multi-constraint comparisons, or requests that need some structured thought.",
  "61-80: debugging, implementation planning, non-trivial math, code changes, or tasks with several moving parts.",
  "81-100: deep architecture, proof-like reasoning, cross-step synthesis, or hard tasks where failure is costly.",
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
    return Math.max(1, Math.min(10, Math.round(value)))
  }

  if (typeof value === "string") {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) {
      return Math.max(1, Math.min(10, Math.round(parsed)))
    }
  }

  return fallback
}

function asString(value: unknown, fallback = "") {
  if (typeof value !== "string") return fallback
  const trimmed = value.trim()
  return trimmed || fallback
}

function normalizeGroundingNeed(
  value: unknown,
  fallback: "low" | "medium" | "high" = "low"
) {
  const normalized = asString(value).toLowerCase()
  if (
    normalized === "low" ||
    normalized === "medium" ||
    normalized === "high"
  ) {
    return normalized
  }

  return fallback
}

function normalizeStringArray(
  value: unknown,
  maxItems = 6,
  fallback: string[] = []
) {
  if (!Array.isArray(value)) {
    return fallback
  }

  return value
    .map((item) => asString(item))
    .filter(Boolean)
    .slice(0, maxItems)
}

function estimateRecommendedStepCount(
  difficultyScore: number,
  groundingNeed: "low" | "medium" | "high",
  complexityFactorCount = 0
) {
  let count = 2

  if (difficultyScore >= 72) count += 1
  if (difficultyScore >= 82) count += 1
  if (difficultyScore >= 90) count += 1
  if (difficultyScore >= 96) count += 1

  if (groundingNeed === "medium") count += 1
  if (groundingNeed === "high") count += 2

  count += Math.min(3, Math.max(0, complexityFactorCount - 1))

  return Math.max(2, Math.min(10, count))
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

  const previousByIdentity = new Map(
    previousEntries.map((entry) => [
      `${entry.key.toLowerCase()}\u0000${entry.value.toLowerCase()}`,
      entry,
    ])
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

      const previous = previousByIdentity.get(
        `${key.toLowerCase()}\u0000${memoryValue.toLowerCase()}`
      )

      return {
        id: previous?.id ?? createGlobalMemoryEntryId(),
        key,
        value: memoryValue,
        updatedAt: previous?.updatedAt ?? Date.now(),
      } satisfies IntelligentGlobalMemoryEntry
    })
    .filter((entry): entry is IntelligentGlobalMemoryEntry => Boolean(entry))

  return dedupeIntelligentMemoryEntries(
    [...parsedEntries, ...previousEntries],
    category
  ).slice(0, limit)
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
      USER_FEATURE_MEMORY_LIMIT
    ),
    instructionMemory: sanitizeMemoryEntries(
      value.instructionMemory,
      previous.instructionMemory,
      "instructionMemory",
      INSTRUCTION_MEMORY_LIMIT
    ),
    recentEvents: sanitizeMemoryEntries(
      value.recentEvents,
      previous.recentEvents,
      "recentEvents",
      RECENT_EVENT_MEMORY_LIMIT
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

  const filterCurrentSessionEntries = (
    entries: IntelligentGlobalMemoryEntry[] = []
  ) =>
    entries.filter((entry) =>
      currentSessionKey ? entry.key !== currentSessionKey : true
    )

  const userFeatures = filterCurrentSessionEntries(memory?.userFeatures)
  const instructionMemory = filterCurrentSessionEntries(memory?.instructionMemory)
  const recentEvents = filterCurrentSessionEntries(memory?.recentEvents)

  if (
    userFeatures.length === 0 &&
    instructionMemory.length === 0 &&
    recentEvents.length === 0
  ) {
    return ""
  }

  const lines = [
    "Cross-session memory bank.",
    "Each memory tier uses session-keyed entries. The bank is provided verbatim for cross-session recall.",
    "",
    "User Features:",
    ...(userFeatures.length
      ? userFeatures.map((entry) => `- ${entry.key}: ${entry.value}`)
      : ["- none"]),
    "",
    "Instruction Memory:",
    ...(instructionMemory.length
      ? instructionMemory.map((entry) => `- ${entry.key}: ${entry.value}`)
      : ["- none"]),
    "",
    "Recent Events:",
    ...(recentEvents.length
      ? recentEvents.map((entry) => `- ${entry.key}: ${entry.value}`)
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

function buildStepSharedRequestContext(args: {
  analysis: ProblemAnalysis
  latestUserContentText: string
  sessionSummary?: string
  includeSessionSummary?: boolean
}) {
  return [
    "Shared stateless request context:",
    `Global analysis summary: ${args.analysis.analysisSummary}`,
    `Overall grounding need: ${args.analysis.groundingNeed}`,
    args.analysis.complexityFactors.length > 0
      ? `Primary complexity factors:\n- ${args.analysis.complexityFactors.join(
          "\n- "
        )}`
      : "",
    args.includeSessionSummary
      ? `Previous-turn session note:\n${
          args.sessionSummary || "No previous-turn session note is available."
        }`
      : "",
    `Latest user content:\n${args.latestUserContentText}`,
  ]
    .filter(Boolean)
    .join("\n\n")
}

function buildStepSpecificContext(args: {
  step: PlannedStep
  priorResultsBlock: string
}) {
  return [
    "Current step details:",
    `Step title: ${args.step.title}`,
    `Step objective: ${args.step.objective}`,
    `Step difficulty score: ${args.step.difficultyScore}/100`,
    `Step grounding need: ${args.step.groundingNeed}`,
    `Step needs full major-lane context: ${args.step.needsFullContext ? "yes" : "no"}`,
    `Prior completed work:\n${args.priorResultsBlock}`,
    "Return a concise execution summary with the main findings and what should matter to the final synthesis.",
  ].join("\n\n")
}

function buildStepSummaryContext(args: {
  step: PlannedStep
  analysisSummary: string
  rawExecutionText: string
  toolUses?: StepToolUseRecord[]
}) {
  return [
    "Completed step details:",
    `Step title: ${args.step.title}`,
    `Step objective: ${args.step.objective}`,
    `Step grounding need: ${args.step.groundingNeed}`,
    `Analysis summary: ${args.analysisSummary}`,
    "Convert the raw step work into a clean structured summary.",
    "Do not repeat chain-of-thought, scratch work, or self-talk.",
    "The summary must preserve the core result of the step and the key process, method, or reasoning path that produced that result whenever later steps or final synthesis would need it.",
    "If this step derived a proof, debugging path, implementation plan, comparison rationale, or decision method, include the important intermediate logic or procedure, not just the bottom-line conclusion.",
    "Write the summary so later steps and final synthesis can rely on it without rereading the raw execution text.",
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
  ].join("\n\n")
}

function buildFallbackTurnSessionSummary(
  history: IntelligentChatHistoryMessage[],
  latestUserSummary: string
) {
  const lines = history
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

function buildContextualSystemMessage(args: {
  mode: IntelligentModeConfig
  tools?: McpTool[]
}): ProviderMessage {
  return {
    role: "system",
    content: [
      createContextualLaneSystemPrompt(args.mode),
      "Contextual phase contract: keep this leading system prefix stable across contextual phases. Cross-session memory and per-phase instructions are appended later as user messages.",
      `Available MCP tools:\n${formatMcpToolsForPrompt(args.tools ?? [])}`,
    ].join("\n\n"),
  }
}

function buildContextualPhaseMessages(args: {
  mode: IntelligentModeConfig
  history: IntelligentChatHistoryMessage[]
  phaseInstruction: string
  phaseContext?: string[]
  globalMemory?: IntelligentGlobalMemory
  tools?: McpTool[]
  currentSessionKey?: string
  timeContext?: string
}) {
  return [
    buildContextualSystemMessage({
      mode: args.mode,
      tools: args.tools,
    }),
    ...toProviderMessages(args.history),
    {
      role: "user" as const,
      content: [
        "Contextual phase envelope.",
        args.timeContext ?? getCurrentTimeContext(),
        `Cross-session memory snapshot:\n${
          buildGlobalMemoryContext(args.globalMemory, args.currentSessionKey) ||
          "No cross-session memory is currently stored."
        }`,
        args.phaseInstruction,
        ...(args.phaseContext ?? []),
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
  ]
}

function buildStatelessPhaseMessages(args: {
  mode: IntelligentModeConfig
  phaseInstruction: string
  sharedContext?: string
  phaseContext?: string[]
  globalMemory?: IntelligentGlobalMemory
  tools?: McpTool[]
  currentSessionKey?: string
  timeContext?: string
}) {
  return [
    buildLeadingSystemMessage({
      base: createStepSystemPrompt(args.mode),
      globalMemory: args.globalMemory,
      currentSessionKey: args.currentSessionKey,
      tools: args.tools,
    }),
    {
      role: "user" as const,
      content: [
        "Stateless phase envelope.",
        args.timeContext ?? getCurrentTimeContext(),
        args.sharedContext ?? "",
        args.phaseInstruction,
        ...(args.phaseContext ?? []),
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
  ]
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
          "True when a direct answer is enough, including cases where tool use may help but the work still does not justify at least two distinct internal steps.",
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
      recommendedStepCount: {
        type: "number",
        description:
          "Recommended number of execution steps from 2 to 10. Base this mainly on how many distinct concerns, evidence-gathering stages, or solution phases the request requires.",
      },
      taskType: {
        type: "string",
        description:
          "Short task label such as general, coding, proof, project-analysis, math, writing, research, or debugging.",
      },
      groundingNeed: {
        type: "string",
        description:
          "How strongly the overall request depends on verification, external grounding, or evidence collection: low, medium, or high.",
      },
      complexityFactors: {
        type: "array",
        description:
          "Short phrases describing the main considerations that make this request complex, such as proof obligations, project-wide dependencies, multiple constraints, or verification needs.",
        items: {
          type: "string",
        },
      },
      analysisSummary: {
        type: "string",
        description:
          "Compact explanation of what the user is asking and what makes the multi-step route necessary.",
      },
    },
    required: [
      "difficultyScore",
      "recommendedStepCount",
      "taskType",
      "groundingNeed",
      "complexityFactors",
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
          "Ordered plan steps for a true multi-step request. Keep the count minimal, but do not collapse the plan into a single step.",
        minItems: 2,
        maxItems: 10,
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
                "Step difficulty from 0 to 100 for model routing and think gating.",
            },
            needsFullContext: {
              type: "boolean",
              description:
                "True only when this step must run on the fixed major-lane context stack with tools, cross-session memory, and the full session history.",
            },
            groundingNeed: {
              type: "string",
              description:
                "How strongly this step depends on verification, external grounding, or tool-backed evidence: low, medium, or high.",
            },
          },
          required: [
            "id",
            "title",
            "objective",
            "difficultyScore",
            "needsFullContext",
            "groundingNeed",
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
          "Session hash key for this memory entry. Multiple distinct entries from the same session are allowed within one tier.",
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
      "Three-tier cross-session memory update payload. Each tier contains session-keyed entries to retain or add after this refresh. Unchanged prior entries may be omitted.",
    properties: {
      userFeatures: {
        type: "array",
        description:
          "Only unusually important, stable user facts or enduring preferences the user clearly cares about, represented as session-keyed entries. Multiple entries from the same session are allowed when they capture distinct memories. Unchanged older entries may be omitted.",
        items: memoryEntrySchema(
          "One user-features entry keyed by the session hash that established it. Several distinct entries may come from the same session."
        ),
      },
      instructionMemory: {
        type: "array",
        description:
          "Only durable response instructions or preferences the user strongly values and would likely want preserved across sessions, represented as session-keyed entries. Multiple entries from the same session are allowed when they capture distinct instructions. Unchanged older entries may be omitted.",
        items: memoryEntrySchema(
          "One instruction-memory entry keyed by the session hash that established it. Several distinct entries may come from the same session."
        ),
      },
      recentEvents: {
        type: "array",
        description:
          "Ongoing work, active deliverables, blockers, or temporary priorities, represented as session-keyed entries. Multiple entries from the same session are allowed when they capture distinct notable events. Keep this freshest and shortest. Unchanged older entries may be omitted. Never store greetings, timestamps, pleasantries, or trivial turn-by-turn chatter.",
        items: memoryEntrySchema(
          "One recent-events entry keyed by the session hash that established it. Several distinct entries may come from the same session."
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

function buildRoutingGateMessages(args: {
  mode: IntelligentModeConfig
  history: IntelligentChatHistoryMessage[]
  latestUserSummary: string
  latestUserContentText: string
  globalMemory?: IntelligentGlobalMemory
  sessionSummary?: string
  tools?: McpTool[]
  currentSessionKey?: string
  timeContext?: string
}) {
  return buildContextualPhaseMessages({
    mode: args.mode,
    history: args.history,
    globalMemory: args.globalMemory,
    tools: args.tools,
    currentSessionKey: args.currentSessionKey,
    timeContext: args.timeContext,
    phaseInstruction: createRoutingGateSystemPrompt(),
    phaseContext: [
      `Latest user request: ${args.latestUserSummary}`,
      `Latest user content:\n${args.latestUserContentText}`,
      "Route based on the newest user turn above. Treat conversation history, session notes, and cross-session memory as supporting context only.",
    ],
  })
}

function buildAnalysisMessages(args: {
  mode: IntelligentModeConfig
  history: IntelligentChatHistoryMessage[]
  latestUserSummary: string
  latestUserContentText: string
  globalMemory?: IntelligentGlobalMemory
  sessionSummary?: string
  tools?: McpTool[]
  currentSessionKey?: string
  timeContext?: string
}) {
  return buildContextualPhaseMessages({
    mode: args.mode,
    history: args.history,
    globalMemory: args.globalMemory,
    tools: args.tools,
    currentSessionKey: args.currentSessionKey,
    timeContext: args.timeContext,
    phaseInstruction: createAnalysisSystemPrompt(),
    phaseContext: [
      `Latest user request: ${args.latestUserSummary}`,
      `Latest user content:\n${args.latestUserContentText}`,
      "Analyze the newest user turn above. Use older history and memory only to identify real dependencies, constraints, or context requirements.",
    ],
  })
}

function buildPlannerMessages(args: {
  mode: IntelligentModeConfig
  history: IntelligentChatHistoryMessage[]
  analysis: ProblemAnalysis
  latestUserSummary: string
  latestUserContentText: string
  globalMemory?: IntelligentGlobalMemory
  sessionSummary?: string
  tools?: McpTool[]
  currentSessionKey?: string
  timeContext?: string
}) {
  return buildContextualPhaseMessages({
    mode: args.mode,
    history: args.history,
    globalMemory: args.globalMemory,
    tools: args.tools,
    currentSessionKey: args.currentSessionKey,
    timeContext: args.timeContext,
    phaseInstruction: createPlannerSystemPrompt(args.analysis),
    phaseContext: [
      `Latest user request: ${args.latestUserSummary}`,
      `Latest user content:\n${args.latestUserContentText}`,
      "Plan for the newest user turn above. Do not decompose unrelated remembered topics that are only background context.",
    ],
  })
}

function buildNextTurnSessionSummaryMessages(args: {
  mode: IntelligentModeConfig
  history: IntelligentChatHistoryMessage[]
  analysis: ProblemAnalysis
  latestUserSummary: string
  finalAnswer: string
  stepResults: StepExecutionResult[]
  globalMemory?: IntelligentGlobalMemory
  sessionSummary?: string
  tools?: McpTool[]
  currentSessionKey?: string
}) {
  return buildContextualPhaseMessages({
    mode: args.mode,
    history: args.history,
    globalMemory: args.globalMemory,
    tools: args.tools,
    currentSessionKey: args.currentSessionKey,
    phaseInstruction: createNextTurnSessionSummarySystemPrompt(args.analysis),
    phaseContext: [
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
    ],
  })
}

function createRoutingGateSystemPrompt() {
  return [
    "Current orchestration phase: direct-answer gate.",
    "Decide whether the latest user request can be answered immediately or should go to the multi-step path.",
    "Keep the judgment lightweight.",
    "Route based on the newest user turn, not on remembered earlier topics by themselves.",
    "Treat conversation history, session state, and cross-session memory as background context only. They may clarify dependencies, but they are not the current request unless the latest user turn actually continues them.",
    "The gate must make the final route decision. Do not assume a later phase will re-route the request.",
    "Prefer instant whenever a direct response is sufficient, even if that direct response may still use tools or careful reasoning.",
    "Choose multi-step only when the work clearly benefits from at least two distinct internal steps such as investigate -> compare, inspect -> modify, or gather evidence -> synthesize.",
    "Requests like proofs, broad project or codebase analysis, multi-file debugging, architecture tradeoff analysis, and verification-heavy research should strongly lean toward multi-step.",
    "If the work would effectively be one substantive action followed by the final answer, keep it on instant instead of forcing a one-step plan.",
    "A greeting, acknowledgement, or casual opener should stay on the instant path unless the newest user turn clearly includes a substantive task.",
    "gateSummary must be only one to three short sentences.",
    "gateSummary should briefly restate the user's intent and whether direct answer is enough.",
  ].join(" ")
}

function createAnalysisSystemPrompt() {
  return [
    "Current orchestration phase: detailed multi-step analysis.",
    "The request has already been definitively routed to the multi-step path.",
    "Analyze the newest user turn itself, not recalled topics from older memory unless the newest user turn clearly depends on them.",
    "Analyze the task in more depth so planning and model routing can be accurate.",
    DIFFICULTY_RUBRIC,
    "Do not reconsider the route. The gate already decided that this request should use multi-step execution.",
    "Use recommendedStepCount mainly to reflect how many distinct concerns, evidence-collection stages, or solution phases the request actually requires, typically between 2 and 10.",
    "Higher step counts are appropriate for proofs, broad project analysis, complex debugging, architecture work, or verification-heavy research when there are genuinely multiple stages.",
    "Keep complexityFactors concrete and short. They should explain what the planner must account for.",
  ].join(" ")
}

function createContextualLaneSystemPrompt(mode: IntelligentModeConfig) {
  return [
    `You are the major contextual lane for Chat Studio Intelligent Mode "${mode.label}".`,
    `The current major model is "${mode.majorModel}".`,
    "This lane is reserved for phases that depend on prior session context and should preserve a stable prompt prefix.",
    "Treat the conversation history as the authoritative session state.",
    "When the final user message identifies the latest user request or latest user content, treat that material as the current task anchor for this phase.",
    "Use older conversation state and cross-session memory as supporting context, not as a replacement for what the newest user turn is asking now.",
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
    `The request difficulty score is ${analysis.difficultyScore}/100.`,
    `Overall grounding need is ${analysis.groundingNeed}.`,
    analysis.complexityFactors.length > 0
      ? `Primary complexity factors: ${analysis.complexityFactors.join("; ")}.`
      : "Primary complexity factors were not explicitly listed.",
    "Create the smallest useful step plan.",
    `Target ${analysis.recommendedStepCount} steps unless fewer are enough.`,
    "Do not create unnecessary steps.",
    "Plan against the newest user turn and its real dependencies, not against older remembered topics that are not actually in scope.",
    "Do not output a one-step plan. If only one substantive step would be enough, this request should have stayed on the instant path instead of reaching the planner.",
    "Use 2 to 10 steps. Add steps only when they correspond to genuinely distinct phases or concerns.",
    "When available MCP tools can reduce hallucination, fetch external facts, or verify the answer, prefer a plan that explicitly leaves room for those tool-backed steps.",
    "Set needsFullContext to true only when the step must run on the fixed major-lane context stack with tools, cross-session memory, and the full conversation history.",
    "Set groundingNeed higher for verification-heavy or evidence-driven steps.",
  ].join(" ")
}

function createNextTurnSessionSummarySystemPrompt(analysis: ProblemAnalysis) {
  return [
    "Current orchestration phase: prepare the next-turn session summary.",
    `Current analysis summary: ${analysis.analysisSummary}`,
    "Summarize the current session state so the next user turn can recover what problem is being worked on.",
    "Keep important constraints, code/doc state, attachment context, what changed in this turn, and what would matter if the next turn uses a stateless sub-step.",
    "Do not write a rolling memory. This summary is only a compact snapshot for the next turn.",
    "Return plain text only, concise but information-dense.",
  ].join(" ")
}

function createStepSystemPrompt(mode: IntelligentModeConfig) {
  return [
    `You are the stateless execution lane for Chat Studio Intelligent Mode "${mode.label}".`,
    `The current major lane model is "${mode.majorModel}".`,
    "This lane is reserved for internal steps that do not need the full session history and should preserve a stable prompt prefix across stateless work.",
    "Treat the shared request context and current step details as the authoritative local state for this stateless step.",
    "The final user message will define the exact stateless phase such as execution or summary.",
    "Do not produce the final user-facing answer unless the phase explicitly asks for it.",
    "Focus on findings, decisions, grounded facts, and unresolved constraints.",
    "Before concluding the step, strongly consider using available tools whenever they can improve factual reliability or verify external information.",
    "If native tools are available in the API request and they would materially help, call them directly instead of describing pretend searches or pretend tool usage in prose.",
  ].join(" ")
}

function createStepSummarySystemPrompt(mode: IntelligentModeConfig) {
  return [
    `You are summarizing a completed internal step for Chat Studio Intelligent Mode "${mode.label}".`,
    "Return only the step conclusion, not hidden chain-of-thought.",
    "Completed step details and raw step work will be provided later in the user message.",
    "Produce a concise UI summary and a fuller reusable step conclusion.",
    "The fuller summary must keep the step's essential result plus the important method, derivation path, proof structure, debugging path, or decision logic whenever that content matters downstream.",
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
  latestUserSummary: string
  latestUserContentText: string
  globalMemory?: IntelligentGlobalMemory
  sessionSummary?: string
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
    latestUserSummary: args.latestUserSummary,
    latestUserContentText: args.latestUserContentText,
    globalMemory: args.globalMemory,
    sessionSummary: args.sessionSummary,
    tools: args.tools,
    currentSessionKey: args.currentSessionKey,
    timeContext: args.timeContext,
  })

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
}

async function createStructuredAnalysisCompletion(args: {
  baseUrl: string
  apiKey?: string
  mode: IntelligentModeConfig
  history: IntelligentChatHistoryMessage[]
  latestUserSummary: string
  latestUserContentText: string
  globalMemory?: IntelligentGlobalMemory
  sessionSummary?: string
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
    latestUserSummary: args.latestUserSummary,
    latestUserContentText: args.latestUserContentText,
    globalMemory: args.globalMemory,
    sessionSummary: args.sessionSummary,
    tools: args.tools,
    currentSessionKey: args.currentSessionKey,
    timeContext: args.timeContext,
  })

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
}

async function createStructuredPlannerCompletion(args: {
  baseUrl: string
  apiKey?: string
  mode: IntelligentModeConfig
  history: IntelligentChatHistoryMessage[]
  analysis: ProblemAnalysis
  latestUserSummary: string
  latestUserContentText: string
  globalMemory?: IntelligentGlobalMemory
  sessionSummary?: string
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
    latestUserContentText: args.latestUserContentText,
    globalMemory: args.globalMemory,
    sessionSummary: args.sessionSummary,
    tools: args.tools,
    currentSessionKey: args.currentSessionKey,
    timeContext: args.timeContext,
  })

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
    "Use the newest user turn as the task anchor. Use older conversation state or cross-session memory only when the newest turn clearly depends on them.",
    "If the newest user turn is brief or social, answer naturally and briefly instead of proactively surfacing unrelated remembered topics.",
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
    "Answer the user's actual request directly by using the original request together with the completed step results.",
    "Use the completed step results to craft the final answer.",
    "Do not let unrelated remembered topics or earlier branches of the conversation take over the answer unless the newest user turn clearly asks for them.",
    "When a step result contains an important derivation, proof method, debugging path, implementation rationale, or comparison logic that is necessary to answer well, carry that substance into the final answer instead of only giving the final verdict.",
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
    `You maintain the global memory bank for Chat Studio Intelligent Mode "${mode.label}".`,
    "This memory-refresh phase runs independently from the major lane answer path.",
    `The current session key is "${currentSessionKey}".`,
    "Each memory tier uses key:value entries where key is a session hash and value is concise memory text.",
    "You will receive the full current memory bank, including any entries already stored for the current session key, so you can detect whether the memory already exists.",
    "Update or replace the entry for the current session key only when the latest turn adds memory that is genuinely worth keeping.",
    "Preserve unrelated session entries unless they are empty, duplicate, stale, or contradicted.",
    "Be highly conservative. Most turns should add nothing.",
    "Use userFeatures only for unusual, durable user interests, rare preferences, or stable facts the user appears to care about strongly.",
    "Use instructionMemory only for durable response instructions or preferences the user clearly expects to persist.",
    "Use recentEvents only for notable ongoing work, strong current priorities, blockers, or special near-term events likely to matter again soon.",
    "Only add memory when the user is especially interested in something, repeatedly emphasizes it, or this turn introduces a distinctly important or special event.",
    "If the latest request and summary are ordinary, one-off, weakly implied, or already captured in the memory bank, do not add or restate memory.",
    "Do not store greetings, pleasantries, timestamps, generic acknowledgements, or trivial chat meta.",
    "Multiple entries from the same session are allowed within one tier when they capture distinct memories, but do not create duplicate or near-duplicate restatements.",
    "Return only the entries that should be retained or added after this refresh. Unchanged prior entries may be omitted and will be preserved automatically.",
    "Keep each memory value concise, dense, and useful for future retrieval. Do not paste the whole conversation.",
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
  const shouldUseInstant =
    heuristic.difficultyScore < MULTI_STEP_THRESHOLD &&
    heuristic.recommendedStepCount <= 2

  return {
    shouldUseInstant,
    gateSummary: shouldUseInstant
      ? "This request appears simple enough for a direct answer."
      : "This request likely needs deeper planning instead of an immediate answer.",
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
  const difficultyScore = Math.max(
    24,
    Math.min(84, Math.round(message.length / 8) + 18)
  )
  const groundingNeed =
    difficultyScore >= 76 ? "high" : difficultyScore >= 58 ? "medium" : "low"

  return {
    difficultyScore,
    recommendedStepCount: estimateRecommendedStepCount(
      difficultyScore,
      groundingNeed
    ),
    taskType: "general",
    groundingNeed,
    complexityFactors:
      groundingNeed === "high"
        ? ["Multiple non-trivial concerns require staged work."]
        : ["The request benefits from staged decomposition."],
    analysisSummary:
      "Fallback analysis estimated difficulty and decomposition because the structured analysis response was unavailable.",
  }
}

function parseProblemAnalysis(text: string, message: string): ProblemAnalysis {
  const parsed = tryParseStructuredText(text)

  if (!isRecord(parsed)) {
    return fallbackProblemAnalysis(message)
  }
  const groundingNeed = normalizeGroundingNeed(parsed.groundingNeed, "medium")
  const complexityFactors = normalizeStringArray(parsed.complexityFactors, 6, [])
  const parsedStepCount = clampCount(
    parsed.recommendedStepCount,
    estimateRecommendedStepCount(50, groundingNeed, complexityFactors.length)
  )

  return {
    difficultyScore: clampScore(parsed.difficultyScore, 50),
    recommendedStepCount: Math.max(2, parsedStepCount),
    taskType: asString(parsed.taskType, "general"),
    groundingNeed,
    complexityFactors,
    analysisSummary: asString(
      parsed.analysisSummary,
      "The model did not provide a detailed analysis summary."
    ),
  }
}

function decideRoute(gate: RoutingGate) {
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
      needsFullContext: false,
      groundingNeed: analysis.groundingNeed,
    },
    {
      id: "step-2",
      title: "Collect or verify the key evidence",
      objective:
        "Gather the information, evidence, or tool-backed findings required before the main conclusion can be trusted.",
      difficultyScore: Math.max(40, analysis.difficultyScore - 2),
      needsFullContext: false,
      groundingNeed: analysis.groundingNeed,
    },
    {
      id: "step-3",
      title: "Do the main reasoning",
      objective:
        "Analyze the gathered material and develop the core reasoning or solution approach.",
      difficultyScore: analysis.difficultyScore,
      needsFullContext: false,
      groundingNeed: analysis.groundingNeed,
    },
    {
      id: "step-4",
      title: "Cross-check important constraints",
      objective:
        "Review edge cases, conflicts, and constraints that could change the final answer.",
      difficultyScore: Math.max(42, analysis.difficultyScore - 8),
      needsFullContext: false,
      groundingNeed: analysis.groundingNeed,
    },
  ].slice(0, Math.max(2, Math.min(4, analysis.recommendedStepCount)))
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
        needsFullContext:
          typeof step.needsFullContext === "boolean"
            ? step.needsFullContext
            : false,
        groundingNeed: normalizeGroundingNeed(
          step.groundingNeed,
          analysis.groundingNeed
        ),
      }
    })
    .filter((step): step is PlannedStep => Boolean(step))
    .slice(0, 10)

  return steps.length >= 2 ? steps : fallbackPlan(message, analysis)
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

function getGroundingBoost(groundingNeed: "low" | "medium" | "high") {
  if (groundingNeed === "high") return 10
  if (groundingNeed === "medium") return 4
  return 0
}

function computeRoutingDemand(args: {
  difficultyScore: number
  groundingNeed: "low" | "medium" | "high"
}) {
  return Math.max(
    0,
    Math.min(
      100,
      args.difficultyScore + getGroundingBoost(args.groundingNeed)
    )
  )
}

function getNormalizedWeightPosition(weight: number, minWeight: number, maxWeight: number) {
  const safeMin = Math.max(minWeight, 0.0001)
  const safeMax = Math.max(maxWeight, safeMin)
  const safeWeight = Math.max(weight, safeMin)

  if (safeMax === safeMin) {
    return 1
  }

  return (
    (Math.log(safeWeight) - Math.log(safeMin)) /
    (Math.log(safeMax) - Math.log(safeMin))
  )
}

function selectModelAndLane(
  mode: IntelligentModeConfig,
  difficultyScore: number,
  needsFullContext: boolean,
  groundingNeed: "low" | "medium" | "high" = "low"
) {
  const entries = getModelEntries(mode)
  const majorEntry =
    entries.find((entry) => entry.id === mode.majorModel) ?? entries[entries.length - 1]
  const maxWeight = entries[entries.length - 1]?.weight ?? majorEntry.weight
  const minWeight = entries[0]?.weight ?? majorEntry.weight

  if (needsFullContext) {
    return {
      modelId: majorEntry.id,
      lane: "contextual" as const,
      slotId: majorEntry.slots?.contextual,
    }
  }

  const demand = computeRoutingDemand({
    difficultyScore,
    groundingNeed,
  })
  const targetPosition = demand / 100
  const selected = entries.reduce((best, entry) => {
    const position = getNormalizedWeightPosition(entry.weight, minWeight, maxWeight)
    const delta = Math.abs(position - targetPosition)

    if (!best) {
      return { entry, delta }
    }

    if (delta < best.delta) {
      return { entry, delta }
    }

    if (delta === best.delta && entry.weight < best.entry.weight) {
      return { entry, delta }
    }

    return best
  }, null as { entry: (typeof entries)[number]; delta: number } | null)?.entry ??
    entries[entries.length - 1]

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
  groundingNeed?: "low" | "medium" | "high"
  phaseKind: PhaseKind
}): IntelligentReasoningMode {
  if (
    args.phaseKind === "instant" ||
    args.phaseKind === "summary" ||
    args.phaseKind === "memory"
  ) {
    return "instant"
  }

  let score = computeRoutingDemand({
    difficultyScore: args.difficultyScore,
    groundingNeed: args.groundingNeed ?? "low",
  })

  const entries = getModelEntries(args.mode)
  const currentWeight =
    entries.find((entry) => entry.id === args.modelId)?.weight ??
    entries[entries.length - 1]?.weight ??
    1
  const majorWeight =
    entries.find((entry) => entry.id === args.mode.majorModel)?.weight ??
    currentWeight

  if (args.lane === "contextual") {
    score += 8
  } else {
    score -= 2
  }

  if (currentWeight > majorWeight) {
    score += 6
  } else if (currentWeight < majorWeight) {
    score -= 6
  } else {
    score += 2
  }

  if (args.phaseKind === "analysis" || args.phaseKind === "planner") {
    score += 4
  }

  if (args.phaseKind === "synthesis") {
    score += 4
  }

  if (args.phaseKind === "step") {
    score += 6
  }

  if (score < THINKING_DIFFICULTY_FLOOR) {
    return "instant"
  }

  return score >= THINKING_SCORE_THRESHOLD ? "think" : "instant"
}

function buildStepExecutionMessages(args: {
  mode: IntelligentModeConfig
  history: IntelligentChatHistoryMessage[]
  analysis: ProblemAnalysis
  step: PlannedStep
  previousResults: StepExecutionResult[]
  latestUserContent: MessagePart[]
  globalMemory?: IntelligentGlobalMemory
  sessionSummary?: string
  tools?: McpTool[]
  currentSessionKey?: string
  timeContext?: string
}) {
  const usesMajorContextStack = args.step.needsFullContext
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

  const sharedRequestContextBlock = buildStepSharedRequestContext({
    analysis: args.analysis,
    latestUserContentText,
    sessionSummary: args.sessionSummary,
    includeSessionSummary: !usesMajorContextStack,
  })
  const stepSpecificContextBlock = buildStepSpecificContext({
    step: args.step,
    priorResultsBlock,
  })

  if (usesMajorContextStack) {
    return buildContextualPhaseMessages({
      mode: args.mode,
      history: args.history,
      globalMemory: args.globalMemory,
      tools: args.tools,
      currentSessionKey: args.currentSessionKey,
      timeContext: args.timeContext,
      phaseInstruction: "Current orchestration phase: execute an internal step.",
      phaseContext: [
        sharedRequestContextBlock,
        stepSpecificContextBlock,
      ],
    })
  }

  return buildStatelessPhaseMessages({
    mode: args.mode,
    globalMemory: args.globalMemory,
    tools: args.tools,
    currentSessionKey: args.currentSessionKey,
    timeContext: args.timeContext,
    sharedContext: sharedRequestContextBlock,
    phaseInstruction:
      "Current orchestration phase: execute a stateless internal step. Produce concise execution notes for orchestration, not the final user-facing answer.",
    phaseContext: [stepSpecificContextBlock],
  })
}

function buildInstantMessages(args: {
  mode: IntelligentModeConfig
  analysis: ProblemAnalysis
  history: IntelligentChatHistoryMessage[]
  latestUserSummary: string
  latestUserContentText: string
  globalMemory?: IntelligentGlobalMemory
  sessionSummary?: string
  tools?: McpTool[]
  currentSessionKey?: string
  timeContext?: string
}) {
  return buildContextualPhaseMessages({
    mode: args.mode,
    history: args.history,
    globalMemory: args.globalMemory,
    tools: args.tools,
    currentSessionKey: args.currentSessionKey,
    timeContext: args.timeContext,
    phaseInstruction: createInstantSystemPrompt(args.mode, args.analysis),
    phaseContext: [
      `Latest user request: ${args.latestUserSummary}`,
      `Latest user content:\n${args.latestUserContentText}`,
      "Answer the newest user turn directly now.",
      "Write the final user-facing answer now.",
    ],
  })
}

function buildSynthesisMessages(args: {
  mode: IntelligentModeConfig
  analysis: ProblemAnalysis
  history: IntelligentChatHistoryMessage[]
  globalMemory?: IntelligentGlobalMemory
  currentSessionKey?: string
  latestUserSummary: string
  stepResults: StepExecutionResult[]
  tools?: McpTool[]
  timeContext?: string
}) {
  return buildContextualPhaseMessages({
    mode: args.mode,
    history: args.history,
    globalMemory: args.globalMemory,
    tools: args.tools,
    currentSessionKey: args.currentSessionKey,
    timeContext: args.timeContext,
    phaseInstruction: createSynthesisSystemPrompt(args.mode, args.analysis),
    phaseContext: [
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
      "Use the user's original request and the completed step results together when writing the final answer.",
      "If a step result contains an essential method or reasoning path, preserve that substance whenever it is necessary to answer the user well.",
      "Write the final user-facing answer now.",
      "Only mention tool-backed facts when they are grounded in the completed step results above.",
    ],
  })
}

async function executeInstantWithMcp(args: {
  baseUrl: string
  apiKey?: string
  serverUrl: string
  authToken?: string
  mode: IntelligentModeConfig
  analysis: ProblemAnalysis
  history: IntelligentChatHistoryMessage[]
  latestUserSummary: string
  latestUserContentText: string
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
    latestUserSummary: args.latestUserSummary,
    latestUserContentText: args.latestUserContentText,
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
  history: IntelligentChatHistoryMessage[]
  rawExecutionText: string
  toolUses?: StepToolUseRecord[]
  analysis: ProblemAnalysis
  globalMemory?: IntelligentGlobalMemory
  sessionSummary?: string
  tools?: McpTool[]
  currentSessionKey?: string
  timeContext?: string
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
          "The reusable full step conclusion for later steps and final synthesis. Include the core result and any important method, derivation path, proof structure, debugging path, or decision logic that later phases would need, but do not expose hidden chain-of-thought.",
      },
    },
    required: ["briefSummary", "summary"],
    additionalProperties: false,
  })

  const summaryPromptContext = [
    buildStepSummaryContext({
      step: args.step,
      analysisSummary: args.analysis.analysisSummary,
      rawExecutionText: args.rawExecutionText,
      toolUses: args.toolUses,
    }),
  ]
  const latestHistoryItem = args.history[args.history.length - 1]
  const latestUserContentText =
    latestHistoryItem?.role === "user" && Array.isArray(latestHistoryItem.content)
      ? formatMessagePartsForPrompt(latestHistoryItem.content)
      : "No latest user content was included."
  const statelessSharedContext = buildStepSharedRequestContext({
    analysis: args.analysis,
    latestUserContentText,
    sessionSummary: args.sessionSummary,
    includeSessionSummary: true,
  })

  const messages: ProviderMessage[] =
    args.lane === "contextual"
      ? buildContextualPhaseMessages({
          mode: args.mode,
          history: args.history,
          globalMemory: args.globalMemory,
          tools: args.tools,
          currentSessionKey: args.currentSessionKey,
          timeContext: args.timeContext,
          phaseInstruction:
            "Current orchestration phase: summarize a completed internal step.",
          phaseContext: summaryPromptContext,
        })
      : buildStatelessPhaseMessages({
          mode: args.mode,
          globalMemory: args.globalMemory,
          tools: args.tools,
          currentSessionKey: args.currentSessionKey,
          timeContext: args.timeContext,
          sharedContext: statelessSharedContext,
          phaseInstruction: createStepSummarySystemPrompt(args.mode),
          phaseContext: summaryPromptContext,
        })

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
  previousMemory?: IntelligentGlobalMemory
  currentSessionKey: string
  latestUserSummary: string
  latestSessionSummary: string
  signal: AbortSignal
  enableThinking: boolean
  slotId?: number
}) {
  const messages: ProviderMessage[] = [
    buildLeadingSystemMessage({
      base: createGlobalMemorySystemPrompt(args.mode, args.currentSessionKey),
      globalMemory: args.previousMemory,
      // Deliberately include the current session key here so this phase can
      // decide whether the memory is already captured.
      currentSessionKey: undefined,
    }),
    {
      role: "user",
      content: [
        `Latest user request: ${args.latestUserSummary}`,
        `Latest session summary:\n${args.latestSessionSummary.trim() || "No session summary was produced."}`,
        "Review the full memory bank and decide whether the current session key needs a new or updated memory entry.",
        "Prefer leaving the current session absent from a tier over writing weak or generic memory.",
      ].join("\n\n"),
    },
  ]

  const memoryCompletion = await createChatCompletion({
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
  sessionSummary?: string
  tools?: McpTool[]
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
      sessionSummary: args.sessionSummary,
      tools: args.tools,
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
  const latestUserContentText = formatMessagePartsForPrompt(latestUserContent)
  const sessionSummary = trimPersistedSessionSummary(body.sessionSummary)
  const preAnalysisHeuristic = fallbackProblemAnalysis(message)
  const routingReasoningMode: IntelligentReasoningMode = "instant"

  activeIntelligentRequest = true

  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (payload: IntelligentChatStreamEvent) => {
        controller.enqueue(encoder.encode(makeSseChunk(payload)))
      }
      let availableMcpTools: McpTool[] = []

      const runInstantPath = async (instantAnalysis: ProblemAnalysis) => {
        let instantAnswer = ""
        const instantLane = "contextual" as const
        const instantReasoningMode = selectReasoningMode({
          mode,
          modelId: mode.majorModel,
          lane: instantLane,
          difficultyScore: instantAnalysis.difficultyScore,
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

        const instantSlotId = majorContextualSlotId
        const usingInstantMcp = Boolean(mcpServerUrl && availableMcpTools.length > 0)

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
                latestUserSummary: message,
                latestUserContentText,
                globalMemory,
                sessionSummary,
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
                  latestUserSummary: message,
                  latestUserContentText,
                  globalMemory,
                  sessionSummary,
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

        if (request.signal.aborted) {
          return
        }

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
            metrics: nativeSlotControlEnabled ? instantCompletion.metrics : undefined,
          },
        })

        const summaryReasoningMode = selectReasoningMode({
          mode,
          modelId: mode.majorModel,
          lane: "contextual",
          difficultyScore: instantAnalysis.difficultyScore,
          phaseKind: "summary",
        })
        const housekeepingSlotId = nativeSlotControlEnabled
          ? majorContextualSlotId
          : undefined
        const housekeepingLane = "contextual" as const

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

        let currentTurnSessionSummary = ""

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
            sessionSummary,
            tools: availableMcpTools,
            currentSessionKey,
            signal: request.signal,
            enableThinking: summaryReasoningMode === "think",
            slotId: housekeepingSlotId,
          })
          currentTurnSessionSummary = nextSessionSummary.summary
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
          currentTurnSessionSummary = fallbackSummary
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
          lane: "stateless",
          difficultyScore: instantAnalysis.difficultyScore,
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
            lane: "stateless",
            reasoningMode: globalMemoryReasoningMode,
          },
        })

        try {
          const nextGlobalMemory = await updateGlobalMemory({
            baseUrl,
            apiKey,
            mode,
            previousMemory: globalMemory,
            currentSessionKey,
            latestUserSummary: message,
            latestSessionSummary: currentTurnSessionSummary,
            signal: request.signal,
            enableThinking: globalMemoryReasoningMode === "think",
            slotId: majorStatelessSlotId,
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
                lane: "stateless",
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
                lane: "stateless",
                reasoningMode: globalMemoryReasoningMode,
              },
            })
          }
        }

        send({ type: "done" })
      }

      try {
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
            reasoningMode: routingReasoningMode,
          },
        })

        const routingGateCompletion = await createStructuredRoutingGateCompletion({
          baseUrl,
          apiKey,
          mode,
          history: body.history,
          latestUserSummary: message,
          latestUserContentText,
          globalMemory,
          sessionSummary,
          tools: availableMcpTools,
          currentSessionKey,
          model: mode.majorModel,
          maxTokens: GATE_MAX_TOKENS,
          enableThinking: false,
          slotId: majorContextualSlotId,
          timeContext: requestTimeContext,
          signal: request.signal,
        })

        const routingGate = parseRoutingGate(routingGateCompletion.text, message)
        const route = decideRoute(routingGate)

        send({
          type: "phase",
          phase: {
            id: "analysis",
            label: "Check user intent",
            status: "completed",
            detail: `${routingGate.gateSummary}\n\nRoute: ${route}.`,
            modelId: routingGateCompletion.model,
            lane: "contextual",
            reasoningMode: routingReasoningMode,
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

        const instantAnalysis: ProblemAnalysis = {
          ...preAnalysisHeuristic,
          recommendedStepCount: 1,
          analysisSummary: routingGate.gateSummary,
        }

        if (route === "instant") {
          await runInstantPath(instantAnalysis)
          return
        }

        const analysisReasoningMode = selectReasoningMode({
          mode,
          modelId: mode.majorModel,
          lane: "contextual",
          difficultyScore: preAnalysisHeuristic.difficultyScore,
          groundingNeed: preAnalysisHeuristic.groundingNeed,
          phaseKind: "analysis",
        })

        send({
          type: "phase",
          phase: {
            id: "problem-analysis",
            label: "Planning solutions",
            status: "active",
            detail: "Scoring difficulty and producing a structured analysis for the multi-step path.",
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
          latestUserSummary: message,
          latestUserContentText,
          globalMemory,
          sessionSummary,
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
            detail: `Difficulty ${analysis.difficultyScore}/100. Grounding need: ${analysis.groundingNeed}. Recommended steps: ${analysis.recommendedStepCount}. ${analysis.analysisSummary}${
              analysis.complexityFactors.length > 0
                ? ` Complexity factors: ${analysis.complexityFactors.join("; ")}.`
                : ""
            }`,
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
          groundingNeed: analysis.groundingNeed,
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
          latestUserContentText,
          globalMemory,
          sessionSummary,
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
            step.needsFullContext,
            step.groundingNeed
          )
          const stepReasoningMode = selectReasoningMode({
            mode,
            modelId: selectedExecution.modelId,
            lane: selectedExecution.lane,
            difficultyScore: step.difficultyScore,
            groundingNeed: step.groundingNeed,
            phaseKind: "step",
          })

          send({
            type: "phase",
            phase: {
              id: step.id,
              label: step.title,
              status: "active",
              detail: `${step.objective} [${selectedExecution.modelId}, ${selectedExecution.lane}, grounding ${step.groundingNeed}]`,
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
              nativeSlotControlEnabled
                ? selectedExecution.lane === "contextual"
                  ? majorContextualSlotId
                  : selectedExecution.slotId ?? majorStatelessSlotId
                : undefined,
            history: body.history,
            rawExecutionText: stepCompletion.text.trim(),
            toolUses: stepToolUses,
            analysis,
            globalMemory,
            sessionSummary,
            tools: availableMcpTools,
            currentSessionKey,
            timeContext: requestTimeContext,
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

        const synthesisSelection = {
          modelId: mode.majorModel,
          lane: "contextual" as const,
          slotId: majorContextualSlotId,
        }
        const synthesisReasoningMode = selectReasoningMode({
          mode,
          modelId: synthesisSelection.modelId,
          lane: synthesisSelection.lane,
          difficultyScore: Math.max(analysis.difficultyScore, 60),
          groundingNeed: analysis.groundingNeed,
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
            lane: "contextual",
            difficultyScore: analysis.difficultyScore,
            phaseKind: "summary",
          })
          const housekeepingSlotId = nativeSlotControlEnabled
            ? majorContextualSlotId
            : undefined
          const housekeepingLane = "contextual" as const

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

          let currentTurnSessionSummary = ""

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
              sessionSummary,
              tools: availableMcpTools,
              currentSessionKey,
              signal: request.signal,
              enableThinking: summaryReasoningMode === "think",
              slotId: housekeepingSlotId,
            })
            currentTurnSessionSummary = nextSessionSummary.summary

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
            currentTurnSessionSummary = fallbackSummary

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
            lane: "stateless",
            difficultyScore: analysis.difficultyScore,
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
              lane: "stateless",
              reasoningMode: globalMemoryReasoningMode,
            },
          })

          try {
            const nextGlobalMemory = await updateGlobalMemory({
              baseUrl,
              apiKey,
              mode,
              previousMemory: globalMemory,
              currentSessionKey,
              latestUserSummary: message,
              latestSessionSummary: currentTurnSessionSummary,
              signal: request.signal,
              enableThinking: globalMemoryReasoningMode === "think",
              slotId: majorStatelessSlotId,
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
                  lane: "stateless",
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
                  lane: "stateless",
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
