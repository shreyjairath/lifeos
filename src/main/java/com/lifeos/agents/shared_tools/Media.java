package com.lifeos.agents.shared_tools;

import org.springframework.stereotype.Component;

import java.util.Map;

/**
 * Image display signaling for the frontend.
 */
@Component
public class Media {

    public Map<String, Object> showImage(String url, String caption) {
        return Map.of("ok", true, "url", url, "caption", caption != null ? caption : "");
    }
}
