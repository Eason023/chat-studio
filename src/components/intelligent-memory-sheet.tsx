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
  onAddEntry: (category: IntelligentGlobalMemoryCategory) => void
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
    description: "Stable facts or long-lived preferences about the user.",
  },
  {
    category: "instructionMemory",
    title: "Instruction Memory",
    description: "Reusable guidance the assistant should keep following.",
  },
  {
    category: "recentEvents",
    title: "Recent Events",
    description: "Cross-session context for ongoing work and temporary priorities.",
  },
]

function MemoryEntryEditor({
  entry,
  disabled,
  onChange,
  onDelete,
}: {
  entry: IntelligentGlobalMemoryEntry
  disabled: boolean
  onChange: (patch: Partial<Pick<IntelligentGlobalMemoryEntry, "key" | "value">>) => void
  onDelete: () => void
}) {
  return (
    <div className="rounded-2xl border bg-background px-3 py-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <Badge variant="outline" className="rounded-full">
          Memory Entry
        </Badge>
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
          placeholder="Key"
          onChange={(event) => onChange({ key: event.target.value })}
        />
        <Textarea
          value={entry.value}
          disabled={disabled}
          placeholder="Value"
          className="min-h-20 resize-y"
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
              <SheetTitle>Global Memory</SheetTitle>
              <SheetDescription>
                Review or edit cross-session memory. Changes are saved locally in this
                browser.
              </SheetDescription>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-2">
            <Badge variant="secondary" className="rounded-full">
              {totalEntries} stored {totalEntries === 1 ? "entry" : "entries"}
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
                      onClick={() => onAddEntry(section.category)}
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
                          onChange={(patch) =>
                            onUpdateEntry(section.category, entry.id, patch)
                          }
                          onDelete={() => onDeleteEntry(section.category, entry.id)}
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
