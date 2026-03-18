import { openDB, type DBSchema, type IDBPDatabase } from "idb"
import type { Conversation } from "@/lib/types"

type ChatStudioDB = {
  conversations: {
    key: string
    value: Conversation
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
const DB_VERSION = 1

let dbPromise: Promise<IDBPDatabase<ChatStudioDB>> | null = null

export function getDB() {
  if (!dbPromise) {
    dbPromise = openDB<ChatStudioDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
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
      },
    })
  }

  return dbPromise
}
