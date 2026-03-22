package com.lifeos.agent;

public interface ChannelLog {
    String loadFull(String agentA, String agentB);
    void append(String agentA, String agentB, String inbound, String response);
}
