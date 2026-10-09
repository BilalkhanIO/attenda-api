import { z } from 'zod';

export const aiChatBodySchema = z.object({
  message: z.string().min(1, 'message required'),
  conversation_id: z.string().uuid().optional(),
});

export type AiChatBody = z.infer<typeof aiChatBodySchema>;