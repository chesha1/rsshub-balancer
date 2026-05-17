import { z } from 'zod'

export const upstreamsResponseSchema = z.object({
  upstreams: z.array(z.string()),
})

export const trafficSankeyLinkSchema = z.object({
  source: z.string(),
  target: z.string(),
  value: z.number(),
})

export const trafficSankeyResponseSchema = z.object({
  links: z.array(trafficSankeyLinkSchema),
})

export type TrafficSankeyLink = z.infer<typeof trafficSankeyLinkSchema>
