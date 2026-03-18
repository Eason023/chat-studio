import { getDB } from "@/lib/db"
import { hydrateConversationAttachments } from "@/lib/attachment-store"
import type { Conversation, MessagePart } from "@/lib/types"

function stripPartUrl(part: MessagePart): MessagePart {
  if (part.type === "image") {
    return {
      type: "image",
      attachmentId: part.attachmentId,
      mimeType: part.mimeType,
      name: part.name,
    }
  }

  if (part.type === "pdf-image") {
    return {
      type: "pdf-image",
      attachmentId: part.attachmentId,
      page: part.page,
      name: part.name,
    }
  }

  return part
}

function stripConversationUrls(conversation: Conversation): Conversation {
  return {
    ...conversation,
    messages: conversation.messages.map((message) => ({
      ...message,
      content: message.content.map(stripPartUrl),
    })),
  }
}

export async function loadAllConversationsFromDB(): Promise<Conversation[]> {
  const db = await getDB()
  const conversations = await db.getAll("conversations")
  const sorted = conversations.sort((a, b) => b.updatedAt - a.updatedAt)

  return Promise.all(sorted.map(hydrateConversationAttachments))
}

export async function saveAllConversationsToDB(
  conversations: Conversation[]
): Promise<void> {
  const db = await getDB()
  const tx = db.transaction("conversations", "readwrite")
  const store = tx.objectStore("conversations")

  const existingKeys = await store.getAllKeys()
  const nextIds = new Set(conversations.map((c) => c.id))

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
