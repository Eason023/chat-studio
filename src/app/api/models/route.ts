export const runtime = "nodejs"

function humanizeModelId(id: string) {
  return id
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

export async function GET() {
  const raw =
    process.env.MODEL_LIST ??
    process.env.DEFAULT_MODEL ??
    "qwen3.5-4b,qwen3.5-27b"

  const models = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((id) => ({
      id,
      label: humanizeModelId(id),
    }))

  return Response.json({
    defaultModel: process.env.DEFAULT_MODEL ?? models[0]?.id ?? null,
    models,
  })
}
