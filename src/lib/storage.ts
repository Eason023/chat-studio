const ACTIVE_KEY = "chat-studio:active-conversation-id"
const INTELLIGENT_ACTIVE_KEY_PREFIX =
  "chat-studio:intelligent-active-conversation:"
const WORKSPACE_MODE_KEY = "chat-studio:workspace-mode"
const WORKSPACE_MODE_EVENT = "chat-studio:workspace-mode-change"

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

export function loadWorkspaceMode(): string | null {
  if (typeof window === "undefined") return null

  try {
    return window.localStorage.getItem(WORKSPACE_MODE_KEY)
  } catch (error) {
    console.warn("Failed to load workspace mode:", error)
    return null
  }
}

export function loadActiveIntelligentConversationId(modeId: string): string | null {
  if (typeof window === "undefined") return null

  try {
    return window.localStorage.getItem(`${INTELLIGENT_ACTIVE_KEY_PREFIX}${modeId}`)
  } catch (error) {
    console.warn("Failed to load intelligent conversation id:", error)
    return null
  }
}

export function saveActiveIntelligentConversationId(modeId: string, id: string) {
  if (typeof window === "undefined") return

  try {
    window.localStorage.setItem(`${INTELLIGENT_ACTIVE_KEY_PREFIX}${modeId}`, id)
  } catch (error) {
    console.error("Failed to save intelligent conversation id:", error)
  }
}

export function saveWorkspaceMode(mode: string) {
  if (typeof window === "undefined") return

  try {
    window.localStorage.setItem(WORKSPACE_MODE_KEY, mode)
    window.dispatchEvent(new CustomEvent(WORKSPACE_MODE_EVENT, { detail: mode }))
  } catch (error) {
    console.error("Failed to save workspace mode:", error)
  }
}

export function subscribeWorkspaceMode(onStoreChange: () => void) {
  if (typeof window === "undefined") {
    return () => undefined
  }

  const handleStorage = (event: StorageEvent) => {
    if (event.key === WORKSPACE_MODE_KEY) {
      onStoreChange()
    }
  }

  const handleCustomEvent = () => {
    onStoreChange()
  }

  window.addEventListener("storage", handleStorage)
  window.addEventListener(WORKSPACE_MODE_EVENT, handleCustomEvent)

  return () => {
    window.removeEventListener("storage", handleStorage)
    window.removeEventListener(WORKSPACE_MODE_EVENT, handleCustomEvent)
  }
}
