plugins {
    kotlin("jvm") version "2.4.21"
    `maven-publish`
}

group = "dev.androidkit"
version = "0.1.0"

kotlin { jvmToolchain(17) }
java { withSourcesJar() }

dependencies {
    testImplementation(kotlin("test-junit"))
    testImplementation("org.json:json:20240303")
}
tasks.test { useJUnit() }

publishing {
    publications {
        create<MavenPublication>("library") { from(components["java"]) }
    }
}
