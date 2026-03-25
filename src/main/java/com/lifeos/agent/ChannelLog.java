package com.lifeos.agent;

public interface ChannelLog {
    String loadFull(String fromAgent, String toAgent);
    void append(String fromAgent, String toAgent, String inbound, String response);
}
