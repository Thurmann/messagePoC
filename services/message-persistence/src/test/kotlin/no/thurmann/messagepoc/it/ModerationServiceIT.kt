package no.thurmann.messagepoc.it

import no.thurmann.messagepoc.audit.MessageResultStatus
import no.thurmann.messagepoc.contracts.MessageAuthor
import no.thurmann.messagepoc.contracts.MessageSubmittedEvent
import no.thurmann.messagepoc.contracts.MessageSubmittedPayload
import no.thurmann.messagepoc.audit.MessageResult
import no.thurmann.messagepoc.moderation.ManualBanResult
import no.thurmann.messagepoc.moderation.ModerationService
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import java.time.Duration
import java.time.Instant
import java.time.temporal.ChronoUnit
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ModerationServiceIT : AbstractIntegrationTest() {
    @Autowired
    lateinit var service: ModerationService

    private fun strikesAfter(userId: String): List<Int?> =
        jdbc.query("SELECT strikes_after FROM message_result WHERE author_id = ? ORDER BY occurred_at, event_id", { rs, _ -> rs.getObject(1) as Int? }, userId)

    private fun bans(userId: String) = jdbc.queryForList("SELECT * FROM user_ban WHERE user_id = ? ORDER BY id", userId)

    private fun reject(userId: String, n: Int) = repeat(n) { service.record(rejected(userId)) }

    /** Moves the user's latest ban (and the strikes that caused it) into the past so the ban counts as ended [ago] ago. */
    private fun expireBan(userId: String, ago: Duration) {
        val endsAt = Instant.now().minus(ago)
        jdbc.update("UPDATE message_result SET occurred_at = ? WHERE author_id = ?", java.sql.Timestamp.from(endsAt.minusSeconds(60)), userId)
        jdbc.update("UPDATE user_ban SET starts_at = ?, ends_at = ? WHERE user_id = ?", java.sql.Timestamp.from(endsAt.minusSeconds(60)), java.sql.Timestamp.from(endsAt), userId)
    }

    @Test
    fun `five rejections give strikes 1 to 5 without a ban and the sixth starts a one minute ban`() {
        createUser("u1")
        reject("u1", 5)
        assertEquals(listOf(1, 2, 3, 4, 5), strikesAfter("u1"))
        assertTrue(bans("u1").isEmpty())

        service.record(rejected("u1"))

        val ban = bans("u1").single()
        assertEquals(0, ban["step"])
        assertEquals(6, ban["strikes_at_ban"])
        val seconds = Duration.between(
            (ban["starts_at"] as java.sql.Timestamp).toInstant(), (ban["ends_at"] as java.sql.Timestamp).toInstant(),
        ).seconds
        assertEquals(60, seconds)
        assertTrue(service.activeBan("u1") != null)
    }

    @Test
    fun `a strike while banned does not create another ban`() {
        createUser("u1")
        reject("u1", 6)
        reject("u1", 2)
        assertEquals(1, bans("u1").size)
        assertEquals(8, jdbc.queryForObject("SELECT count(*) FROM message_result WHERE strike", Int::class.java))
    }

    @Test
    fun `second ban within the escalation window escalates to step 1 with five minutes`() {
        createUser("u1")
        reject("u1", 6)
        expireBan("u1", Duration.ofHours(1))
        assertEquals(0, service.currentStrikes("u1"))

        reject("u1", 6)

        val all = bans("u1")
        assertEquals(2, all.size)
        assertEquals(1, all[1]["step"])
        val d = Duration.between((all[1]["starts_at"] as java.sql.Timestamp).toInstant(), (all[1]["ends_at"] as java.sql.Timestamp).toInstant())
        assertEquals(Duration.ofMinutes(5), d)
    }

    @Test
    fun `a ban that ended outside the escalation window restarts at step 0`() {
        createUser("u1")
        reject("u1", 6)
        expireBan("u1", Duration.ofDays(2))

        reject("u1", 6)

        val all = bans("u1")
        assertEquals(2, all.size)
        assertEquals(0, all[1]["step"])
    }

    @Test
    fun `strike counter resets once a ban has ended`() {
        createUser("u1")
        reject("u1", 6)
        expireBan("u1", Duration.ofMinutes(10))

        service.record(rejected("u1"))

        assertEquals(1, service.currentStrikes("u1"))
        assertEquals(1, strikesAfter("u1").last())
        assertEquals(1, bans("u1").size)
    }

    @Test
    fun `admin is never banned but strikes are still recorded`() {
        createUser("adm", email = ADMIN_EMAIL.uppercase())
        reject("adm", 8)
        assertTrue(bans("adm").isEmpty())
        assertEquals(8, service.currentStrikes("adm"))
        assertEquals((1..8).toList(), strikesAfter("adm"))
    }

    @Test
    fun `redelivery of the same event is stored once and not counted twice`() {
        createUser("u1")
        reject("u1", 5)
        val id = UUID.randomUUID()
        service.record(rejected("u1", eventId = id))
        service.record(rejected("u1", eventId = id))
        service.record(rejected("u1", eventId = id))

        assertEquals(1, jdbc.queryForObject("SELECT count(*) FROM message_result WHERE event_id = ?", Int::class.java, id))
        assertEquals(6, jdbc.queryForObject("SELECT count(*) FROM message_result WHERE author_id='u1' AND strike", Int::class.java))
        assertEquals(listOf(1, 2, 3, 4, 5, 6), strikesAfter("u1"))
        assertEquals(1, bans("u1").size)
        assertEquals(6, bans("u1").single()["strikes_at_ban"])
    }

    private fun countByMessage(id: UUID) = jdbc.queryForObject("SELECT count(*) FROM message_result WHERE message_id = ?", Int::class.java, id)!!

    @Test
    fun `a second rejected result with the same messageId and a new eventId is ignored`() {
        createUser("u1")
        val messageId = UUID.randomUUID()
        service.record(rejected("u1").also { it.messageId = messageId })
        service.record(rejected("u1").also { it.messageId = messageId })

        assertEquals(1, countByMessage(messageId))
        assertEquals(listOf(1), strikesAfter("u1"))
        assertEquals(1, jdbc.queryForObject("SELECT count(*) FROM message_result WHERE author_id='u1' AND strike", Int::class.java))
    }

    @Test
    fun `a DLT result after a validated result with the same messageId is ignored`() {
        createUser("u1")
        val messageId = UUID.randomUUID()
        service.record(validated("u1").also { it.messageId = messageId })
        service.record(dlt(0.9, "u1").also { it.messageId = messageId })

        assertEquals(1, countByMessage(messageId))
        assertEquals("VALIDATED", jdbc.queryForObject("SELECT status FROM message_result WHERE message_id = ?", String::class.java, messageId))
        assertEquals(0, service.currentStrikes("u1"))
    }

    @Test
    fun `concurrent results with the same messageId are stored once`() {
        createUser("u1")
        val messageId = UUID.randomUUID()
        val threads = 8
        val pool = Executors.newFixedThreadPool(threads)
        val start = CountDownLatch(1)
        val futures = (1..threads).map { pool.submit { start.await(); service.record(rejected("u1").also { it.messageId = messageId }) } }
        start.countDown()
        futures.forEach { it.get(30, TimeUnit.SECONDS) }
        pool.shutdown()

        assertEquals(1, countByMessage(messageId))
        assertTrue(jdbc.queryForObject("SELECT count(*) FROM message_result WHERE author_id='u1' AND strike", Int::class.java)!! <= 1)
        assertEquals(1, service.currentStrikes("u1"))
    }

    @Test
    fun `a duplicate messageId at the ban boundary neither adds a strike nor a ban`() {
        createUser("u1")
        reject("u1", 5)
        val messageId = UUID.randomUUID()
        service.record(rejected("u1").also { it.messageId = messageId })
        service.record(rejected("u1").also { it.messageId = messageId })

        assertEquals(6, jdbc.queryForObject("SELECT count(*) FROM message_result WHERE author_id='u1' AND strike", Int::class.java))
        assertEquals(listOf(1, 2, 3, 4, 5, 6), strikesAfter("u1"))
        assertEquals(1, countByMessage(messageId))
        assertEquals(1, bans("u1").size)
    }

    @Test
    fun `concurrent strikes at the ban boundary create exactly one ban`() {
        createUser("u1")
        reject("u1", 4)
        val threads = 10
        val pool = Executors.newFixedThreadPool(threads)
        val start = CountDownLatch(1)
        val futures = (1..threads).map { pool.submit { start.await(); service.record(rejected("u1")) } }
        start.countDown()
        futures.forEach { it.get(30, TimeUnit.SECONDS) }
        pool.shutdown()

        assertEquals(1, bans("u1").size)
        assertEquals(6, bans("u1").single()["strikes_at_ban"])
        assertEquals(4 + threads, jdbc.queryForObject("SELECT count(*) FROM message_result", Int::class.java))
        // strikes 1..6 each assigned exactly once up to the ban
        val upToBan = jdbc.queryForList("SELECT strikes_after FROM message_result WHERE author_id='u1' AND strikes_after <= 6 ORDER BY strikes_after", Int::class.java)
        assertTrue(upToBan.containsAll((1..6).toList()))
    }

    private fun dlt(score: Double?, author: String?) = MessageResult.fromDlt(
        MessageSubmittedEvent(
            eventId = UUID.randomUUID(), occurredAt = Instant.now(), messageId = UUID.randomUUID(), correlationId = UUID.randomUUID(),
            producer = "t", payload = MessageSubmittedPayload("dlt text"), profanityScore = score, author = author?.let { MessageAuthor(it, "h") },
        ),
    )

    @Test
    fun `technical DLT without score is no strike but DLT with a score is`() {
        createUser("u1")
        val technical = dlt(null, "u1")
        val profane = dlt(0.99, "u1")
        service.record(technical)
        service.record(profane)

        val rows = jdbc.queryForList("SELECT event_id, status, strike, strikes_after FROM message_result WHERE author_id='u1'")
            .associateBy { it["event_id"] }
        assertEquals(false, rows[technical.eventId]!!["strike"])
        assertEquals(0, rows[technical.eventId]!!["strikes_after"])
        assertEquals("DLT", rows[technical.eventId]!!["status"])
        assertEquals(true, rows[profane.eventId]!!["strike"])
        assertEquals(1, rows[profane.eventId]!!["strikes_after"])
        assertEquals(MessageResultStatus.DLT.name, rows[profane.eventId]!!["status"])
    }

    @Test
    fun `results without author or with unknown author are saved without strike logic`() {
        service.record(rejected(null))
        service.record(rejected("ghost"))
        service.record(validated("ghost"))

        assertEquals(3, jdbc.queryForObject("SELECT count(*) FROM message_result", Int::class.java))
        assertEquals(0, jdbc.queryForObject("SELECT count(*) FROM message_result WHERE strike", Int::class.java))
        assertNull(jdbc.queryForObject("SELECT max(strikes_after) FROM message_result", Int::class.javaObjectType))
        assertEquals(0, jdbc.queryForObject("SELECT count(*) FROM user_ban", Int::class.java))
    }

    @Test
    fun `validated result by a known user is stored without a strike`() {
        createUser("u1")
        service.record(validated("u1"))
        assertEquals(listOf<Int?>(0), strikesAfter("u1"))
        assertEquals(0, service.currentStrikes("u1"))
    }

    @Test
    fun `manual ban without history is a one minute step 0 ban`() {
        createUser("u1", handle = "Alice")
        val now = Instant.now().truncatedTo(ChronoUnit.MICROS) // Postgres precision

        val result = service.manualBan("alice", "Boss@Test.local", now)

        val banned = result as ManualBanResult.Banned
        assertEquals("Alice", banned.handle)
        assertEquals(0, banned.step)
        assertEquals(now.plus(Duration.ofMinutes(1)), banned.until)
        val ban = bans("u1").single()
        assertEquals(0, ban["step"])
        assertEquals("Boss@Test.local", ban["banned_by"])
        assertNull(ban["strikes_at_ban"])
        assertNull(ban["trigger_message_id"])
        assertTrue(service.activeBan("u1") != null)
    }

    @Test
    fun `manual ban after a recently ended ban escalates to five minutes`() {
        createUser("u1", handle = "alice")
        val ended = Instant.now().minus(Duration.ofHours(1))
        jdbc.update(
            "INSERT INTO user_ban (user_id, step, starts_at, ends_at, created_at) VALUES ('u1', 0, ?, ?, ?)",
            java.sql.Timestamp.from(ended.minusSeconds(60)), java.sql.Timestamp.from(ended), java.sql.Timestamp.from(ended.minusSeconds(60)),
        )
        val now = Instant.now().truncatedTo(ChronoUnit.MICROS)

        val banned = service.manualBan("alice", ADMIN_EMAIL, now) as ManualBanResult.Banned

        assertEquals(1, banned.step)
        assertEquals(now.plus(Duration.ofMinutes(5)), banned.until)
        assertEquals(2, bans("u1").size)
    }

    @Test
    fun `manual ban of an admin is refused`() {
        createUser("adm", email = ADMIN_EMAIL, handle = "boss")

        assertEquals(ManualBanResult.CannotBanAdmin, service.manualBan("boss", ADMIN_EMAIL))
        assertTrue(bans("adm").isEmpty())
    }

    @Test
    fun `manual ban of an already banned user reports the active ban`() {
        createUser("u1", handle = "alice")
        val first = service.manualBan("alice", ADMIN_EMAIL) as ManualBanResult.Banned

        val second = service.manualBan("alice", ADMIN_EMAIL)

        assertEquals(ManualBanResult.AlreadyBanned(first.until), second)
        assertEquals(1, bans("u1").size)
    }

    @Test
    fun `manual ban of an unknown handle is reported`() {
        assertEquals(ManualBanResult.UnknownHandle, service.manualBan("nobody", ADMIN_EMAIL))
    }

    @Test
    fun `concurrent manual bans create exactly one ban`() {
        createUser("u1", handle = "alice")
        val threads = 2
        val pool = Executors.newFixedThreadPool(threads)
        val start = CountDownLatch(1)
        val futures = (1..threads).map { pool.submit<ManualBanResult> { start.await(); service.manualBan("alice", ADMIN_EMAIL) } }
        start.countDown()
        val results = futures.map { it.get(30, TimeUnit.SECONDS) }
        pool.shutdown()

        assertEquals(1, bans("u1").size)
        assertEquals(1, results.count { it is ManualBanResult.Banned })
        assertEquals(1, results.count { it is ManualBanResult.AlreadyBanned })
    }
}
