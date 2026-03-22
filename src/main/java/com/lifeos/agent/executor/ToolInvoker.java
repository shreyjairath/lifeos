package com.lifeos.agent.executor;

import java.util.Map;

/**
 * Dispatches a named tool call. Implemented by ToolsRegistry; passed per runLoop invocation
 * so the executor package has no dependency on com.lifeos.agents.tools.
 */
@FunctionalInterface
public interface ToolInvoker {
    Map<String, Object> invoke(String name, Map<String, Object> input, String agentName);
}
