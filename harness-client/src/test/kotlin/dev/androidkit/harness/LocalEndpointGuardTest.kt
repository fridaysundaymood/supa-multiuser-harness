package dev.androidkit.harness

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse

class LocalEndpointGuardTest {
    @Test fun acceptsExplicitLocalHosts() {
        listOf("http://localhost:54321/rest/v1/tasks", "http://127.0.0.1:54321", "http://10.0.2.2:54321", "http://10.0.3.2:54321", "http://[::1]:54321").forEach {
            assertEquals(it, LocalEndpointGuard.check(it).toString())
        }
    }

    @Test fun rejectsRemoteOrAmbiguousEndpoints() {
        listOf("https://example.com", "http://localhost.example.com", "http://localhost@evil.example", "http://127.0.0.2", "http://127.1", "http://[::ffff:127.0.0.1]", "file:///tmp/test", "http://10.0.2.3", "http://localhost:99999", "http://localhost/#fragment").forEach {
            assertFailsWith<IllegalArgumentException>(it) { LocalEndpointGuard.check(it) }
        }
    }

    @Test fun disablesRedirects() {
        assertFalse(LocalEndpointGuard.open("http://127.0.0.1:54321").instanceFollowRedirects)
    }
}
