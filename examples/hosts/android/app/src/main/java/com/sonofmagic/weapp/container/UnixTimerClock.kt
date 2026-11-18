package com.sonofmagic.weapp.container

/**
 * pollTimers consumes Unix epoch nanoseconds, matching Rust SystemTime and
 * AppService Date.now(). Choreographer/uptime timestamps only schedule the pump.
 */
internal object UnixTimerClock {
    fun nowNs(nowMillis: Long = System.currentTimeMillis()): Long {
        // JNI carries this value as signed jlong before converting to u64.
        // Reject unrepresentable observations instead of wrapping or clamping
        // them into a date that could fire every pending timer at once.
        require(nowMillis in 0..Long.MAX_VALUE / 1_000_000L) {
            "ERR_ENGINE: timer clock must be representable non-negative Unix epoch nanoseconds"
        }
        return nowMillis * 1_000_000L
    }
}
