"use client"

import type { KeyboardEvent } from "react"
import { PencilLine, RotateCcw, Sparkles } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Separator } from "@/components/ui/separator"
import { Composer } from "@/components/composer"
import { MarkdownRenderer } from "@/components/markdown-renderer"
import { ModeToggle } from "@/components/mode-toggle"
import type { AttachmentPreview, ChatMessage, Conversation, MessagePart } from "@/lib/types"
import { cn } from "@/lib/utils"
import { downloadCsvFromObjects, downloadJson } from "@/lib/export-utils"

type ChatPanelProps = {
  conversation: Conversation | null
  input: string
  onInputChange: (value: string) => void
  onSend: () => void
  onStop: () => void
  onComposerKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void
  canSend: boolean
  isSending: boolean
  isEditing: boolean
  onCancelEdit: () => void
  onEditRequest: (userMessageId: string) => void
  onRegenerate: (userMessageId: string) => void
  attachments: AttachmentPreview[]
  onFilesAccepted: (files: File[]) => void
  onRemoveAttachment: (attachmentId: string) => void
  isProcessingAttachments: boolean
}

function getTextContent(message: ChatMessage) {
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
}

function compareGridClass(count: number) {
  if (count <= 1) return "grid-cols-1"
  if (count === 2) return "grid-cols-1 xl:grid-cols-2"
  return "grid-cols-1 xl:grid-cols-3"
}

function isJsonPreviewPart(
  part: MessagePart
): part is Extract<MessagePart, { type: "json-preview" }> {
  return part.type === "json-preview"
}

function renderMessageParts(message: ChatMessage) {
  return message.content.map((part, index) => {
    if (part.type === "text") {
      return <MarkdownRenderer key={index} content={part.text} />
    }

    if (part.type === "image") {
      return (
        <div key={index} className="space-y-2">
          <div className="text-sm text-muted-foreground">[Image attachment]</div>
          <img
            src={part.url}
            alt="uploaded"
            className="max-h-80 rounded-xl border"
          />
        </div>
      )
    }

    if (part.type === "pdf-image") {
      return (
        <div key={index} className="space-y-2">
          <div className="text-sm text-muted-foreground">
            [PDF page {part.page}]
          </div>
          <img
            src={part.url}
            alt={`PDF page ${part.page}`}
            className="max-h-80 rounded-xl border"
          />
        </div>
      )
    }

    if (part.type === "json-preview") {
      return (
        <pre
          key={index}
          className="overflow-x-auto rounded-xl bg-muted p-3 text-xs"
        >
          {JSON.stringify(part.value, null, 2)}
        </pre>
      )
    }

    return null
  })
}

export function ChatPanel({
  conversation,
  input,
  onInputChange,
  onSend,
  onStop,
  onComposerKeyDown,
  canSend,
  isSending,
  isEditing,
  onCancelEdit,
  onEditRequest,
  onRegenerate,
  attachments,
  onFilesAccepted,
  onRemoveAttachment,
  isProcessingAttachments,
}: ChatPanelProps) {
  const userMessages =
    conversation?.messages.filter((message) => message.role === "user") ?? []

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 flex items-center justify-between px-6 py-4">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">
            {conversation?.title ?? "Chat Studio"}
          </h1>
          <Badge variant="secondary">
            {conversation?.settings.model ?? "No Model"}
          </Badge>
          <Badge variant="outline">
            {conversation?.settings.thinkMode ?? "instant"}
          </Badge>
        </div>

        <ModeToggle />
      </div>

      <Separator className="shrink-0" />

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="mx-auto flex max-w-5xl flex-col gap-5">
          {conversation && userMessages.length > 0 ? (
            userMessages.map((userMessage) => {
              const assistants = conversation.messages.filter(
                (message) =>
                  message.role === "assistant" &&
                  message.parentUserMessageId === userMessage.id
              )

              const expectedSlots = Array.from(
                { length: conversation.settings.compareMode },
                (_, index) => (index + 1) as 1 | 2 | 3
              )

              const orderedAssistants = expectedSlots
                .map((slot) =>
                  assistants.find((message) => message.meta?.compareSlot === slot)
                )
                .filter((message): message is ChatMessage => Boolean(message))

              return (
                <div key={userMessage.id} className="space-y-3">
                  <Card className="rounded-2xl border-border/80 shadow-sm">
                    <CardContent className="p-4">
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <span>User</span>
                        </div>

                        <div className="flex items-center gap-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="rounded-full"
                            disabled={isSending}
                            onClick={() => onEditRequest(userMessage.id)}
                          >
                            <PencilLine className="mr-2 h-3.5 w-3.5" />
                            Edit & Resend
                          </Button>

                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="rounded-full"
                            disabled={isSending}
                            onClick={() => onRegenerate(userMessage.id)}
                          >
                            <RotateCcw className="mr-2 h-3.5 w-3.5" />
                            Regenerate
                          </Button>
                        </div>
                      </div>

                      <div className="space-y-3">
                        {renderMessageParts(userMessage)}
                      </div>
                    </CardContent>
                  </Card>

                  {orderedAssistants.length > 0 ? (
                    <div
                      className={cn(
                        "grid gap-3",
                        compareGridClass(orderedAssistants.length)
                      )}
                    >
                      {orderedAssistants.map((assistant) => (
                        <Card
                          key={assistant.id}
                          className="rounded-2xl border-primary/20 shadow-sm"
                        >
                          <CardContent className="p-4">
                            <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                              <span>Assistant</span>

                              {typeof assistant.meta?.compareSlot === "number" &&
                              conversation.settings.compareMode > 1 ? (
                                <Badge variant="secondary">
                                  Variant {assistant.meta.compareSlot}
                                </Badge>
                              ) : null}

                              {assistant.meta?.model ? (
                                <Badge variant="secondary">
                                  {assistant.meta.model}
                                </Badge>
                              ) : null}

                              {typeof assistant.meta?.promptTokens === "number" ? (
                                <Badge variant="outline">
                                  Prompt {assistant.meta.promptTokens}
                                </Badge>
                              ) : null}

                              {typeof assistant.meta?.completionTokens === "number" ? (
                                <Badge variant="outline">
                                  Completion {assistant.meta.completionTokens}
                                </Badge>
                              ) : null}

                              {typeof assistant.meta?.ppTps === "number" ? (
                                <Badge variant="outline">
                                  PP {assistant.meta.ppTps.toFixed(1)} tps
                                </Badge>
                              ) : null}

                              {typeof assistant.meta?.tgTps === "number" ? (
                                <Badge variant="outline">
                                  TG {assistant.meta.tgTps.toFixed(1)} tps
                                </Badge>
                              ) : null}
                            </div>

                            {assistant.content.some(isJsonPreviewPart) ? (
                              <div className="mb-4 flex flex-wrap gap-2">
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  className="rounded-full"
                                  onClick={() => {
                                    const jsonPart = assistant.content.find(isJsonPreviewPart)
                                    if (!jsonPart) return
                                    downloadJson("structured-output.json", jsonPart.value)
                                  }}
                                >
                                  Export JSON
                                </Button>

                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  className="rounded-full"
                                  onClick={() => {
                                    const jsonPart = assistant.content.find(isJsonPreviewPart)
                                    if (!jsonPart) return
                                    downloadCsvFromObjects("structured-output.csv", [jsonPart.value])
                                  }}
                                >
                                  Export CSV
                                </Button>
                              </div>
                            ) : null}

                            {assistant.reasoning?.trim() ? (
                              <Collapsible className="mb-4 rounded-xl border bg-muted/40">
                                <div className="flex items-center justify-between px-3 py-2">
                                  <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                                    <Sparkles className="h-3.5 w-3.5" />
                                    <span>Thinking process</span>
                                  </div>

                                  <CollapsibleTrigger asChild>
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="ghost"
                                      className="rounded-full"
                                    >
                                      Toggle
                                    </Button>
                                  </CollapsibleTrigger>
                                </div>

                                <CollapsibleContent className="border-t px-3 py-3">
                                  <MarkdownRenderer
                                    content={assistant.reasoning}
                                    muted
                                  />
                                </CollapsibleContent>
                              </Collapsible>
                            ) : null}

                            <div className="space-y-3">
                              {renderMessageParts(assistant)}
                            </div>
                          </CardContent>
                        </Card>
                      ))}
                    </div>
                  ) : null}
                </div>
              )
            })
          ) : (
            <Card className="rounded-2xl border-border/80 shadow-sm">
              <CardContent className="p-4">
                <div className="mb-2 text-xs text-muted-foreground">
                  Quick Start
                </div>
                <p className="text-sm leading-7">
                  現在支援多模態附件、Stop generation、thinking 摺疊、compare 2/3、
                  regenerate 和 edit & resend。
                </p>
              </CardContent>
            </Card>
          )}

          {isSending ? (
            <Card className="rounded-2xl border-dashed border-primary/30 shadow-sm">
              <CardContent className="p-4">
                <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
                  <span>Streaming</span>
                  <Badge variant="outline">Live</Badge>
                </div>
                <p className="text-sm leading-7 text-muted-foreground">
                  Receiving tokens...
                </p>
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>

      <div className="shrink-0 bg-background/95 p-4 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <Composer
          value={input}
          onChange={onInputChange}
          onSend={onSend}
          onStop={onStop}
          onKeyDown={onComposerKeyDown}
          disabled={!canSend}
          isSending={isSending}
          isEditing={isEditing}
          onCancelEdit={onCancelEdit}
          attachments={attachments}
          onFilesAccepted={onFilesAccepted}
          onRemoveAttachment={onRemoveAttachment}
          isProcessingAttachments={isProcessingAttachments}
        />
      </div>
    </div>
  )
}
