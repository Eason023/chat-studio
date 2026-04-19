"use client"

import { DatabaseZap, Plus, Trash2 } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"
import type {
  IntelligentGlobalMemory,
  IntelligentGlobalMemoryCategory,
  IntelligentGlobalMemoryEntry,
} from "@/lib/types"

type IntelligentMemorySheetProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  memory: IntelligentGlobalMemory
  isSending: boolean
  currentSessionKey: string
  onAddEntry: (
    category: IntelligentGlobalMemoryCategory,
    initialKey?: string,
    initialValue?: string
  ) => void
  onUpdateEntry: (
    category: IntelligentGlobalMemoryCategory,
    entryId: string,
    patch: Partial<Pick<IntelligentGlobalMemoryEntry, "key" | "value">>
  ) => void
  onDeleteEntry: (
    category: IntelligentGlobalMemoryCategory,
    entryId: string
  ) => void
}

const MEMORY_SECTIONS: Array<{
  category: IntelligentGlobalMemoryCategory
  title: string
  description: string
}> = [
  {
    category: "userFeatures",
    title: "User Features",
    description:
      "Stable, distinctive user facts or strong enduring preferences. Entries are keyed by session hash.",
  },
  {
    category: "instructionMemory",
    title: "Instruction Memory",
    description:
      "Reusable response instructions or preferences the user strongly values. Entries are keyed by session hash.",
  },
  {
    category: "recentEvents",
    title: "Recent Events",
    description:
      "Ongoing projects or temporary priorities that may matter soon. Entries are keyed by session hash.",
  },
]

function MemoryEntryEditor({
  entry,
  disabled,
  currentSessionKey,
  onChange,
  onDelete,
}: {
  entry: IntelligentGlobalMemoryEntry
  disabled: boolean
  currentSessionKey: string
  onChange: (patch: Partial<Pick<IntelligentGlobalMemoryEntry, "key" | "value">>) => void
  onDelete: () => void
}) {
  const isCurrentSession = entry.key === currentSessionKey

  return (
    <div className="rounded-2xl border bg-background px-3 py-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="rounded-full">
            Session-Keyed Entry
          </Badge>
          {isCurrentSession ? (
            <Badge variant="secondary" className="rounded-full">
              Current session, excluded from prefix
            </Badge>
          ) : null}
        </div>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          disabled={disabled}
          onClick={onDelete}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      <div className="space-y-2.5">
        <Input
          value={entry.key}
          disabled={disabled}
          placeholder="Session hash key"
          onChange={(event) => onChange({ key: event.target.value })}
        />
        <Textarea
          value={entry.value}
          disabled={disabled}
          placeholder="Memory value"
          className="min-h-24 resize-y"
          onChange={(event) => onChange({ value: event.target.value })}
        />
      </div>
    </div>
  )
}

export function IntelligentMemorySheet({
  open,
  onOpenChange,
  memory,
  isSending,
  currentSessionKey,
  onAddEntry,
  onUpdateEntry,
  onDeleteEntry,
}: IntelligentMemorySheetProps) {
  const totalEntries =
    memory.userFeatures.length +
    memory.instructionMemory.length +
    memory.recentEvents.length

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full max-w-[680px] p-0 sm:max-w-[720px]">
        <SheetHeader className="border-b px-5 py-4">
          <div className="flex items-center gap-2">
            <div className="rounded-full bg-primary/10 p-2 text-primary">
              <DatabaseZap className="h-4 w-4" />
            </div>
            <div>
              <SheetTitle>Three-Tier Session Memory</SheetTitle>
              <SheetDescription>
                Each tier still uses session-keyed key:value entries. The current
                session key is excluded from its own prefix.
              </SheetDescription>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-2">
            <Badge variant="secondary" className="rounded-full">
              {totalEntries} stored {totalEntries === 1 ? "entry" : "entries"}
            </Badge>
            <Badge variant="outline" className="rounded-full">
              Current key {currentSessionKey}
            </Badge>
            <Badge variant="outline" className="rounded-full">
              {isSending ? "Locked during orchestration" : "Editable"}
            </Badge>
          </div>
        </SheetHeader>

        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-5 px-5 py-5">
            {MEMORY_SECTIONS.map((section) => {
              const entries = memory[section.category]

              return (
                <section
                  key={section.category}
                  className="rounded-[1.4rem] border bg-muted/20 p-4"
                >
                  <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold">{section.title}</div>
                      <div className="mt-1 text-sm leading-6 text-muted-foreground">
                        {section.description}
                      </div>
                    </div>

                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={isSending}
                      onClick={() => onAddEntry(section.category, currentSessionKey)}
                    >
                      <Plus className="h-4 w-4" />
                      Add
                    </Button>
                  </div>

                  {entries.length > 0 ? (
                    <div className="space-y-3">
                      {entries.map((entry) => (
                        <MemoryEntryEditor
                          key={entry.id}
                          entry={entry}
                          disabled={isSending}
                          currentSessionKey={currentSessionKey}
                          onChange={(patch) =>
                            onUpdateEntry(section.category, entry.id, patch)
                          }
                          onDelete={() =>
                            onDeleteEntry(section.category, entry.id)
                          }
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-2xl border border-dashed bg-background/70 px-4 py-6 text-sm text-muted-foreground">
                      No entries yet.
                    </div>
                  )}
                </section>
              )
            })}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}
