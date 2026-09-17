import { z } from 'zod'

export const upstreamsResponseSchema = z.object({
  upstreams: z.array(z.string()),
})

export const trafficSankeyRowSchema = z.object({
  country: z.string(),
  upstream: z.string(),
  value: z.number(),
})

export const trafficSankeyResponseSchema = z.object({
  rows: z.array(trafficSankeyRowSchema),
})

export type TrafficSankeyRow = z.infer<typeof trafficSankeyRowSchema>
