type JsonRpcId = string | number

type JsonRpcRequest = {
  jsonrpc: "2.0"
  id?: JsonRpcId
  method: string
  params?: unknown
}

type JsonRpcResponse = {
  jsonrpc?: unknown
  id?: unknown
  result?: unknown
  error?: {
    code?: unknown
    message?: unknown
    data?: unknown
  }
  method?: unknown
  params?: unknown
}

type McpSessionState = {
  sessionId?: string
  protocolVersion?: string
}

type McpInitializeResult = {
  protocolVersion?: unknown
  capabilities?: unknown
  serverInfo?: unknown
}

export type McpTool = {
  name: string
  description: string
  inputSchema?: Record<string, unknown>
}

export type McpToolCallResult = {
  isError: boolean
  contentText: string
  structuredContent?: unknown
}

const MCP_PROTOCOL_VERSION = "2025-03-26"
const MCP_SESSION_HEADER = "Mcp-Session-Id"
const MCP_CLIENT_INFO = {
  name: "Chat Studio",
  version: "2.0.0",
}

const sessionCache = new Map<string, McpSessionState>()

class McpSessionExpiredError extends Error {
  constructor() {
    super("MCP session expired")
    this.name = "McpSessionExpiredError"
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asString(value: unknown, fallback = "") {
  if (typeof value !== "string") {
    return fallback
  }

  const trimmed = value.trim()
  return trimmed || fallback
}

function createRequestId() {
  return `${Date.now()}-${crypto.randomUUID()}`
}

function buildHeaders(sessionId?: string) {
  const headers = new Headers()
  headers.set("Content-Type", "application/json")
  headers.set("Accept", "application/json, text/event-stream")

  if (sessionId) {
    headers.set(MCP_SESSION_HEADER, sessionId)
  }

  return headers
}

function extractResponseMessage(
  payload: unknown,
  requestId?: JsonRpcId
): JsonRpcResponse | undefined {
  if (Array.isArray(payload)) {
    return payload.find((item) => extractResponseMessage(item, requestId)) as
      | JsonRpcResponse
      | undefined
  }

  if (!isRecord(payload)) {
    return undefined
  }

  if (typeof requestId !== "undefined") {
    if (
      payload.id === requestId &&
      ("result" in payload || "error" in payload)
    ) {
      return payload
    }

    return undefined
  }

  if ("result" in payload || "error" in payload) {
    return payload
  }

  return undefined
}

async function parseEventStreamResponse(
  response: Response,
  requestId?: JsonRpcId
) {
  if (!response.body) {
    return undefined
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }

      buffer += decoder.decode(value, { stream: true })

      let boundaryIndex = buffer.indexOf("\n\n")

      while (boundaryIndex !== -1) {
        const rawEvent = buffer.slice(0, boundaryIndex)
        buffer = buffer.slice(boundaryIndex + 2)

        const dataLines = rawEvent
          .split("\n")
          .map((line) => line.trimEnd())
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())

        if (dataLines.length > 0) {
          const data = dataLines.join("\n")

          if (data && data !== "[DONE]") {
            try {
              const parsed = JSON.parse(data) as unknown
              const match = extractResponseMessage(parsed, requestId)

              if (match) {
                return match
              }
            } catch {
              // ignore malformed event payloads
            }
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

  return undefined
}

async function postJsonRpc(args: {
  serverUrl: string
  request: JsonRpcRequest
  sessionId?: string
  signal: AbortSignal
}) {
  const response = await fetch(args.serverUrl, {
    method: "POST",
    headers: buildHeaders(args.sessionId),
    body: JSON.stringify(args.request),
    signal: args.signal,
  })

  const nextSessionId = response.headers.get(MCP_SESSION_HEADER) ?? args.sessionId

  if (response.status === 404 && args.sessionId) {
    throw new McpSessionExpiredError()
  }

  if (
    typeof args.request.id === "undefined" &&
    (response.status === 202 || response.status === 204)
  ) {
    return {
      sessionId: nextSessionId ?? undefined,
      message: undefined,
    }
  }

  if (!response.ok) {
    const details = await response.text()
    throw new Error(details || `MCP request failed with ${response.status}`)
  }

  const contentType = response.headers.get("Content-Type") ?? ""

  if (contentType.includes("text/event-stream")) {
    return {
      sessionId: nextSessionId ?? undefined,
      message: await parseEventStreamResponse(response, args.request.id),
    }
  }

  if (contentType.includes("application/json")) {
    const payload = (await response.json()) as unknown

    return {
      sessionId: nextSessionId ?? undefined,
      message: extractResponseMessage(payload, args.request.id),
    }
  }

  const details = await response.text()
  throw new Error(details || "Unsupported MCP response content type")
}

function assertNoJsonRpcError(message: JsonRpcResponse | undefined) {
  if (!message) {
    throw new Error("MCP server returned no JSON-RPC response")
  }

  if (message.error) {
    const errorMessage =
      asString(message.error.message) || "MCP server returned an error"
    throw new Error(errorMessage)
  }
}

async function initializeSession(serverUrl: string, signal: AbortSignal) {
  const initializeRequest: JsonRpcRequest = {
    jsonrpc: "2.0",
    id: createRequestId(),
    method: "initialize",
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: MCP_CLIENT_INFO,
    },
  }

  const initializeResponse = await postJsonRpc({
    serverUrl,
    request: initializeRequest,
    signal,
  })

  assertNoJsonRpcError(initializeResponse.message)

  const result = initializeResponse.message?.result as
    | McpInitializeResult
    | undefined
  const protocolVersion = asString(result?.protocolVersion, MCP_PROTOCOL_VERSION)

  await postJsonRpc({
    serverUrl,
    sessionId: initializeResponse.sessionId,
    request: {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    },
    signal,
  })

  const nextState: McpSessionState = {
    sessionId: initializeResponse.sessionId,
    protocolVersion,
  }

  sessionCache.set(serverUrl, nextState)
  return nextState
}

async function withSession<T>(
  serverUrl: string,
  signal: AbortSignal,
  run: (session: McpSessionState) => Promise<T>
) {
  let session = sessionCache.get(serverUrl)

  if (!session) {
    session = await initializeSession(serverUrl, signal)
  }

  try {
    return await run(session)
  } catch (error) {
    if (error instanceof McpSessionExpiredError) {
      sessionCache.delete(serverUrl)
      const nextSession = await initializeSession(serverUrl, signal)
      return run(nextSession)
    }

    throw error
  }
}

function normalizeTool(value: unknown): McpTool | null {
  if (!isRecord(value)) {
    return null
  }

  const name = asString(value.name)
  if (!name) {
    return null
  }

  const description =
    asString(value.description) || "No tool description provided."
  const inputSchema = isRecord(value.inputSchema)
    ? value.inputSchema
    : isRecord(value.input_schema)
      ? value.input_schema
      : undefined

  return {
    name,
    description,
    inputSchema,
  }
}

function normalizeToolResultText(result: unknown) {
  if (!isRecord(result)) {
    return {
      isError: false,
      contentText: "Tool returned no structured result.",
      structuredContent: undefined,
    }
  }

  const content = Array.isArray(result.content) ? result.content : []
  const lines: string[] = []

  for (const item of content) {
    if (!isRecord(item)) {
      continue
    }

    const type = asString(item.type)

    if (type === "text") {
      const text = asString(item.text)
      if (text) {
        lines.push(text)
      }
      continue
    }

    if (type === "image") {
      lines.push(
        `[Image tool result omitted; mime=${asString(item.mimeType, "unknown")}]`
      )
      continue
    }

    if (type === "audio") {
      lines.push(
        `[Audio tool result omitted; mime=${asString(item.mimeType, "unknown")}]`
      )
      continue
    }

    if (type === "resource" && isRecord(item.resource)) {
      const resource = item.resource
      const resourceText = asString(resource.text)

      if (resourceText) {
        lines.push(resourceText)
      } else {
        lines.push(
          `[Resource result: ${asString(resource.uri, "unknown-resource")}]`
        )
      }
    }
  }

  const structuredContent =
    "structuredContent" in result ? result.structuredContent : undefined

  if (lines.length === 0 && typeof structuredContent !== "undefined") {
    lines.push(JSON.stringify(structuredContent, null, 2))
  }

  return {
    isError: Boolean(result.isError),
    contentText: lines.join("\n\n").trim() || "Tool returned no text content.",
    structuredContent,
  }
}

export async function listMcpTools(serverUrl: string, signal: AbortSignal) {
  return withSession(serverUrl, signal, async (session) => {
    const tools: McpTool[] = []
    let cursor: string | undefined

    while (true) {
      const request: JsonRpcRequest = {
        jsonrpc: "2.0",
        id: createRequestId(),
        method: "tools/list",
        params: cursor ? { cursor } : {},
      }

      const response = await postJsonRpc({
        serverUrl,
        sessionId: session.sessionId,
        request,
        signal,
      })

      if (response.sessionId && response.sessionId !== session.sessionId) {
        session.sessionId = response.sessionId
        sessionCache.set(serverUrl, session)
      }

      assertNoJsonRpcError(response.message)

      const result = isRecord(response.message?.result)
        ? response.message?.result
        : {}
      const nextCursor = asString(result.nextCursor)
      const pageTools = Array.isArray(result.tools) ? result.tools : []

      for (const item of pageTools) {
        const tool = normalizeTool(item)
        if (tool) {
          tools.push(tool)
        }
      }

      if (!nextCursor) {
        break
      }

      cursor = nextCursor
    }

    return tools
  })
}

export async function callMcpTool(args: {
  serverUrl: string
  toolName: string
  toolArguments?: Record<string, unknown>
  signal: AbortSignal
}) {
  return withSession(args.serverUrl, args.signal, async (session) => {
    const response = await postJsonRpc({
      serverUrl: args.serverUrl,
      sessionId: session.sessionId,
      request: {
        jsonrpc: "2.0",
        id: createRequestId(),
        method: "tools/call",
        params: {
          name: args.toolName,
          arguments: args.toolArguments ?? {},
        },
      },
      signal: args.signal,
    })

    if (response.sessionId && response.sessionId !== session.sessionId) {
      session.sessionId = response.sessionId
      sessionCache.set(args.serverUrl, session)
    }

    assertNoJsonRpcError(response.message)

    return normalizeToolResultText(response.message?.result)
  })
}

export function invalidateMcpSession(serverUrl: string) {
  sessionCache.delete(serverUrl)
}
