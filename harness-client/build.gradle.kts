plugins {
    kotlin("jvm") version "2.4.21"
}

group = "dev.androidkit"
version = "0.1.0"

kotlin { jvmToolchain(21) }

dependencies {
    testImplementation(kotlin("test-junit"))
    testImplementation("org.json:json:20240303")
}
tasks.test { useJUnit() }

