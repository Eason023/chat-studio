import { openDB, type IDBPDatabase } from "idb"
import type {
  AttachmentRecord,
  Conversation,
  IntelligentConversation,
} from "@/lib/types"

type ChatStudioDB = {
  conversations: {
    key: string
    value: Conversation
  }
  attachments: {
    key: string
    value: AttachmentRecord
  }
  intelligentConversations: {
    key: string
    value: IntelligentConversation
  }
  meta: {
    key: string
    value: {
      key: string
      value: unknown
    }
  }
}

const DB_NAME = "chat-studio-db"
const DB_VERSION = 3

let dbPromise: Promise<IDBPDatabase<ChatStudioDB>> | null = null

export function getDB() {
  if (!dbPromise) {
    dbPromise = openDB<ChatStudioDB>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        if (!db.objectStoreNames.contains("conversations")) {
          db.createObjectStore("conversations", {
            keyPath: "id",
          })
        }

        if (!db.objectStoreNames.contains("meta")) {
          db.createObjectStore("meta", {
            keyPath: "key",
          })
        }

        if (oldVersion < 2 && !db.objectStoreNames.contains("attachments")) {
          db.createObjectStore("attachments", {
            keyPath: "id",
          })
        }

        if (
          oldVersion < 3 &&
          !db.objectStoreNames.contains("intelligentConversations")
        ) {
          db.createObjectStore("intelligentConversations", {
            keyPath: "id",
          })
        }
      },
    })
  }

  return dbPromise
}
