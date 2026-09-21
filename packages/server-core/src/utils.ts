// 统一上游地址格式，拼接请求路径时避免重复斜线。
export function trimSlash(url: string) {
  return url.replace(/\/+$/, '')
}

// 打乱候选顺序但保留输入快照，避免修改共享缓存。
export function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}
