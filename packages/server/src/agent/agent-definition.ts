export interface ToolsFilter {
  mode: string;       // "include" | "exclude"
  names: string[];
}

export interface RecurringTask {
  name: string;
  promptFile: string;
  cadenceHours: number;
  disabled: boolean;
}

export interface AgentReasoning {
  effort?: string;
  maxTokens?: number;
}

export interface AgentDefinition {
  name: string;
  title: string;
  description: string;
  goal: string | null;
  promptBase: string;
  manager: string | null;
  identity: string[];
  tools: ToolsFilter | null;
  disabledModes: Set<string>;
  recurringTasks: RecurringTask[];
  subscribedTopics: string[];
  model: string | null;
  backgroundModel: string | null;
  reasoning: AgentReasoning | null;
}

export function parseAgentDefinition(
  map: Record<string, any>,
  promptBase: string
): AgentDefinition {
  const name = map.name as string;
  const title = (map.title ?? name) as string;
  const description = (map.description ?? '') as string;
  const goal = (map.goal ?? null) as string | null;
  const manager = (map.manager ?? null) as string | null;
  const identity = (map.identity ?? []) as string[];
  const toolsMap = map.tools as Record<string, any> | undefined;
  const tools = toolsMap
    ? { mode: toolsMap.mode as string, names: (toolsMap.names ?? []) as string[] }
    : null;

  const disabledList = (map['disabled-modes'] ?? []) as string[];

  const rtRaw = (map['recurring-tasks'] ?? []) as Record<string, any>[];
  const recurringTasks: RecurringTask[] = rtRaw.map((m) => ({
    name: m.name as string,
    promptFile: m.prompt as string,
    cadenceHours: Number(m['cadence-hours']),
    disabled: (m.disabled as boolean | undefined) ?? false,
  }));

  const subscribedTopics = (map['subscribed-topics'] ?? []) as string[];
  const model = (map.model ?? null) as string | null;
  const backgroundModel = (map['background-model'] ?? null) as string | null;

  const reasoningMap = map.reasoning as Record<string, any> | undefined;
  const reasoning = reasoningMap
    ? {
        effort: reasoningMap.effort as string | undefined,
        maxTokens: reasoningMap['max-tokens'] != null ? Number(reasoningMap['max-tokens']) : undefined,
      }
    : null;

  return {
    name,
    title,
    description,
    goal,
    promptBase,
    manager,
    identity,
    tools,
    disabledModes: new Set(disabledList),
    recurringTasks,
    subscribedTopics,
    model,
    backgroundModel,
    reasoning,
  };
}
