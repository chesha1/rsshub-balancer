import type { ResponseSnapshot } from './types'

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

// 从快照创建独立的 Response（body 会被复制）
export function toResponse(snapshot: ResponseSnapshot): Response {
  return new Response(snapshot.body.slice(0), {
    status: snapshot.status,
    headers: snapshot.headers,
  })
}
