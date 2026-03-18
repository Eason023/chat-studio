const ACTIVE_KEY = "chat-studio:active-conversation-id"

export function loadActiveConversationId(): string | null {
  if (typeof window === "undefined") return null

  try {
    return window.localStorage.getItem(ACTIVE_KEY)
  } catch (error) {
    console.warn("Failed to load active conversation id:", error)
    return null
  }
}

export function saveActiveConversationId(id: string) {
  if (typeof window === "undefined") return

  try {
    window.localStorage.setItem(ACTIVE_KEY, id)
  } catch (error) {
    console.error("Failed to save active conversation id:", error)
  }
}
