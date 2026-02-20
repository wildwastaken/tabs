export interface InlineMarkdownSegment {
  text: string
  bold: boolean
  underline: boolean
}

/**
 * Very small inline parser:
 * - `*text*` toggles bold
 * - `_text_` toggles underline
 * - `\*` and `\_` escape markers
 */
export function parseInlineMarkdown(input: string): InlineMarkdownSegment[] {
  const segments: InlineMarkdownSegment[] = []
  let buffer = ""
  let bold = false
  let underline = false

  const flush = () => {
    if (!buffer) return
    segments.push({ text: buffer, bold, underline })
    buffer = ""
  }

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]
    const nextChar = i < input.length - 1 ? input[i + 1] : ""

    if (char === "\\" && (nextChar === "*" || nextChar === "_" || nextChar === "\\")) {
      buffer += nextChar
      i += 1
      continue
    }

    if (char === "*") {
      flush()
      bold = !bold
      continue
    }

    if (char === "_") {
      flush()
      underline = !underline
      continue
    }

    buffer += char
  }

  flush()

  return segments
}
