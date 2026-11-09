import { z } from 'zod';

/** Cấu hình công khai trả về cho web qua GET /config (không chứa secret). */
export const publicConfigSchema = z.object({
  featureAiEnabled: z.boolean(),
  zaloPersonalEnabled: z.boolean(),
});
export type PublicConfig = z.infer<typeof publicConfigSchema>;
