const DEFAULT_APP_TITLE = "Chat Studio"
const DEFAULT_APP_DESCRIPTION =
  "A modern multimodal chat workspace for LLM experiments."

export function getAppTitle() {
  const value = process.env.APP_TITLE?.trim()
  return value || DEFAULT_APP_TITLE
}

export function getAppDescription() {
  return DEFAULT_APP_DESCRIPTION
}
