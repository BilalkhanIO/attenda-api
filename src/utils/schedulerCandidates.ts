/** Merge explicitly assigned employees with employees covered by a branch-wide shift. */
export function mergeShiftCandidates<T extends { id: string }, S>(
  assignments: Array<{ user_id: string; user: T; shift: S }>,
  fallbackEmployees: T[],
) {
  const employeesById = new Map<string, T>();
  const shiftByUserId = new Map<string, S>();
  for (const assignment of assignments) {
    employeesById.set(assignment.user.id, assignment.user);
    shiftByUserId.set(assignment.user_id, assignment.shift);
  }
  for (const employee of fallbackEmployees) employeesById.set(employee.id, employee);
  return { employees: [...employeesById.values()], shiftByUserId };
}
