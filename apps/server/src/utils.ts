import type { ResponseSnapshot } from './types'

type ToResponseOptions = {
  includeBody?: boolean
}

export function trimSlash(url: string) {
  return url.replace(/\/+$/, '')
}

export function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// 将 Response 冻结为可共享的快照（消费 body 流）
export async function fromResponse(res: Response): Promise<ResponseSnapshot> {
  const body = new Uint8Array(await res.arrayBuffer())
  return { status: res.status, headers: [...res.headers], body }
}

// 从快照创建独立的 Response；HEAD 等场景可以只复用状态码和 headers，不返回 body。
export function toResponse(
  snapshot: ResponseSnapshot,
  options: ToResponseOptions = {},
): Response {
  const includeBody = options.includeBody ?? true
  return new Response(includeBody ? snapshot.body.slice(0) : null, {
    status: snapshot.status,
    headers: snapshot.headers,
  })
}
