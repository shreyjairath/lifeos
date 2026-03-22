package com.lifeos.agentfleet;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import nl.martijndwars.webpush.Notification;
import nl.martijndwars.webpush.PushService;
import nl.martijndwars.webpush.Subscription;
import org.bouncycastle.jce.ECNamedCurveTable;
import org.bouncycastle.jce.interfaces.ECPrivateKey;
import org.bouncycastle.jce.interfaces.ECPublicKey;
import org.bouncycastle.jce.provider.BouncyCastleProvider;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import jakarta.annotation.PostConstruct;
import java.io.IOException;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.*;
import java.util.*;
import java.util.concurrent.CopyOnWriteArrayList;

@Component
public class WebPushService implements com.lifeos.agent.PushNotifier {

    private static final Logger log = LoggerFactory.getLogger(WebPushService.class);
    private static final ObjectMapper MAPPER = new ObjectMapper();

    private static final Path SYSTEM_DIR  = Path.of(System.getProperty("user.dir")).resolve(".user-data/system").normalize();
    private static final Path KEYS_FILE   = SYSTEM_DIR.resolve("vapid-keys.json");
    private static final Path SUBS_FILE   = SYSTEM_DIR.resolve("push-subscriptions.json");

    private PushService pushService;
    private String publicKeyBase64;
    private final List<Map<String, Object>> subscriptions = new CopyOnWriteArrayList<>();

    @PostConstruct
    public void init() throws Exception {
        Security.addProvider(new BouncyCastleProvider());

        Map<String, String> keys;
        if (Files.exists(KEYS_FILE)) {
            keys = MAPPER.readValue(Files.readString(KEYS_FILE, StandardCharsets.UTF_8),
                    new TypeReference<>() {});
        } else {
            // Generate EC P-256 keypair using BouncyCastle
            var spec = ECNamedCurveTable.getParameterSpec("prime256v1");
            var gen = KeyPairGenerator.getInstance("ECDH", "BC");
            gen.initialize(spec);
            var keyPair = gen.generateKeyPair();

            // Public key: uncompressed point (65 bytes: 0x04 || x || y) — required by browsers
            var ecPub = (ECPublicKey) keyPair.getPublic();
            var pubBytes = ecPub.getQ().getEncoded(false);

            // Private key: raw scalar padded to 32 bytes
            var ecPriv = (ECPrivateKey) keyPair.getPrivate();
            var privD = ecPriv.getD().toByteArray();
            var privBytes = new byte[32];
            // BigInteger.toByteArray() may have a leading 0x00 sign byte or be shorter than 32
            var src = privD.length > 32 ? 1 : 0;
            var len = Math.min(privD.length, 32);
            System.arraycopy(privD, src, privBytes, 32 - len, len);

            var enc = Base64.getUrlEncoder().withoutPadding();
            keys = Map.of(
                    "publicKey",  enc.encodeToString(pubBytes),
                    "privateKey", enc.encodeToString(privBytes));
            Files.createDirectories(SYSTEM_DIR);
            Files.writeString(KEYS_FILE, MAPPER.writerWithDefaultPrettyPrinter().writeValueAsString(keys), StandardCharsets.UTF_8);
            log.info("Generated new VAPID keypair");
        }

        publicKeyBase64 = keys.get("publicKey");
        pushService = new PushService(keys.get("publicKey"), keys.get("privateKey"), "mailto:lifeos@localhost");

        if (Files.exists(SUBS_FILE)) {
            var loaded = MAPPER.readValue(Files.readString(SUBS_FILE, StandardCharsets.UTF_8),
                    new TypeReference<List<Map<String, Object>>>() {});
            subscriptions.addAll(loaded);
            log.info("Loaded {} push subscriptions", subscriptions.size());
        }
    }

    public String getPublicKey() { return publicKeyBase64; }

    public void addSubscription(Map<String, Object> sub) throws IOException {
        subscriptions.removeIf(s -> Objects.equals(s.get("endpoint"), sub.get("endpoint")));
        subscriptions.add(sub);
        saveSubscriptions();
    }

    public void removeSubscription(String endpoint) throws IOException {
        subscriptions.removeIf(s -> Objects.equals(s.get("endpoint"), endpoint));
        saveSubscriptions();
    }

    public void sendToAll(String title, String body) {
        var payload = "{\"title\":\"" + escape(title) + "\",\"body\":\"" + escape(body) + "\"}";
        var dead = new ArrayList<String>();
        for (var sub : subscriptions) {
            try {
                var endpoint = (String) sub.get("endpoint");
                @SuppressWarnings("unchecked")
                var keys = (Map<String, String>) sub.get("keys");
                var subscription = new Subscription(endpoint,
                        new Subscription.Keys(keys.get("p256dh"), keys.get("auth")));
                var notification = new Notification(subscription, payload);
                var resp = pushService.send(notification);
                if (resp.getStatusLine().getStatusCode() == 410) dead.add(endpoint);
            } catch (Exception e) {
                log.warn("Push failed: {}", e.getMessage());
            }
        }
        if (!dead.isEmpty()) {
            dead.forEach(ep -> subscriptions.removeIf(s -> Objects.equals(s.get("endpoint"), ep)));
            try { saveSubscriptions(); } catch (IOException ignored) {}
        }
    }

    private void saveSubscriptions() throws IOException {
        Files.writeString(SUBS_FILE, MAPPER.writerWithDefaultPrettyPrinter().writeValueAsString(subscriptions), StandardCharsets.UTF_8);
    }

    private static String escape(String s) {
        return s.replace("\\", "\\\\").replace("\"", "\\\"");
    }
}
