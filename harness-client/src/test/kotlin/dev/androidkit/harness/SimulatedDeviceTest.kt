package dev.androidkit.harness

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class SimulatedDeviceTest {
    private class Backend : SyncTransport {
        val values = linkedMapOf<String, String>()
        val users = mutableListOf<String>()
        var fail = false
        override fun sync(session: Session, edits: List<Edit>): Map<String, String> {
            if (fail) error("unavailable")
            users.add(session.userId)
            edits.forEach { if (it.value == null) values.remove(it.key) else values[it.key] = it.value }
            return values.toMap()
        }
    }

    private fun device(id: String, backend: Backend) = SimulatedDevice(Session(id, "secret-$id"), backend)

    @Test fun twoDevicesKeepOfflineChangesUntilSync() {
        val backend = Backend()
        val alice = device("alice", backend)
        val bob = device("bob", backend)
        alice.online = false
        alice.edit("one", "first")
        assertTrue(bob.snapshot().isEmpty())
        assertFailsWith<IllegalStateException> { alice.sync() }
        assertEquals(1, alice.pendingEdits().size)
        alice.online = true
        backend.fail = true
        assertFailsWith<IllegalStateException> { alice.sync() }
        assertEquals(mapOf("one" to "first"), alice.snapshot())
        assertEquals(1, alice.pendingEdits().size)
        backend.fail = false
        alice.sync()
        bob.sync()
        assertEquals(alice.snapshot(), bob.snapshot())
        assertEquals(listOf("alice", "bob"), backend.users)
        assertTrue(alice.pendingEdits().isEmpty())
    }

    @Test fun threeDevicesConvergeAfterOfflineEditsAndDeletion() {
        val backend = Backend()
        val devices = listOf(device("a", backend), device("b", backend), device("c", backend))
        devices.forEachIndexed { index, device -> device.online = false; device.edit("$index", "value$index") }
        devices.forEach { it.online = true; it.sync() }
        devices[1].edit("1", null)
        devices[1].sync()
        devices.forEach { it.sync() }
        val expected = mapOf("0" to "value0", "2" to "value2")
        devices.forEach { assertEquals(expected, it.snapshot()) }
        assertTrue(devices.all { it.pendingEdits().isEmpty() })
    }
}
