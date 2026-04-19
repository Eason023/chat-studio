"use client"

import { FileImage, FileText, Upload } from "lucide-react"
import { useDropzone } from "react-dropzone"

import { cn } from "@/lib/utils"

type AttachmentDropzoneProps = {
  onFilesAccepted: (files: File[]) => void
  disabled?: boolean
  isBusy?: boolean
}

export function AttachmentDropzone({
  onFilesAccepted,
  disabled = false,
  isBusy = false,
}: AttachmentDropzoneProps) {
  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    disabled,
    multiple: true,
    accept: {
      "image/*": [],
      "application/pdf": [".pdf"],
    },
    onDropAccepted: (files) => {
      onFilesAccepted(files)
    },
  })

  return (
    <div
      {...getRootProps()}
      className={cn(
        "mt-2 rounded-xl border border-dashed px-3 py-3 transition",
        isDragActive && "border-primary bg-primary/5",
        disabled && "cursor-not-allowed opacity-60",
        !disabled && "cursor-pointer hover:bg-muted/40"
      )}
    >
      <input {...getInputProps()} />

      <div className="flex items-start gap-2.5">
        <div className="rounded-lg border bg-background p-2">
          <Upload className="h-4 w-4" />
        </div>

        <div className="min-w-0">
          <div className="text-sm font-medium">
            {isBusy ? "Processing attachments..." : "Drop images or PDFs here"}
          </div>

          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <FileImage className="h-3.5 w-3.5" />
              Images
            </span>
            <span className="inline-flex items-center gap-1">
              <FileText className="h-3.5 w-3.5" />
              PDFs
            </span>
            <span>Click also works</span>
          </div>
        </div>
      </div>
    </div>
  )
}
