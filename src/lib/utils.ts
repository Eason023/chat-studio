export function cn(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ")
}

export function makeId() {
  return crypto.randomUUID()
}

export function formatRelativeTime(timestamp: number) {
  const diff = Date.now() - timestamp

  const sec = Math.floor(diff / 1000)
  if (sec < 60) return "just now"

  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} min ago`

  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} hr ago`

  const day = Math.floor(hour / 24)
  return `${day} day ago`
}
