"use client"

import { MessageSquare, Plus, Trash2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import type { Conversation } from "@/lib/types"
import { cn, formatRelativeTime } from "@/lib/utils"

type ConversationSidebarProps = {
  appTitle: string
  conversations: Conversation[]
  activeConversationId: string | null
  onCreateConversation: () => void
  onSelectConversation: (id: string) => void
  onDeleteConversation: (id: string) => void
}

export function ConversationSidebar({
  appTitle,
  conversations,
  activeConversationId,
  onCreateConversation,
  onSelectConversation,
  onDeleteConversation,
}: ConversationSidebarProps) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-4 py-3">
        <div>
          <div className="text-sm font-semibold">{appTitle}</div>
          <div className="text-xs text-muted-foreground">Conversations</div>
        </div>

        <Button
          size="icon"
          variant="outline"
          aria-label="New chat"
          onClick={onCreateConversation}
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      <Separator />

      <ScrollArea className="flex-1">
        <div className="space-y-2 p-3">
          {conversations.map((conv) => {
            const isActive = conv.id === activeConversationId

            return (
              <div
                key={conv.id}
                className={cn(
                  "group flex items-start gap-2 rounded-xl px-2 py-2 transition",
                  isActive && "bg-muted"
                )}
              >
                <button
                  className="flex min-w-0 flex-1 items-start gap-3 text-left"
                  onClick={() => onSelectConversation(conv.id)}
                >
                  <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{conv.title}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {formatRelativeTime(conv.updatedAt)}
                    </div>
                  </div>
                </button>

                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8 opacity-0 group-hover:opacity-100"
                  onClick={() => onDeleteConversation(conv.id)}
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
