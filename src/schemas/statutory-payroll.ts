import { z } from 'zod';

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, 'Enter a valid calendar date.');

export const statutoryParameterSetSchema = z.object({
  country_code: z.string().regex(/^[A-Z]{2}$/, 'Use a two-letter uppercase country code.'),
  effective_from: dateOnly,
  effective_to: dateOnly.nullable().optional(),
  source_reference: z.string().trim().min(8).max(2000),
  annual_tax_slabs: z.array(z.object({
    lower_bound: z.number().finite().min(0),
    upper_bound: z.number().finite().positive().nullable(),
    base_tax: z.number().finite().min(0),
    marginal_rate_pct: z.number().finite().min(0).max(100),
  }).strict()).max(100).default([]),
  contributions: z.array(z.object({
    key: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/),
    label: z.string().trim().min(1).max(80),
    employee_rate_pct: z.number().finite().min(0).max(100).default(0),
    employer_rate_pct: z.number().finite().min(0).max(100).default(0),
    wage_base_cap_monthly: z.number().finite().positive().nullable().default(null),
  }).strict()).max(30).default([]),
}).strict().superRefine((value, context) => {
  if (value.effective_to && value.effective_to < value.effective_from) context.addIssue({ code: 'custom', path: ['effective_to'], message: 'End date must be on or after the start date.' });
  if (new Set(value.contributions.map(item => item.key)).size !== value.contributions.length) context.addIssue({ code: 'custom', path: ['contributions'], message: 'Contribution keys must be unique.' });
  const slabs = value.annual_tax_slabs;
  if (slabs.length) {
    if (slabs[0].lower_bound !== 0) context.addIssue({ code: 'custom', path: ['annual_tax_slabs', 0, 'lower_bound'], message: 'The first annual tax band must begin at zero.' });
    for (let index = 0; index < slabs.length; index++) {
      const current = slabs[index];
      const last = index === slabs.length - 1;
      if (last !== (current.upper_bound === null)) context.addIssue({ code: 'custom', path: ['annual_tax_slabs', index, 'upper_bound'], message: 'Only the final band may have no upper bound.' });
      if (current.upper_bound !== null && current.upper_bound <= current.lower_bound) context.addIssue({ code: 'custom', path: ['annual_tax_slabs', index, 'upper_bound'], message: 'The upper bound must exceed the lower bound.' });
      const next = slabs[index + 1];
      if (next && current.upper_bound !== next.lower_bound) context.addIssue({ code: 'custom', path: ['annual_tax_slabs', index + 1, 'lower_bound'], message: 'Tax bands must be sorted and contiguous.' });
    }
  }
});

export type StatutoryParameterSetInput = z.infer<typeof statutoryParameterSetSchema>;
