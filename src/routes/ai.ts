import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { aiChatBodySchema } from '../schemas/ai';
import { AiAgent, ToolDefinition } from '../services/ai/agent';
import { PrismaClient } from '@prisma/client';
import { requirePermission } from '../middleware/auth';
import { ok } from '../utils/response';

const router = Router();

interface AiReq {
  user?: { sub: string; org_id: string };
  body: any;
}

/** POST /api/v1/ai/chat */
router.post(
  '/chat',
  authenticate,
  requirePermission('analytics.ai_chat'),
  validate({ body: aiChatBodySchema }),
  async (req: AiReq, res, next) => {
    try {
      const prisma = new PrismaClient();
      const orgId = req.user!.org_id;
      const agent = new AiAgent(prisma, orgId);

      const { message, conversation_id } = req.body;

      // Use existing conversation or create new one
      let conversationId = conversation_id;
      if (!conversationId) {
        const conv = await prisma.aiConversation.create({
          data: { orgId, messages: [] as any },
        });
        conversationId = conv.id;
      }

      // Load existing messages
      const conv = await agent.loadConversation(conversationId);
      let messages: Array<{ role: string; content: string; tool_calls: any }> = [];
      if (conv && conv.messages) {
        messages = conv.messages;
      }

      // Add user message
      messages.push({ role: 'user', content: message, tool_calls: undefined });

      // Define the available tools
      const tools: ToolDefinition[] = [
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
      ];

      // Build system prompt with tool definitions
      const systemPrompt = agent.buildSystemPrompt(tools);

      const axios = await import('axios');
      const apiKey = process.env.ANTHROPIC_API_KEY;

      if (!apiKey) {
        await prisma.$disconnect();
        throw new Error('AI service not configured (ANTHROPIC_API_KEY missing)');
      }

      const anthropicMessages = messages.map(m => ({
        role: m.role,
        content: m.content,
      }));

      const res = await axios.default.post(
        'https://api.anthropic.com/v1/messages',
        {
          model: process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20240620',
          max_tokens: 1024,
          temperature: 0,
          system: systemPrompt,
          messages: anthropicMessages,
          tools,
          tool_choice: 'auto',
        },
        {
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
        }
      );

      const assistantText = res.data.content?.[0]?.text || '';
      const toolUseBlocks = res.data.content?.filter(
        (c: any) => c.type === 'tool_use'
      ) || [];

      // Handle tool calls
      let toolResults: any[] = [];
      if (toolUseBlocks.length > 0) {
        for (const block of toolUseBlocks) {
          const toolName = block.name;
          const toolArgs = block.input || {};
          const toolId = block.id;

          const result = await agent.executeTool(toolName, toolArgs);
          toolResults.push({
            toolId,
            toolName,
            success: result.success,
            data: result.data,
            error: result.error,
          });

          // Add tool response to messages
          messages.push({
            role: 'user',
            content: JSON.stringify({
              tool: toolName,
              id: toolId,
              result: result.success ? result.data : result.error,
            }),
            tool_calls: undefined,
          });
        }

        // Get final response after tool use
        const finalAnthropicMessages = [...messages];

        const finalRes = await axios.default.post(
          'https://api.anthropic.com/v1/messages',
          {
            model: process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20240620',
            max_tokens: 1024,
            temperature: 0,
            system: systemPrompt,
            messages: finalAnthropicMessages,
            tool_choice: 'auto',
          },
          {
            headers: {
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01',
              'content-type': 'application/json',
            },
          }
        );

        const finalText = finalRes.data.content?.[0]?.text || '';

        // Persist conversation
        await agent.persistConversation(conversationId, messages.map(m => ({
          role: m.role,
          content: m.content,
          tool_calls: m.tool_calls,
        })));

        await prisma.$disconnect();

ok(res as any, {
          response: finalText,
          conversation_id: conversationId,
        });
      } else {
        // No tool calls, just return the assistant response
        await agent.persistConversation(conversationId, messages.map(m => ({
          role: m.role,
          content: m.content,
          tool_calls: m.tool_calls,
        })));

        await prisma.$disconnect();

        ok(res as any, {
          response: assistantText,
          conversation_id: conversationId,
        });
      }
    } catch (e) {
      next(e);
    }
  }
);

export const aiRouter = router;