import { access, readFile } from "node:fs/promises"
import path from "node:path"

import type {
  IntelligentModelSlots,
  IntelligentModesResponse,
} from "@/lib/types"

type JsonObject = Record<string, unknown>

type IntelligentModelConfig = {
  weight: number
  slots?: IntelligentModelSlots
}

export type IntelligentModeConfig = {
  id: string
  label: string
  majorModel: string
  models: Record<string, IntelligentModelConfig>
}

export type IntelligentConfig = {
  version: 1
  defaultModeId: string | null
  mcpServer: string | null
  modes: Record<string, IntelligentModeConfig>
  sourcePath: string
}

const DEFAULT_CONFIG_CANDIDATES = [
  "intelligent.config.yaml",
  "intelligent.config.yml",
  "intelligent.config.json",
]

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }

  if (typeof value === "string") {
    const trimmed = value.trim()
    if (!trimmed) return null

    const parsed = Number(trimmed)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }

  return null
}

function normalizeOpenAiCompatibleBaseUrl(value: string) {
  const normalized = value.replace(/\/$/, "")

  return normalized.endsWith("/v1") ? normalized : `${normalized}/v1`
}

function normalizeLlamaServerBaseUrl(value: string) {
  const normalized = value.replace(/\/$/, "")

  return normalized.endsWith("/v1") ? normalized.slice(0, -3) : normalized
}

function isEnabledFlag(value: string | undefined) {
  if (!value) return false

  return ["1", "true", "yes", "on", "enable", "enabled"].includes(
    value.trim().toLowerCase()
  )
}

export function isIntelligentModeEnabled() {
  return isEnabledFlag(process.env.INTELLIGENT_MODE)
}

export function getOpenAiCompatibleBaseUrl() {
  const explicitCompat = readString(process.env.OPENAI_COMPAT_BASE_URL)
  if (explicitCompat) {
    return normalizeOpenAiCompatibleBaseUrl(explicitCompat)
  }

  const explicitLlama = readString(process.env.LLAMA_SERVER_BASE_URL)
  if (explicitLlama) {
    return normalizeOpenAiCompatibleBaseUrl(explicitLlama)
  }

  return null
}

export function getLlamaServerBaseUrl() {
  const explicit = readString(process.env.LLAMA_SERVER_BASE_URL)
  if (explicit) {
    return normalizeLlamaServerBaseUrl(explicit)
  }

  const compatBaseUrl = readString(process.env.OPENAI_COMPAT_BASE_URL)
  if (!compatBaseUrl) {
    return null
  }

  return normalizeLlamaServerBaseUrl(compatBaseUrl)
}

function hasExplicitLlamaServerBaseUrl() {
  return Boolean(readString(process.env.LLAMA_SERVER_BASE_URL))
}

export function getLlmApiKey() {
  const key =
    readString(process.env.LLM_API_KEY) ??
    readString(process.env.OPENAI_COMPAT_API_KEY)

  return key ?? undefined
}

export function getIntelligentBackendCapabilities() {
  const openAiBaseUrl = getOpenAiCompatibleBaseUrl()
  const isLlamaServerBackend = hasExplicitLlamaServerBaseUrl()

  return {
    hasOpenAiCompatibleBaseUrl: Boolean(openAiBaseUrl),
    hasLlamaServerBaseUrl: isLlamaServerBackend,
    isLlamaServerBackend,
    canUseNativeSlotControl: isLlamaServerBackend,
  }
}

async function resolveConfigPath() {
  const explicit = readString(process.env.INTELLIGENT_CONFIG_PATH)

  if (explicit) {
    return path.resolve(process.cwd(), explicit)
  }

  for (const candidate of DEFAULT_CONFIG_CANDIDATES) {
    const absolute = path.resolve(process.cwd(), candidate)

    try {
      await access(absolute)
      return absolute
    } catch {
      // keep looking
    }
  }

  return null
}

async function parseConfigText(
  sourcePath: string,
  text: string
): Promise<unknown> {
  if (sourcePath.endsWith(".json")) {
    return JSON.parse(text)
  }

  const yamlModule = (await import("js-yaml")) as {
    load: (input: string) => unknown
  }

  return yamlModule.load(text)
}

function parseSlots(
  modelId: string,
  value: unknown
): IntelligentModelSlots | undefined {
  if (Array.isArray(value)) {
    const numericSlots = value
      .map((item) => readNumber(item))
      .filter((item): item is number => item !== null)

    if (numericSlots.length === 0) {
      return undefined
    }

    if (numericSlots.length > 2) {
      throw new Error(
        `Model "${modelId}" defines more than 2 native slots. Use at most 2.`
      )
    }

    return {
      contextual: numericSlots[0],
      stateless: numericSlots[1],
    }
  }

  if (!isObject(value)) {
    return undefined
  }

  const contextual = readNumber(value.contextual)
  const stateless = readNumber(value.stateless)

  if (contextual === null && stateless === null) {
    return undefined
  }

  return {
    contextual: contextual ?? undefined,
    stateless: stateless ?? undefined,
  }
}

function parseModelEntry(
  modelId: string,
  value: unknown
): IntelligentModelConfig {
  const directWeight = readNumber(value)
  if (directWeight !== null) {
    return { weight: directWeight }
  }

  if (!isObject(value)) {
    throw new Error(
      `Model "${modelId}" must be a number or an object with "weight".`
    )
  }

  const weight =
    readNumber(value.weight) ??
    readNumber(value.rank) ??
    readNumber(value.model_param) ??
    readNumber(value.modelParam)

  if (weight === null) {
    throw new Error(`Model "${modelId}" is missing a numeric "weight".`)
  }

  const slots = parseSlots(
    modelId,
    value.slots ?? value.llama_server_slots ?? value.llamaServerSlots
  )

  return {
    weight,
    slots,
  }
}

function parseModels(modeId: string, value: unknown) {
  if (!isObject(value)) {
    throw new Error(`Mode "${modeId}" must define "models" as an object map.`)
  }

  const models: Record<string, IntelligentModelConfig> = {}

  for (const [modelId, modelConfig] of Object.entries(value)) {
    const cleanModelId = modelId.trim()
    if (!cleanModelId) continue

    models[cleanModelId] = parseModelEntry(cleanModelId, modelConfig)
  }

  if (Object.keys(models).length === 0) {
    throw new Error(`Mode "${modeId}" must define at least one model.`)
  }

  return models
}

function parseMode(modeId: string, value: unknown): IntelligentModeConfig {
  if (!isObject(value)) {
    throw new Error(`Mode "${modeId}" must be an object.`)
  }

  const id = modeId.trim()
  const label = readString(value.label) ?? id
  const models = parseModels(id, value.models)
  const majorModel =
    readString(value.major_model) ??
    readString(value.majorModel) ??
    readString(value.major_model_id) ??
    readString(value.majorModelId)

  if (!majorModel) {
    throw new Error(`Mode "${id}" is missing "major_model".`)
  }

  if (!models[majorModel]) {
    throw new Error(
      `Mode "${id}" major_model "${majorModel}" is not listed in its models map.`
    )
  }

  return {
    id,
    label,
    majorModel,
    models,
  }
}

function parseConfigDocument(
  sourcePath: string,
  document: unknown
): IntelligentConfig {
  if (!isObject(document)) {
    throw new Error("Intelligent config root must be an object.")
  }

  const versionValue = readNumber(document.version) ?? 1

  if (versionValue !== 1) {
    throw new Error(`Unsupported intelligent config version "${versionValue}".`)
  }

  const rawModes = document.modes
  if (!isObject(rawModes)) {
    throw new Error('Intelligent config must define "modes" as an object map.')
  }

  const modes: Record<string, IntelligentModeConfig> = {}

  for (const [modeId, modeConfig] of Object.entries(rawModes)) {
    const cleanModeId = modeId.trim()
    if (!cleanModeId) continue

    modes[cleanModeId] = parseMode(cleanModeId, modeConfig)
  }

  const modeIds = Object.keys(modes)
  if (modeIds.length === 0) {
    throw new Error("Intelligent config must define at least one mode.")
  }

  const defaultModeId =
    readString(document.default_mode) ??
    readString(document.defaultMode) ??
    modeIds[0]

  if (defaultModeId && !modes[defaultModeId]) {
    throw new Error(
      `default_mode "${defaultModeId}" does not exist in the modes map.`
    )
  }

  const mcpServer =
    readString(document.mcp_server) ??
    readString(document.mcpServer) ??
    readString(document.MCP_SERVER)

  return {
    version: 1,
    defaultModeId: defaultModeId ?? null,
    mcpServer: mcpServer ?? null,
    modes,
    sourcePath,
  }
}

export async function loadIntelligentConfig() {
  if (!isIntelligentModeEnabled()) {
    return null
  }

  const sourcePath = await resolveConfigPath()
  if (!sourcePath) {
    throw new Error(
      "Intelligent mode is enabled but no config file was found. Set INTELLIGENT_CONFIG_PATH or add intelligent.config.yaml."
    )
  }

  const text = await readFile(sourcePath, "utf8")
  const document = await parseConfigText(sourcePath, text)

  return parseConfigDocument(sourcePath, document)
}

export async function getIntelligentModesResponse(): Promise<IntelligentModesResponse> {
  const backend = getIntelligentBackendCapabilities()

  if (!isIntelligentModeEnabled()) {
    return {
      enabled: false,
      defaultModeId: null,
      configFile: null,
      mcpServerConfigured: false,
      backend,
      modes: [],
    }
  }

  const config = await loadIntelligentConfig()

  if (!config) {
    return {
      enabled: false,
      defaultModeId: null,
      configFile: null,
      mcpServerConfigured: false,
      backend,
      modes: [],
    }
  }

  return {
    enabled: true,
    defaultModeId: config.defaultModeId,
    configFile: path.basename(config.sourcePath),
    mcpServerConfigured: Boolean(config.mcpServer),
    backend,
    modes: Object.values(config.modes).map((mode) => ({
      id: mode.id,
      label: mode.label,
      majorModel: mode.majorModel,
      models: Object.entries(mode.models).map(([modelId, modelConfig]) => ({
        id: modelId,
        weight: modelConfig.weight,
        hasSlots: Boolean(modelConfig.slots),
        slots: modelConfig.slots,
      })),
    })),
  }
}
