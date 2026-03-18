import { getDB } from "@/lib/db"
import type { Conversation } from "@/lib/types"

export async function loadAllConversationsFromDB(): Promise<Conversation[]> {
  const db = await getDB()
  const conversations = await db.getAll("conversations")

  return conversations.sort((a, b) => b.updatedAt - a.updatedAt)
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
    await store.put(conversation)
  }

  await tx.done
}

export async function clearAllConversationsFromDB(): Promise<void> {
  const db = await getDB()
  await db.clear("conversations")
}
