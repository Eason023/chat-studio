"use client"

import { useEffect, useMemo, useRef, useState } from "react"

import { loadAllConversationsFromDB, saveAllConversationsToDB } from "@/lib/conversation-store"
import {
  loadActiveConversationId,
  saveActiveConversationId,
} from "@/lib/storage"
import type {
  ChatMessage,
  ChatSettingsSnapshot,
  Conversation,
} from "@/lib/types"
import { makeId } from "@/lib/utils"

function createDefaultSettings(): ChatSettingsSnapshot {
  return {
    model: "qwen3.5-27b",
    systemPrompt: "You are a helpful multimodal assistant.",
    temperature: 0.7,
    thinkMode: "think",
    compareMode: 3,
    outputMode: "normal",
    jsonSchema: {
      title: "ResponseSchema",
      fields: [],
    },
  }
}

function createEmptyConversation(): Conversation {
  const now = Date.now()

  return {
    id: makeId(),
    title: "New Chat",
    createdAt: now,
    updatedAt: now,
    settings: createDefaultSettings(),
    messages: [],
  }
}

export function useConversations() {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null)
  const [hydrated, setHydrated] = useState(false)

  const hasLoadedRef = useRef(false)

  useEffect(() => {
    let cancelled = false

    async function hydrateFromDB() {
      const stored = await loadAllConversationsFromDB()
      const storedActiveId = loadActiveConversationId()

      if (cancelled) return

      if (stored.length > 0) {
        const hasStoredActive = stored.some((c) => c.id === storedActiveId)
        const safeActiveId = hasStoredActive
          ? storedActiveId
          : stored[0].id

        setConversations(stored)
        setActiveConversationId(safeActiveId)
      } else {
        const initial = createEmptyConversation()
        setConversations([initial])
        setActiveConversationId(initial.id)
      }

      hasLoadedRef.current = true
      setHydrated(true)
    }

    void hydrateFromDB()

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!hydrated || !hasLoadedRef.current) return
    void saveAllConversationsToDB(conversations)
  }, [conversations, hydrated])

  useEffect(() => {
    if (!hydrated || !activeConversationId) return
    saveActiveConversationId(activeConversationId)
  }, [activeConversationId, hydrated])

  const activeConversation = useMemo(() => {
    return conversations.find((c) => c.id === activeConversationId) ?? null
  }, [conversations, activeConversationId])

  useEffect(() => {
    if (!hydrated) return

    if (conversations.length === 0) {
      const fresh = createEmptyConversation()
      setConversations([fresh])
      setActiveConversationId(fresh.id)
      return
    }

    const stillExists = conversations.some((c) => c.id === activeConversationId)
    if (!stillExists) {
      setActiveConversationId(conversations[0].id)
    }
  }, [conversations, activeConversationId, hydrated])

  function createConversation() {
    const next = createEmptyConversation()
    setConversations((prev) => [next, ...prev])
    setActiveConversationId(next.id)
  }

  function deleteConversation(id: string) {
    setConversations((prev) => {
      const filtered = prev.filter((c) => c.id !== id)

      if (filtered.length === 0) {
        const fresh = createEmptyConversation()
        setActiveConversationId(fresh.id)
        return [fresh]
      }

      if (activeConversationId === id) {
        setActiveConversationId(filtered[0].id)
      }

      return filtered
    })
  }

  function selectConversation(id: string) {
    setActiveConversationId(id)
  }

  function updateConversationSettings(
    id: string,
    updater: (settings: ChatSettingsSnapshot) => ChatSettingsSnapshot
  ) {
    setConversations((prev) =>
      prev.map((conv) =>
        conv.id === id
          ? {
              ...conv,
              updatedAt: Date.now(),
              settings: updater(conv.settings),
            }
          : conv
      )
    )
  }

  function updateConversationTitle(id: string, title: string) {
    setConversations((prev) =>
      prev.map((conv) =>
        conv.id === id
          ? {
              ...conv,
              title,
              updatedAt: Date.now(),
            }
          : conv
      )
    )
  }

  function setConversationMessages(id: string, messages: ChatMessage[]) {
    setConversations((prev) =>
      prev.map((conv) =>
        conv.id === id
          ? {
              ...conv,
              messages,
              updatedAt: Date.now(),
            }
          : conv
      )
    )
  }

  function appendMessage(id: string, message: ChatMessage) {
    setConversations((prev) =>
      prev.map((conv) =>
        conv.id === id
          ? {
              ...conv,
              messages: [...conv.messages, message],
              updatedAt: Date.now(),
            }
          : conv
      )
    )
  }

  function updateMessage(
    conversationId: string,
    messageId: string,
    updater: (message: ChatMessage) => ChatMessage
  ) {
    setConversations((prev) =>
      prev.map((conv) =>
        conv.id === conversationId
          ? {
              ...conv,
              updatedAt: Date.now(),
              messages: conv.messages.map((message) =>
                message.id === messageId ? updater(message) : message
              ),
            }
          : conv
      )
    )
  }

  return {
    hydrated,
    conversations,
    activeConversation,
    activeConversationId,
    createConversation,
    deleteConversation,
    selectConversation,
    updateConversationSettings,
    updateConversationTitle,
    setConversationMessages,
    appendMessage,
    updateMessage,
  }
}
