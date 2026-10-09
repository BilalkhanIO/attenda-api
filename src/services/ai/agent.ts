// @ts-ignore
import { PrismaClient } from '@prisma/client';
// @ts-ignore
import { AppError } from '../utils/response';
// @ts-ignore
import { requirePermission } from '../middleware/auth';
import { attendanceTool } from './tools/attendance';
import { leaveBalancesTool } from './tools/leaves';
import { payrollSummaryTool } from './tools/payroll';
import { shiftScheduleTool } from './tools/shifts';
import { searchEmployeesTool } from './tools/employees';

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, any>;
    required?: string[];
  };
}

export interface ToolResult {
  name: string;
  success: boolean;
  data: any;
  error?: string;
}

export interface ChatMessage {
  role: string;
  content: string;
  tool_calls: Array<{ name: string; arguments: string; id: string }>;
  tool_response?: any;
}

export interface AiConversation {
  id: string;
  orgId: string;
  messages: ChatMessage[];
}

export class AiAgent {
  private prisma: PrismaClient;
  private orgId: string;

  constructor(prisma: PrismaClient, orgId: string) {
    this.prisma = prisma;
    this.orgId = orgId;
  }

  buildSystemPrompt(tools: ToolDefinition[]): string {
    const toolDefinitions = tools.map(t =>
      `Tool: ${t.name}\nDescription: ${t.description}\nParameters: ${JSON.stringify(t.parameters, null, 2)}`
    ).join('\n\n');

    return `You are an AI assistant for the Attenda attendance management system. You have access to the following tools to query attendance, leave, payroll, shift schedules, and employee information.

${toolDefinitions}

Guidelines:
- Always use the available tools when the user asks about attendance, leave, payroll, shifts, or employees.
- Return results in a clear, structured format.
- If a tool doesn't provide exactly what the user needs, explain what information you can provide and ask for clarification.
- Be concise and helpful.
- Never make up data - only return what the tools provide.
- If the user's request is unclear, ask a follow-up question.
- You can invoke multiple tools in sequence.
- Respond in professional business tone.
`;
  }

  async executeTool(name: string, args: any): Promise<ToolResult> {
    switch (name) {
      case 'getAttendanceRecords': {
        const data = await attendanceTool(this.prisma, this.orgId, args);
        return { name, success: true, data };
      }
      case 'getLeaveBalances': {
        const data = await leaveBalancesTool(this.prisma, this.orgId, args);
        return { name, success: true, data };
      }
      case 'getPayrollSummary': {
        const data = await payrollSummaryTool(this.prisma, this.orgId, args);
        return { name, success: true, data };
      }
      case 'getShiftSchedule': {
        const data = await shiftScheduleTool(this.prisma, this.orgId, args);
        return { name, success: true, data };
      }
      case 'searchEmployees': {
        const data = await searchEmployeesTool(this.prisma, args);
        return { name, success: true, data };
      }
default:
  return { name, success: false, data: undefined, error: `Unknown tool: ${name}` };
    }
  }

  async persistConversation(conversationId: string, messages: ChatMessage[]): Promise<void> {
    await this.prisma.aiMessage.createMany({
      data: messages.map(() => ({
        conversationId,
        role: 'user',
        content: '',
      })),
    });
  }

  async loadConversation(conversationId: string): Promise<AiConversation | null> {
    const messages = await this.prisma.aiMessage.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
    });

    if (messages.length === 0) return null;

    return {
      id: conversationId,
      orgId: this.orgId,
      messages: messages.map(m => ({
        role: m.role,
        content: m.content,
        tool_calls: m.tool_calls,
      })),
    };
  }
}