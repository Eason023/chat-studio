"use client"

import type { KeyboardEvent } from "react"
import {
  ChevronDown,
  ChevronUp,
  CornerDownLeft,
  FileImage,
  FileText,
  PencilLine,
  SendHorizonal,
  Square,
  X,
} from "lucide-react"
import { useState } from "react"

import { AttachmentDropzone } from "@/components/attachment-dropzone"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import type { AttachmentPreview } from "@/lib/types"

type ComposerProps = {
  value: string
  onChange: (value: string) => void
  onSend: () => void
  onStop: () => void
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void
  disabled?: boolean
  isSending?: boolean
  isEditing?: boolean
  onCancelEdit?: () => void
  attachments: AttachmentPreview[]
  onFilesAccepted: (files: File[]) => void
  onRemoveAttachment: (attachmentId: string) => void
  isProcessingAttachments?: boolean
  showAttachments?: boolean
}

export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  onKeyDown,
  disabled = false,
  isSending = false,
  isEditing = false,
  onCancelEdit,
  attachments,
  onFilesAccepted,
  onRemoveAttachment,
  isProcessingAttachments = false,
  showAttachments = true,
}: ComposerProps) {
  const [dropzoneOpen, setDropzoneOpen] = useState(false)
  const attachmentsExpanded = dropzoneOpen

  return (
    <div className="mx-auto max-w-5xl rounded-xl border bg-card shadow-sm">
      <div className="flex min-h-[216px] flex-col p-3">
        {isEditing ? (
          <div className="mb-2 flex shrink-0 items-center justify-between rounded-lg border border-primary/20 bg-primary/5 px-3 py-2">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <PencilLine className="h-3.5 w-3.5" />
              <span>Editing previous message</span>
            </div>

            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-8 rounded-full"
              onClick={onCancelEdit}
            >
              <X className="mr-1 h-3.5 w-3.5" />
              Cancel
            </Button>
          </div>
        ) : null}

        <div className="min-h-[128px] flex-1 overflow-y-auto">
          <Textarea
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Type your message... (Enter to send, Shift+Enter for newline)"
            className="h-full min-h-[128px] resize-none border-0 bg-transparent px-0 py-1 shadow-none focus-visible:ring-0"
          />
        </div>

        {showAttachments ? (
          <div className="mt-2 shrink-0 border-t pt-2">
            <div className="flex items-center justify-between gap-3">
              <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
                Attachments
                {attachments.length > 0 ? ` (${attachments.length})` : ""}
              </div>

              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 rounded-full px-2"
                onClick={() => setDropzoneOpen((prev) => !prev)}
              >
                {attachmentsExpanded ? (
                  <>
                    <ChevronDown className="mr-1 h-4 w-4" />
                    Collapse
                  </>
                ) : (
                  <>
                    <ChevronUp className="mr-1 h-4 w-4" />
                    Add files
                  </>
                )}
              </Button>
            </div>

            {attachmentsExpanded ? (
              <div className="mt-2">
                <AttachmentDropzone
                  onFilesAccepted={onFilesAccepted}
                  disabled={isSending || isProcessingAttachments}
                  isBusy={isProcessingAttachments}
                />
              </div>
            ) : null}

            {attachments.length > 0 ? (
              <div className="mt-2 overflow-x-auto pb-1">
                <div className="flex min-w-max gap-2.5">
                  {attachments.map((attachment) => (
                    <div
                      key={attachment.id}
                      className="group relative w-28 shrink-0 overflow-hidden rounded-lg border bg-muted/30"
                    >
                      <button
                        type="button"
                        onClick={() => onRemoveAttachment(attachment.id)}
                        className="absolute right-1.5 top-1.5 z-10 rounded-full border bg-background/90 p-1 opacity-100 shadow-sm transition group-hover:opacity-100"
                        aria-label="Remove attachment"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>

                      <div className="aspect-video overflow-hidden bg-background">
                        {/* Local blob/data URLs are displayed directly and are not suitable for next/image optimization. */}
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={attachment.previewUrl}
                          alt={attachment.name}
                          className="h-full w-full object-cover"
                        />
                      </div>

                      <div className="space-y-1 p-2">
                        <div className="flex items-center gap-1 text-xs text-muted-foreground">
                          {attachment.type === "image" ? (
                            <FileImage className="h-3.5 w-3.5" />
                          ) : (
                            <FileText className="h-3.5 w-3.5" />
                          )}

                          <span className="truncate">
                            {attachment.type === "pdf-image"
                              ? `PDF ${attachment.page}`
                              : "Image"}
                          </span>
                        </div>

                        <div className="truncate text-xs">{attachment.name}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="mt-2 shrink-0 border-t pt-2">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <CornerDownLeft className="h-3.5 w-3.5" />
              <span>Enter to send</span>
            </div>

            <div className="flex items-center gap-2">
              {isSending ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={onStop}
                  className="rounded-full"
                >
                  <Square className="mr-2 h-4 w-4" />
                  Stop
                </Button>
              ) : null}

              <Button onClick={onSend} disabled={disabled} className="rounded-full">
                <SendHorizonal className="mr-2 h-4 w-4" />
                {isEditing ? "Resend" : "Send"}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
