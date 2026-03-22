package com.lifeos.agent.executor.events;

/**
 * Marker interface for all events emitted by the executor pipeline.
 * LlmEvent, ToolEvent, and AgentAppendEvent are the public event types.
 * Internal sentinel types (e.g. LoopControl) also implement this.
 */
public interface ExecutorEvent {}
