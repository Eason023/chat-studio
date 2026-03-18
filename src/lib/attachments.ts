import type { AttachmentPreview } from "@/lib/types"
import { pdfFileToImageAttachments } from "@/lib/pdf"
import { makeId } from "@/lib/utils"

export async function filesToAttachmentPreviews(
  files: File[]
): Promise<AttachmentPreview[]> {
  const results: AttachmentPreview[] = []

  for (const file of files) {
    if (file.type.startsWith("image/")) {
      results.push({
        id: makeId(),
        type: "image",
        blob: file,
        previewUrl: URL.createObjectURL(file),
        name: file.name,
        mimeType: file.type,
      })
      continue
    }

    if (file.type === "application/pdf") {
      const pdfPages = await pdfFileToImageAttachments(file)
      results.push(...pdfPages)
    }
  }

  return results
}
