function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

export function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json;charset=utf-8",
  })
  downloadBlob(filename, blob)
}

function flattenObject(
  value: unknown,
  prefix = ""
): Record<string, string> {
  if (value === null || value === undefined) {
    return prefix ? { [prefix]: "" } : {}
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    return prefix ? { [prefix]: String(value) } : {}
  }

  const result: Record<string, string> = {}

  for (const [key, child] of Object.entries(value)) {
    const nextPrefix = prefix ? `${prefix}.${key}` : key

    if (
      child !== null &&
      typeof child === "object" &&
      !Array.isArray(child)
    ) {
      Object.assign(result, flattenObject(child, nextPrefix))
    } else if (Array.isArray(child)) {
      result[nextPrefix] = child.map((item) => String(item)).join(" | ")
    } else {
      result[nextPrefix] = child == null ? "" : String(child)
    }
  }

  return result
}

export function downloadCsvFromObjects(
  filename: string,
  rows: unknown[]
) {
  if (!rows.length) {
    downloadBlob(
      filename,
      new Blob([""], { type: "text/csv;charset=utf-8" })
    )
    return
  }

  const flattened = rows.map((row) => flattenObject(row))
  const headers = Array.from(
    new Set(flattened.flatMap((row) => Object.keys(row)))
  )

  const escapeCell = (value: string) => {
    const escaped = value.replace(/"/g, '""')
    return `"${escaped}"`
  }

  const lines = [
    headers.map(escapeCell).join(","),
    ...flattened.map((row) =>
      headers.map((header) => escapeCell(row[header] ?? "")).join(",")
    ),
  ]

  const blob = new Blob([lines.join("\n")], {
    type: "text/csv;charset=utf-8",
  })

  downloadBlob(filename, blob)
}
