"use client"

import type { ReactNode } from "react"
import {
  BrainCircuit,
  MessageSquareText,
  Plus,
  Settings2,
  Trash2,
} from "lucide-react"

import { AppBrand } from "@/components/app-brand"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import type { IntelligentConversation } from "@/lib/types"
import { cn, formatRelativeTime } from "@/lib/utils"

type IntelligentConversationSidebarProps = {
  appTitle: string
  modeLabel: string
  workspaceSwitcher?: ReactNode
  conversations: IntelligentConversation[]
  activeConversationId: string | null
  globalMemoryCount: number
  isSending: boolean
  onCreateConversation: () => void
  onOpenMemorySettings: () => void
  onSelectConversation: (id: string) => void
  onDeleteConversation: (id: string) => void
}

function clampConversationTitle(title: string, maxLength = 28) {
  const compact = title.replace(/\s+/g, " ").trim()

  if (!compact) {
    return "New Session"
  }

  return compact.length > maxLength
    ? `${compact.slice(0, maxLength).trimEnd()}...`
    : compact
}

export function IntelligentConversationSidebar({
  appTitle,
  modeLabel,
  workspaceSwitcher,
  conversations,
  activeConversationId,
  globalMemoryCount,
  isSending,
  onCreateConversation,
  onOpenMemorySettings,
  onSelectConversation,
  onDeleteConversation,
}: IntelligentConversationSidebarProps) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="shrink-0 space-y-3 px-3 py-3">
        <div className="flex items-start justify-between gap-3">
          <AppBrand
            title={appTitle}
            titleClassName="text-base"
            iconClassName="size-9"
            subtitle={
              <span className="flex items-center gap-2">
                <BrainCircuit className="h-3.5 w-3.5" />
                <span>{modeLabel}</span>
              </span>
            }
          />

          <div className="flex items-center gap-1.5">
            <Button
              size="icon-sm"
              variant="outline"
              aria-label="Open global memory settings"
              onClick={onOpenMemorySettings}
            >
              <Settings2 className="h-4 w-4" />
            </Button>
            <Button
              size="icon-sm"
              variant="outline"
              aria-label="New intelligent session"
              disabled={isSending}
              onClick={onCreateConversation}
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {workspaceSwitcher ? (
          <div className="rounded-xl border bg-muted/20 px-3 py-3">
            {workspaceSwitcher}
          </div>
        ) : null}

        <div className="rounded-xl border bg-muted/30 px-3 py-2 text-xs leading-5 text-muted-foreground">
          Session history stays local in this browser. Cross-session memory currently
          has {globalMemoryCount} stored {globalMemoryCount === 1 ? "session entry" : "session entries"}.
        </div>
      </div>

      <Separator />

      <ScrollArea className="min-h-0 flex-1 overflow-hidden">
        <div className="space-y-1.5 p-2">
          {conversations.map((conversation) => {
            const isActive = conversation.id === activeConversationId
            const messageCount = conversation.messages.length
            const displayTitle = clampConversationTitle(conversation.title)

            return (
              <div
                key={conversation.id}
                className={cn(
                  "group grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2 rounded-xl px-2 py-2 transition",
                  isActive && "bg-muted"
                )}
              >
                <button
                  className="min-w-0 overflow-hidden text-left"
                  disabled={isSending}
                  onClick={() => onSelectConversation(conversation.id)}
                >
                  <div className="flex min-w-0 items-start gap-3 overflow-hidden">
                    <MessageSquareText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 max-w-[10.75rem] overflow-hidden pr-1 sm:max-w-[11.5rem]">
                      <div className="truncate text-sm font-medium">
                        {displayTitle}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {messageCount} messages | {formatRelativeTime(conversation.updatedAt)}
                      </div>
                    </div>
                  </div>
                </button>

                <Button
                  size="icon-sm"
                  variant="ghost"
                  className={cn(
                    "shrink-0 self-center opacity-100 sm:opacity-0 sm:group-hover:opacity-100",
                    isActive && "sm:opacity-100"
                  )}
                  disabled={isSending}
                  onClick={() => onDeleteConversation(conversation.id)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            )
          })}
        </div>
      </ScrollArea>
    </div>
  )
}
