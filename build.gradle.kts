import org.gradle.api.tasks.testing.Test

plugins {
    kotlin("jvm") version "2.4.21" apply false
    kotlin("plugin.spring") version "2.4.21" apply false
    id("org.springframework.boot") version "4.1.1" apply false
    id("io.spring.dependency-management") version "1.1.7" apply false
}

allprojects {
    group = "no.thurmann.messagepoc"
    version = "0.1.0-SNAPSHOT"

    repositories {
        mavenCentral()
    }
}

subprojects {
    tasks.withType<Test>().configureEach {
        useJUnitPlatform()
    }
}
