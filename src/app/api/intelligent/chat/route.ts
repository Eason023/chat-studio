import {
  getIntelligentBackendCapabilities,
  getLlmApiKey,
  getOpenAiCompatibleBaseUrl,
  type IntelligentModeConfig,
  loadIntelligentConfig,
} from "@/lib/intelligent-config"
import { tryParseStructuredText } from "@/lib/schema-utils"
import type {
  IntelligentChatHistoryMessage,
  IntelligentChatRequest,
  IntelligentChatStreamEvent,
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

type UpstreamStreamingChunk = {
  model?: unknown
  choices?: UpstreamStreamingChoice[]
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
  summary: string
}

const ANALYSIS_TEMPERATURE = 0
const EXECUTION_TEMPERATURE = 0.2
const ANALYSIS_MAX_TOKENS = 400
const PLANNER_MAX_TOKENS = 700
const STEP_MAX_TOKENS = 500
const SESSION_SUMMARY_MAX_TOKENS = 280
const INSTANT_THRESHOLD = 40
const MULTI_STEP_THRESHOLD = 58
const HIGH_CONTEXT_THRESHOLD = 60
const MEDIUM_CONTEXT_THRESHOLD = 40
const ANALYSIS_HISTORY_WINDOW = 8
const PLANNER_HISTORY_WINDOW = 8
const CONTEXTUAL_HISTORY_WINDOW = 8
const MEDIUM_HISTORY_WINDOW = 4
const LOW_HISTORY_WINDOW = 2
const SYNTHESIS_HISTORY_WINDOW = 4
const SESSION_SUMMARY_CHAR_LIMIT = 1800
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

function trimSessionSummary(summary?: string | null) {
  if (!summary) {
    return ""
  }

  const compact = summary.replace(/\s+/g, " ").trim()
  if (!compact) {
    return ""
  }

  return compact.length > SESSION_SUMMARY_CHAR_LIMIT
    ? `${compact.slice(0, SESSION_SUMMARY_CHAR_LIMIT)}...`
    : compact
}

function formatSessionSummaryDetail(summary?: string | null) {
  const trimmed = trimSessionSummary(summary)

  if (!trimmed) {
    return "Session summary updated."
  }

  return trimmed
}

function buildSessionSummaryMessages(summary?: string | null): ProviderMessage[] {
  const trimmed = trimSessionSummary(summary)

  if (!trimmed) {
    return []
  }

  return [
    {
      role: "system",
      content: `Current rolling session summary:\n${trimmed}`,
    },
  ]
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
  sessionSummary?: string
}) {
  return [
    {
      role: "system" as const,
      content: createAnalysisSystemPrompt(args.mode),
    },
    ...buildSessionSummaryMessages(args.sessionSummary),
    ...toProviderMessages(sliceHistoryTail(args.history, ANALYSIS_HISTORY_WINDOW)),
  ]
}

function buildPlannerMessages(args: {
  mode: IntelligentModeConfig
  history: IntelligentChatHistoryMessage[]
  analysis: ProblemAnalysis
  latestUserSummary: string
  sessionSummary?: string
}) {
  return [
    {
      role: "system" as const,
      content: createPlannerSystemPrompt(args.mode, args.analysis),
    },
    ...buildSessionSummaryMessages(args.sessionSummary),
    ...toProviderMessages(sliceHistoryTail(args.history, PLANNER_HISTORY_WINDOW)),
    {
      role: "user" as const,
      content: `Latest user request: ${args.latestUserSummary}`,
    },
  ]
}

function createAnalysisSystemPrompt(mode: IntelligentModeConfig) {
  return [
    `You are the analysis router for Chat Studio Intelligent Mode "${mode.label}".`,
    `The current major model is "${mode.majorModel}".`,
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

function createPlannerSystemPrompt(
  mode: IntelligentModeConfig,
  analysis: ProblemAnalysis
) {
  return [
    `You are the planner for Chat Studio Intelligent Mode "${mode.label}".`,
    `The current major model is "${mode.majorModel}".`,
    `The request difficulty score is ${analysis.difficultyScore}/100 and the context dependency score is ${analysis.contextDependencyScore}/100.`,
    "Create the smallest useful step plan.",
    "Return JSON only. Do not use markdown fences.",
    'Required JSON shape: {"steps":[{"id":"step-1","title":"string","objective":"string","difficultyScore":0-100,"contextDependencyScore":0-100}]}',
    `Target ${analysis.recommendedStepCount} steps unless fewer are enough.`,
    "Do not create unnecessary steps.",
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

function createSessionSummarySystemPrompt(mode: IntelligentModeConfig) {
  return [
    `You maintain the rolling session summary for Chat Studio Intelligent Mode "${mode.label}".`,
    "Update the summary so future turns can recover important context without replaying the full transcript.",
    "Keep durable goals, user preferences, active constraints, relevant code or document state, unresolved questions, and important attachment context.",
    "Drop low-value chatter and resolved details that no longer matter.",
    "Return plain text only, concise but information-dense.",
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
          } else if (reasoning) {
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

  return resolvedModel
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

  let selected = majorEntry

  if (contextDependencyScore < HIGH_CONTEXT_THRESHOLD) {
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
  }

  const lane: "contextual" | "stateless" =
    contextDependencyScore >= HIGH_CONTEXT_THRESHOLD ? "contextual" : "stateless"

  const slotId =
    lane === "contextual"
      ? selected.slots?.contextual
      : selected.slots?.stateless ?? selected.slots?.contextual

  return {
    modelId: selected.id,
    lane,
    slotId,
  }
}

function buildStepExecutionMessages(args: {
  mode: IntelligentModeConfig
  history: IntelligentChatHistoryMessage[]
  analysis: ProblemAnalysis
  step: PlannedStep
  previousResults: StepExecutionResult[]
  latestUserContent: MessagePart[]
  latestUserSummary: string
  sessionSummary?: string
}) {
  const historyWindow = getHistoryWindowForDependency(
    args.step.contextDependencyScore
  )
  const slicedHistory = sliceHistoryTail(args.history, historyWindow)
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
    {
      role: "system" as const,
      content: createStepSystemPrompt(args.mode, args.step),
    },
    ...buildSessionSummaryMessages(args.sessionSummary),
    ...historyMessages,
    {
      role: "user" as const,
      content: [
        `Global analysis summary: ${args.analysis.analysisSummary}`,
        `Current step objective: ${args.step.objective}`,
        `Step difficulty score: ${args.step.difficultyScore}/100`,
        `Step context dependency score: ${args.step.contextDependencyScore}/100`,
        `Latest user request summary: ${args.latestUserSummary}`,
        `Latest user content:\n${
          typeof partsToProviderContent(args.latestUserContent) === "string"
            ? partsToProviderContent(args.latestUserContent)
            : "The latest request includes multimodal attachments."
        }`,
        `Prior completed work:\n${priorResultsBlock}`,
        "Return a concise execution summary with the main findings and what should matter to the final synthesis.",
      ].join("\n\n"),
    },
  ]
}

function buildInstantMessages(args: {
  mode: IntelligentModeConfig
  analysis: ProblemAnalysis
  history: IntelligentChatHistoryMessage[]
  sessionSummary?: string
}) {
  return [
    {
      role: "system" as const,
      content: createInstantSystemPrompt(args.mode, args.analysis),
    },
    ...buildSessionSummaryMessages(args.sessionSummary),
    ...toProviderMessages(
      sliceHistoryTail(
        args.history,
        getHistoryWindowForDependency(args.analysis.contextDependencyScore)
      )
    ),
  ]
}

function buildSynthesisMessages(args: {
  mode: IntelligentModeConfig
  analysis: ProblemAnalysis
  history: IntelligentChatHistoryMessage[]
  sessionSummary?: string
  latestUserSummary: string
  stepResults: StepExecutionResult[]
}) {
  return [
    {
      role: "system" as const,
      content: createSynthesisSystemPrompt(args.mode, args.analysis),
    },
    ...buildSessionSummaryMessages(args.sessionSummary),
    ...toProviderMessages(sliceHistoryTail(args.history, SYNTHESIS_HISTORY_WINDOW)),
    {
      role: "user" as const,
      content: [
        `Original request: ${args.latestUserSummary}`,
        `Analysis summary: ${args.analysis.analysisSummary}`,
        "Completed step results:",
        args.stepResults
          .map(
            (result, index) =>
              `${index + 1}. ${result.step.title} (${result.modelId}, ${result.lane})\n${result.summary}`
          )
          .join("\n\n"),
        "Write the final user-facing answer now.",
      ].join("\n\n"),
    },
  ]
}

async function updateSessionSummary(args: {
  baseUrl: string
  apiKey?: string
  mode: IntelligentModeConfig
  history: IntelligentChatHistoryMessage[]
  previousSummary?: string
  latestUserSummary: string
  finalAnswer: string
  stepResults: StepExecutionResult[]
  signal: AbortSignal
  slotId?: number
}) {
  const summaryCompletion = await createChatCompletion({
    baseUrl: args.baseUrl,
    apiKey: args.apiKey,
    model: args.mode.majorModel,
    temperature: ANALYSIS_TEMPERATURE,
    maxTokens: SESSION_SUMMARY_MAX_TOKENS,
    enableThinking: false,
    slotId: args.slotId,
    signal: args.signal,
    messages: [
      {
        role: "system",
        content: createSessionSummarySystemPrompt(args.mode),
      },
      ...buildSessionSummaryMessages(args.previousSummary),
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
          "Write the updated rolling session summary now.",
        ].join("\n\n"),
      },
    ],
  })

  return trimSessionSummary(summaryCompletion.text)
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

  const sessionSummary = trimSessionSummary(body.sessionSummary)
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

  activeIntelligentRequest = true

  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (payload: IntelligentChatStreamEvent) => {
        controller.enqueue(encoder.encode(makeSseChunk(payload)))
      }

      try {
        send({
          type: "phase",
          phase: {
            id: "analysis",
            label: "Checking user intent",
            status: "active",
            detail: "Scoring difficulty and context dependency.",
            modelId: mode.majorModel,
          },
        })

        const analysisCompletion = await createChatCompletion({
          baseUrl,
          apiKey,
          model: mode.majorModel,
          temperature: ANALYSIS_TEMPERATURE,
          maxTokens: ANALYSIS_MAX_TOKENS,
          enableThinking: false,
          slotId: majorContextualSlotId,
          signal: request.signal,
          messages: buildAnalysisMessages({
            mode,
            history: body.history,
            sessionSummary,
          }),
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
          send({
            type: "phase",
            phase: {
              id: "instant-response",
              label: "Constructing response",
              status: "active",
              detail: `Direct answer via ${mode.majorModel}.`,
              modelId: mode.majorModel,
            },
          })

          await streamChatCompletion({
            baseUrl,
            apiKey,
            model: mode.majorModel,
            temperature: EXECUTION_TEMPERATURE,
            enableThinking: false,
            slotId:
              analysis.contextDependencyScore >= HIGH_CONTEXT_THRESHOLD
                ? majorContextualSlotId
                : majorStatelessSlotId,
            signal: request.signal,
            messages: buildInstantMessages({
              mode,
              analysis,
              history: body.history,
              sessionSummary,
            }),
            onToken: (text) => {
              if (!request.signal.aborted) {
                instantAnswer += text
                send({ type: "token", text })
              }
            },
          })

          if (!request.signal.aborted) {
            send({
              type: "phase",
              phase: {
                id: "instant-response",
                label: "Constructing response",
                status: "completed",
                detail: "Instant response completed.",
                modelId: mode.majorModel,
              },
            })
            send({
              type: "phase",
              phase: {
                id: "session-summary",
                label: "Updating session summary",
                status: "active",
                detail: "Compressing the latest turn into rolling context.",
                modelId: mode.majorModel,
                lane: "contextual",
              },
            })
            try {
              const nextSessionSummary = await updateSessionSummary({
                baseUrl,
                apiKey,
                mode,
                history: body.history,
                previousSummary: sessionSummary,
                latestUserSummary: message,
                finalAnswer: instantAnswer,
                stepResults: [],
                signal: request.signal,
                slotId: majorContextualSlotId,
              })
              if (!request.signal.aborted) {
                send({
                  type: "phase",
                  phase: {
                    id: "session-summary",
                    label: "Updating session summary",
                    status: "completed",
                    detail: formatSessionSummaryDetail(nextSessionSummary),
                    modelId: mode.majorModel,
                    lane: "contextual",
                  },
                })
                send({
                  type: "session_summary",
                  summary: {
                    text: nextSessionSummary,
                    updatedAt: Date.now(),
                  },
                })
              }
            } catch (summaryError) {
              if (!request.signal.aborted) {
                send({
                  type: "phase",
                  phase: {
                    id: "session-summary",
                    label: "Updating session summary",
                    status: "error",
                    detail:
                      summaryError instanceof Error
                        ? summaryError.message
                        : "Failed to update session summary.",
                    modelId: mode.majorModel,
                    lane: "contextual",
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
            id: "planner",
            label: "Planning steps",
            status: "active",
            detail: `Target ${analysis.recommendedStepCount} steps.`,
            modelId: mode.majorModel,
          },
        })

        const plannerCompletion = await createChatCompletion({
          baseUrl,
          apiKey,
          model: mode.majorModel,
          temperature: ANALYSIS_TEMPERATURE,
          maxTokens: PLANNER_MAX_TOKENS,
          enableThinking: false,
          slotId: majorContextualSlotId,
          signal: request.signal,
          messages: buildPlannerMessages({
            mode,
            history: body.history,
            analysis,
            latestUserSummary: message,
            sessionSummary,
          }),
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

          send({
            type: "phase",
            phase: {
              id: step.id,
              label: step.title,
              status: "active",
              detail: `${step.objective} [${selectedExecution.modelId}, ${selectedExecution.lane}]`,
              modelId: selectedExecution.modelId,
              lane: selectedExecution.lane,
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

          const stepCompletion = await createChatCompletion({
            baseUrl,
            apiKey,
            model: selectedExecution.modelId,
            temperature: EXECUTION_TEMPERATURE,
            maxTokens: STEP_MAX_TOKENS,
            enableThinking: false,
            slotId: nativeSlotControlEnabled ? selectedExecution.slotId : undefined,
            signal: request.signal,
            messages: buildStepExecutionMessages({
              mode,
              history: body.history,
              analysis,
              step,
              previousResults: stepResults,
              latestUserContent,
              latestUserSummary: message,
              sessionSummary,
            }),
          })

          const result: StepExecutionResult = {
            step,
            modelId: selectedExecution.modelId,
            lane: selectedExecution.lane,
            summary: stepCompletion.text.trim(),
          }

          stepResults.push(result)

          send({
            type: "phase",
            phase: {
              id: step.id,
              label: step.title,
              status: "completed",
              detail: normalizePhaseDetail(result.summary),
              modelId: selectedExecution.modelId,
              lane: selectedExecution.lane,
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

        await streamChatCompletion({
          baseUrl,
          apiKey,
          model: synthesisSelection.modelId,
          temperature: EXECUTION_TEMPERATURE,
          enableThinking: false,
          slotId: nativeSlotControlEnabled
            ? synthesisSelection.slotId
            : undefined,
          signal: request.signal,
          messages: buildSynthesisMessages({
            mode,
            analysis,
            history: body.history,
            sessionSummary,
            latestUserSummary: message,
            stepResults,
          }),
          onToken: (text) => {
            if (!request.signal.aborted) {
              synthesisAnswer += text
              send({ type: "token", text })
            }
          },
        })

        if (!request.signal.aborted) {
          send({
            type: "phase",
            phase: {
              id: "synthesis",
              label: "Synthesizing final answer",
              status: "completed",
              detail: "Multi-step response completed.",
              modelId: synthesisSelection.modelId,
              lane: synthesisSelection.lane,
            },
          })
          send({
            type: "phase",
            phase: {
              id: "session-summary",
              label: "Updating session summary",
              status: "active",
              detail: "Compressing the latest turn into rolling context.",
              modelId: mode.majorModel,
              lane: "contextual",
            },
          })
          try {
            const nextSessionSummary = await updateSessionSummary({
              baseUrl,
              apiKey,
              mode,
              history: body.history,
              previousSummary: sessionSummary,
              latestUserSummary: message,
              finalAnswer: synthesisAnswer,
              stepResults,
              signal: request.signal,
              slotId: majorContextualSlotId,
            })
            if (!request.signal.aborted) {
              send({
                type: "phase",
                phase: {
                  id: "session-summary",
                  label: "Updating session summary",
                  status: "completed",
                  detail: formatSessionSummaryDetail(nextSessionSummary),
                  modelId: mode.majorModel,
                  lane: "contextual",
                },
              })
              send({
                type: "session_summary",
                summary: {
                  text: nextSessionSummary,
                  updatedAt: Date.now(),
                },
              })
            }
          } catch (summaryError) {
            if (!request.signal.aborted) {
              send({
                type: "phase",
                phase: {
                  id: "session-summary",
                  label: "Updating session summary",
                  status: "error",
                  detail:
                    summaryError instanceof Error
                      ? summaryError.message
                      : "Failed to update session summary.",
                  modelId: mode.majorModel,
                  lane: "contextual",
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
