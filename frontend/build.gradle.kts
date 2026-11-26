import com.github.gradle.node.npm.task.NpmTask

plugins {
    base
    java
    id("com.github.node-gradle.node")
}

node {
    download = true
    version = "22.12.0"
    npmInstallCommand = "ci"
}

val compileTypeScript by tasks.registering(NpmTask::class) {
    dependsOn(tasks.npmInstall)
    args = listOf("run", "build")
    inputs.dir("src/ts").withPathSensitivity(PathSensitivity.RELATIVE)
    inputs.files("tsconfig.json", "package.json", "package-lock.json").withPathSensitivity(PathSensitivity.RELATIVE)
    outputs.dir(layout.buildDirectory.dir("tsc"))
    outputs.cacheIf { true }
}

// The jar carries the chat UI as classpath:/static so message-persistence serves it.
tasks.processResources {
    from("src/static") { into("static") }
    from(compileTypeScript) { into("static/js") }
}
