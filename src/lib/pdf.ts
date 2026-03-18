import type { AttachmentPreview } from "@/lib/types"
import { readFileAsArrayBuffer } from "@/lib/file-utils"
import { makeId } from "@/lib/utils"

let pdfjsPromise: Promise<any> | null = null

async function loadPdfJs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist/build/pdf.mjs").then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs"
      return pdfjs
    })
  }

  return pdfjsPromise
}

export async function pdfFileToImageAttachments(
  file: File,
  maxPages?: number,
  scale = 1.25
): Promise<AttachmentPreview[]> {
  const pdfjs = await loadPdfJs()
  const buffer = await readFileAsArrayBuffer(file)

  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),
  })

  const pdf = await loadingTask.promise
  const totalPages =
    typeof maxPages === "number" ? Math.min(pdf.numPages, maxPages) : pdf.numPages

  const results: AttachmentPreview[] = []

  for (let pageNumber = 1; pageNumber <= totalPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber)
    const viewport = page.getViewport({ scale })

    const canvas = document.createElement("canvas")
    const context = canvas.getContext("2d")

    if (!context) {
      throw new Error("Failed to create canvas context for PDF rendering")
    }

    canvas.width = Math.ceil(viewport.width)
    canvas.height = Math.ceil(viewport.height)

    await page.render({
      canvasContext: context,
      viewport,
    }).promise

    results.push({
      id: makeId(),
      type: "pdf-image",
      url: canvas.toDataURL("image/png"),
      page: pageNumber,
      name: `${file.name} · page ${pageNumber}`,
    })
  }

  return results
}
