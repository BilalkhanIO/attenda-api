import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { aiChatBodySchema } from '../schemas/ai';
import { leaveRequestSchema } from '../schemas';
import { AiAgent, ToolDefinition, ChatMessage } from '../services/ai/agent';
import { requirePermission } from '../middleware/auth';
import { AppError, ok } from '../utils/response';
import prisma from '../utils/prisma';
import { logger } from '../utils/logger';

const router = Router();
const AI_WRITE_TOOLS = new Set([
  'requestOvertime',
  'requestLeave',
  'requestShiftSwap',
  'requestAttendanceCorrection',
  'requestShiftAvailability',
  'reviewShiftAvailability',
  'cancelMyRequest',
  'createShiftBreakTemplate',
  'createProject',
  'updateProjectDetails',
  'manageProjectMember',
  'createProjectTask',
  'createProjectTasks',
  'updateProjectTaskStatus',
  'updateProjectTask',
  'addProjectTaskComment',
  'reviewApproval',
]);

function getConversationContextTitle(context: string | null): string | null {
  if (!context) return null;
  try {
    const data: unknown = JSON.parse(context);
    if (!data || typeof data !== 'object') return 'Context attached';
    const record = data as { project?: { name?: unknown }; task?: { title?: unknown } };
    const project = typeof record.project?.name === 'string' ? record.project.name : null;
    const task = typeof record.task?.title === 'string' ? record.task.title : null;
    if (project && task) return `${project} · ${task}`;
    if (project) return project;
  } catch {
    return 'Context attached';
  }
  return 'Context attached';
}

router.get('/conversations', authenticate, requirePermission('analytics.ai_chat'), async (req: AiReq, res, next) => {
  try {
    const userId = req.user!.sub;
    const conversations = await prisma.aiConversation.findMany({
      where: { orgId: req.user!.org_id, userId },
      orderBy: { updatedAt: 'desc' },
      take: 50,
      select: {
        id: true, createdAt: true, updatedAt: true, context: true,
        messages: { where: { role: 'user' }, orderBy: { createdAt: 'asc' }, take: 1, select: { content: true } },
        _count: { select: { messages: true } },
      },
    });
    ok(res as any, conversations.map(conversation => ({
      id: conversation.id,
      title: conversation.messages[0]?.content?.trim().slice(0, 90) || 'New conversation',
      context_title: getConversationContextTitle(conversation.context),
      created_at: conversation.createdAt,
      updated_at: conversation.updatedAt,
      message_count: conversation._count.messages,
    })));
  } catch (error) { next(error); }
});

router.get('/conversations/:id', authenticate, requirePermission('analytics.ai_chat'), async (req: AiReq, res, next) => {
  try {
    const conversation = await prisma.aiConversation.findFirst({
      where: { id: String(req.params.id), orgId: req.user!.org_id, userId: req.user!.sub },
      select: { id: true, context: true, _count: { select: { messages: true } }, messages: { orderBy: { sequence: 'desc' }, take: 100, select: { id: true, role: true, content: true, toolCalls: true, createdAt: true } } },
    });
    if (!conversation) throw new AppError('Conversation not found', 404, 'NOT_FOUND');
    const messages = conversation.messages.reverse();
    ok(res as any, {
      id: conversation.id,
      context: conversation.context,
      messages,
      message_count: conversation._count.messages,
      has_older_messages: conversation._count.messages > messages.length,
    });
  } catch (error) { next(error); }
});

interface AiReq {
  user?: { sub: string; org_id: string };
  body: any;
  params: Record<string, string>;
}

type AiChoice = { label: string; prompt: string };

function inferResponseLanguage(text: string): string {
  if (/[\u0679\u0688\u0691\u0698\u06ba\u06d2\u06be\u06c1]/u.test(text)) return 'ur';
  if (/[\u0600-\u06ff]/u.test(text)) return 'ar';
  if (/[\u0900-\u097f]/u.test(text)) return 'hi';
  if (/[\u0980-\u09ff]/u.test(text)) return 'bn';
  const value = text.toLocaleLowerCase();
  if (/[¿¡ñáíóú]/u.test(value) || /\b(hola|gracias|quiero|solicitud|permiso|por favor|puedes)\b/u.test(value)) return 'es';
  if (/[àâçéèêëîïôûùüÿœ]/u.test(value) || /\b(bonjour|merci|je|vous|congé|demande)\b/u.test(value)) return 'fr';
  if (/[ãõáâêôç]/u.test(value) || /\b(olá|obrigado|solicitação|férias|por favor)\b/u.test(value)) return 'pt';
  return 'en';
}

const leaveConfirmationCopy: Record<string, { title: string; type: string; dates: string; status: string; pending: string; id: string }> = {
  en: { title: 'Leave request is pending', type: 'Type', dates: 'Dates', status: 'Status', pending: 'Pending manager review', id: 'Request ID' },
  ur: { title: 'چھٹی کی درخواست زیرِ التوا ہے', type: 'قسم', dates: 'تاریخیں', status: 'حیثیت', pending: 'منیجر کی منظوری کا انتظار ہے', id: 'درخواست نمبر' },
  ar: { title: 'طلب الإجازة قيد الانتظار', type: 'النوع', dates: 'التواريخ', status: 'الحالة', pending: 'بانتظار مراجعة المدير', id: 'رقم الطلب' },
  es: { title: 'La solicitud de permiso está pendiente', type: 'Tipo', dates: 'Fechas', status: 'Estado', pending: 'Pendiente de revisión del responsable', id: 'ID de solicitud' },
  fr: { title: 'La demande de congé est en attente', type: 'Type', dates: 'Dates', status: 'Statut', pending: 'En attente de validation du responsable', id: 'Identifiant de la demande' },
  hi: { title: 'छुट्टी का अनुरोध लंबित है', type: 'प्रकार', dates: 'तिथियाँ', status: 'स्थिति', pending: 'प्रबंधक की समीक्षा लंबित', id: 'अनुरोध आईडी' },
  bn: { title: 'ছুটির আবেদনটি অপেক্ষমাণ', type: 'ধরন', dates: 'তারিখ', status: 'অবস্থা', pending: 'ম্যানেজারের পর্যালোচনার অপেক্ষায়', id: 'আবেদন আইডি' },
  pt: { title: 'A solicitação de licença está pendente', type: 'Tipo', dates: 'Datas', status: 'Status', pending: 'Aguardando análise do gestor', id: 'ID da solicitação' },
};

function explicitlyRequestedWrite(toolName: string, args: any, message: string): boolean {
  const text = message.toLocaleLowerCase();
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

function clarificationChoices(toolName: string, args: any): AiChoice[] {
  const task = args.taskId ? `task ${args.taskId}` : 'that task';
  if (toolName === 'updateProjectTask' || toolName === 'updateProjectTaskStatus') return [
    { label: 'Assign someone', prompt: `I want to explicitly change the assignee on ${task}. Ask me which employee to assign; do not change anything until I name them.` },
    { label: 'Change its status', prompt: `I want to explicitly change the status of ${task}. Ask me what status to use; do not change it until I answer.` },
    { label: 'Add a comment', prompt: `I want to add a comment to ${task}. Ask me for the comment text and who to mention; do not post yet.` },
    { label: 'Show task details', prompt: `Show me the details of ${task} without changing it.` },
  ];
  if (toolName === 'addProjectTaskComment') return [
    { label: 'Add one comment', prompt: `Ask me for the exact comment text for ${task}; do not post until I provide it.` },
    { label: 'Mention someone', prompt: `Ask me which project member to mention and what the comment should say; do not post until I answer.` },
    { label: 'Show task details', prompt: `Show me the details of ${task} without changing it.` },
  ];
  return [
    { label: 'Tell me what you can change', prompt: 'Ask me which project or task action I want. Do not make a change based on an earlier request.' },
    { label: 'Show project details', prompt: 'Show my accessible project details without changing them.' },
  ];
}

/** POST /api/v1/ai/chat */
router.post(
  '/chat',
  authenticate,
  requirePermission('analytics.ai_chat'),
  validate({ body: aiChatBodySchema }),
  async (req: AiReq, res, next) => {
    try {
      const orgId = req.user!.org_id;
      const { message, conversation_id } = req.body;
      logger.info({ userId: req.user!.sub, orgId, conversationId: conversation_id ?? null, messageLength: message.length }, 'AI request received');

      // Use existing conversation or create new one
      let conversationId = conversation_id;
      if (!conversationId) {
        const conv = await prisma.aiConversation.create({
          data: { orgId, userId: req.user!.sub, context: req.body.context || null },
        });
        conversationId = conv.id;
      }

      const ownedConversation = await prisma.aiConversation.findFirst({
        where: { id: conversationId, orgId, userId: req.user!.sub },
        select: { id: true, context: true },
      });
      if (!ownedConversation) throw new AppError('Conversation not found', 404, 'NOT_FOUND');
      const agent = new AiAgent(prisma, orgId, req.user!.sub, ownedConversation.context ?? undefined, message);

      // Load existing messages
      const conv = await agent.loadConversation(conversationId);
      let messages: ChatMessage[] = [];
      if (conv && conv.messages) {
        messages = [...conv.messages];
      }

      // Add user message
      messages.push({ role: 'user', content: message, toolCalls: undefined });

      const previousAssistant = conv?.messages?.[conv.messages.length - 1];
      const confirmAction = /^(?:confirm the proposed action|confirm|yes|yes,? proceed|proceed)$/i.test(message.trim());
      const cancelAction = /^(?:cancel|cancel the proposed action\. do not make any changes\.)$/i.test(message.trim());
      if (/^confirm the proposed action$/i.test(message.trim()) && !previousAssistant?.toolCalls?.pendingAction) {
        throw new AppError('This action is no longer awaiting confirmation. Check the conversation or request status before trying again.', 409, 'NO_PENDING_ACTION');
      }
      if (previousAssistant?.role === 'assistant' && previousAssistant.toolCalls?.pendingAction && (confirmAction || cancelAction)) {
        const previous = conv?.messages?.[conv.messages.length - 1];
        const pending = previous?.role === 'assistant' ? previous.toolCalls?.pendingAction : null;
        if (!pending || !AI_WRITE_TOOLS.has(pending.name) || typeof pending.args !== 'object' || !pending.args) throw new AppError('There is no action waiting for confirmation', 400, 'NO_PENDING_ACTION');
        const last = await prisma.aiMessage.findFirst({ where: { conversationId }, orderBy: { sequence: 'desc' }, select: { id: true, role: true, toolCalls: true } });
        if (!last || last.role !== 'assistant' || !last.toolCalls || typeof last.toolCalls !== 'object' || Array.isArray(last.toolCalls) || !('pendingAction' in last.toolCalls)) throw new AppError('There is no action waiting for confirmation', 400, 'NO_PENDING_ACTION');
        if (JSON.stringify(last.toolCalls.pendingAction) !== JSON.stringify(pending)) throw new AppError('The proposed action has changed; review it again', 409, 'ACTION_CHANGED');
        const claimed = await prisma.aiMessage.updateMany({ where: { id: last.id, toolCalls: { equals: last.toolCalls } }, data: { toolCalls: { choices: [] } } });
        if (!claimed.count) throw new AppError('This action was already confirmed', 409, 'ACTION_ALREADY_CONFIRMED');
        if (cancelAction) {
          const response = 'Cancelled. No changes were made.';
          await agent.persistConversation(conversationId, [{ role: 'user', content: message }, { role: 'assistant', content: response }]);
          ok(res as any, { response, conversation_id: conversationId });
          return;
        }
        let response: string;
        try {
          const result = await agent.executeTool(pending.name, pending.args);
          if (result.success && pending.name === 'requestLeave') {
            const request = result.data;
            const priorUserMessages = conv?.messages?.filter(item => item.role === 'user') ?? [];
            const locale = inferResponseLanguage(priorUserMessages[priorUserMessages.length - 1]?.content ?? message);
            const dateLabel = (value: unknown) => value ? new Date(String(value)).toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : 'date unavailable';
            const copy = leaveConfirmationCopy[locale] ?? leaveConfirmationCopy.en;
            response = `**${copy.title}**\n\n- **${copy.type}:** ${request.leave_type}\n- **${copy.dates}:** ${dateLabel(request.start_date)}${String(request.start_date) === String(request.end_date) ? '' : ` – ${dateLabel(request.end_date)}`}\n- **${copy.status}:** ${copy.pending}\n- **${copy.id}:** ${request.id}`;
          } else {
            response = result.success ? `The requested action was completed: ${JSON.stringify(result.data)}.` : `The action was not completed: ${result.error ?? 'Please check the details.'}`;
          }
        } catch (error) {
          response = `The action was not completed: ${error instanceof AppError ? error.message : 'Please check the details and try again.'}`;
        }
        await agent.persistConversation(conversationId, [{ role: 'user', content: message }, { role: 'assistant', content: response }]);
        ok(res as any, { response, conversation_id: conversationId });
        return;
      }

      const addToTask = message.match(/\badd\s+(?:the\s+)?(.+?)\s+to\s+(?:the\s+)?task\b/i);
      const namesAction = /\b(assign|assignee|owner|mention|tag|comment|note|project member)\b/i.test(message);
      if (addToTask && !namesAction) {
        const target = addToTask[1].trim();
        const response = `“Add ${target} to the task” could mean several things. Choose what you want; I have not changed the task.`;
        const choices: AiChoice[] = [
          { label: 'Assign as task owner', prompt: `Assign an employee to the task. First ask me which employee; do not change the task until I choose.` },
          { label: 'Add to the project team', prompt: `Add an employee as a project member, not as a task assignee. Ask me which project and employee; do not change anything until I answer.` },
          { label: 'Mention in a comment', prompt: `Add a comment mentioning an employee. Ask me which person and what the comment should say; do not post until I answer.` },
          { label: 'Add a task comment', prompt: `Ask me for the exact task comment text. Do not post anything until I provide it.` },
        ];
        await agent.persistConversation(conversationId, [{ role: 'user', content: message }, { role: 'assistant', content: response, toolCalls: { choices } }]);
        ok(res as any, { response, choices, conversation_id: conversationId });
        return;
      }
      if (/\b(?:add|put|move)\b.{0,40}\b(?:hr|human resources|a person|someone|an employee)\b.{0,40}\b(?:task|tasks)\b/i.test(message)
        && !/\b(assign|assignee|owner|mention|tag|comment|note|project member)\b/i.test(message)) {
        const response = 'I will not guess what “add someone to a task” means. Choose the action first; I will ask for the person and task details before changing anything.';
        const choices: AiChoice[] = [
          { label: 'Assign as task owner', prompt: 'I want to assign an employee to a task. Ask me which task and employee; do not change anything until I answer.' },
          { label: 'Add to project team', prompt: 'I want to add an employee as a project member, not assign a task. Ask which project and employee; do not change anything yet.' },
          { label: 'Mention in a comment', prompt: 'I want to mention an employee in a task comment. Ask me which task, person, and comment text; do not post it yet.' },
          { label: 'Write a task comment', prompt: 'I want to write a comment on a task. Ask me which task and what the comment should say; do not post it yet.' },
        ];
        await agent.persistConversation(conversationId, [{ role: 'user', content: message }, { role: 'assistant', content: response, toolCalls: { choices } }]);
        ok(res as any, { response, choices, conversation_id: conversationId });
        return;
      }

      // Define the available tools
      const tools: ToolDefinition[] = [
        {
          name: 'getMyAttendanceSummary',
          description: 'Return exact attendance totals for the signed-in employee. Defaults to the current month in the organisation timezone. If a date range is supplied, provide both start and end as YYYY-MM-DD. Includes record/status counts, late and absent days, checked-in days, overtime, and hours worked only when every record has hours recorded.',
          parameters: {
            type: 'object',
            properties: {
              start: { type: 'string', description: 'Inclusive start date YYYY-MM-DD; provide together with end' },
              end: { type: 'string', description: 'Inclusive end date YYYY-MM-DD; provide together with start' },
            },
            required: [],
          },
        },
        { name: 'getMyShifts', description: 'List the signed-in employee’s shift assignments and break policies.', parameters: { type: 'object', properties: {} } },
        { name: 'getMyAvailability', description: 'List the signed-in employee’s availability requests and approval status.', parameters: { type: 'object', properties: {} } },
        { name: 'getTeamAvailability', description: 'List organization availability requests for managers with shifts.availability.manage. Optional status: pending, approved, or rejected.', parameters: { type: 'object', properties: { status: { type: 'string', enum: ['pending', 'approved', 'rejected'] } } } },
        { name: 'requestShiftAvailability', description: 'Submit a preferred or unavailable time for the signed-in employee. Use a date or recurring weekday, optional time range and note. This creates a pending request and requires confirmation.', parameters: { type: 'object', properties: { kind: { type: 'string', enum: ['preferred', 'unavailable'] }, date: { type: 'string', description: 'Specific date YYYY-MM-DD; use instead of weekday' }, weekday: { type: 'integer', description: 'Recurring day 0 Monday through 6 Sunday; use instead of date' }, starts_on: { type: 'string' }, ends_on: { type: 'string' }, start_time: { type: 'string' }, end_time: { type: 'string' }, note: { type: 'string' } }, required: ['kind'] } },
        { name: 'reviewShiftAvailability', description: 'Approve or reject one exact team availability request by requestId. Requires shifts.availability.manage. Rejection requires a reason and all decisions require confirmation.', parameters: { type: 'object', properties: { requestId: { type: 'string' }, status: { type: 'string', enum: ['approved', 'rejected'] }, reason: { type: 'string' } }, required: ['requestId', 'status'] } },
        { name: 'getShiftPlanningInsights', description: 'Summarize weekly shift coverage, workload, approved leave conflicts, unavailability and off-day assignments. Requires shifts.view.', parameters: { type: 'object', properties: { weekStart: { type: 'string', description: 'Monday YYYY-MM-DD; defaults to current week' } } } },
        { name: 'requestOvertime', description: 'Submit an overtime request for the signed-in employee’s eligible attendance record only when explicitly requested.', parameters: { type: 'object', properties: { attendance_id: { type: 'string' }, reason: { type: 'string' } }, required: ['attendance_id'] } },
        { name: 'requestLeave', description: 'Submit a leave request for the signed-in user only when explicitly requested. Ask for leave type and dates, and for morning or afternoon if half-day.', parameters: { type: 'object', properties: { leave_type: { type: 'string' }, start_date: { type: 'string', description: 'YYYY-MM-DD' }, end_date: { type: 'string', description: 'YYYY-MM-DD' }, reason: { type: 'string' }, is_half_day: { type: 'boolean' }, half_day_period: { type: 'string', enum: ['morning', 'afternoon'] }, leave_start_time: { type: 'string', description: 'Timed leave start, HH:MM' }, leave_end_time: { type: 'string', description: 'Timed leave end, HH:MM' } }, required: ['leave_type', 'start_date', 'end_date'] } },
        { name: 'requestShiftSwap', description: 'Submit a shift swap for the signed-in user. Obtain assignment IDs from shift schedule and ask the user to identify both shifts and the other employee.', parameters: { type: 'object', properties: { target_id: { type: 'string' }, requester_assign_id: { type: 'string' }, target_assign_id: { type: 'string' }, reason: { type: 'string' } }, required: ['target_id', 'requester_assign_id', 'target_assign_id'] } },
        { name: 'requestAttendanceCorrection', description: 'Submit an attendance correction for the signed-in employee. Require date, reason and at least one corrected timestamp, with an explicit timezone.', parameters: { type: 'object', properties: { date: { type: 'string', description: 'YYYY-MM-DD' }, requested_check_in: { type: 'string', description: 'ISO timestamp with timezone' }, requested_check_out: { type: 'string', description: 'ISO timestamp with timezone' }, reason: { type: 'string' } }, required: ['date', 'reason'] } },
        { name: 'getMyRequests', description: 'List the signed-in employee’s recent leave, shift swaps, overtime, attendance corrections and remote-work requests, including statuses and decision reasons.', parameters: { type: 'object', properties: {} } },
        { name: 'cancelMyRequest', description: 'Cancel one of the signed-in employee’s own pending leave, shift swap, overtime, attendance correction, or remote-work requests. Call after the user explicitly asks to cancel or withdraw. If more than one pending request matches, return choices and wait for the user to select one. Never cancel another employee’s request or a request that is no longer pending.', parameters: { type: 'object', properties: { requestType: { type: 'string', enum: ['leave', 'swap', 'overtime', 'correction', 'remote'], description: 'Optional request type; omit when the user has not specified one' }, requestId: { type: 'string', description: 'Optional exact request ID, obtained from getMyRequests' } } } },
        { name: 'listShiftBreakTemplates', description: 'List organization shifts and their configured break templates. Requires shifts.view.', parameters: { type: 'object', properties: {} } },
        { name: 'createShiftBreakTemplate', description: 'Create one fixed or flexible break policy for a shift only when explicitly requested. Requires shifts.breaks.manage. Ask for missing shift, name, type, paid status and timing. Unspecified optional settings use defaults.', parameters: { type: 'object', properties: { shiftId: { type: 'string' }, name: { type: 'string' }, kind: { type: 'string', enum: ['fixed', 'flexible'] }, isPaid: { type: 'boolean' }, startTime: { type: 'string' }, endTime: { type: 'string' }, durationMinutes: { type: 'integer' }, allowedCount: { type: 'integer' }, paidWithinLimit: { type: 'boolean' }, deductExtraTime: { type: 'boolean' }, allowExtraBreaks: { type: 'boolean' }, autoStart: { type: 'boolean' }, deductIfSkipped: { type: 'boolean' }, appliesDays: { type: 'array', items: { type: 'integer' }, description: 'Weekdays 0 Sunday through 6 Saturday' }, exceptionDates: { type: 'array', items: { type: 'string' }, description: 'Specific applicable dates YYYY-MM-DD' } }, required: ['shiftId', 'name', 'kind', 'isPaid'] } },
        {
          name: 'getAttendanceRecords',
          description: 'Fetch attendance records for the org with optional user/date filter',
          parameters: {
            type: 'object',
            properties: {
              userId: { type: 'string', description: 'User ID filter' },
              start: { type: 'string', description: 'Start date (ISO)' },
              end: { type: 'string', description: 'End date (ISO)' },
              type: {
                type: 'string',
                description: 'Filter by status: check-in, check-out, leave',
              },
            },
            required: [],
          },
        },
        {
          name: 'getLeaveBalances',
          description: 'Get leave balances per user',
          parameters: {
            type: 'object',
            properties: {
              userId: { type: 'string', description: 'User ID filter' },
              leaveType: { type: 'string', description: 'Leave type filter' },
            },
            required: [],
          },
        },
        {
          name: 'getPayrollSummary',
          description: 'Get payroll summary for a period',
          parameters: {
            type: 'object',
            properties: {
              userId: { type: 'string', description: 'User ID filter' },
              start: { type: 'string', description: 'Start date (ISO YYYY)' },
              end: { type: 'string', description: 'End date (ISO YYYY)' },
            },
            required: [],
          },
        },
        {
          name: 'getShiftSchedule',
          description: 'Get upcoming shift schedule',
          parameters: {
            type: 'object',
            properties: {
              userId: { type: 'string', description: 'User ID filter' },
              start: { type: 'string', description: 'Start date (ISO)' },
              end: { type: 'string', description: 'End date (ISO)' },
              department: { type: 'string', description: 'Department filter' },
            },
            required: [],
          },
        },
        {
          name: 'searchEmployees',
          description: 'Search employees by name or email',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Search query' },
              orgId: { type: 'string', description: 'Organisation ID filter' },
            },
            required: ['query'],
          },
        },
        {
          name: 'getPendingApprovals',
          description: 'List pending approval items the signed-in user is allowed to review: leave, overtime, remote-work requests, shift swaps, late-arrival notices, attendance corrections, and expense claims. Results are permission scoped. Use this to answer how many approvals are waiting.',
          parameters: { type: 'object', properties: {} },
        },
        {
          name: 'reviewApproval',
          description: 'Approve, reject, or acknowledge one specific pending approval returned by getPendingApprovals. Requires the matching module permission. Never act on multiple items unless the user explicitly asks; rejection requires a reason. Late-arrival notices can only be acknowledged.',
          parameters: { type: 'object', properties: {
            type: { type: 'string', enum: ['leave', 'overtime', 'remote', 'swap', 'late_notice', 'attendance_correction', 'expense'] },
            id: { type: 'string', description: 'Approval item ID from getPendingApprovals' },
            action: { type: 'string', enum: ['approve', 'reject', 'acknowledge'] },
            reason: { type: 'string', description: 'Required reason for reject; at least 5 characters' },
            note: { type: 'string', description: 'Optional reviewer note for approvals that support it' },
          }, required: ['type', 'id', 'action'] },
        },
        {
          name: 'listMyProjects',
          description: 'List projects the signed-in user can access, with project status, deadlines, task totals, status counts, milestone counts, and overdue work. Use this without asking for a project ID when the user asks what projects they have or requests a general project summary.',
          parameters: { type: 'object', properties: {} },
        },
        {
          name: 'createProject',
          description: 'Create a project with optional description, dates, priority, and active organisation members. Requires projects.manage permission.',
          parameters: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] }, startDate: { type: 'string', description: 'YYYY-MM-DD' }, dueDate: { type: 'string', description: 'YYYY-MM-DD' }, memberIds: { type: 'array', items: { type: 'string' } } }, required: ['name'] },
        },
        {
          name: 'updateProjectDetails',
          description: 'Update explicitly requested project metadata, status, dates, priority, or task status options. Requires projects.manage permission. Do not change fields the user did not request.',
          parameters: {
            type: 'object',
            properties: {
              projectId: { type: 'string', description: 'Project ID' },
              name: { type: 'string', description: 'New project name' },
              description: { type: 'string', description: 'New project description' },
              priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
              status: { type: 'string', enum: ['planning', 'active', 'on_hold', 'completed', 'cancelled'] },
              startDate: { type: 'string', description: 'YYYY-MM-DD, or empty string to clear' },
              dueDate: { type: 'string', description: 'YYYY-MM-DD, or empty string to clear' },
              statusOptions: { type: 'array', items: { type: 'string' }, description: 'Unique lowercase status keys including todo; currently used statuses must remain' },
            },
            required: ['projectId'],
          },
        },
        {
          name: 'getProjectTasks',
          description: 'Read an accessible project, members, file metadata, task comments, milestones, owners, dates, priorities, statuses, subtasks, and dependencies.',
          parameters: { type: 'object', properties: { projectId: { type: 'string', description: 'Project ID' } }, required: ['projectId'] },
        },
        {
          name: 'manageProjectMember',
          description: 'Add or remove an active organisation employee from a project. Requires projects.manage. A member with assigned tasks cannot be removed until those tasks are reassigned or unassigned; the owner cannot be removed.',
          parameters: { type: 'object', properties: { projectId: { type: 'string' }, userId: { type: 'string' }, action: { type: 'string', enum: ['add', 'remove'] } }, required: ['projectId', 'userId', 'action'] },
        },
        {
          name: 'getProjectActivity',
          description: 'Read the latest 50 audit events for an accessible project and its tasks.',
          parameters: { type: 'object', properties: { projectId: { type: 'string' } }, required: ['projectId'] },
        },
        {
          name: 'createProjectTask',
          description: 'Create a task in a project. Use only when the user explicitly asks you to create or add a task. Requires project task management permission.',
          parameters: {
            type: 'object',
            properties: {
              projectId: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' },
              assigneeId: { type: 'string' }, priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
              startDate: { type: 'string', description: 'Start date in YYYY-MM-DD format' }, dueDate: { type: 'string', description: 'Due date in YYYY-MM-DD format' },
              status: { type: 'string', description: 'A status configured in this project' }, isMilestone: { type: 'boolean' }, parentTaskId: { type: 'string', description: 'Optional parent task ID for a subtask' },
              dependsOnTaskId: { type: 'string', description: 'Optional task ID this task depends on' },
            },
            required: ['projectId', 'title'],
          },
        },
        {
          name: 'createProjectTasks',
          description: 'Create 1 to 5 related tasks in one project when the user asks you to derive useful tasks from a project goal or description. Provide detailed, actionable descriptions. Do not invent assignees or dates. Requires projects.tasks.manage permission.',
          parameters: {
            type: 'object',
            properties: {
              projectId: { type: 'string' },
              tasks: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    title: { type: 'string' }, description: { type: 'string' },
                    priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
                    assigneeId: { type: 'string' }, startDate: { type: 'string' }, dueDate: { type: 'string' },
                    status: { type: 'string' }, isMilestone: { type: 'boolean' }, parentTaskId: { type: 'string' }, dependsOnTaskId: { type: 'string' },
                  },
                  required: ['title', 'description', 'priority'],
                },
              },
            },
            required: ['projectId', 'tasks'],
          },
        },
        {
          name: 'updateProjectTaskStatus',
          description: 'Change a task status after the user explicitly asks. The status must be configured for the task project. Managers or the assigned employee may change it.',
          parameters: {
            type: 'object', properties: { taskId: { type: 'string' }, status: { type: 'string' } }, required: ['taskId', 'status'],
          },
        },
        {
          name: 'updateProjectTask',
          description: 'Update requested fields on an existing task. Requires projects.tasks.manage for all edits; an assigned employee may only change their own task status. Assignee must be a project member. Use empty assigneeId or empty date to clear those fields.',
          parameters: { type: 'object', properties: {
            taskId: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
            status: { type: 'string' }, assigneeId: { type: 'string', description: 'Project member ID, or empty string to unassign' },
            startDate: { type: 'string', description: 'YYYY-MM-DD, or empty string to clear' }, dueDate: { type: 'string', description: 'YYYY-MM-DD, or empty string to clear' },
            isMilestone: { type: 'boolean' }, dependsOnTaskIds: { type: 'array', items: { type: 'string' } },
          }, required: ['taskId'] },
        },
        {
          name: 'addProjectTaskComment',
          description: 'Add one comment or note to an accessible task. Project managers, members, owners, and task assignees may comment. Mention project members by full @Name; mentions and task assignee receive notifications. If a similar comment exists, ask first; set allowDuplicate true only after the user explicitly selects “Post another comment anyway”.',
          parameters: { type: 'object', properties: { taskId: { type: 'string' }, body: { type: 'string', description: 'Comment text, up to 5000 characters' }, allowDuplicate: { type: 'boolean', description: 'Use true only after the user explicitly confirmed posting a similar comment again' } }, required: ['taskId', 'body'] },
        },
      ];

      // Build system prompt with tool definitions
      const systemPrompt = await agent.buildSystemPrompt(tools);

      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) throw new Error('AI service not configured (GEMINI_API_KEY missing)');

      const axios = await import('axios');
      const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      const contents: any[] = messages
        .filter(message => (message.role === 'user' || message.role === 'assistant') && message.content?.trim())
        .map(message => ({ role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: message.content }] }));
      const functionDeclarations = tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
      const callGemini = async () => {
        const response = await axios.default.post(endpoint, {
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents,
          tools: [{ functionDeclarations }],
          generationConfig: { maxOutputTokens: 2048 },
        }, {
          headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
          timeout: 120000,
        });
        return response.data?.candidates?.[0]?.content;
      };

      let assistantText = '';
      let assistantChoices: Array<{ label: string; prompt: string }> | undefined;
      const toolResults = new Map<string, Awaited<ReturnType<typeof agent.executeTool>>>();
      const completedChanges: string[] = [];
      const writeTools = AI_WRITE_TOOLS;
      const canonicalize = (value: any): any => Array.isArray(value)
        ? value.map(canonicalize)
        : value && typeof value === 'object'
          ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]))
          : value;
      // Allow a few sequential tool rounds so Gemini can inspect, act, and summarize.
      for (let round = 0; round < 4; round++) {
        const modelContent = await callGemini();
        if (!modelContent?.parts?.length) throw new Error('Gemini returned an empty response');
        const functionCalls = modelContent.parts.filter((part: any) => part.functionCall?.name)
          .sort((left: any, right: any) => Number(right.functionCall.name === 'searchEmployees') - Number(left.functionCall.name === 'searchEmployees'));
        assistantText = modelContent.parts.map((part: any) => part.text || '').filter(Boolean).join('\n');
        if (!functionCalls.length) break;

        contents.push(modelContent);
        const functionResponses = [];
        for (const part of functionCalls) {
          const call = part.functionCall;
          const args = call.args || {};
          if (call.name === 'requestLeave') {
            const validation = leaveRequestSchema.safeParse(args);
            if (!validation.success) {
              functionResponses.push({ functionResponse: { name: call.name, response: { result: { error: `Leave request needs valid details: ${validation.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}. Ask the user for the missing information.` } } } });
              continue;
            }
          }
          if (call.name === 'reviewShiftAvailability' && args.status === 'rejected' && !String(args.reason ?? '').trim()) {
            assistantText = 'Please provide a rejection reason before I prepare this availability decision. I have not changed the request.';
            assistantChoices = [{ label: 'Provide a reason', prompt: 'Ask me to provide the reason for rejecting this availability request. Do not change the request yet.' }];
            break;
          }
          if (writeTools.has(call.name) && !explicitlyRequestedWrite(call.name, args, message)) {
            if (call.name === 'cancelMyRequest') {
              assistantText = 'I can cancel your own pending leave, shift swap, overtime, attendance correction, or remote-work request. Tell me which type to cancel; if more than one pending request matches, I will ask you to choose. I have not changed anything.';
              break;
            }
            if (['requestLeave', 'requestShiftSwap', 'requestAttendanceCorrection', 'requestOvertime', 'createShiftBreakTemplate', 'requestShiftAvailability', 'reviewShiftAvailability'].includes(call.name)) {
              const choices: AiChoice[] = [{ label: 'Confirm action', prompt: 'Confirm the proposed action' }, { label: 'Cancel', prompt: 'Cancel the proposed action. Do not make any changes.' }];
              const actionNames: Record<string, string> = { requestLeave: 'Submit leave request', requestShiftSwap: 'Submit shift swap request', requestAttendanceCorrection: 'Submit attendance correction', requestOvertime: 'Submit overtime request', createShiftBreakTemplate: 'Create shift break template', requestShiftAvailability: 'Submit availability request', reviewShiftAvailability: 'Review availability request' };
              const details = Object.entries(args).map(([key, value]) => `- **${key.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ')}:** ${Array.isArray(value) ? value.join(', ') : String(value)}`).join('\n');
              const response = `Please review and confirm: **${actionNames[call.name]}**\n\n${details}`;
              await agent.persistConversation(conversationId, [{ role: 'user', content: message }, { role: 'assistant', content: response, toolCalls: { choices, pendingAction: { name: call.name, args } } }]);
              ok(res as any, { response, choices, conversation_id: conversationId });
              return;
            }
            assistantText = 'I did not make that change. I only apply project or task changes explicitly requested in your latest message; earlier messages do not authorize new changes.';
            assistantChoices = clarificationChoices(call.name, args);
            break;
          }
          if (writeTools.has(call.name)) {
            const isDecision = call.name === 'reviewApproval' || call.name === 'reviewShiftAvailability';
            const actionLabel = isDecision ? 'Confirm decision' : 'Confirm action';
            const choices: AiChoice[] = [
              { label: actionLabel, prompt: 'Confirm the proposed action' },
              { label: 'Cancel', prompt: 'Cancel the proposed action. Do not make any changes.' },
            ];
            const actionNames: Record<string, string> = {
              requestLeave: 'Submit leave request',
              requestShiftSwap: 'Submit shift swap request',
              requestAttendanceCorrection: 'Submit attendance correction',
              requestOvertime: 'Submit overtime request',
              createShiftBreakTemplate: 'Create shift break template',
              requestShiftAvailability: 'Submit availability request',
              reviewShiftAvailability: args.status === 'approved' ? 'Approve availability request' : 'Reject availability request',
              cancelMyRequest: 'Cancel request',
              reviewApproval: `${String(args.action ?? 'Review')} ${String(args.type ?? 'approval')} request`,
              createProject: 'Create project',
              updateProjectDetails: 'Update project details',
              manageProjectMember: args.action === 'remove' ? 'Remove project member' : 'Add project member',
              createProjectTask: 'Create project task',
              createProjectTasks: 'Create project tasks',
              updateProjectTaskStatus: 'Update task status',
              updateProjectTask: 'Update project task',
              addProjectTaskComment: 'Post task comment',
            };
            const details = Object.entries(args)
              .map(([key, value]) => {
                const displayValue = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
                return `- **${key.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ')}:** ${displayValue}`;
              })
              .join('\n');
            const response = `Please review before I continue: **${actionNames[call.name] ?? 'Requested change'}**\n\n${details}\n\nNo change has been made yet.`;
            await agent.persistConversation(conversationId, [
              { role: 'user', content: message },
              { role: 'assistant', content: response, toolCalls: { choices, pendingAction: { name: call.name, args } } },
            ]);
            ok(res as any, { response, choices, conversation_id: conversationId });
            return;
          }
          const signature = `${call.name}:${JSON.stringify(canonicalize(args))}`;
          let result = toolResults.get(signature);
          if (!result) {
            try {
              result = await agent.executeTool(call.name, args);
            } catch (error) {
              logger.error({ err: error, userId: req.user!.sub, orgId, conversationId, tool: call.name }, 'AI tool failed');
              result = { name: call.name, success: false, error: error instanceof AppError ? error.message : 'The request could not be completed. Check the details and try again.' };
            }
            toolResults.set(signature, result);
          }

          if (call.name === 'searchEmployees' && Array.isArray(result.data) && result.data.length > 1
            && /\b(assign|mention|tag|add.{0,40}(member|comment)|comment.{0,40}(mention|tag))\b/i.test(message)) {
            const query = String(args.query ?? '').trim().toLocaleLowerCase();
            const exactMatches = result.data.filter((person: any) => person.name?.toLocaleLowerCase() === query || person.email?.toLocaleLowerCase() === query);
            if (exactMatches.length !== 1) {
              assistantText = `I found several people matching “${args.query}”. Choose the right person before I make the requested change.`;
              assistantChoices = result.data.slice(0, 8).map((person: any) => ({
                label: `${person.name}${person.jobTitle ? ` · ${person.jobTitle}` : ''} · ${person.email}`,
                prompt: `Use ${person.name} (${person.email}) for my previous task request. Continue it once, and do not repeat any comments or updates already made.`,
              }));
              break;
            }
          }

          if (result.choices?.length) {
            assistantText = result.error || 'I need you to choose an option before I continue.';
            assistantChoices = result.choices;
            break;
          }
          if (!toolResults.has(`counted:${signature}`) && result.success && writeTools.has(call.name)) {
            toolResults.set(`counted:${signature}`, result);
            const action = call.name === 'requestOvertime' ? 'Submitted the overtime request' : call.name === 'requestLeave' ? 'Submitted the leave request' : call.name === 'requestShiftSwap' ? 'Submitted the shift swap request' : call.name === 'requestAttendanceCorrection' ? 'Submitted the attendance correction request' : call.name === 'requestShiftAvailability' ? 'Submitted the availability request' : call.name === 'reviewShiftAvailability' ? 'Reviewed the availability request' : call.name === 'createShiftBreakTemplate' ? 'Created the shift break template'
              : call.name === 'cancelMyRequest' ? 'Cancelled the pending request'
              : call.name === 'reviewApproval' ? 'Reviewed the approval request'
              : call.name === 'addProjectTaskComment' ? 'Added the task comment'
              : call.name === 'updateProjectTask' || call.name === 'updateProjectTaskStatus' ? 'Updated the task'
                : call.name === 'manageProjectMember' ? 'Updated project membership'
                  : call.name === 'createProjectTask' || call.name === 'createProjectTasks' ? 'Created project task(s)'
                    : call.name === 'createProject' ? 'Created the project' : 'Updated project details';
            completedChanges.push(action);
          }
          functionResponses.push({ functionResponse: { name: call.name, response: { result: result.success ? result.data : { error: result.error } } } });
        }
        if (assistantChoices?.length) break;
        contents.push({ role: 'user', parts: functionResponses });
        if (round === 3) assistantText = completedChanges.length
          ? `${[...new Set(completedChanges)].join('. ')}. The requested changes were applied once.`
          : 'I checked the available information but could not finish the response. Please ask me to continue.';
      }

      const newMessages = messages.slice(conv?.messages?.length ?? 0);
      await agent.persistConversation(conversationId, [...newMessages, { role: 'assistant', content: assistantText, ...(assistantChoices?.length ? { toolCalls: { choices: assistantChoices } } : {}) }]);
      logger.info({ userId: req.user!.sub, orgId, conversationId, toolCalls: toolResults.size, writes: completedChanges.length }, 'AI request completed');
      ok(res as any, { response: assistantText, conversation_id: conversationId, ...(assistantChoices?.length ? { choices: assistantChoices } : {}) });
    } catch (e) {
      logger.error({ err: e, userId: req.user?.sub, orgId: req.user?.org_id, conversationId: req.body?.conversation_id }, 'AI request failed');
      const providerError = e as { isAxiosError?: boolean; code?: string; message?: string; response?: { status?: number; data?: { error?: { message?: string } } } };
      if (providerError?.isAxiosError) {
        logger.error({
          code: providerError.code,
          status: providerError.response?.status,
          message: providerError.response?.data?.error?.message || providerError.message,
          userId: req.user?.sub,
          orgId: req.user?.org_id,
          conversationId: req.body?.conversation_id,
        }, 'Gemini request failed');
        const timedOut = providerError.code === 'ECONNABORTED' || providerError.code === 'ETIMEDOUT';
        return next(new AppError(
          timedOut ? 'Gemini took too long to respond. Please try again.' : 'Gemini could not complete the request. Please try again.',
          timedOut ? 504 : 502,
          'AI_PROVIDER_ERROR',
        ));
      }
      next(e);
    }
  }
);

export const aiRouter = router;
