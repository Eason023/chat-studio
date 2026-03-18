export function readFileAsArrayBuffer(file: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()

    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(reader.result)
      } else {
        reject(new Error("Failed to read file as ArrayBuffer"))
      }
    }

    reader.onerror = () => {
      reject(reader.error ?? new Error("FileReader failed"))
    }

    reader.readAsArrayBuffer(file)
  })
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()

    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result)
      } else {
        reject(new Error("Failed to read blob as data URL"))
      }
    }

    reader.onerror = () => {
      reject(reader.error ?? new Error("FileReader failed"))
    }

    reader.readAsDataURL(blob)
  })
}

export function canvasToBlob(
  canvas: HTMLCanvasElement,
  type = "image/png",
  quality?: number
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("Failed to convert canvas to Blob"))
        return
      }

      resolve(blob)
    }, type, quality)
  })
}
