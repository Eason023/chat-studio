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
}

type McpInitializeResult = {
  protocolVersion?: unknown
}

type StreamableHttpSessionState = {
  transport: "streamable-http"
  sessionId?: string
  protocolVersion?: string
}

type SseSessionState = {
  transport: "sse"
  protocolVersion?: string
  connection: McpSseConnection
}

type McpSessionState = StreamableHttpSessionState | SseSessionState

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

class McpHttpError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = "McpHttpError"
    this.status = status
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

function buildHeaders(
  sessionId?: string,
  authToken?: string,
  includeJsonContentType = true
) {
  const headers = new Headers()
  headers.set("Accept", "application/json, text/event-stream")

  if (includeJsonContentType) {
    headers.set("Content-Type", "application/json")
  }

  if (sessionId) {
    headers.set(MCP_SESSION_HEADER, sessionId)
  }

  if (authToken?.trim()) {
    headers.set("Authorization", `Bearer ${authToken.trim()}`)
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

function findSseBoundary(buffer: string) {
  const match = /\r?\n\r?\n/.exec(buffer)

  if (!match || typeof match.index !== "number") {
    return null
  }

  return {
    index: match.index,
    length: match[0].length,
  }
}

function looksLikeSseUrl(serverUrl: string) {
  return serverUrl.replace(/\/$/, "").endsWith("/sse")
}

function resolveSseConnectUrl(serverUrl: string) {
  const normalized = serverUrl.replace(/\/$/, "")
  return normalized.endsWith("/sse") ? normalized : `${normalized}/sse`
}

function resolveUrl(baseUrl: string, maybeRelative: string) {
  try {
    return new URL(maybeRelative, baseUrl).toString()
  } catch {
    return maybeRelative
  }
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

      let boundary = findSseBoundary(buffer)

      while (boundary) {
        const rawEvent = buffer.slice(0, boundary.index)
        buffer = buffer.slice(boundary.index + boundary.length)

        const dataLines = rawEvent
          .split(/\r?\n/)
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

        boundary = findSseBoundary(buffer)
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

async function postStreamableJsonRpc(args: {
  serverUrl: string
  request: JsonRpcRequest
  sessionId?: string
  authToken?: string
  signal: AbortSignal
}) {
  const response = await fetch(args.serverUrl, {
    method: "POST",
    headers: buildHeaders(args.sessionId, args.authToken),
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
    throw new McpHttpError(
      response.status,
      details || `MCP request failed with ${response.status}`
    )
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

class McpSseConnection {
  private readonly response: Response
  private readonly sourceUrl: string
  private readonly authToken?: string
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>
  private readonly decoder = new TextDecoder()
  private buffer = ""
  private queuedMessages: JsonRpcResponse[] = []
  private waiters: Array<{
    requestId: JsonRpcId
    resolve: (value: JsonRpcResponse | undefined) => void
    reject: (error: Error) => void
  }> = []
  private closed = false
  private endpointResolver!: (value: string) => void
  private endpointRejecter!: (reason?: unknown) => void
  private readonly endpointPromise: Promise<string>
  private readonly pumpPromise: Promise<void>

  private constructor(response: Response, sourceUrl: string, authToken?: string) {
    this.response = response
    this.sourceUrl = sourceUrl
    this.authToken = authToken
    this.reader = response.body!.getReader()
    this.endpointPromise = new Promise<string>((resolve, reject) => {
      this.endpointResolver = resolve
      this.endpointRejecter = reject
    })
    this.pumpPromise = this.pump()
  }

  static async connect(
    serverUrl: string,
    signal: AbortSignal,
    authToken?: string
  ) {
    const connectUrl = resolveSseConnectUrl(serverUrl)
    const response = await fetch(connectUrl, {
      method: "GET",
      headers: buildHeaders(undefined, authToken, false),
      signal,
    })

    if (!response.ok || !response.body) {
      const details = await response.text()
      throw new McpHttpError(
        response.status,
        details || `MCP SSE connect failed with ${response.status}`
      )
    }

    const connection = new McpSseConnection(response, connectUrl, authToken)
    await connection.waitForEndpoint(signal)
    return connection
  }

  private deliverMessage(message: JsonRpcResponse) {
    const waiterIndex = this.waiters.findIndex(
      (waiter) => waiter.requestId === message.id
    )

    if (waiterIndex !== -1) {
      const waiter = this.waiters.splice(waiterIndex, 1)[0]
      waiter.resolve(message)
      return
    }

    this.queuedMessages.push(message)
  }

  private async pump() {
    try {
      while (!this.closed) {
        const { done, value } = await this.reader.read()
        if (done) {
          break
        }

        this.buffer += this.decoder.decode(value, { stream: true })

        let boundary = findSseBoundary(this.buffer)

        while (boundary) {
          const rawEvent = this.buffer.slice(0, boundary.index)
          this.buffer = this.buffer.slice(boundary.index + boundary.length)

          const lines = rawEvent.split(/\r?\n/)
          let eventName = "message"
          const dataLines: string[] = []

          for (const line of lines) {
            const trimmed = line.trimEnd()

            if (trimmed.startsWith("event:")) {
              eventName = trimmed.slice(6).trim() || "message"
            } else if (trimmed.startsWith("data:")) {
              dataLines.push(trimmed.slice(5).trim())
            }
          }

          const data = dataLines.join("\n")

          if (eventName === "endpoint" && data) {
            this.endpointResolver(resolveUrl(this.sourceUrl, data))
          } else if (eventName === "message" && data) {
            try {
              const parsed = JSON.parse(data) as unknown
              const message = extractResponseMessage(parsed)
              if (message) {
                this.deliverMessage(message)
              }
            } catch {
              // ignore malformed payloads
            }
          }

          boundary = findSseBoundary(this.buffer)
        }
      }
    } catch (error) {
      this.endpointRejecter(error)

      const nextError =
        error instanceof Error ? error : new Error("MCP SSE connection failed")

      for (const waiter of this.waiters.splice(0)) {
        waiter.reject(nextError)
      }
    } finally {
      this.closed = true
      this.endpointRejecter(new Error("MCP SSE connection closed"))

      for (const waiter of this.waiters.splice(0)) {
        waiter.reject(new Error("MCP SSE connection closed"))
      }

      try {
        this.reader.releaseLock()
      } catch {
        // ignore
      }
    }
  }

  async waitForEndpoint(signal: AbortSignal) {
    if (signal.aborted) {
      throw new Error("MCP SSE request aborted")
    }

    return Promise.race([
      this.endpointPromise,
      new Promise<string>((_, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new Error("MCP SSE request aborted")),
          { once: true }
        )
      }),
    ])
  }

  async post(request: JsonRpcRequest, signal: AbortSignal) {
    const endpointUrl = await this.waitForEndpoint(signal)
    const response = await fetch(endpointUrl, {
      method: "POST",
      headers: buildHeaders(undefined, this.authToken),
      body: JSON.stringify(request),
      signal,
    })

    if (!response.ok) {
      const details = await response.text()
      throw new McpHttpError(
        response.status,
        details || `MCP SSE message POST failed with ${response.status}`
      )
    }

    if (typeof request.id === "undefined") {
      return undefined
    }

    return this.waitForResponse(request.id, signal)
  }

  private async waitForResponse(requestId: JsonRpcId, signal: AbortSignal) {
    const queuedIndex = this.queuedMessages.findIndex(
      (message) => message.id === requestId
    )

    if (queuedIndex !== -1) {
      return this.queuedMessages.splice(queuedIndex, 1)[0]
    }

    if (signal.aborted) {
      throw new Error("MCP SSE request aborted")
    }

    return await new Promise<JsonRpcResponse | undefined>((resolve, reject) => {
      const waiter = { requestId, resolve, reject }
      this.waiters.push(waiter)

      signal.addEventListener(
        "abort",
        () => {
          const index = this.waiters.indexOf(waiter)
          if (index !== -1) {
            this.waiters.splice(index, 1)
          }
          reject(new Error("MCP SSE request aborted"))
        },
        { once: true }
      )
    })
  }

  async close() {
    this.closed = true

    try {
      await this.reader.cancel()
    } catch {
      // ignore
    }

    try {
      await this.pumpPromise
    } catch {
      // ignore
    }
  }
}

async function initializeStreamableSession(
  serverUrl: string,
  authToken: string | undefined,
  signal: AbortSignal
) {
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

  const initializeResponse = await postStreamableJsonRpc({
    serverUrl,
    request: initializeRequest,
    authToken,
    signal,
  })

  assertNoJsonRpcError(initializeResponse.message)

  const result = initializeResponse.message?.result as
    | McpInitializeResult
    | undefined
  const protocolVersion = asString(result?.protocolVersion, MCP_PROTOCOL_VERSION)

  await postStreamableJsonRpc({
    serverUrl,
    sessionId: initializeResponse.sessionId,
    authToken,
    request: {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    },
    signal,
  })

  const nextState: StreamableHttpSessionState = {
    transport: "streamable-http",
    sessionId: initializeResponse.sessionId,
    protocolVersion,
  }

  sessionCache.set(serverUrl, nextState)
  return nextState
}

async function initializeSseSession(
  serverUrl: string,
  authToken: string | undefined,
  signal: AbortSignal
) {
  const connection = await McpSseConnection.connect(serverUrl, signal, authToken)
  const initializeMessage = await connection.post(
    {
      jsonrpc: "2.0",
      id: createRequestId(),
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: MCP_CLIENT_INFO,
      },
    },
    signal
  )

  assertNoJsonRpcError(initializeMessage)

  const result = initializeMessage?.result as McpInitializeResult | undefined
  const protocolVersion = asString(result?.protocolVersion, MCP_PROTOCOL_VERSION)

  await connection.post(
    {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    },
    signal
  )

  const nextState: SseSessionState = {
    transport: "sse",
    protocolVersion,
    connection,
  }

  sessionCache.set(serverUrl, nextState)
  return nextState
}

function shouldFallbackToSse(error: unknown) {
  return (
    error instanceof McpHttpError &&
    (error.status === 405 || error.status === 404)
  )
}

async function initializeSession(
  serverUrl: string,
  authToken: string | undefined,
  signal: AbortSignal
) {
  if (looksLikeSseUrl(serverUrl)) {
    return initializeSseSession(serverUrl, authToken, signal)
  }

  try {
    return await initializeStreamableSession(serverUrl, authToken, signal)
  } catch (error) {
    if (!shouldFallbackToSse(error)) {
      throw error
    }

    return initializeSseSession(serverUrl, authToken, signal)
  }
}

async function sendJsonRpc(args: {
  serverUrl: string
  session: McpSessionState
  request: JsonRpcRequest
  authToken?: string
  signal: AbortSignal
}) {
  if (args.session.transport === "sse") {
    return {
      message: await args.session.connection.post(args.request, args.signal),
    }
  }

  const response = await postStreamableJsonRpc({
    serverUrl: args.serverUrl,
    sessionId: args.session.sessionId,
    request: args.request,
    authToken: args.authToken,
    signal: args.signal,
  })

  if (response.sessionId && response.sessionId !== args.session.sessionId) {
    args.session.sessionId = response.sessionId
    sessionCache.set(args.serverUrl, args.session)
  }

  return response
}

async function withSession<T>(
  serverUrl: string,
  authToken: string | undefined,
  signal: AbortSignal,
  run: (session: McpSessionState) => Promise<T>
) {
  let session = sessionCache.get(serverUrl)

  if (!session) {
    session = await initializeSession(serverUrl, authToken, signal)
  }

  try {
    return await run(session)
  } catch (error) {
    if (error instanceof McpSessionExpiredError) {
      invalidateMcpSession(serverUrl)
      const nextSession = await initializeSession(serverUrl, authToken, signal)
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

export async function listMcpTools(
  serverUrl: string,
  signal: AbortSignal,
  authToken?: string
) {
  return withSession(serverUrl, authToken, signal, async (session) => {
    const tools: McpTool[] = []
    let cursor: string | undefined

    while (true) {
      const response = await sendJsonRpc({
        serverUrl,
        session,
        request: {
          jsonrpc: "2.0",
          id: createRequestId(),
          method: "tools/list",
          params: cursor ? { cursor } : {},
        },
        authToken,
        signal,
      })

      assertNoJsonRpcError(response.message)

      const result = isRecord(response.message?.result)
        ? response.message.result
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

    return tools.sort((left, right) => left.name.localeCompare(right.name))
  })
}

export async function callMcpTool(args: {
  serverUrl: string
  toolName: string
  toolArguments?: Record<string, unknown>
  authToken?: string
  signal: AbortSignal
}) {
  return withSession(
    args.serverUrl,
    args.authToken,
    args.signal,
    async (session) => {
    const response = await sendJsonRpc({
      serverUrl: args.serverUrl,
      session,
      request: {
        jsonrpc: "2.0",
        id: createRequestId(),
        method: "tools/call",
        params: {
          name: args.toolName,
          arguments: args.toolArguments ?? {},
        },
      },
      authToken: args.authToken,
      signal: args.signal,
    })

    assertNoJsonRpcError(response.message)

    return normalizeToolResultText(response.message?.result)
    }
  )
}

export function invalidateMcpSession(serverUrl: string) {
  const session = sessionCache.get(serverUrl)
  sessionCache.delete(serverUrl)

  if (session?.transport === "sse") {
    void session.connection.close()
  }
}
