import { buildJsonSchema, buildProviderMessages } from "@/lib/provider"
import type { ChatMessage, JsonSchemaDraft, MessageMeta, ThinkMode } from "@/lib/types"

export const runtime = "nodejs"

type ChatRequestBody = {
  model: string
  systemPrompt: string
  temperature: number
  thinkMode: ThinkMode
  outputMode: "normal" | "json"
  jsonSchema?: JsonSchemaDraft
  messages: ChatMessage[]
}

function makeSseChunk(payload: unknown) {
  return `data: ${JSON.stringify(payload)}\n\n`
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError"
}

export async function POST(request: Request) {
  const baseUrl = process.env.OPENAI_COMPAT_BASE_URL
  const apiKey = process.env.OPENAI_COMPAT_API_KEY ?? "sk-demo"

  if (!baseUrl) {
    return Response.json(
      { error: "Missing OPENAI_COMPAT_BASE_URL in .env.local" },
      { status: 500 }
    )
  }

  const body = (await request.json()) as ChatRequestBody

  const providerMessages = buildProviderMessages(body.systemPrompt, body.messages)
  const jsonSchema = buildJsonSchema(body.jsonSchema)

  const providerPayload: Record<string, unknown> = {
    model: body.model,
    messages: providerMessages,
    temperature: body.temperature,
    stream: true,
    chat_template_kwargs: {
      enable_thinking: body.thinkMode === "think",
    },
  }

  if (body.outputMode === "json" && jsonSchema) {
    providerPayload.response_format = {
      type: "json_schema",
      json_schema: jsonSchema,
    }
  }

  let upstream: Response

  try {
    upstream = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(providerPayload),
      signal: request.signal,
    })
  } catch (error) {
    if (isAbortError(error)) {
      return new Response(null, { status: 204 })
    }

    return Response.json(
      {
        error: "Upstream provider request failed before streaming started",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    )
  }

  if (!upstream.ok || !upstream.body) {
    const details = await upstream.text()

    return Response.json(
      {
        error: "Upstream provider request failed",
        details,
      },
      { status: upstream.status || 500 }
    )
  }

  const encoder = new TextEncoder()
  const decoder = new TextDecoder()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.body!.getReader()

      let buffer = ""
      let sentDone = false

      const finalMeta: MessageMeta = {
        model: body.model,
      }

      const send = (payload: unknown) => {
        controller.enqueue(encoder.encode(makeSseChunk(payload)))
      }

      const abortHandler = async () => {
        try {
          await reader.cancel()
        } catch {
          // ignore
        }
      }

      request.signal.addEventListener("abort", abortHandler)

      try {
        while (true) {
          if (request.signal.aborted) {
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
              if (!data) continue

              if (data === "[DONE]") {
                if (!sentDone && !request.signal.aborted) {
                  send({ type: "meta", meta: finalMeta })
                  send({ type: "done" })
                  sentDone = true
                }
                continue
              }

              let json: any

              try {
                json = JSON.parse(data)
              } catch {
                continue
              }

              if (json.model) {
                finalMeta.model = json.model
              }

              const choice = json.choices?.[0]
              const delta = choice?.delta ?? {}

              const reasoningText =
                typeof delta.reasoning_content === "string"
                  ? delta.reasoning_content
                  : ""

              const normalText =
                typeof delta.content === "string" ? delta.content : ""

              if (reasoningText && !request.signal.aborted) {
                send({
                  type: "reasoning",
                  text: reasoningText,
                })
              }

              if (normalText && !request.signal.aborted) {
                send({
                  type: "token",
                  text: normalText,
                })
              }

              if (choice?.finish_reason) {
                finalMeta.finishReason = choice.finish_reason
              }

              if (json.usage) {
                finalMeta.promptTokens = json.usage.prompt_tokens
                finalMeta.completionTokens = json.usage.completion_tokens
                finalMeta.totalTokens = json.usage.total_tokens
              }

              if (json.timings) {
                finalMeta.ppTps = json.timings.prompt_per_second
                finalMeta.tgTps = json.timings.predicted_per_second
              }
            }

            boundaryIndex = buffer.indexOf("\n\n")
          }
        }

        if (!sentDone && !request.signal.aborted) {
          send({ type: "meta", meta: finalMeta })
          send({ type: "done" })
        }
      } catch (error) {
        if (!isAbortError(error) && !request.signal.aborted) {
          send({
            type: "error",
            error:
              error instanceof Error ? error.message : "Streaming proxy failed",
          })
        }
      } finally {
        request.signal.removeEventListener("abort", abortHandler)

        try {
          reader.releaseLock()
        } catch {
          // ignore
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
