package app.yourwine

import org.junit.Assert.assertEquals
import org.junit.Test

class WineApiTest {
    @Test
    fun feedbackBodyLoved() {
        assertEquals(
            mapOf("scan_id" to "s123", "verdict" to "loved"),
            feedbackBody("s123", true),
        )
    }

    @Test
    fun feedbackBodyNotForMe() {
        assertEquals(
            mapOf("scan_id" to "s123", "verdict" to "not_for_me"),
            feedbackBody("s123", false),
        )
    }
}
