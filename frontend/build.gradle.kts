import com.github.gradle.node.npm.task.NpmTask

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

val viteBuild by tasks.registering(NpmTask::class) {
    npmInputs()
    args = listOf("run", "build")
    outputs.dir(layout.buildDirectory.dir("vite"))
    outputs.cacheIf { true }
}

val typecheck by tasks.registering(NpmTask::class) {
    npmInputs()
    args = listOf("run", "typecheck")
    outputs.dir(layout.buildDirectory.dir("typecheck"))
    outputs.cacheIf { true }
}

val unitTest by tasks.registering(NpmTask::class) {
    group = "verification"
    npmInputs()
    args = listOf("run", "test")
    outputs.dir(layout.buildDirectory.dir("test-results/vitest"))
    outputs.cacheIf { true }
}

tasks.check {
    dependsOn(typecheck, unitTest)
}

// The jar carries the chat UI as classpath:/static so message-persistence serves it.
tasks.processResources {
    from(viteBuild) { into("static") }
}
