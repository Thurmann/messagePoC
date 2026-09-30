pluginManagement {
    repositories {
        gradlePluginPortal()
        mavenCentral()
    }
}

rootProject.name = "message-poc"

include(
    "contracts",
    "services:message-api",
    "services:validation-service",
    "services:message-persistence",
    "services:message-audit",
)
