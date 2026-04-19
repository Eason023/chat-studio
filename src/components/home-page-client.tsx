"use client"

import { useMemo, useSyncExternalStore } from "react"

import { IntelligentModePanel } from "@/components/intelligent-mode-panel"
import { LegacyWorkspace } from "@/components/legacy-workspace"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useIntelligentModes } from "@/hooks/use-intelligent-modes"
import {
  loadWorkspaceMode,
  saveWorkspaceMode,
  subscribeWorkspaceMode,
} from "@/lib/storage"

type HomePageClientProps = {
  appTitle: string
}

const LEGACY_WORKSPACE_ID = "legacy"

export function HomePageClient({ appTitle }: HomePageClientProps) {
  const { data, isLoading, error } = useIntelligentModes()

  const intelligentModeOptions = data.modes
  const hasIntelligentModes = data.enabled && intelligentModeOptions.length > 0

  const availableWorkspaceIds = useMemo(
    () => [LEGACY_WORKSPACE_ID, ...intelligentModeOptions.map((mode) => mode.id)],
    [intelligentModeOptions]
  )

  const storedWorkspaceId = useSyncExternalStore(
    subscribeWorkspaceMode,
    loadWorkspaceMode,
    () => null
  )

  const resolvedWorkspaceId = useMemo(() => {
    if (storedWorkspaceId && availableWorkspaceIds.includes(storedWorkspaceId)) {
      return storedWorkspaceId
    }

    if (
      hasIntelligentModes &&
      data.defaultModeId &&
      availableWorkspaceIds.includes(data.defaultModeId)
    ) {
      return data.defaultModeId
    }

    return LEGACY_WORKSPACE_ID
  }, [
    availableWorkspaceIds,
    data.defaultModeId,
    hasIntelligentModes,
    storedWorkspaceId,
  ])

  const selectedIntelligentMode =
    intelligentModeOptions.find((mode) => mode.id === resolvedWorkspaceId) ?? null

  if (!hasIntelligentModes) {
    return (
      <div className="h-screen">
        <LegacyWorkspace appTitle={appTitle} />
      </div>
    )
  }

  return (
    <div className="flex h-screen min-h-0 flex-col bg-background text-foreground">
      <div className="shrink-0 border-b border-border bg-background/95 px-4 py-2.5 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-semibold">{appTitle}</div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {isLoading ? <Badge variant="outline">Loading modes...</Badge> : null}
            {error ? <Badge variant="destructive">Modes unavailable</Badge> : null}

            <Select
              value={resolvedWorkspaceId}
              onValueChange={saveWorkspaceMode}
            >
              <SelectTrigger className="min-w-56">
                <SelectValue placeholder="Select workspace mode" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={LEGACY_WORKSPACE_ID}>
                  Legacy Custom Mode
                </SelectItem>
                {intelligentModeOptions.map((mode) => (
                  <SelectItem key={mode.id} value={mode.id}>
                    {mode.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {selectedIntelligentMode ? (
          <IntelligentModePanel
            appTitle={appTitle}
            mode={selectedIntelligentMode}
          />
        ) : (
          <LegacyWorkspace appTitle={appTitle} />
        )}
      </div>
    </div>
  )
}
