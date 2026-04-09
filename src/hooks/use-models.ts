"use client"

import { useEffect, useState } from "react"

export type ModelOption = {
  id: string
  label: string
}

type ModelsResponse = {
  defaultModel?: string | null
  models?: ModelOption[]
}

export function useModels() {
  const [models, setModels] = useState<ModelOption[]>([])
  const [defaultModel, setDefaultModel] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function loadModels() {
      try {
        const response = await fetch("/api/models", {
          method: "GET",
          cache: "no-store",
        })

        if (!response.ok) return

        const data = (await response.json()) as ModelsResponse

        if (cancelled) return

        setModels(Array.isArray(data.models) ? data.models : [])
        setDefaultModel(
          typeof data.defaultModel === "string" && data.defaultModel.trim()
            ? data.defaultModel
            : null
        )
      } catch {
        if (!cancelled) {
          setModels([])
          setDefaultModel(null)
        }
      }
    }

    void loadModels()

    return () => {
      cancelled = true
    }
  }, [])

  return { models, defaultModel }
}
