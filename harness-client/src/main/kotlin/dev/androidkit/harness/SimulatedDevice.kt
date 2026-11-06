package dev.androidkit.harness

/** A session supplied by the test; its token is never included in string output. */
class Session(val userId: String, val accessToken: String) {
    override fun toString(): String = "Session(userId=$userId, accessToken=<redacted>)"
}

data class Edit(val key: String, val value: String?)

/** Implementations must send requests through LocalEndpointGuard.open or an equivalent guarded transport. */
fun interface SyncTransport {
    /** Apply edits and return the complete current view visible to this session. */
    fun sync(session: Session, edits: List<Edit>): Map<String, String>
}

/** Each instance owns its local view and pending edits; no state is shared between devices. */
class SimulatedDevice(val session: Session, private val transport: SyncTransport) {
    private val values = linkedMapOf<String, String>()
    private val pending = mutableListOf<Edit>()
    var online: Boolean = true

    fun edit(key: String, value: String?) {
        require(key.isNotEmpty())
        val edit = Edit(key, value)
        pending.add(edit)
        apply(edit)
    }

    fun snapshot(): Map<String, String> = values.toMap()
    fun pendingEdits(): List<Edit> = pending.toList()

    /** Offline sync is refused; a failed transport leaves local data and pending edits intact. */
    fun sync() {
        check(online) { "Device is offline" }
        val changes = pending.toList()
        val remote = transport.sync(session, changes)
        values.clear()
        values.putAll(remote)
        pending.clear()
    }

    private fun apply(edit: Edit) {
        if (edit.value == null) values.remove(edit.key) else values[edit.key] = edit.value
    }
}
