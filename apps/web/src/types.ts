import { z } from 'zod'

// 首页 CSP 不允许 eval。Zod 默认在创建对象 schema 时用 new Function 探测能否启用 JIT，
// 探测失败虽被捕获，浏览器仍会记录并上报 CSP 违规；关闭 JIT 后解析改走普通路径，不再探测。
// 该开关在 z.object() 创建 schema 时读取，必须放在下面所有 schema 定义之前。
z.config({ jitless: true })

export const upstreamsResponseSchema = z.object({
  upstreams: z.array(z.string()),
})

export const trafficSankeyRowSchema = z.object({
  country: z.string(),
  path: z.string(),
  upstream: z.string(),
  value: z.number(),
})

export const trafficSankeyResponseSchema = z.object({
  rows: z.array(trafficSankeyRowSchema),
})

export type TrafficSankeyRow = z.infer<typeof trafficSankeyRowSchema>
