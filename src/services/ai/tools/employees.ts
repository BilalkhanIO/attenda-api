import { PrismaClient } from '@prisma/client';

export interface SearchEmployeesInput {
  query: string;
  orgId?: string;
}

export async function searchEmployeesTool(
  prisma: PrismaClient,
  input: SearchEmployeesInput
) {
  const { query, orgId } = input;
  const where: any = {
    OR: [
      { name: { contains: query, mode: 'insensitive' } },
      { email: { contains: query, mode: 'insensitive' } },
    ],
    is_active: true,
    deleted_at: null,
  };
  if (orgId) where.org_id = orgId;

  const users = await prisma.user.findMany({
    where,
    select: { id: true, name: true, email: true, department: true, job_title: true },
  });

  return users.map(u => ({
    id: u.id,
    name: u.name,
    email: u.email,
    department: u.department,
    jobTitle: u.job_title,
  }));
}