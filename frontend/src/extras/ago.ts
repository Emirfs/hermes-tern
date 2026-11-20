// How long ago something happened, as the device tab's status line and side panel say it.

/** `3 min ago`: how long ago `at` was. */
export function agoText(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000))

  return s < 45 ? 'just now' : s < 3600 ? `${Math.max(1, Math.round(s / 60))} min ago` : s < 86_400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86_400)} d ago`
}
