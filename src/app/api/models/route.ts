import {
  getLlmApiKey,
  getOpenAiCompatibleBaseUrl,
} from "@/lib/intelligent-config"

export const runtime = "nodejs"

type UpstreamModelRecord = {
  id?: unknown
}

type UpstreamModelsResponse = {
  data?: UpstreamModelRecord[]
}

function humanizeModelId(id: string) {
  return id
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

function buildAuthHeaders(apiKey?: string) {
  const headers = new Headers()

  if (apiKey?.trim()) {
    headers.set("Authorization", `Bearer ${apiKey.trim()}`)
  }

  return headers
}

function extractModelIds(payload: UpstreamModelsResponse) {
  const seen = new Set<string>()
  const ids: string[] = []

  for (const item of payload.data ?? []) {
    if (typeof item?.id !== "string") continue

    const id = item.id.trim()
    if (!id || seen.has(id)) continue

    seen.add(id)
    ids.push(id)
  }

  return ids
}

export async function GET() {
  const baseUrl = getOpenAiCompatibleBaseUrl()
  const apiKey = getLlmApiKey()

  if (!baseUrl) {
    return Response.json(
      {
        error:
          "Missing provider base URL. Set OPENAI_COMPAT_BASE_URL or LLAMA_SERVER_BASE_URL in .env.local.",
        defaultModel: null,
        models: [],
      },
      { status: 500 }
    )
  }

  let upstream: Response

  try {
    upstream = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
      method: "GET",
      headers: buildAuthHeaders(apiKey),
      cache: "no-store",
    })
  } catch (error) {
    return Response.json(
      {
        error: "Upstream provider models request failed before response",
        details: error instanceof Error ? error.message : "Unknown error",
        defaultModel: null,
        models: [],
      },
      { status: 500 }
    )
  }

  if (!upstream.ok) {
    const details = await upstream.text()

    return Response.json(
      {
        error: "Upstream provider models request failed",
        details,
        defaultModel: null,
        models: [],
      },
      { status: upstream.status || 500 }
    )
  }

  let payload: UpstreamModelsResponse

  try {
    payload = (await upstream.json()) as UpstreamModelsResponse
  } catch {
    return Response.json(
      {
        error: "Upstream provider returned invalid JSON for /models",
        defaultModel: null,
        models: [],
      },
      { status: 500 }
    )
  }

  const models = extractModelIds(payload).map((id) => ({
    id,
    label: humanizeModelId(id),
  }))

  return Response.json({
    defaultModel: models[0]?.id ?? null,
    models,
  })
}
