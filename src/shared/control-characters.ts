type ControlCharacterOptions = {
  allowLineWhitespace?: boolean
  rejectDelete?: boolean
}

export function hasControlCharacters(
  value: string,
  { allowLineWhitespace = false, rejectDelete = true }: ControlCharacterOptions = {},
): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)
    if (code === undefined) continue
    if (code < 0x20 && !(allowLineWhitespace && (code === 0x09 || code === 0x0a || code === 0x0d))) return true
    if (rejectDelete && code === 0x7f) return true
  }
  return false
}
