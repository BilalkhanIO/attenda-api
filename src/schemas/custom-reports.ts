import { z } from 'zod';

export const customReportSchema = z.object({
  dataset: z.enum(['employees', 'attendance', 'leave']),
  columns: z.array(z.string().min(1).max(64)).min(1).max(12),
  filters: z.object({
    date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    department: z.string().max(100).optional(),
    status: z.string().max(32).optional(),
    employee_id: z.string().uuid().optional(),
    is_active: z.boolean().optional(),
  }).strict().default({}),
}).strict().superRefine((value, context) => {
  for (const key of ['date_from', 'date_to'] as const) {
    const date = value.filters[key];
    if (date) {
      const parsed = new Date(`${date}T00:00:00.000Z`);
      if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['filters', key], message: 'Enter a valid calendar date.' });
      }
    }
  }
  if (value.filters.date_from && value.filters.date_to && value.filters.date_from > value.filters.date_to) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['filters', 'date_to'], message: 'End date must be on or after the start date.' });
  }
});

export type CustomReportInput = z.infer<typeof customReportSchema>;

export const customReportDefinitionSchema = z.object({
  name: z.string().trim().min(1).max(120),
  definition: customReportSchema,
}).strict();
