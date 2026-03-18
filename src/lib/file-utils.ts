export function readFileAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()

    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result)
      } else {
        reject(new Error("Failed to read file as data URL"))
      }
    }

    reader.onerror = () => {
      reject(reader.error ?? new Error("FileReader failed"))
    }

    reader.readAsDataURL(file)
  })
}

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
