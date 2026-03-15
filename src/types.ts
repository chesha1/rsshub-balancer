// Response 的不可变快照，用于请求合并（request coalescing）。
// Response.body 是一次性流，无法被多个消费者共享。请求合并要求 leader 的响应
// 能被所有 follower 复用，因此需要将 body 缓冲为可复制的 Uint8Array，
// 连同 status 和 headers 一起冻结为纯数据快照。
// headers 使用 [string, string][] 而非 Headers 对象，以便跨 isolate 序列化（DO RPC）。
export type ResponseSnapshot = {
  status: number
  headers: string[][]
  body: Uint8Array
}
