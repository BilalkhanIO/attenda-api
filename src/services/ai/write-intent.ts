export function explicitlyRequestedWrite(toolName: string, args: any, message: string): boolean {
  const text = message.toLocaleLowerCase();
  // Tool arguments alone are never authorization. Questions and explicit
  // negations must not trigger a mutation, including project tools whose
  // field-specific intent checks are otherwise permissive.
  if (message.trim().endsWith('?') || /\b(?:do not|don't|never|should not|shouldn't|did not ask|didn't ask|not asking|do not want|don't want)\b/i.test(text)) return false;
  const has = (pattern: RegExp) => pattern.test(text);
  if (toolName === 'requestLeave') return has(/\b(request|apply|submit)\b.{0,60}\bleave\b/) && !message.trim().endsWith('?') && !has(/\b(do not|don't|never|how (?:do|can)|should i)\b/);
  if (toolName === 'requestShiftSwap') return has(/\b(request|submit|create)\b.{0,60}\b(swap|shift exchange)\b/) && !message.trim().endsWith('?') && !has(/\b(do not|don't|never|how (?:do|can)|should i)\b/);
  if (toolName === 'requestAttendanceCorrection') return has(/\b(request|submit|create)\b.{0,60}\b(correction|attendance correction)\b/) && !message.trim().endsWith('?') && !has(/\b(do not|don't|never|how (?:do|can)|should i)\b/);
  if (toolName === 'requestOvertime') return has(/\b(request|submit|claim)\b.{0,60}\bovertime\b/) && !message.trim().endsWith('?') && !has(/\b(do not|don't|never|how (?:do|can)|should i)\b/);
  if (toolName === 'cancelMyRequest') return has(/\b(cancel|withdraw|retract)\b.{0,80}\b(request|leave|swap|overtime|correction|remote|work from home)\b|\b(request|leave|swap|overtime|correction|remote|work from home)\b.{0,80}\b(cancel|withdraw|retract)\b/)
    && !message.trim().endsWith('?') && !has(/\b(how (?:do|can)|should i|can i|could i|what if|do not|don't|never|not able|unable|can't|cannot|add tools?|implement|support for)\b/);
  if (toolName === 'createShiftBreakTemplate') return has(/\b(create|add|make)\b.{0,80}\bbreak\b/) && !message.trim().endsWith('?') && !has(/\b(do not|don't|never|how (?:do|can)|should i)\b/);
  if (toolName === 'requestShiftAvailability') return has(/\b(request|submit|add)\b.{0,60}\b(availability|unavailability|preferred work time|time unavailable)\b/) && !message.trim().endsWith('?') && !has(/\b(do not|don't|never|how (?:do|can)|should i)\b/);
  if (toolName === 'reviewShiftAvailability') return has(/\b(approve|accept|reject|decline)\b.{0,100}\b(availability|unavailability|request)\b/) && !message.trim().endsWith('?') && !has(/\b(when did|did i|how do i|what if|should i|can i)\b/);
  if (toolName === 'createProject') return has(/\b(create|start|make|new)\b.{0,50}\bproject\b/);
  if (toolName === 'createProjectTask' || toolName === 'createProjectTasks') return has(/\b(add|create|make|break down)\b.{0,70}\b(tasks?|milestones?|subtasks?)\b/);
  if (toolName === 'reviewApproval') {
    const matchingAction = args.action === 'approve' ? /\bapprove\b/i : args.action === 'reject' ? /\b(reject|decline)\b/i : /\backnowledge\b/i;
    return matchingAction.test(message) && !message.trim().endsWith('?')
      && !/\b(when did|did i|how do i|what if|should i|can i)\b/i.test(message);
  }
  if (toolName === 'manageProjectMember') {
    return args.action === 'add'
      ? has(/\b(add|invite)\b.{0,70}\b(member|employee|person|team|project)\b/)
      : has(/\b(remove|delete|take off)\b.{0,70}\b(member|employee|person|team|project)\b/);
  }
  if (toolName === 'addProjectTaskComment') return has(/\b(comment|note|discussion|mention|tag)\b/)
    && !has(/\b(ask me|ask which|what (?:the )?comment|do not post|don't post|do not add|do not change|wait until I answer)\b/);
  if (toolName === 'updateProjectDetails') {
    return (args.name !== undefined && has(/\b(rename|project name|call the project|name the project)\b/))
      || (args.description !== undefined && has(/\b(description|project details)\b/))
      || (args.priority !== undefined && has(/\bpriority\b/))
      || (args.status !== undefined && has(/\b(project status|mark the project|set the project status)\b/))
      || (args.startDate !== undefined && has(/\b(start date|project start)\b/))
      || (args.dueDate !== undefined && has(/\b(due date|project deadline|project due)\b/))
      || (args.statusOptions !== undefined && has(/\b(task status|status options|workflow statuses)\b/));
  }
  if (toolName === 'updateProjectTaskStatus') return has(/\b(status|move (?:the )?task|mark (?:the )?task|set (?:the )?task)\b|\b(todo|to do|in progress|blocked|done|complete|completed)\b/);
  if (toolName === 'updateProjectTask') {
    const fieldIntents: Record<string, RegExp> = {
      title: /\b(rename|change the task title|task title)\b/,
      description: /\b(task description|task details|change the description)\b/,
      priority: /\bpriority\b/,
      status: /\b(status|move (?:the )?task|mark (?:the )?task|set (?:the )?task)\b|\b(todo|to do|in progress|blocked|done|complete|completed)\b/,
      assigneeId: /\b(assign|assigned|assignment|assignee|reassign|unassign)\b/,
      startDate: /\b(start date|start this task|task starts)\b/,
      dueDate: /\b(due date|deadline|due this task)\b/,
      isMilestone: /\bmilestone\b/,
      dependsOnTaskIds: /\b(dependenc|depends on|blocked by|blocking)\b/,
    };
    const requestedFields = Object.keys(args).filter(key => key !== 'taskId');
    return requestedFields.length > 0 && requestedFields.every(key => fieldIntents[key]?.test(text));
  }
  return false;
}
