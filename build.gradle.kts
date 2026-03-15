plugins {
    java
    id("org.springframework.boot") version "3.5.3"
    id("io.spring.dependency-management") version "1.1.7"
}

group = "com.lifeos"
version = "0.0.1-SNAPSHOT"

java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(25)
    }
}

repositories {
    mavenCentral()
}

dependencies {
    // Spring WebFlux
    implementation("org.springframework.boot:spring-boot-starter-webflux")

    // Jackson for JSON
    implementation("com.fasterxml.jackson.core:jackson-databind")

    // YAML config
    implementation("org.yaml:snakeyaml")

    // HTML content extraction
    implementation("org.jsoup:jsoup:1.18.3")

    // Web Push (VAPID + RFC 8291 message encryption)
    implementation("nl.martijndwars:web-push:5.1.1")
    implementation("org.bouncycastle:bcprov-jdk18on:1.78.1")

    // Lombok (optional — we'll use records instead)
    // compileOnly("org.projectlombok:lombok")
    // annotationProcessor("org.projectlombok:lombok")

    // Dev tools — auto-restart on class changes, live reload for static resources
    developmentOnly("org.springframework.boot:spring-boot-devtools")

    // Test
    testImplementation("org.springframework.boot:spring-boot-starter-test")
    testImplementation("io.projectreactor:reactor-test")
}

tasks.withType<Test> {
    useJUnitPlatform()
}
