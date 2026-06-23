const MAX_EMBED_LEFT_OFFSET = 320

export function normalizeEmbedLeftOffset(value: string | null) {
  if (value === null) return 0

  const trimmed = value.trim()
  if (!trimmed) return 0

  const match = /^(\d+(?:\.\d+)?)(?:px)?$/i.exec(trimmed)
  if (!match) return 0

  const offset = Number(match[1])
  if (!Number.isFinite(offset)) return 0

  return Math.min(offset, MAX_EMBED_LEFT_OFFSET)
}

export function getEmbedLeftOffset(searchParams: URLSearchParams) {
  return normalizeEmbedLeftOffset(searchParams.get('embedLeft'))
}

export function applyEmbedLayoutParams(searchParams = new URLSearchParams(window.location.search)) {
  const offset = getEmbedLeftOffset(searchParams)
  document.documentElement.style.setProperty('--embed-left-offset', `${offset}px`)
}
