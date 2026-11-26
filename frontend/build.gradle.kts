import com.github.gradle.node.npm.task.NpmTask
import com.github.gradle.node.npm.task.NpxTask

plugins {
    base
    java
    id("com.github.node-gradle.node")
}

node {
    download = true
    version = "24.15.0"
    npmInstallCommand = "ci"
}

val configFiles = listOf(
    "package.json", "package-lock.json", "tsconfig.json", "tsconfig.node.json", "tsconfig.theme.json",
    "vite.config.ts", "index.html",
)

fun NpmTask.npmInputs() {
    dependsOn(tasks.npmInstall)
    inputs.dir("src").withPathSensitivity(PathSensitivity.RELATIVE)
    inputs.dir("build-tools").withPathSensitivity(PathSensitivity.RELATIVE)
    inputs.files(configFiles).withPathSensitivity(PathSensitivity.RELATIVE)
}

fun NpmTask.e2eInputs() {
    inputs.dir("e2e").withPathSensitivity(PathSensitivity.RELATIVE)
    inputs.files("tsconfig.e2e.json", "playwright.config.ts", "playwright.smoke.config.ts")
        .withPathSensitivity(PathSensitivity.RELATIVE)
}

val viteBuild = tasks.register<NpmTask>("viteBuild") {
    npmInputs()
    args = listOf("run", "build")
    outputs.dir(layout.buildDirectory.dir("vite"))
    outputs.cacheIf { true }
}

val typecheck = tasks.register<NpmTask>("typecheck") {
    npmInputs()
    e2eInputs()
    args = listOf("run", "typecheck")
    outputs.dir(layout.buildDirectory.dir("typecheck"))
    outputs.cacheIf { true }
}

val unitTest = tasks.register<NpmTask>("unitTest") {
    group = "verification"
    npmInputs()
    args = listOf("run", "test")
    outputs.dir(layout.buildDirectory.dir("test-results/vitest"))
    outputs.cacheIf { true }
}

// Browser tests run against `vite preview` of the production build with the real Content-Security-Policy.
// They are not part of build/check; CI runs them in a separate job.
val installPlaywrightBrowsers = tasks.register<NpxTask>("installPlaywrightBrowsers") {
    group = "verification"
    description = "Downloads the Chromium build Playwright drives (pass -PplaywrightWithDeps=true on Linux CI for system libraries)."
    dependsOn(tasks.npmInstall)
    command = "playwright"
    val withDeps = providers.gradleProperty("playwrightWithDeps").map { it.toBoolean() }.orElse(false)
    args = withDeps.map { deps -> listOf("install") + (if (deps) listOf("--with-deps") else emptyList()) + "chromium" }
}

val e2eTest = tasks.register<NpmTask>("e2eTest") {
    group = "verification"
    description = "Runs the Playwright browser tests against the built frontend with mocked APIs."
    npmInputs()
    e2eInputs()
    dependsOn(viteBuild, installPlaywrightBrowsers)
    args = listOf("run", "e2e")
    outputs.upToDateWhen { false }
}

tasks.check {
    dependsOn(typecheck, unitTest)
}

// The jar carries the chat UI as classpath:/static so message-persistence serves it.
tasks.processResources {
    from(viteBuild) { into("static") }
}
