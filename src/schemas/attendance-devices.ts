import { z } from 'zod';

export const attendanceDeviceEnrollSchema = z.object({
  label: z.string().trim().min(2).max(100),
  platform: z.literal('android'),
  public_key: z.string().min(80).max(800).regex(/^[A-Za-z0-9+/]+={0,2}$/),
});

export const attendanceDeviceProofSchema = z.object({
  challenge: z.string().min(20).max(100),
  signature: z.string().min(40).max(1000).regex(/^[A-Za-z0-9+/]+={0,2}$/),
});

export const attendanceDeviceChallengeSchema = z.object({}).strict();

export const attendanceDeviceQueueSchema = z.object({
  status: z.enum(['pending', 'approved', 'revoked']).optional(),
});
