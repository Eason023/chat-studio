"use client"

import { useEffect, useState } from "react"

import type { IntelligentModesResponse } from "@/lib/types"

const DISABLED_RESPONSE: IntelligentModesResponse = {
  enabled: false,
  defaultModeId: null,
  configFile: null,
  mcpServerConfigured: false,
  backend: {
    hasOpenAiCompatibleBaseUrl: false,
    hasLlamaServerBaseUrl: false,
    canUseNativeSlotControl: false,
  },
  modes: [],
}

export function useIntelligentModes() {
  const [data, setData] = useState<IntelligentModesResponse>(DISABLED_RESPONSE)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function loadModes() {
      try {
        setIsLoading(true)
        setError(null)

        const response = await fetch("/api/intelligent/modes", {
          method: "GET",
          cache: "no-store",
        })

        const payload = (await response.json()) as Partial<IntelligentModesResponse> & {
          error?: string
          details?: string
        }

        if (cancelled) return

        if (!response.ok) {
          setData(DISABLED_RESPONSE)
          setError(payload.details ?? payload.error ?? "Failed to load intelligent modes")
          return
        }

        setData({
          ...DISABLED_RESPONSE,
          ...payload,
          backend: {
            ...DISABLED_RESPONSE.backend,
            ...payload.backend,
          },
          modes: Array.isArray(payload.modes) ? payload.modes : [],
        })
      } catch (nextError) {
        if (cancelled) return

        setData(DISABLED_RESPONSE)
        setError(
          nextError instanceof Error
            ? nextError.message
            : "Failed to load intelligent modes"
        )
      } finally {
        if (!cancelled) {
          setIsLoading(false)
        }
      }
    }

    void loadModes()

    return () => {
      cancelled = true
    }
  }, [])

  return {
    data,
    isLoading,
    error,
  }
}
