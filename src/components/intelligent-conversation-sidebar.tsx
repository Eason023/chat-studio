"use client"

import { BrainCircuit, MessageSquareText, Plus, Trash2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import type { IntelligentConversation } from "@/lib/types"
import { cn, formatRelativeTime } from "@/lib/utils"

type IntelligentConversationSidebarProps = {
  appTitle: string
  modeLabel: string
  conversations: IntelligentConversation[]
  activeConversationId: string | null
  isSending: boolean
  onCreateConversation: () => void
  onSelectConversation: (id: string) => void
  onDeleteConversation: (id: string) => void
}

export function IntelligentConversationSidebar({
  appTitle,
  modeLabel,
  conversations,
  activeConversationId,
  isSending,
  onCreateConversation,
  onSelectConversation,
  onDeleteConversation,
}: IntelligentConversationSidebarProps) {
  return (
    <div className="flex h-full flex-col bg-background">
      <div className="space-y-3 px-3 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-semibold">{appTitle}</div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <BrainCircuit className="h-3.5 w-3.5" />
              <span>{modeLabel}</span>
            </div>
          </div>

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

        <div className="rounded-xl border bg-muted/30 px-3 py-2 text-xs leading-5 text-muted-foreground">
          Session history stays local in this browser for now. Long-term memory can
          build across these sessions later without losing per-session traceability.
        </div>
      </div>

      <Separator />

      <ScrollArea className="flex-1">
        <div className="space-y-1.5 p-2">
          {conversations.map((conversation) => {
            const isActive = conversation.id === activeConversationId
            const messageCount = conversation.messages.length

            return (
              <div
                key={conversation.id}
                className={cn(
                  "group flex items-start gap-2 rounded-xl px-2 py-2 transition",
                  isActive && "bg-muted"
                )}
              >
                <button
                  className="flex min-w-0 flex-1 items-start gap-3 text-left"
                  disabled={isSending}
                  onClick={() => onSelectConversation(conversation.id)}
                >
                  <MessageSquareText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">
                      {conversation.title}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {messageCount} messages · {formatRelativeTime(conversation.updatedAt)}
                    </div>
                  </div>
                </button>

                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="shrink-0 self-center opacity-0 group-hover:opacity-100"
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
