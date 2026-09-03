# syntax=docker/dockerfile:1.7

FROM eclipse-temurin:21-jdk-alpine AS build

WORKDIR /workspace

COPY gradlew gradlew.bat settings.gradle.kts build.gradle.kts gradle.properties ./
COPY gradle ./gradle
COPY contracts ./contracts
COPY services ./services

RUN --mount=type=cache,target=/root/.gradle,sharing=locked \
    ./gradlew \
      :services:message-api:bootJar \
      :services:validation-service:bootJar \
      :services:message-view:bootJar \
      --no-daemon

FROM eclipse-temurin:21-jre-alpine

WORKDIR /app

ARG SERVICE
COPY --from=build --chown=1001:1001 /workspace/services/${SERVICE}/build/libs/*.jar app.jar

USER 1001:1001

ENTRYPOINT ["java", "-jar", "/app/app.jar"]
