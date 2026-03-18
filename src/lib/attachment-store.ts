import { getDB } from "@/lib/db"
import { blobToDataUrl } from "@/lib/file-utils"
import type {
  AttachmentPreview,
  AttachmentRecord,
  ChatMessage,
  Conversation,
  MessagePart,
} from "@/lib/types"

function partNeedsHydration(
  part: MessagePart
): part is Extract<MessagePart, { type: "image" | "pdf-image" }> {
  return part.type === "image" || part.type === "pdf-image"
}

export async function saveAttachmentPreviewsToDB(
  attachments: AttachmentPreview[]
): Promise<void> {
  if (attachments.length === 0) return

  const db = await getDB()
  const tx = db.transaction("attachments", "readwrite")
  const store = tx.objectStore("attachments")

  for (const attachment of attachments) {
    const record: AttachmentRecord =
      attachment.type === "image"
        ? {
            id: attachment.id,
            type: "image",
            blob: attachment.blob,
            name: attachment.name,
            mimeType: attachment.mimeType,
          }
        : {
            id: attachment.id,
            type: "pdf-image",
            blob: attachment.blob,
            page: attachment.page,
            name: attachment.name,
          }

    await store.put(record)
  }

  await tx.done
}

export async function getAttachmentRecord(
  attachmentId: string
): Promise<AttachmentRecord | undefined> {
  const db = await getDB()
  return db.get("attachments", attachmentId)
}

export async function getAttachmentDataUrl(
  attachmentId: string
): Promise<string | null> {
  const record = await getAttachmentRecord(attachmentId)
  if (!record) return null
  return blobToDataUrl(record.blob)
}

export async function hydrateMessageAttachments(
  message: ChatMessage
): Promise<ChatMessage> {
  const nextContent: MessagePart[] = []

  for (const part of message.content) {
    if (!partNeedsHydration(part)) {
      nextContent.push(part)
      continue
    }

    const record = await getAttachmentRecord(part.attachmentId)

    if (!record) {
      nextContent.push(part)
      continue
    }

    const objectUrl = URL.createObjectURL(record.blob)

    if (part.type === "image" && record.type === "image") {
      nextContent.push({
        ...part,
        url: objectUrl,
        mimeType: record.mimeType,
        name: record.name,
      })
      continue
    }

    if (part.type === "pdf-image" && record.type === "pdf-image") {
      nextContent.push({
        ...part,
        url: objectUrl,
        page: record.page,
        name: record.name,
      })
      continue
    }

    nextContent.push(part)
  }

  return {
    ...message,
    content: nextContent,
  }
}

export async function hydrateConversationAttachments(
  conversation: Conversation
): Promise<Conversation> {
  const hydratedMessages = await Promise.all(
    conversation.messages.map(hydrateMessageAttachments)
  )

  return {
    ...conversation,
    messages: hydratedMessages,
  }
}

export async function getAttachmentPreviewsFromMessage(
  message: ChatMessage
): Promise<AttachmentPreview[]> {
  const results: AttachmentPreview[] = []

  for (const part of message.content) {
    if (!partNeedsHydration(part)) continue

    const record = await getAttachmentRecord(part.attachmentId)
    if (!record) continue

    const previewUrl = URL.createObjectURL(record.blob)

    if (record.type === "image") {
      results.push({
        id: record.id,
        type: "image",
        blob: record.blob,
        previewUrl,
        name: record.name,
        mimeType: record.mimeType,
      })
      continue
    }

    results.push({
      id: record.id,
      type: "pdf-image",
      blob: record.blob,
      previewUrl,
      page: record.page,
      name: record.name,
    })
  }

  return results
}
