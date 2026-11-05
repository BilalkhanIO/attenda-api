/** Intersect user-facing schedule filters with the caller's permission scope. */
export function intersectAssignmentEmployeeIds(
  scopedIds: string[] | null,
  departmentIds?: string[],
  employeeId?: string,
): string[] | null {
  let allowed = scopedIds === null ? null : new Set(scopedIds);
  if (departmentIds) {
    const department = new Set(departmentIds);
    allowed = allowed === null
      ? department
      : new Set([...allowed].filter(id => department.has(id)));
  }
  if (employeeId) {
    allowed = allowed === null
      ? new Set([employeeId])
      : new Set(allowed.has(employeeId) ? [employeeId] : []);
  }
  return allowed === null ? null : [...allowed];
}
