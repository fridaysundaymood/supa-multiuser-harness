package dev.androidkit.harness

import java.net.HttpURLConnection
import java.net.Proxy
import java.net.URI

/** Include this library only in debug or instrumentation-test configurations. */
object LocalEndpointGuard {
    fun check(endpoint: String, allowEmulator: Boolean = false): URI {
        val uri = try { URI(endpoint) } catch (e: Exception) {
            throw IllegalArgumentException("Invalid endpoint", e)
        }
        val host = uri.host?.lowercase()
        require(uri.isAbsolute && uri.scheme?.lowercase() in setOf("http", "https") &&
            uri.rawUserInfo == null && uri.rawFragment == null &&
            (host in setOf("localhost", "127.0.0.1", "[::1]", "::1") ||
                (allowEmulator && host in setOf("10.0.2.2", "10.0.3.2"))) &&
            (uri.port == -1 || uri.port in 1..65535)) { "Endpoint must use an approved local host" }
        return uri
    }

    /** Opens the exact checked URL without a proxy or automatic redirects. */
    fun open(endpoint: String, allowEmulator: Boolean = false): HttpURLConnection {
        val connection = check(endpoint, allowEmulator).toURL().openConnection(Proxy.NO_PROXY) as HttpURLConnection
        connection.instanceFollowRedirects = false
        return connection
    }
}
