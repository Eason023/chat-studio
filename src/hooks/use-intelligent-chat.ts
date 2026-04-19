"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import type { KeyboardEvent } from "react"

import { getAttachmentDataUrl, saveAttachmentPreviewsToDB } from "@/lib/attachment-store"
import { filesToAttachmentPreviews } from "@/lib/attachments"
import { loadAllIntelligentConversationsFromDB, saveAllIntelligentConversationsToDB } from "@/lib/intelligent-conversation-store"
import {
  loadActiveIntelligentConversationId,
  saveActiveIntelligentConversationId,
} from "@/lib/storage"
import type {
  AttachmentPreview,
  IntelligentAttachmentPart,
  IntelligentChatHistoryMessage,
  IntelligentChatRequest,
  IntelligentChatStreamEvent,
  IntelligentConversation,
  IntelligentConversationMessage,
  IntelligentConversationMessageStatus,
  IntelligentMessageProcess,
  IntelligentModeSummary,
  IntelligentPhaseStatus,
  IntelligentTracePhase,
  MessagePart,
} from "@/lib/types"
import { makeId } from "@/lib/utils"

type PendingAssistantTarget = {
  conversationId: string
  messageId: string
}

function isAbortLike(error: unknown) {
  return error instanceof Error && error.name === "AbortError"
}

function createEmptyConversation(modeId: string): IntelligentConversation {
  const now = Date.now()

  return {
    id: makeId(),
    modeId,
    title: "New Session",
    createdAt: now,
    updatedAt: now,
    sessionSummary: "",
    sessionSummaryUpdatedAt: now,
    messages: [],
  }
}

function deriveConversationTitle(input: string) {
  const compact = input.replace(/\s+/g, " ").trim()
  if (!compact) return "New Session"

  return compact.length > 42 ? `${compact.slice(0, 42)}...` : compact
}

function deriveAttachmentConversationTitle(attachments: IntelligentAttachmentPart[]) {
  if (attachments.some((attachment) => attachment.type === "pdf-image")) {
    return "PDF Upload"
  }

  return "Image Upload"
}

function createAssistantProcess(timestamp: number): IntelligentMessageProcess {
  return {
    route: null,
    activeModel: null,
    phases: [],
    startedAt: timestamp,
    updatedAt: timestamp,
  }
}

function attachmentToMessagePart(
  attachment: AttachmentPreview
): IntelligentAttachmentPart {
  if (attachment.type === "image") {
    return {
      type: "image",
      attachmentId: attachment.id,
      url: attachment.previewUrl,
      mimeType: attachment.mimeType,
      name: attachment.name,
    }
  }

  return {
    type: "pdf-image",
    attachmentId: attachment.id,
    page: attachment.page,
    url: attachment.previewUrl,
    name: attachment.name,
  }
}

function attachmentToSummaryText(attachment: IntelligentAttachmentPart) {
  if (attachment.type === "image") {
    return `[Image: ${attachment.name ?? "uploaded image"}]`
  }

  return `[PDF page ${attachment.page}: ${attachment.name ?? "uploaded pdf"}]`
}

function summarizeMessageContent(
  text: string,
  attachments: IntelligentAttachmentPart[] = []
) {
  const parts = []

  if (text.trim()) {
    parts.push(text.trim())
  }

  for (const attachment of attachments) {
    parts.push(attachmentToSummaryText(attachment))
  }

  return parts.join("\n").trim()
}

function buildHistoryContent(
  message: IntelligentConversationMessage
): MessagePart[] {
  const content: MessagePart[] = []

  if (message.content.trim()) {
    content.push({
      type: "text",
      text: message.content.trim(),
    })
  }

  if (message.attachments?.length) {
    content.push(...message.attachments)
  }

  if (content.length === 0) {
    content.push({
      type: "text",
      text: "",
    })
  }

  return content
}

async function resolveHistoryContent(
  content: MessagePart[]
): Promise<MessagePart[]> {
  const resolved: MessagePart[] = []

  for (const part of content) {
    if (part.type === "text" || part.type === "json-preview") {
      resolved.push(part)
      continue
    }

    const dataUrl = await getAttachmentDataUrl(part.attachmentId)

    if (part.type === "image") {
      resolved.push({
        ...part,
        url: dataUrl ?? part.url,
      })
      continue
    }

    resolved.push({
      ...part,
      url: dataUrl ?? part.url,
    })
  }

  return resolved
}

async function resolveHistoryMessageForRequest(
  message: IntelligentConversationMessage
): Promise<IntelligentChatHistoryMessage> {
  return {
    role: message.role,
    content: await resolveHistoryContent(buildHistoryContent(message)),
  }
}

async function consumeSseStream(
  response: Response,
  onEvent: (event: IntelligentChatStreamEvent) => void
) {
  if (!response.body) {
    throw new Error("No response body from /api/intelligent/chat")
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      let boundaryIndex = buffer.indexOf("\n\n")

      while (boundaryIndex !== -1) {
        const rawEvent = buffer.slice(0, boundaryIndex)
        buffer = buffer.slice(boundaryIndex + 2)

        const lines = rawEvent.split("\n")

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith("data:")) continue

          const data = trimmed.slice(5).trim()
          if (!data) continue

          try {
            const parsed = JSON.parse(data) as IntelligentChatStreamEvent
            onEvent(parsed)
          } catch {
            // ignore malformed chunks
          }
        }

        boundaryIndex = buffer.indexOf("\n\n")
      }
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // ignore
    }
  }
}

function upsertPhaseInProcess(
  process: IntelligentMessageProcess,
  phase: {
    id: string
    label: string
    status: IntelligentPhaseStatus
    detail?: string
    modelId?: string
    lane?: "contextual" | "stateless"
  }
): IntelligentMessageProcess {
  const now = Date.now()
  const existingIndex = process.phases.findIndex((item) => item.id === phase.id)

  if (existingIndex === -1) {
    const nextPhase: IntelligentTracePhase = {
      id: phase.id,
      label: phase.label,
      status: phase.status,
      detail: phase.detail,
      modelId: phase.modelId,
      lane: phase.lane,
      startedAt: now,
      updatedAt: now,
    }

    return {
      ...process,
      updatedAt: now,
      phases: [...process.phases, nextPhase],
    }
  }

  const nextPhases = [...process.phases]
  nextPhases[existingIndex] = {
    ...nextPhases[existingIndex],
    label: phase.label,
    status: phase.status,
    detail: phase.detail,
    modelId: phase.modelId ?? nextPhases[existingIndex].modelId,
    lane: phase.lane ?? nextPhases[existingIndex].lane,
    updatedAt: now,
  }

  return {
    ...process,
    updatedAt: now,
    phases: nextPhases,
  }
}

function sortConversations(
  conversations: IntelligentConversation[]
): IntelligentConversation[] {
  return [...conversations].sort((left, right) => right.updatedAt - left.updatedAt)
}

export function useIntelligentChat(mode: IntelligentModeSummary) {
  const [allConversations, setAllConversations] = useState<IntelligentConversation[]>([])
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null)
  const [expandedProcessMessageId, setExpandedProcessMessageId] = useState<
    string | null
  >(null)
  const [hydrated, setHydrated] = useState(false)
  const [input, setInput] = useState("")
  const [isSending, setIsSending] = useState(false)
  const [pendingAttachments, setPendingAttachments] = useState<AttachmentPreview[]>([])
  const [isProcessingAttachments, setIsProcessingAttachments] = useState(false)

  const controllerRef = useRef<AbortController | null>(null)
  const pendingAssistantRef = useRef<PendingAssistantTarget | null>(null)

  useEffect(() => {
    let cancelled = false

    async function hydrateConversations() {
      const stored = await loadAllIntelligentConversationsFromDB()

      if (cancelled) return

      setAllConversations(sortConversations(stored))
      setHydrated(true)
    }

    void hydrateConversations()

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!hydrated) return
    void saveAllIntelligentConversationsToDB(allConversations)
  }, [allConversations, hydrated])

  const conversations = useMemo(
    () =>
      allConversations
        .filter((conversation) => conversation.modeId === mode.id)
        .sort((left, right) => right.updatedAt - left.updatedAt),
    [allConversations, mode.id]
  )

  useEffect(() => {
    if (!hydrated) return

    const currentActive = conversations.find(
      (conversation) => conversation.id === activeConversationId
    )
    if (currentActive) {
      return
    }

    const storedActiveId = loadActiveIntelligentConversationId(mode.id)
    const fallbackId =
      conversations.find((conversation) => conversation.id === storedActiveId)?.id ??
      conversations[0]?.id ??
      null

    if (fallbackId) {
      setActiveConversationId(fallbackId)
      return
    }

    const freshConversation = createEmptyConversation(mode.id)
    setAllConversations((prev) => sortConversations([freshConversation, ...prev]))
    setActiveConversationId(freshConversation.id)
  }, [activeConversationId, conversations, hydrated, mode.id])

  useEffect(() => {
    if (!hydrated || !activeConversationId) return
    saveActiveIntelligentConversationId(mode.id, activeConversationId)
  }, [activeConversationId, hydrated, mode.id])

  const activeConversation = useMemo(
    () =>
      conversations.find((conversation) => conversation.id === activeConversationId) ??
      null,
    [activeConversationId, conversations]
  )

  const messages = useMemo(
    () => activeConversation?.messages ?? [],
    [activeConversation]
  )

  useEffect(() => {
    setInput("")
    setPendingAttachments([])
    setIsProcessingAttachments(false)
  }, [activeConversation?.id])

  useEffect(() => {
    const assistantMessages = messages.filter((message) => message.role === "assistant")
    if (assistantMessages.length === 0) {
      setExpandedProcessMessageId(null)
      return
    }

    const currentExpanded = assistantMessages.find(
      (message) => message.id === expandedProcessMessageId
    )
    if (currentExpanded) return

    setExpandedProcessMessageId(null)
  }, [expandedProcessMessageId, messages])

  const canSend = useMemo(() => {
    const hasText = input.trim().length > 0
    const hasAttachments = pendingAttachments.length > 0

    return (
      hydrated &&
      !isSending &&
      !isProcessingAttachments &&
      (hasText || hasAttachments)
    )
  }, [hydrated, input, isProcessingAttachments, isSending, pendingAttachments])

  function updateConversation(
    conversationId: string,
    updater: (conversation: IntelligentConversation) => IntelligentConversation
  ) {
    setAllConversations((prev) =>
      sortConversations(
        prev.map((conversation) =>
          conversation.id === conversationId
            ? {
                ...updater(conversation),
                updatedAt: Date.now(),
              }
            : conversation
        )
      )
    )
  }

  function updateMessage(
    conversationId: string,
    messageId: string,
    updater: (message: IntelligentConversationMessage) => IntelligentConversationMessage
  ) {
    updateConversation(conversationId, (conversation) => ({
      ...conversation,
      messages: conversation.messages.map((message) =>
        message.id === messageId ? updater(message) : message
      ),
    }))
  }

  function markAssistantStatus(
    target: PendingAssistantTarget | null,
    status: IntelligentConversationMessageStatus
  ) {
    if (!target) return

    updateMessage(target.conversationId, target.messageId, (message) => ({
      ...message,
      status,
      process: message.process
        ? {
            ...message.process,
            updatedAt: Date.now(),
          }
        : message.process,
    }))
  }

  async function handleFilesSelected(files: File[]) {
    if (!files.length || isSending) return

    setIsProcessingAttachments(true)

    try {
      const nextAttachments = await filesToAttachmentPreviews(files)
      await saveAttachmentPreviewsToDB(nextAttachments)
      setPendingAttachments((prev) => [...prev, ...nextAttachments])
    } finally {
      setIsProcessingAttachments(false)
    }
  }

  function removeAttachment(attachmentId: string) {
    setPendingAttachments((prev) =>
      prev.filter((attachment) => attachment.id !== attachmentId)
    )
  }

  function stopGeneration() {
    const pendingTarget = pendingAssistantRef.current

    try {
      controllerRef.current?.abort()
    } catch {
      // ignore
    }

    controllerRef.current = null
    pendingAssistantRef.current = null

    if (pendingTarget) {
      markAssistantStatus(pendingTarget, "stopped")
    }

    setIsSending(false)
  }

  function createConversation() {
    const nextConversation = createEmptyConversation(mode.id)
    setAllConversations((prev) => sortConversations([nextConversation, ...prev]))
    setActiveConversationId(nextConversation.id)
    setExpandedProcessMessageId(null)
  }

  function deleteConversation(id: string) {
    setAllConversations((prev) => prev.filter((conversation) => conversation.id !== id))

    const remainingForMode = conversations.filter((conversation) => conversation.id !== id)

    if (remainingForMode.length > 0) {
      if (activeConversationId === id) {
        setActiveConversationId(remainingForMode[0].id)
      }
      return
    }

    const freshConversation = createEmptyConversation(mode.id)
    setAllConversations((prev) => sortConversations([freshConversation, ...prev]))
    setActiveConversationId(freshConversation.id)
    setExpandedProcessMessageId(null)
  }

  function selectConversation(id: string) {
    setActiveConversationId(id)
  }

  function toggleProcessMessage(messageId: string) {
    setExpandedProcessMessageId((current) =>
      current === messageId ? null : messageId
    )
  }

  async function sendMessage() {
    const text = input.trim()
    if ((!text && pendingAttachments.length === 0) || isSending || !activeConversation) {
      return
    }

    const timestamp = Date.now()
    const attachmentsSnapshot = pendingAttachments.map(attachmentToMessagePart)
    const nextUserMessage: IntelligentConversationMessage = {
      id: makeId(),
      role: "user",
      content: text,
      attachments: attachmentsSnapshot,
      createdAt: timestamp,
      status: "completed",
    }

    const nextAssistantMessage: IntelligentConversationMessage = {
      id: makeId(),
      role: "assistant",
      content: "",
      createdAt: timestamp + 1,
      status: "streaming",
      process: createAssistantProcess(timestamp + 1),
    }

    updateConversation(activeConversation.id, (conversation) => ({
      ...conversation,
      title:
        conversation.messages.length === 0
          ? text
            ? deriveConversationTitle(text)
            : deriveAttachmentConversationTitle(attachmentsSnapshot)
          : conversation.title,
      messages: [...conversation.messages, nextUserMessage, nextAssistantMessage],
    }))

    setInput("")
    setPendingAttachments([])
    setIsSending(true)

    const controller = new AbortController()
    const target = {
      conversationId: activeConversation.id,
      messageId: nextAssistantMessage.id,
    }

    controllerRef.current = controller
    pendingAssistantRef.current = target

    try {
      const requestHistory = await Promise.all(
        [...activeConversation.messages, nextUserMessage].map(
          resolveHistoryMessageForRequest
        )
      )

      const requestBody: IntelligentChatRequest = {
        modeId: mode.id,
        conversationId: activeConversation.id,
        message: summarizeMessageContent(text, attachmentsSnapshot),
        sessionSummary: activeConversation.sessionSummary,
        history: requestHistory,
      }

      const response = await fetch("/api/intelligent/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      })

      if (!response.ok) {
        const details = await response.text()
        throw new Error(details || "Request failed")
      }

      await consumeSseStream(response, (event) => {
        if (event.type === "phase") {
          updateMessage(target.conversationId, target.messageId, (message) => ({
            ...message,
            process: upsertPhaseInProcess(
              message.process ?? createAssistantProcess(Date.now()),
              {
                id: event.phase.id,
                label: event.phase.label,
                status: event.phase.status,
                detail: event.phase.detail,
                modelId: event.phase.modelId,
                lane: event.phase.lane,
              }
            ),
          }))
          return
        }

        if (event.type === "meta") {
          updateMessage(target.conversationId, target.messageId, (message) => ({
            ...message,
            process: {
              ...(message.process ?? createAssistantProcess(Date.now())),
              route: event.meta.route,
              activeModel: event.meta.model,
              updatedAt: Date.now(),
            },
          }))
          return
        }

        if (event.type === "token") {
          updateMessage(target.conversationId, target.messageId, (message) => ({
            ...message,
            content: message.content + event.text,
          }))
          return
        }

        if (event.type === "error") {
          updateMessage(target.conversationId, target.messageId, (message) => ({
            ...message,
            status: "error",
            content: message.content
              ? `${message.content}\n\n[Request failed] ${event.error}`
              : `[Request failed] ${event.error}`,
            process: message.process
              ? {
                  ...message.process,
                  updatedAt: Date.now(),
                }
              : message.process,
          }))
          return
        }

        if (event.type === "session_summary") {
          updateConversation(target.conversationId, (conversation) => ({
            ...conversation,
            sessionSummary: event.summary.text,
            sessionSummaryUpdatedAt: event.summary.updatedAt,
          }))
          return
        }

        if (event.type === "done") {
          markAssistantStatus(target, "completed")
        }
      })
    } catch (error) {
      if (!isAbortLike(error)) {
        updateMessage(target.conversationId, target.messageId, (message) => ({
          ...message,
          status: "error",
          content: `[Request failed] ${
            error instanceof Error ? error.message : "Unknown error"
          }`,
        }))
      }
    } finally {
      if (pendingAssistantRef.current?.messageId === target.messageId) {
        pendingAssistantRef.current = null
      }
      controllerRef.current = null
      setIsSending(false)
    }
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      void sendMessage()
    }
  }

  return {
    hydrated,
    conversations,
    activeConversation,
    activeConversationId,
    messages,
    input,
    setInput,
    isSending,
    canSend,
    createConversation,
    deleteConversation,
    selectConversation,
    sendMessage,
    stopGeneration,
    handleComposerKeyDown,
    expandedProcessMessageId,
    toggleProcessMessage,
    pendingAttachments,
    handleFilesSelected,
    removeAttachment,
    isProcessingAttachments,
  }
}
