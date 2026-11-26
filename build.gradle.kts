import org.jetbrains.kotlin.gradle.dsl.KotlinJvmProjectExtension

plugins {
    kotlin("jvm") version "2.4.21" apply false
    kotlin("plugin.spring") version "2.4.21" apply false
    id("org.springframework.boot") version "4.2.0" apply false
    id("io.spring.dependency-management") version "1.1.7" apply false
}

allprojects {
    group = "no.thurmann.messagepoc"
    version = providers.gradleProperty("releaseVersion").getOrElse("0.1.0-SNAPSHOT")

    repositories {
        mavenCentral()
    }
}

subprojects {
    pluginManager.withPlugin("org.jetbrains.kotlin.jvm") {
        extensions.configure<JavaPluginExtension> {
            toolchain.languageVersion = JavaLanguageVersion.of(25)
        }
        extensions.configure<KotlinJvmProjectExtension> {
            compilerOptions {
                freeCompilerArgs.add("-Xjsr305=strict")
            }
        }
    }

    tasks.withType<Test>().configureEach {
        useJUnitPlatform()
    }
}
