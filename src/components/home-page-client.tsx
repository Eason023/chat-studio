"use client"

import { useMemo, useSyncExternalStore } from "react"

import { IntelligentModePanel } from "@/components/intelligent-mode-panel"
import { LegacyWorkspace } from "@/components/legacy-workspace"
import { WorkspaceSwitcher } from "@/components/workspace-switcher"
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
  const workspaceOptions = useMemo(
    () => [
      { id: LEGACY_WORKSPACE_ID, label: "Legacy Custom Mode" },
      ...intelligentModeOptions.map((mode) => ({
        id: mode.id,
        label: mode.label,
      })),
    ],
    [intelligentModeOptions]
  )

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
      <div className="h-dvh">
        <LegacyWorkspace appTitle={appTitle} />
      </div>
    )
  }

  const workspaceSwitcher = (
    <WorkspaceSwitcher
      value={resolvedWorkspaceId}
      options={workspaceOptions}
      isLoading={isLoading}
      error={error}
      onValueChange={saveWorkspaceMode}
    />
  )

  return (
    <div className="h-dvh bg-background text-foreground">
      {selectedIntelligentMode ? (
        <IntelligentModePanel
          appTitle={appTitle}
          mode={selectedIntelligentMode}
          workspaceSwitcher={workspaceSwitcher}
        />
      ) : (
        <LegacyWorkspace
          appTitle={appTitle}
          workspaceSwitcher={workspaceSwitcher}
        />
      )}
    </div>
  )
}
