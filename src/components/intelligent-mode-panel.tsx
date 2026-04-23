"use client"

/* eslint-disable @next/next/no-img-element */

import type { ReactNode } from "react"
import { useEffect, useRef, useState } from "react"
import {
  ChevronDown,
  ChevronUp,
  DatabaseZap,
  FileImage,
  FileText,
  LoaderCircle,
  PanelLeftOpen,
  PencilLine,
  RotateCcw,
  Route,
  Sparkles,
} from "lucide-react"

import { Composer } from "@/components/composer"
import { IntelligentConversationSidebar } from "@/components/intelligent-conversation-sidebar"
import { IntelligentMemorySheet } from "@/components/intelligent-memory-sheet"
import { MarkdownRenderer } from "@/components/markdown-renderer"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { useIntelligentChat } from "@/hooks/use-intelligent-chat"
import { getIntelligentSessionMemoryKey } from "@/lib/intelligent-memory"
import type {
  IntelligentAttachmentPart,
  IntelligentConversationMessage,
  IntelligentMessageProcess,
  IntelligentModeSummary,
  IntelligentPhaseMetrics,
  IntelligentTracePhase,
} from "@/lib/types"

type IntelligentModePanelProps = {
  appTitle: string
  mode: IntelligentModeSummary
  workspaceSwitcher?: ReactNode
}

function TypewriterText({
  text,
  active,
}: {
  text: string
  active: boolean
}) {
  return (
    <TypewriterTextInner
      key={`${active ? "active" : "idle"}:${text}`}
      text={text}
      active={active}
    />
  )
}

function TypewriterTextInner({
  text,
  active,
}: {
  text: string
  active: boolean
}) {
  const [visibleLength, setVisibleLength] = useState(active ? 0 : text.length)

  useEffect(() => {
    if (!active || !text) {
      return
    }

    const interval = window.setInterval(() => {
      setVisibleLength((current) => {
        if (current >= text.length) {
          window.clearInterval(interval)
          return text.length
        }

        return Math.min(text.length, current + 2)
      })
    }, 14)

    return () => {
      window.clearInterval(interval)
    }
  }, [active, text])

  return <span>{active ? text.slice(0, visibleLength) : text}</span>
}

function getCurrentPhase(phases: IntelligentTracePhase[]) {
  const activePhase = [...phases].reverse().find((phase) => phase.status === "active")
  if (activePhase) {
    return activePhase
  }

  const preferredCompletedPhase = [...phases].reverse().find(
    (phase) =>
      phase.id !== "session-summary" &&
      phase.id !== "global-memory" &&
      phase.id !== "mcp-tools"
  )

  return preferredCompletedPhase ?? phases[phases.length - 1] ?? null
}

function getMajorLanePhase(phases: IntelligentTracePhase[]) {
  return [...phases].reverse().find(
    (phase) =>
      phase.lane === "contextual" &&
      phase.metrics &&
      phase.id !== "session-summary" &&
      phase.id !== "global-memory" &&
      phase.id !== "mcp-tools"
  )
}

function formatPromptTokenLabel(tokens?: number) {
  if (typeof tokens !== "number") {
    return ""
  }

  return `Context usage ${tokens.toLocaleString()} tok`
}

function getLatestContextUsageLabel(messages: IntelligentConversationMessage[]) {
  const latestAssistantWithProcess = [...messages]
    .reverse()
    .find((message) => message.role === "assistant" && message.process?.phases.length)

  if (!latestAssistantWithProcess?.process) {
    return ""
  }

  const majorLanePhase = getMajorLanePhase(latestAssistantWithProcess.process.phases)
  return formatPromptTokenLabel(majorLanePhase?.metrics?.promptTokens)
}

function compactInlineSummary(text?: string, maxLength = 120) {
  if (!text) return ""

  const compact = text.replace(/\s+/g, " ").trim()
  if (!compact) return ""

  return compact.length > maxLength
    ? `${compact.slice(0, maxLength).trimEnd()} ... click to expand`
    : compact
}

function getPhaseMetricBadges(metrics?: IntelligentPhaseMetrics) {
  if (!metrics) {
    return []
  }

  const badges: string[] = []

  if (typeof metrics.cacheHitRate === "number") {
    badges.push(`KV ${metrics.cacheHitRate.toFixed(1)}%`)
  }

  if (typeof metrics.ppTps === "number") {
    badges.push(`PP ${metrics.ppTps.toFixed(1)} tps`)
  }

  if (typeof metrics.tgTps === "number") {
    badges.push(`TG ${metrics.tgTps.toFixed(1)} tps`)
  }

  return badges
}

function renderAttachments(attachments: IntelligentAttachmentPart[] = []) {
  if (attachments.length === 0) {
    return null
  }

  return (
    <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {attachments.map((attachment) => (
        <div
          key={`${attachment.attachmentId}-${attachment.type === "pdf-image" ? attachment.page : "image"}`}
          className="overflow-hidden rounded-2xl border bg-muted/25"
        >
          <div className="aspect-[4/3] overflow-hidden bg-background">
            {attachment.url ? (
              <img
                src={attachment.url}
                alt={attachment.name ?? "attachment preview"}
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                Preview unavailable
              </div>
            )}
          </div>

          <div className="space-y-1 px-3 py-2.5">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              {attachment.type === "image" ? (
                <FileImage className="h-3.5 w-3.5" />
              ) : (
                <FileText className="h-3.5 w-3.5" />
              )}
              <span className="truncate">
                {attachment.type === "image"
                  ? "Image"
                  : `PDF page ${attachment.page}`}
              </span>
            </div>
            <div className="truncate text-xs font-medium">
              {attachment.name ?? "Untitled attachment"}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

function PhaseTraceItem({
  phase,
  index,
}: {
  phase: IntelligentTracePhase
  index: number
}) {
  const summary = compactInlineSummary(phase.summary ?? phase.detail, 220)
  const metricBadges = getPhaseMetricBadges(phase.metrics)

  return (
    <details className="group rounded-2xl border bg-background/80 open:bg-background">
      <summary className="cursor-pointer list-none px-3 py-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground">
                {index + 1}
              </div>
              <div className="truncate text-sm font-medium">{phase.label}</div>
            </div>

            {summary ? (
              <div className="mt-1.5 pl-8 text-sm leading-6 text-muted-foreground">
                {summary}
              </div>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2">
            {phase.modelId ? (
              <Badge variant="outline" className="rounded-full">
                {phase.modelId}
              </Badge>
            ) : null}
            {phase.lane ? (
              <Badge variant="outline" className="rounded-full">
                {phase.lane}
              </Badge>
            ) : null}
            {phase.reasoningMode ? (
              <Badge variant="outline" className="rounded-full">
                {phase.reasoningMode === "think" ? "think" : "instant"}
              </Badge>
            ) : null}
            {metricBadges.map((badge) => (
              <Badge key={badge} variant="outline" className="rounded-full">
                {badge}
              </Badge>
            ))}
            <Badge
              variant={
                phase.status === "completed"
                  ? "secondary"
                  : phase.status === "error"
                    ? "destructive"
                    : "outline"
              }
              className="rounded-full"
            >
              {phase.status}
            </Badge>
          </div>
        </div>
      </summary>

      {phase.detail ? (
        <div className="border-t px-3 py-3">
          <MarkdownRenderer content={phase.detail} muted />
        </div>
      ) : null}
    </details>
  )
}

function OrchestrationPanel({
  process,
  status,
  expanded,
  onToggle,
}: {
  process: IntelligentMessageProcess
  status: IntelligentConversationMessage["status"]
  expanded: boolean
  onToggle: () => void
}) {
  const currentPhase = getCurrentPhase(process.phases)
  const majorLanePhase = getMajorLanePhase(process.phases)
  const metricBadges = getPhaseMetricBadges(
    majorLanePhase?.metrics ?? currentPhase?.metrics
  )
  const titleText =
    status === "completed"
      ? "Reasoning complete"
      : status === "stopped"
        ? "Generation stopped"
        : status === "error"
          ? "Reasoning failed"
          : currentPhase?.label ?? "Working through the request"
  const statusText =
    status === "completed"
      ? "All routing, execution, and memory updates are complete."
      : status === "stopped"
        ? "The current orchestration run was stopped."
        : currentPhase?.detail?.trim() ||
          currentPhase?.label ||
          "Preparing the next step."

  return (
    <Collapsible open={expanded}>
      <div className="mb-4 rounded-2xl border border-primary/15 bg-primary/[0.04]">
        <button
          type="button"
          className="flex w-full items-start gap-3 px-3 py-3 text-left"
          onClick={onToggle}
        >
          <div className="mt-0.5 rounded-full bg-primary/10 p-1.5 text-primary">
            {status === "streaming" ? (
              <LoaderCircle className="h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
          </div>

          <div className="min-w-0 flex-1">
            <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="secondary" className="rounded-full">
                Trace
              </Badge>
              {currentPhase?.modelId ?? process.activeModel ? (
                <Badge variant="outline" className="rounded-full">
                  {currentPhase?.modelId ?? process.activeModel}
                </Badge>
              ) : null}
              {currentPhase?.lane ? (
                <Badge variant="outline" className="rounded-full">
                  {currentPhase.lane}
                </Badge>
              ) : null}
              {currentPhase?.reasoningMode ? (
                <Badge variant="outline" className="rounded-full">
                  {currentPhase.reasoningMode === "think" ? "think" : "instant"}
                </Badge>
              ) : null}
              {metricBadges.map((badge) => (
                <Badge key={badge} variant="outline" className="rounded-full">
                  {badge}
                </Badge>
              ))}
              {process.route ? (
                <Badge variant="outline" className="rounded-full">
                  <Route className="mr-1 h-3 w-3" />
                  {process.route}
                </Badge>
              ) : null}
            </div>

            <div className="text-sm font-medium">{titleText}</div>
            <div className="mt-1 text-sm leading-6 text-muted-foreground">
              <TypewriterText text={statusText} active={status === "streaming"} />
            </div>
          </div>

          <div className="pt-1 text-muted-foreground">
            {expanded ? (
              <ChevronUp className="h-4 w-4" />
            ) : (
              <ChevronDown className="h-4 w-4" />
            )}
          </div>
        </button>

        <CollapsibleContent>
          <div className="border-t px-3 py-3">
            <div className="space-y-2.5">
              {process.phases.map((phase, index) => (
                <PhaseTraceItem key={phase.id} phase={phase} index={index} />
              ))}
            </div>
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}

function AssistantMessageCard({
  message,
  expanded,
  onToggleProcess,
}: {
  message: IntelligentConversationMessage
  expanded: boolean
  onToggleProcess: () => void
}) {
  const process = message.process

  return (
    <div className="animate-in fade-in-0 slide-in-from-bottom-2 w-full pr-0 sm:pr-10 lg:pr-16 xl:pr-24 duration-300">
      <Card className="rounded-[1.6rem] border-border/80 shadow-sm">
        <CardContent className="p-4">
          <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Assistant</span>
            {message.status === "stopped" ? (
              <Badge variant="outline" className="rounded-full">
                Stopped
              </Badge>
            ) : null}
            {message.status === "error" ? (
              <Badge variant="destructive" className="rounded-full">
                Error
              </Badge>
            ) : null}
          </div>

          {process?.phases.length ? (
            <OrchestrationPanel
              process={process}
              status={message.status}
              expanded={expanded}
              onToggle={onToggleProcess}
            />
          ) : null}

          {message.content ? (
            <MarkdownRenderer content={message.content} />
          ) : message.status === "streaming" ? null : (
            <div className="text-sm text-muted-foreground">
              No visible answer content was produced.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function UserMessageCard({
  message,
  isSending,
  onEditRequest,
  onRegenerate,
}: {
  message: IntelligentConversationMessage
  isSending: boolean
  onEditRequest: (messageId: string) => void
  onRegenerate: (messageId: string) => void
}) {
  return (
    <div className="animate-in fade-in-0 slide-in-from-bottom-2 w-full pl-0 sm:pl-10 lg:pl-16 xl:pl-24 duration-300">
      <Card className="rounded-[1.6rem] border-border/80 bg-muted/40 shadow-sm">
        <CardContent className="p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs font-medium text-muted-foreground">User</div>

            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="rounded-full"
                disabled={isSending}
                onClick={() => onEditRequest(message.id)}
              >
                <PencilLine className="mr-2 h-3.5 w-3.5" />
                Edit & Resend
              </Button>

              <Button
                type="button"
                size="sm"
                variant="outline"
                className="rounded-full"
                disabled={isSending}
                onClick={() => onRegenerate(message.id)}
              >
                <RotateCcw className="mr-2 h-3.5 w-3.5" />
                Regenerate
              </Button>
            </div>
          </div>

          {message.content ? <MarkdownRenderer content={message.content} /> : null}
          {renderAttachments(message.attachments)}
        </CardContent>
      </Card>
    </div>
  )
}

export function IntelligentModePanel({
  appTitle,
  mode,
  workspaceSwitcher,
}: IntelligentModePanelProps) {
  const {
    hydrated,
    conversations,
    activeConversation,
    activeConversationId,
    messages,
    input,
    setInput,
    isSending,
    canSend,
    isEditing,
    createConversation,
    deleteConversation,
    selectConversation,
    sendMessage,
    startEditingMessage,
    cancelEditingMessage,
    regenerateMessage,
    stopGeneration,
    handleComposerKeyDown,
    expandedProcessMessageId,
    toggleProcessMessage,
    globalMemory,
    addGlobalMemoryEntry,
    updateGlobalMemoryEntry,
    deleteGlobalMemoryEntry,
    pendingAttachments,
    handleFilesSelected,
    removeAttachment,
    isProcessingAttachments,
  } = useIntelligentChat(mode)

  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const [memorySheetOpen, setMemorySheetOpen] = useState(false)
  const globalMemoryCount =
    globalMemory.userFeatures.length +
    globalMemory.instructionMemory.length +
    globalMemory.recentEvents.length
  const contextUsageLabel = getLatestContextUsageLabel(messages)

  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) return

    container.scrollTo({
      top: container.scrollHeight,
      behavior: "auto",
    })
  }, [isSending, messages])

  if (!hydrated || !activeConversation) {
    return null
  }

  const currentSessionKey = getIntelligentSessionMemoryKey(activeConversation.id)

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background md:grid md:grid-cols-[296px_minmax(0,1fr)]">
      <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2.5 md:hidden">
        <Sheet>
          <SheetTrigger asChild>
            <Button type="button" variant="outline" size="sm" className="rounded-full">
              <PanelLeftOpen className="mr-2 h-4 w-4" />
              Sessions
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-[88vw] max-w-[320px] p-0">
            <SheetHeader className="border-b">
              <SheetTitle>Intelligent Sessions</SheetTitle>
              <SheetDescription>
                Browse sessions, switch workspace mode, and open memory settings.
              </SheetDescription>
            </SheetHeader>
            <div className="min-h-0 flex-1 overflow-hidden">
              <IntelligentConversationSidebar
                appTitle={appTitle}
                modeLabel={mode.label}
                workspaceSwitcher={workspaceSwitcher}
                conversations={conversations}
                activeConversationId={activeConversationId}
                globalMemoryCount={globalMemoryCount}
                isSending={isSending}
                onCreateConversation={createConversation}
                onOpenMemorySettings={() => setMemorySheetOpen(true)}
                onSelectConversation={selectConversation}
                onDeleteConversation={deleteConversation}
              />
            </div>
          </SheetContent>
        </Sheet>

        <div className="min-w-0 flex-1 text-center">
          <div className="truncate text-sm font-semibold">
            {activeConversation.title || appTitle}
          </div>
          <div className="truncate text-[11px] text-muted-foreground">
            {mode.label}
          </div>
        </div>

        <Button
          type="button"
          variant="outline"
          size="sm"
          className="rounded-full"
          onClick={() => setMemorySheetOpen(true)}
        >
          <DatabaseZap className="mr-2 h-4 w-4" />
          Memory
        </Button>
      </div>

      <aside className="hidden min-h-0 min-w-0 overflow-hidden border-r border-border md:block">
        <IntelligentConversationSidebar
          appTitle={appTitle}
          modeLabel={mode.label}
          workspaceSwitcher={workspaceSwitcher}
          conversations={conversations}
          activeConversationId={activeConversationId}
          globalMemoryCount={globalMemoryCount}
          isSending={isSending}
          onCreateConversation={createConversation}
          onOpenMemorySettings={() => setMemorySheetOpen(true)}
          onSelectConversation={selectConversation}
          onDeleteConversation={deleteConversation}
        />
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <div
          ref={scrollContainerRef}
          className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-4 sm:py-5"
        >
          <div className="mx-auto flex max-w-6xl flex-col gap-4">
            {messages.length === 0 ? (
              <div className="flex min-h-full items-center justify-center py-8">
                <Card className="max-w-2xl rounded-[1.8rem] border-border/80 shadow-sm">
                  <CardContent className="p-6">
                    <div className="mb-4 flex flex-wrap items-center gap-2">
                      <Badge variant="secondary" className="rounded-full">
                        Intelligent Mode
                      </Badge>
                      <Badge variant="outline" className="rounded-full">
                        {mode.label}
                      </Badge>
                      <Badge variant="outline" className="rounded-full">
                        Major {mode.majorModel}
                      </Badge>
                    </div>

                    <div className="mb-3 text-2xl font-semibold tracking-tight">
                      Session-aware orchestration with multimodal input.
                    </div>

                    <p className="text-sm leading-7 text-muted-foreground">
                      Ask normally, or drop images and PDFs into the composer. Each
                      assistant reply keeps its own expandable orchestration trace,
                      so you can revisit older turns without pinning a permanent
                      dashboard on screen.
                    </p>
                  </CardContent>
                </Card>
              </div>
            ) : (
              messages.map((message) =>
                message.role === "user" ? (
                  <UserMessageCard
                    key={message.id}
                    message={message}
                    isSending={isSending}
                    onEditRequest={(messageId) => {
                      void startEditingMessage(messageId)
                    }}
                    onRegenerate={regenerateMessage}
                  />
                ) : (
                  <AssistantMessageCard
                    key={message.id}
                    message={message}
                    expanded={expandedProcessMessageId === message.id}
                    onToggleProcess={() => toggleProcessMessage(message.id)}
                  />
                )
              )
            )}
          </div>
        </div>

        <div className="shrink-0 bg-background/95 px-3 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:px-4">
          <div className="mx-auto max-w-6xl">
            <Composer
              value={input}
              onChange={setInput}
              onSend={sendMessage}
              onStop={stopGeneration}
              onKeyDown={handleComposerKeyDown}
              disabled={!canSend}
              isSending={isSending}
              isEditing={isEditing}
              onCancelEdit={cancelEditingMessage}
              attachments={pendingAttachments}
              onFilesAccepted={handleFilesSelected}
              onRemoveAttachment={removeAttachment}
              isProcessingAttachments={isProcessingAttachments}
              showAttachments
              contextUsageLabel={contextUsageLabel}
            />
          </div>
        </div>
      </div>

      <IntelligentMemorySheet
        open={memorySheetOpen}
        onOpenChange={setMemorySheetOpen}
        memory={globalMemory}
        isSending={isSending}
        currentSessionKey={currentSessionKey}
        onAddEntry={addGlobalMemoryEntry}
        onUpdateEntry={updateGlobalMemoryEntry}
        onDeleteEntry={deleteGlobalMemoryEntry}
      />
    </div>
  )
}
