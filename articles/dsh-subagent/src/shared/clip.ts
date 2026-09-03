/** 输出截断工具：超过 max 字符的文本截断并加 … */
export function clip(text: string, max = 60): string {
  return text.length > max ? text.slice(0, max) + '…' : text
}

export {}
