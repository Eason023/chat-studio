import { getDB } from "@/lib/db"
import { getAttachmentRecord } from "@/lib/attachment-store"
import type {
  IntelligentAttachmentPart,
  IntelligentConversation,
} from "@/lib/types"

function stripAttachmentUrl(part: IntelligentAttachmentPart): IntelligentAttachmentPart {
  if (part.type === "image") {
    return {
      type: "image",
      attachmentId: part.attachmentId,
      mimeType: part.mimeType,
      name: part.name,
    }
  }

  return {
    type: "pdf-image",
    attachmentId: part.attachmentId,
    page: part.page,
    name: part.name,
  }
}

async function hydrateAttachmentPart(
  part: IntelligentAttachmentPart
): Promise<IntelligentAttachmentPart> {
  const record = await getAttachmentRecord(part.attachmentId)

  if (!record) {
    return part
  }

  const objectUrl = URL.createObjectURL(record.blob)

  if (part.type === "image" && record.type === "image") {
    return {
      ...part,
      url: objectUrl,
      mimeType: record.mimeType,
      name: record.name,
    }
  }

  if (part.type === "pdf-image" && record.type === "pdf-image") {
    return {
      ...part,
      url: objectUrl,
      page: record.page,
      name: record.name,
    }
  }

  return part
}

async function hydrateConversation(
  conversation: IntelligentConversation
): Promise<IntelligentConversation> {
  const messages = await Promise.all(
    conversation.messages.map(async (message) => ({
      ...message,
      attachments: message.attachments
        ? await Promise.all(message.attachments.map(hydrateAttachmentPart))
        : undefined,
    }))
  )

  return {
    ...conversation,
    messages,
  }
}

function stripConversationUrls(
  conversation: IntelligentConversation
): IntelligentConversation {
  return {
    ...conversation,
    messages: conversation.messages.map((message) => ({
      ...message,
      attachments: message.attachments?.map(stripAttachmentUrl),
    })),
  }
}

export async function loadAllIntelligentConversationsFromDB(): Promise<
  IntelligentConversation[]
> {
  const db = await getDB()
  const conversations = await db.getAll("intelligentConversations")
  const sorted = conversations.sort((a, b) => b.updatedAt - a.updatedAt)

  return Promise.all(sorted.map(hydrateConversation))
}

export async function saveAllIntelligentConversationsToDB(
  conversations: IntelligentConversation[]
): Promise<void> {
  const db = await getDB()
  const tx = db.transaction("intelligentConversations", "readwrite")
  const store = tx.objectStore("intelligentConversations")

  const existingKeys = await store.getAllKeys()
  const nextIds = new Set(conversations.map((conversation) => conversation.id))

  for (const key of existingKeys) {
    if (!nextIds.has(String(key))) {
      await store.delete(key)
    }
  }

  for (const conversation of conversations) {
    await store.put(stripConversationUrls(conversation))
  }

  await tx.done
}
