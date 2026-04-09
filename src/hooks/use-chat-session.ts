"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import type { KeyboardEvent } from "react"

import { filesToAttachmentPreviews } from "@/lib/attachments"
import {
  getAttachmentDataUrl,
  getAttachmentPreviewsFromMessage,
  saveAttachmentPreviewsToDB,
} from "@/lib/attachment-store"
import { getMessagePlainText, tryParseStructuredText } from "@/lib/schema-utils"
import type {
  AttachmentPreview,
  ChatMessage,
  Conversation,
  MessageMeta,
  MessagePart,
} from "@/lib/types"
import { makeId } from "@/lib/utils"

type UseChatSessionArgs = {
  conversation: Conversation | null
  appendMessage: (conversationId: string, message: ChatMessage) => void
  updateMessage: (
    conversationId: string,
    messageId: string,
    updater: (message: ChatMessage) => ChatMessage
  ) => void
  setConversationMessages: (
    conversationId: string,
    messages: ChatMessage[]
  ) => void
  updateConversationTitle: (conversationId: string, title: string) => void
}

type StreamEvent =
  | { type: "token"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "meta"; meta: MessageMeta }
  | { type: "done" }
  | { type: "error"; error: string }

function deriveConversationTitle(text: string) {
  const clean = text.replace(/\s+/g, " ").trim()
  if (!clean) return "New Chat"
  return clean.length > 28 ? `${clean.slice(0, 28)}...` : clean
}

function deriveAttachmentConversationTitle(attachments: AttachmentPreview[]) {
  if (attachments.some((item) => item.type === "pdf-image")) {
    return "PDF Upload"
  }
  return "Image Upload"
}

function appendTextToMessage(message: ChatMessage, text: string): ChatMessage {
  const firstPart = message.content[0]

  if (firstPart?.type === "text") {
    return {
      ...message,
      content: [
        {
          ...firstPart,
          text: firstPart.text + text,
        },
        ...message.content.slice(1),
      ],
    }
  }

  return {
    ...message,
    content: [{ type: "text", text }, ...message.content],
  }
}

function appendReasoningToMessage(
  message: ChatMessage,
  text: string
): ChatMessage {
  return {
    ...message,
    reasoning: (message.reasoning ?? "") + text,
  }
}

function extractPlainText(message: ChatMessage) {
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
}

function attachmentToMessagePart(attachment: AttachmentPreview): MessagePart {
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

function buildUserContent(
  text: string,
  pendingAttachments: AttachmentPreview[]
): MessagePart[] {
  const next: MessagePart[] = []

  if (text.trim()) {
    next.push({
      type: "text",
      text: text.trim(),
    })
  }

  next.push(...pendingAttachments.map(attachmentToMessagePart))

  return next
}

function isAbortLike(error: unknown) {
  return error instanceof Error && error.name === "AbortError"
}

async function consumeSseStream(
  response: Response,
  onEvent: (event: StreamEvent) => void
) {
  if (!response.body) {
    throw new Error("No response body from /api/chat")
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
            const parsed = JSON.parse(data) as StreamEvent
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

function buildAssistantPlaceholders(
  userMessageId: string,
  model: string,
  count: 1 | 2 | 3
): ChatMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: makeId(),
    role: "assistant",
    createdAt: Date.now(),
    parentUserMessageId: userMessageId,
    content: [{ type: "text", text: "" }],
    reasoning: "",
    meta: {
      model,
      compareSlot: (index + 1) as 1 | 2 | 3,
    },
  }))
}

async function resolveMessagesForProvider(
  messages: ChatMessage[]
): Promise<ChatMessage[]> {
  const resolvedMessages: ChatMessage[] = []

  for (const message of messages) {
    const resolvedContent: MessagePart[] = []

    for (const part of message.content) {
      if (part.type === "text" || part.type === "json-preview") {
        resolvedContent.push(part)
        continue
      }

      if (part.type === "image") {
        const dataUrl = await getAttachmentDataUrl(part.attachmentId)

        resolvedContent.push({
          ...part,
          url: dataUrl ?? part.url,
        })
        continue
      }

      if (part.type === "pdf-image") {
        const dataUrl = await getAttachmentDataUrl(part.attachmentId)

        resolvedContent.push({
          ...part,
          url: dataUrl ?? part.url,
        })
      }
    }

    resolvedMessages.push({
      ...message,
      content: resolvedContent,
    })
  }

  return resolvedMessages
}

export function useChatSession({
  conversation,
  appendMessage,
  updateMessage,
  setConversationMessages,
  updateConversationTitle,
}: UseChatSessionArgs) {
  const [input, setInput] = useState("")
  const [isSending, setIsSending] = useState(false)
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null)
  const [pendingAttachments, setPendingAttachments] = useState<AttachmentPreview[]>([])
  const [isProcessingAttachments, setIsProcessingAttachments] = useState(false)

  const activeControllersRef = useRef<AbortController[]>([])

  function clearControllers() {
    activeControllersRef.current = []
  }

  function abortAllControllers() {
    for (const controller of activeControllersRef.current) {
      try {
        controller.abort()
      } catch {
        // ignore
      }
    }
    clearControllers()
  }

  useEffect(() => {
    abortAllControllers()
    setInput("")
    setIsSending(false)
    setEditingMessageId(null)
    setPendingAttachments([])
    setIsProcessingAttachments(false)
  }, [conversation?.id])

  useEffect(() => {
    return () => {
      abortAllControllers()
    }
  }, [])

  useEffect(() => {
    const handleBeforeUnload = () => {
      abortAllControllers()
    }

    window.addEventListener("beforeunload", handleBeforeUnload)
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload)
    }
  }, [])

  const editingMessage = useMemo(() => {
    if (!conversation || !editingMessageId) return null
    return (
      conversation.messages.find(
        (message) =>
          message.id === editingMessageId && message.role === "user"
      ) ?? null
    )
  }, [conversation, editingMessageId])

  const canSend = useMemo(() => {
    const hasText = input.trim().length > 0
    const hasAttachments = pendingAttachments.length > 0
    const hasModel = Boolean(conversation?.settings.model.trim())

    return Boolean(
      conversation &&
        hasModel &&
        (hasText || hasAttachments) &&
        !isSending &&
        !isProcessingAttachments
    )
  }, [conversation, input, pendingAttachments, isSending, isProcessingAttachments])

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
    abortAllControllers()
    setIsSending(false)
  }

  async function streamAssistantResponse(
    conversationId: string,
    assistantMessageId: string,
    resolvedMessages: ChatMessage[],
    controller: AbortController
  ) {
    if (!conversation) return

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: conversation.settings.model,
          systemPrompt: conversation.settings.systemPrompt,
          temperature: conversation.settings.temperature,
          thinkMode: conversation.settings.thinkMode,
          outputMode: conversation.settings.outputMode,
          jsonSchema: conversation.settings.jsonSchema,
          messages: resolvedMessages,
        }),
        signal: controller.signal,
      })

      if (!response.ok) {
        const details = await response.text()
        throw new Error(details || "Request failed")
      }

      await consumeSseStream(response, (event) => {
        if (event.type === "token") {
          updateMessage(conversationId, assistantMessageId, (message) =>
            appendTextToMessage(message, event.text)
          )
          return
        }

        if (event.type === "reasoning") {
          updateMessage(conversationId, assistantMessageId, (message) =>
            appendReasoningToMessage(message, event.text)
          )
          return
        }

        if (event.type === "meta") {
          updateMessage(conversationId, assistantMessageId, (message) => ({
            ...message,
            meta: {
              ...message.meta,
              ...event.meta,
            },
          }))
          return
        }

        if (event.type === "done") {
          if (conversation.settings.outputMode === "json") {
            updateMessage(conversationId, assistantMessageId, (message) => {
              const parsed = tryParseStructuredText(getMessagePlainText(message))
              if (!parsed) return message

              const nonPreviewParts = message.content.filter(
                (part) => part.type !== "json-preview"
              )

              return {
                ...message,
                content: [
                  ...nonPreviewParts,
                  {
                    type: "json-preview",
                    value: parsed,
                  },
                ],
              }
            })
          }

          return
        }

        if (event.type === "error") {
          updateMessage(conversationId, assistantMessageId, (message) =>
            appendTextToMessage(
              message,
              `\n\n[Streaming error] ${event.error}`
            )
          )
        }
      })
    } catch (error) {
      if (isAbortLike(error)) {
        return
      }

      updateMessage(conversationId, assistantMessageId, (message) =>
        appendTextToMessage(
          message,
          `\n\n[Request failed] ${
            error instanceof Error ? error.message : "Unknown error"
          }`
        )
      )
    }
  }

  async function generateResponses(
    conversationId: string,
    baseMessages: ChatMessage[],
    userMessageId: string,
    compareMode: 1 | 2 | 3,
    model: string
  ) {
    if (!model.trim()) return

    const placeholders = buildAssistantPlaceholders(
      userMessageId,
      model,
      compareMode
    )

    setConversationMessages(conversationId, [...baseMessages, ...placeholders])

    const resolvedMessages = await resolveMessagesForProvider(baseMessages)

    const controllers = placeholders.map(() => new AbortController())
    activeControllersRef.current = controllers

    await Promise.allSettled(
      placeholders.map((placeholder, index) =>
        streamAssistantResponse(
          conversationId,
          placeholder.id,
          resolvedMessages,
          controllers[index]
        )
      )
    )

    clearControllers()
  }

  async function sendMessage() {
    if (!conversation) return
    if (isSending || isProcessingAttachments) return
    if (!conversation.settings.model.trim()) return

    const text = input.trim()
    const conversationId = conversation.id
    const attachmentsSnapshot = [...pendingAttachments]
    const userContent = buildUserContent(text, attachmentsSnapshot)

    if (userContent.length === 0) return

    setIsSending(true)

    try {
      if (editingMessageId) {
        const targetIndex = conversation.messages.findIndex(
          (message) =>
            message.id === editingMessageId && message.role === "user"
        )

        if (targetIndex === -1) {
          setEditingMessageId(null)
          setIsSending(false)
          return
        }

        const originalUserMessage = conversation.messages[targetIndex]

        const editedUserMessage: ChatMessage = {
          ...originalUserMessage,
          createdAt: Date.now(),
          content: userContent,
        }

        const baseMessages = [
          ...conversation.messages.slice(0, targetIndex),
          editedUserMessage,
        ]

        setConversationMessages(conversationId, baseMessages)

        if (targetIndex === 0) {
          updateConversationTitle(
            conversationId,
            text
              ? deriveConversationTitle(text)
              : deriveAttachmentConversationTitle(attachmentsSnapshot)
          )
        }

        setInput("")
        setEditingMessageId(null)
        setPendingAttachments([])

        await generateResponses(
          conversationId,
          baseMessages,
          editedUserMessage.id,
          conversation.settings.compareMode,
          conversation.settings.model
        )

        return
      }

      const userMessage: ChatMessage = {
        id: makeId(),
        role: "user",
        createdAt: Date.now(),
        content: userContent,
      }

      const baseMessages = [...conversation.messages, userMessage]
      setConversationMessages(conversationId, baseMessages)

      if (conversation.title === "New Chat" && conversation.messages.length === 0) {
        updateConversationTitle(
          conversationId,
          text
            ? deriveConversationTitle(text)
            : deriveAttachmentConversationTitle(attachmentsSnapshot)
        )
      }

      setInput("")
      setPendingAttachments([])

      await generateResponses(
        conversationId,
        baseMessages,
        userMessage.id,
        conversation.settings.compareMode,
        conversation.settings.model
      )
    } finally {
      setIsSending(false)
    }
  }

  async function regenerateFromUserMessage(userMessageId: string) {
    if (!conversation || isSending) return
    if (!conversation.settings.model.trim()) return

    const targetIndex = conversation.messages.findIndex(
      (message) => message.id === userMessageId && message.role === "user"
    )

    if (targetIndex === -1) return

    const targetUserMessage = conversation.messages[targetIndex]
    const baseMessages = conversation.messages.slice(0, targetIndex + 1)

    setIsSending(true)
    setEditingMessageId(null)
    setPendingAttachments([])

    try {
      setConversationMessages(conversation.id, baseMessages)

      await generateResponses(
        conversation.id,
        baseMessages,
        targetUserMessage.id,
        conversation.settings.compareMode,
        conversation.settings.model
      )
    } finally {
      setIsSending(false)
    }
  }

  async function beginEditMessage(userMessageId: string) {
    if (!conversation || isSending) return

    const target = conversation.messages.find(
      (message) => message.id === userMessageId && message.role === "user"
    )

    if (!target) return

    setEditingMessageId(userMessageId)
    setInput(extractPlainText(target))
    const restoredAttachments = await getAttachmentPreviewsFromMessage(target)
    setPendingAttachments(restoredAttachments)
  }

  function cancelEditMessage() {
    setEditingMessageId(null)
    setInput("")
    setPendingAttachments([])
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      void sendMessage()
    }
  }

  return {
    input,
    setInput,
    isSending,
    canSend,
    sendMessage,
    stopGeneration,
    handleComposerKeyDown,
    editingMessageId,
    editingMessage,
    beginEditMessage,
    cancelEditMessage,
    regenerateFromUserMessage,
    pendingAttachments,
    handleFilesSelected,
    removeAttachment,
    isProcessingAttachments,
  }
}
