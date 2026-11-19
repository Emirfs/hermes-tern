// How long ago something happened, in the Turkish the device tab's status line and side panel use.

/** `3 dk önce`: how long ago `at` was. */
export function agoText(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000))

  return s < 45 ? 'az önce' : s < 3600 ? `${Math.max(1, Math.round(s / 60))} dk önce` : s < 86_400 ? `${Math.round(s / 3600)} sa önce` : `${Math.round(s / 86_400)} gün önce`
}
