# syntax=docker/dockerfile:1.7

FROM eclipse-temurin:25-jdk-alpine AS build

WORKDIR /workspace
ARG SERVICE
# Set by the release workflow so the jar carries the release version.
ARG RELEASE_VERSION

COPY gradlew gradlew.bat settings.gradle.kts build.gradle.kts gradle.properties ./
COPY gradle ./gradle
COPY contracts ./contracts
COPY services ./services

RUN --mount=type=cache,target=/root/.gradle,sharing=locked \
    ./gradlew ":services:${SERVICE}:bootJar" ${RELEASE_VERSION:+-PreleaseVersion=$RELEASE_VERSION} --no-daemon

FROM eclipse-temurin:25-jre-alpine

WORKDIR /app

ARG SERVICE
COPY --from=build --chown=1001:1001 /workspace/services/${SERVICE}/build/libs/*.jar app.jar

USER 1001:1001

ENTRYPOINT ["java", "-jar", "/app/app.jar"]
