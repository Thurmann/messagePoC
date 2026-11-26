pluginManagement {
    repositories {
        gradlePluginPortal()
        mavenCentral()
    }
}

rootProject.name = "message-poc"

include(
    "contracts",
    "frontend",
    "services:message-api",
    "services:validation-service",
    "services:message-persistence",
    "services:message-audit",
)
