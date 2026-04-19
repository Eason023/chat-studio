import { getIntelligentModesResponse } from "@/lib/intelligent-config"

export const runtime = "nodejs"

export async function GET() {
  try {
    const payload = await getIntelligentModesResponse()
    return Response.json(payload)
  } catch (error) {
    return Response.json(
      {
        enabled: true,
        error: "Failed to load intelligent mode config",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    )
  }
}
