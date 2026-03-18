import type { AttachmentPreview } from "@/lib/types"
import { readFileAsDataUrl } from "@/lib/file-utils"
import { pdfFileToImageAttachments } from "@/lib/pdf"
import { makeId } from "@/lib/utils"

export async function filesToAttachmentPreviews(
  files: File[]
): Promise<AttachmentPreview[]> {
  const results: AttachmentPreview[] = []

  for (const file of files) {
    if (file.type.startsWith("image/")) {
      const url = await readFileAsDataUrl(file)

      results.push({
        id: makeId(),
        type: "image",
        url,
        name: file.name,
        mimeType: file.type,
      })

      continue
    }

    if (file.type === "application/pdf") {
      const pdfPages = await pdfFileToImageAttachments(file, undefined, 1.2)
      results.push(...pdfPages)
    }
  }

  return results
}
