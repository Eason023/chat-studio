"use client"

import { useEffect, useState } from "react"

export type ModelOption = {
  id: string
  label: string
}

const fallbackModels: ModelOption[] = [
  { id: "qwen3.5-4b", label: "Qwen3.5 4B" },
  { id: "qwen3.5-27b", label: "Qwen3.5 27B" },
]

export function useModels() {
  const [models, setModels] = useState<ModelOption[]>(fallbackModels)

  useEffect(() => {
    let cancelled = false

    async function loadModels() {
      try {
        const response = await fetch("/api/models", {
          method: "GET",
          cache: "no-store",
        })

        if (!response.ok) return

        const data = await response.json()

        if (!cancelled && Array.isArray(data.models) && data.models.length > 0) {
          setModels(data.models)
        }
      } catch {
        // keep fallback models
      }
    }

    void loadModels()

    return () => {
      cancelled = true
    }
  }, [])

  return { models }
}
