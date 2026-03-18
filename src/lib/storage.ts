import type { Conversation } from "@/lib/types"

const STORAGE_KEY = "chat-studio:conversations"
const ACTIVE_KEY = "chat-studio:active-conversation-id"

export function loadConversations(): Conversation[] {
  if (typeof window === "undefined") return []

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    return JSON.parse(raw) as Conversation[]
  } catch {
    return []
  }
}

export function saveConversations(conversations: Conversation[]) {
  if (typeof window === "undefined") return
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations))
}

export function loadActiveConversationId(): string | null {
  if (typeof window === "undefined") return null
  return window.localStorage.getItem(ACTIVE_KEY)
}

export function saveActiveConversationId(id: string) {
  if (typeof window === "undefined") return
  window.localStorage.setItem(ACTIVE_KEY, id)
}
