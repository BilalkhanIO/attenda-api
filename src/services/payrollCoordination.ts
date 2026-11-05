import { AppError } from '../utils/response';
import { acquireRedisLease } from '../utils/redisLease';

/** Shared org-level lock between payroll runs and changes to their source rules. */
export async function acquirePayrollConfigurationLease(orgId: string) {
  let release: null | (() => Promise<void>);
  try {
    release = await acquireRedisLease(`payroll-config:${orgId}`, 30 * 60_000);
  } catch {
    throw new AppError('Payroll coordination is temporarily unavailable. No payroll changes were applied; retry shortly.', 503, 'PAYROLL_COORDINATION_UNAVAILABLE');
  }
  if (!release) throw new AppError('Payroll rules are being updated or a payroll run is in progress. Retry after it completes.', 409, 'PAYROLL_CONFIGURATION_BUSY');
  return release;
}
