package com.lifeos.core.agent;

import java.util.List;
import java.util.Map;

/**
 * Combines tool schema (for the LLM) with tool dispatch (for execution).
 * Extends the executor-level invoker so instances can be passed directly to Executor.runLoop().
 */
public interface ToolInvoker extends com.lifeos.core.executor.ToolInvoker {
    List<Map<String, Object>> definitions();
}
