import prisma from '../utils/prisma';
import { swapRequestSchema } from '../schemas';
import { ValidationError } from '../utils/response';
import { emitOrgEvent } from './notifications';

export async function submitShiftSwap(userId: string, orgId: string, args: unknown) {
  const input = swapRequestSchema.parse(args);
  if (!input.requester_assign_id || !input.target_assign_id) throw new ValidationError('Both shift assignments are required');
  const [mine, theirs] = await Promise.all([
    prisma.shiftAssignment.findFirst({ where: { id: input.requester_assign_id, user_id: userId, shift: { org_id: orgId } } }),
    prisma.shiftAssignment.findFirst({ where: { id: input.target_assign_id, user_id: input.target_id, shift: { org_id: orgId } } }),
  ]);
  if (!mine || !theirs || input.target_id === userId) throw new ValidationError('Select your shift and a shift belonging to another employee');
  const swap = await prisma.shiftSwap.create({ data: { requester_id: userId, target_id: input.target_id, requester_assign_id: mine.id, target_assign_id: theirs.id, reason: input.reason } });
  emitOrgEvent(orgId, 'swap_changed');
  return swap;
}
