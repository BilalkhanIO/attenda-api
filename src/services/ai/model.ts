// @ts-nocheck
import { PrismaClient } from '@prisma/client';
import { AiAgent } from './agent';
import { ok, AppError } from '../utils/response';

export interface ModelConfig {
  model: string;
  maxTokens?: number;
  temperature?: number;
}

export class ModelWrapper {
  private prisma: PrismaClient;
  private orgId: string;

  constructor(prisma: PrismaClient, orgId: string) {
    this.prisma = prisma;
    this.orgId = orgId;
  }

  /** Call transformers.js small agentic modal */
  async chat(
    conversationId: string,
    userMessage: string,
    tools: any[],
    model: string = 'meta-llama/Meta-Llama-3.1-8B-Instruct'
  ): Promise<{ response: string; conversationId: string; toolResults?: any[] }> {
    const agent = new AiAgent(this.prisma, this.orgId);

    // Load existing conversation
    const conv = await agent.loadConversation(conversationId);
    const messages: Array<{ role: string; content: string; tool_calls: any }> = conv?.messages || [];

    // Add user message
    messages.push({ role: 'user', content: userMessage, tool_calls: undefined });

    // Construct the full conversation object for transformers.js
    const conversation = {
      messages: messages.map(m => ({
        role: m.role,
        content: m.content,
      })),
      system: await agent.buildSystemPrompt(tools),
      tools: tools,
    };

    try {
      const { pipeline } = await import('@huggingface/transformers');

      // Run the small agentic modal using transformers.js
      // The pipeline handles text generation with the specified model
      const result = await pipeline('text-generation', {
        model: model,
        messages: conversation.messages,
        system: conversation.system,
        tools: conversation.tools,
        temperature: 0.0,
        max_new_tokens: 1024,
      });

      // Extract the assistant's response
      const assistantResponse = result[0]?.generated_text || '';

      // Check if the model requested tool use
      const toolUseBlocks = result[0]?.tool_use_blocks || [];

      let toolResults: any[] = [];

      if (toolUseBlocks && toolUseBlocks.length > 0) {
        // Process tool calls from the model
        for (const block of toolUseBlocks) {
          const toolName = block.name;
          const toolArgs = block.input || {};

          // Execute the tool through the agent
          const result = await agent.executeTool(toolName, toolArgs);
          toolResults.push({
            toolId: block.id,
            toolName,
            success: result.success,
            data: result.data,
            error: result.error,
          });

          // Add tool response to conversation messages
          messages.push({
            role: 'user',
            content: JSON.stringify({
              tool: toolName,
              id: block.id,
              result: result.success ? result.data : result.error,
            }),
            tool_calls: undefined,
          });
        }

        // Get the final assistant response after tool use
        const finalConversation = {
          messages: messages.map(m => ({
            role: m.role,
            content: m.content,
          })),
          system: await agent.buildSystemPrompt(tools),
          tools: tools,
        };

        const finalResult = await pipeline('text-generation', {
          model: model,
          messages: finalConversation.messages,
          system: finalConversation.system,
          tools: finalConversation.tools,
          temperature: 0.0,
          max_new_tokens: 1024,
        });

        const finalText = finalResult[0]?.generated_text || '';

        // Persist the full conversation to database
        await agent.persistConversation(conversationId, messages);

        return { response: finalText, conversationId: conversationId, toolResults };
      } else {
        // No tool calls - just return the assistant response
        await agent.persistConversation(conversationId, messages);
        return { response: assistantResponse, conversationId: conversationId };
      }
    } catch (e: any) {
      console.error('Transformers.js chat error:', e.message);
      throw new AppError(e.message || 'Model execution error', 500, 'MODEL_ERROR');
    }
  }
}
