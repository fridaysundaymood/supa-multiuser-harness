package dev.androidkit.harness

import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assume.assumeTrue
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/** Set HARNESS_SUPABASE_URL, HARNESS_SUPABASE_ANON_KEY and HARNESS_SUPABASE_SERVICE_KEY to opt in. */
class SupabaseIntegrationTest {
    @Test fun twoPhones() = scenario(2)
    @Test fun threePhones() = scenario(3)

    private fun scenario(count: Int) {
        val base = System.getenv("HARNESS_SUPABASE_URL")
        val anon = System.getenv("HARNESS_SUPABASE_ANON_KEY")
        val service = System.getenv("HARNESS_SUPABASE_SERVICE_KEY")
        assumeTrue("Set all HARNESS_SUPABASE_* variables to run local integration tests", !base.isNullOrBlank() && !anon.isNullOrBlank() && !service.isNullOrBlank())
        val api = LocalApi(base!!, anon!!, service!!)
        val sessions = mutableListOf<Session>()
        var board: String? = null
        try {
            repeat(count) { sessions += api.signUp() }
            board = UUID.randomUUID().toString()
            api.request("POST", "/rest/v1/boards", sessions.first().accessToken,
                JSONObject().put("id", board).put("name", "Harness ${UUID.randomUUID()}").toString())
            sessions.drop(1).forEach { session ->
                api.admin("POST", "/rest/v1/board_members", JSONObject().put("board_id", board).put("user_id", session.userId).put("role", "member").toString())
            }
            val boardId = board
            val transport = SyncTransport { session, edits ->
                edits.forEach { edit ->
                    if (edit.value == null) {
                        api.request("DELETE", "/rest/v1/tasks?id=eq.${edit.key}&board_id=eq.$boardId", session.accessToken)
                    } else {
                        val row = JSONObject().put("id", edit.key).put("board_id", boardId).put("title", edit.value)
                        api.request("POST", "/rest/v1/tasks?on_conflict=id", session.accessToken, row.toString(), "resolution=merge-duplicates,return=minimal")
                    }
                }
                val rows = JSONArray(api.request("GET", "/rest/v1/tasks?board_id=eq.$boardId&select=id,title", session.accessToken))
                buildMap { for (i in 0 until rows.length()) rows.getJSONObject(i).let { put(it.getString("id"), it.getString("title")) } }
            }
            val devices = sessions.map { SimulatedDevice(it, transport) }
            val keys = devices.map { UUID.randomUUID().toString() }
            devices.forEachIndexed { index, device ->
                device.online = false
                device.edit(keys[index], "device-$index")
                assertFailsWith<IllegalStateException> { device.sync() }
                assertEquals(1, device.pendingEdits().size)
            }
            devices.forEach { it.online = true; it.sync() }
            devices.forEach { it.sync() }
            val expected = keys.mapIndexed { index, key -> key to "device-$index" }.toMap()
            devices.forEach { assertEquals(expected, it.snapshot()); assertTrue(it.pendingEdits().isEmpty()) }
            devices.last().edit(keys.first(), null)
            devices.last().sync()
            devices.forEach { it.sync(); assertEquals(expected - keys.first(), it.snapshot()) }
        } finally {
            try {
                if (board != null && sessions.isNotEmpty()) {
                    api.request("DELETE", "/rest/v1/tasks?board_id=eq.$board", sessions.first().accessToken)
                    api.request("DELETE", "/rest/v1/boards?id=eq.$board", sessions.first().accessToken)
                }
            } finally {
                sessions.forEach { api.admin("DELETE", "/auth/v1/admin/users/${it.userId}") }
            }
        }
    }

    private class LocalApi(base: String, private val anon: String, private val service: String) {
        private val base = LocalEndpointGuard.check(base).toString().trimEnd('/')

        fun signUp(): Session {
            val result = JSONObject(request("POST", "/auth/v1/signup", anon, "{}"))
            return Session(result.getJSONObject("user").getString("id"), result.getString("access_token"))
        }

        fun admin(method: String, path: String, body: String? = null): String =
            execute(method, path, service, if (service.startsWith("sb_secret_")) null else service, body, null)

        fun request(method: String, path: String, token: String, body: String? = null, prefer: String? = null): String =
            execute(method, path, anon, token, body, prefer)

        private fun execute(method: String, path: String, key: String, token: String?, body: String?, prefer: String?): String {
            val connection = LocalEndpointGuard.open(base + path)
            try {
                connection.requestMethod = method
                connection.connectTimeout = 15_000
                connection.readTimeout = 15_000
                connection.setRequestProperty("apikey", key)
                if (token != null) connection.setRequestProperty("Authorization", "Bearer $token")
                connection.setRequestProperty("Content-Type", "application/json")
                if (prefer != null) connection.setRequestProperty("Prefer", prefer)
                if (body != null) {
                    connection.doOutput = true
                    connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
                }
                val status = connection.responseCode
                check(status in 200..299) { "Local Supabase request failed: $method $path ($status)" }
                return connection.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
            } finally {
                connection.disconnect()
            }
        }
    }
}
