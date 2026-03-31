import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { McpServerConfig } from '../../config.js';
import type { ToolDefinition } from '../../agent/types.js';

/**
 * Connects to configured MCP server subprocesses at startup, discovers their tools,
 * and proxies tool calls. Tools are exposed with the prefix mcp_{serverName}_{toolName}.
 */
export class McpToolsClient {
  private readonly allTools: ToolDefinition[] = [];
  private readonly toolClients = new Map<string, Client>();
  private readonly toolOriginalNames = new Map<string, string>();
  private readonly clients: Client[] = [];

  async init(servers: McpServerConfig[]): Promise<void> {
    for (const server of servers) {
      try {
        const transport = new StdioClientTransport({
          command: server.command,
          args: server.args ?? [],
          env: server.env ?? {},
        });
        const client = new Client({ name: 'lifeos', version: '1.0' }, { capabilities: {} });
        await client.connect(transport);
        this.clients.push(client);

        const { tools } = await client.listTools();
        for (const tool of tools) {
          const prefixedName = `mcp_${server.name}_${tool.name}`;
          this.allTools.push({
            name: prefixedName,
            description: tool.description ?? '',
            input_schema: (tool.inputSchema ?? { type: 'object', properties: {} }) as Record<string, any>,
          });
          this.toolClients.set(prefixedName, client);
          this.toolOriginalNames.set(prefixedName, tool.name);
        }
        console.log(`[McpToolsClient] Registered ${tools.length} tools from server '${server.name}'`);
      } catch (err: any) {
        console.warn(`[McpToolsClient] Failed to connect to server '${server.name}': ${err?.message}`);
      }
    }
  }

  getTools(): ToolDefinition[] {
    return [...this.allTools];
  }

  async callTool(prefixedName: string, input: Record<string, any>): Promise<Record<string, any>> {
    const client = this.toolClients.get(prefixedName);
    const originalName = this.toolOriginalNames.get(prefixedName);
    if (!client || !originalName) return { error: `Unknown MCP tool: ${prefixedName}` };
    try {
      const result = await client.callTool({ name: originalName, arguments: input ?? {} });
      const text = (result.content as any[])
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text as string)
        .join('\n');
      return { result: text };
    } catch (err: any) {
      return { error: err?.message ?? 'MCP tool call failed' };
    }
  }

  async shutdown(): Promise<void> {
    for (const client of this.clients) {
      try { await client.close(); } catch { /* ignore */ }
    }
  }
}
