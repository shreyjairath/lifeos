package com.lifeos.app.api;

import com.lifeos.agentfleet.WebPushService;
import org.springframework.web.bind.annotation.*;

import java.io.IOException;
import java.util.Map;

@RestController
@RequestMapping("/api/push")
public class PushController {

    private final WebPushService webPush;

    public PushController(WebPushService webPush) {
        this.webPush = webPush;
    }

    @GetMapping("/vapid-public-key")
    public Map<String, String> vapidPublicKey() {
        return Map.of("publicKey", webPush.getPublicKey());
    }

    @PostMapping("/subscribe")
    public Map<String, Boolean> subscribe(@RequestBody Map<String, Object> subscription) throws IOException {
        webPush.addSubscription(subscription);
        return Map.of("ok", true);
    }

    @PostMapping("/unsubscribe")
    public Map<String, Boolean> unsubscribe(@RequestBody Map<String, String> body) throws IOException {
        webPush.removeSubscription(body.get("endpoint"));
        return Map.of("ok", true);
    }
}
