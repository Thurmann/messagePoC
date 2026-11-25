# syntax=docker/dockerfile:1.7

# "build" compiles the jar with Gradle inside Docker (default, used by docker compose);
# "prebuilt" packages a jar from the `jars` build context, which CI fills with jars it already built and tested.
ARG JAR_SOURCE=build

FROM eclipse-temurin:25-jdk-alpine AS build

WORKDIR /workspace
ARG SERVICE
# Optional: gives the jar a release version, for example in a manual image build.
# The workflows build the jars with Gradle and use the prebuilt source instead.
ARG RELEASE_VERSION

COPY gradlew gradlew.bat settings.gradle.kts build.gradle.kts gradle.properties ./
COPY gradle ./gradle
COPY contracts ./contracts
COPY services ./services

RUN --mount=type=cache,target=/root/.gradle,sharing=locked \
    ./gradlew ":services:${SERVICE}:bootJar" ${RELEASE_VERSION:+-PreleaseVersion=$RELEASE_VERSION} --no-daemon

RUN mkdir /jar && cp services/${SERVICE}/build/libs/*.jar /jar/

# Needs --build-context jars=<dir> with <service>/build/libs/<boot jar>; without it,
# BuildKit looks for an image called "jars" and the build fails.
FROM scratch AS prebuilt

ARG SERVICE
COPY --from=jars ${SERVICE}/build/libs/ /jar/

FROM ${JAR_SOURCE} AS jar-source

FROM eclipse-temurin:25-jre-alpine

WORKDIR /app

COPY --from=jar-source --chown=1001:1001 /jar/*.jar app.jar

USER 1001:1001

ENTRYPOINT ["java", "-jar", "/app/app.jar"]
