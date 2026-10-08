const API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MAX_TOKENS = 32768;

export interface LlmResult {
  fullText: string;
  fullReasoning: string;
  parsedToolUses: ParsedToolUse[];
  stopReason: string;
  usage: { input_tokens: number; output_tokens: number };
}

export interface ParsedToolUse {
  id: string;
  name: string;
  input: Record<string, any>;
  rawArguments?: string;
}

interface ToolUseAccumulator {
  id?: string;
  name?: string;
  argumentsJson: string;
  parsedInput?: Record<string, any>;
}

export type LlmEvent =
  | { type: 'llm_request'; model: string; maxTokens: number; system: string; messages: Record<string, any>[]; tools: Record<string, any>[] }
  | { type: 'llm_text'; text: string }
  | { type: 'llm_reasoning'; text: string }
  | { type: 'llm_tool_call'; name: string; input: Record<string, any> }
  | { type: 'llm_response'; stopReason: string; usage: { input_tokens: number; output_tokens: number }; content: Record<string, any>[] };

export class LlmClient {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async *stream(
    model: string,
    system: string,
    messages: Record<string, any>[],
    tools: Record<string, any>[],
    reasoning: Record<string, any> | null,
    result: LlmResult,
    maxTokens: number = DEFAULT_MAX_TOKENS,
  ): AsyncGenerator<LlmEvent> {
    yield { type: 'llm_request', model, maxTokens, system, messages, tools };

    const body = this.buildRequestBody(model, system, messages, tools, maxTokens, reasoning);

    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
        'HTTP-Referer': 'https://github.com/lifeos',
        'X-Title': 'lifeos',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`LLM API error ${response.status}: ${errorBody}`);
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const toolAccumulators: ToolUseAccumulator[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6).trim();
        if (data === '[DONE]') break;

        try {
          const node = JSON.parse(data);
          yield* this.onChunk(node, result, toolAccumulators);
        } catch {
          // ignore parse errors
        }
      }
    }

    // Finalize tool uses and emit tool call events (once, after full stream)
    for (const acc of toolAccumulators) {
      if (acc.id && acc.name) {
        if (!acc.parsedInput) {
          try {
            acc.parsedInput = acc.argumentsJson ? JSON.parse(acc.argumentsJson) : {};
          } catch {
            acc.parsedInput = {};
          }
        }
        result.parsedToolUses.push({ id: acc.id!, name: acc.name!, input: acc.parsedInput ?? {}, rawArguments: acc.argumentsJson });
        yield { type: 'llm_tool_call', id: acc.id!, name: acc.name!, input: acc.parsedInput ?? {} };
      }
    }

    if (!result.usage) result.usage = { input_tokens: 0, output_tokens: 0 };

    const content: Record<string, any>[] = [];
    if (result.fullText) content.push({ type: 'text', text: result.fullText });
    for (const tu of result.parsedToolUses) {
      content.push({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input });
    }

    yield {
      type: 'llm_response',
      stopReason: result.stopReason ?? 'end_turn',
      usage: result.usage,
      content,
    };
  }

  /** Blocking convenience method used by session summarizer */
  async streamBlocking(
    model: string,
    system: string,
    messages: Record<string, any>[],
    maxTokens: number = 1024,
  ): Promise<string> {
    const result = newLlmResult();
    for await (const _ of this.stream(model, system, messages, [], null, result, maxTokens)) {
      // drain
    }
    return result.fullText;
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private *onChunk(
    node: any,
    result: LlmResult,
    toolAccumulators: ToolUseAccumulator[],
  ): Generator<LlmEvent> {
    // Usage chunk
    if (node.usage && !node.usage.prompt_tokens === undefined) {
      // handled below
    }
    if (node.usage) {
      result.usage = {
        input_tokens: node.usage.prompt_tokens ?? 0,
        output_tokens: node.usage.completion_tokens ?? 0,
      };
    }

    const choices = node.choices;
    if (!Array.isArray(choices) || choices.length === 0) return;

    const choice = choices[0];
    const delta = choice.delta;

    if (delta?.content != null) {
      const text = String(delta.content);
      if (text) {
        result.fullText += text;
        yield { type: 'llm_text', text };
      }
    }

    // Reasoning (DeepSeek R1 / OpenRouter extended thinking)
    const reasoningText = delta?.reasoning ?? delta?.reasoning_content;
    if (reasoningText != null) {
      const text = String(reasoningText);
      if (text) {
        result.fullReasoning += text;
        yield { type: 'llm_reasoning', text };
      }
    }

    // Tool calls streamed incrementally
    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        const index = tc.index ?? 0;
        while (toolAccumulators.length <= index) toolAccumulators.push({ argumentsJson: '' });
        const acc = toolAccumulators[index]!;
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.name = tc.function.name;
        if (tc.function?.arguments) acc.argumentsJson += tc.function.arguments;
      }
    }

    const finishReason = choice.finish_reason;
    if (finishReason === 'tool_calls') {
      result.stopReason = 'tool_use';
    } else if (finishReason === 'stop') {
      result.stopReason = 'end_turn';
    } else if (finishReason && finishReason !== 'null') {
      result.stopReason = finishReason;
    }
  }

  private buildRequestBody(
    model: string,
    system: string,
    messages: Record<string, any>[],
    tools: Record<string, any>[],
    maxTokens: number,
    reasoning: Record<string, any> | null,
  ): Record<string, any> {
    const allMessages = [
      { role: 'system', content: system },
      ...messages.map((m) => {
        const filtered: Record<string, any> = {};
        for (const [k, v] of Object.entries(m)) {
          if (!k.startsWith('_')) filtered[k] = v;
        }
        return filtered;
      }),
    ];

    const body: Record<string, any> = {
      model,
      messages: allMessages,
      max_tokens: maxTokens,
      stream: true,
      stream_options: { include_usage: true },
      plugins: [{ id: 'context-compression', max_middle_tokens: 8192 }],
    };

    if (tools.length > 0) {
      const hasWebSearch = tools.some((t) => t.name === 'web_search');
      const functionTools = tools
        .filter((t) => t.name !== 'web_search')
        .map((t) => ({
          type: 'function',
          function: {
            name: t.name,
            description: t.description,
            parameters: t.input_schema,
          },
        }));
      body.tools = [
        ...(hasWebSearch ? [{ type: 'openrouter:web_search', parameters: { engine: 'exa' } }] : []),
        ...functionTools,
      ];
    }

    if (reasoning) body.reasoning = reasoning;

    return body;
  }
}

export function newLlmResult(): LlmResult {
  return {
    fullText: '',
    fullReasoning: '',
    parsedToolUses: [],
    stopReason: '',
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}
