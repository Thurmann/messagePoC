package no.thurmann.messagepoc.chat

import kotlin.test.Test
import kotlin.test.assertEquals

class JdbcUrlsTest {
    @Test
    fun `appends with question mark when no query`() {
        assertEquals("jdbc:postgresql://h:5432/db?tcpKeepAlive=true", JdbcUrls.withTcpKeepAlive("jdbc:postgresql://h:5432/db"))
    }

    @Test
    fun `appends with ampersand when query exists`() {
        assertEquals("jdbc:postgresql://h/db?ssl=true&tcpKeepAlive=true", JdbcUrls.withTcpKeepAlive("jdbc:postgresql://h/db?ssl=true"))
    }

    @Test
    fun `does not duplicate existing setting`() {
        val url = "jdbc:postgresql://h/db?tcpKeepAlive=false&ssl=true"
        assertEquals(url, JdbcUrls.withTcpKeepAlive(url))
    }

    @Test
    fun `handles trailing separators`() {
        assertEquals("jdbc:postgresql://h/db?tcpKeepAlive=true", JdbcUrls.withTcpKeepAlive("jdbc:postgresql://h/db?"))
        assertEquals("jdbc:postgresql://h/db?a=b&tcpKeepAlive=true", JdbcUrls.withTcpKeepAlive("jdbc:postgresql://h/db?a=b&"))
    }
}
