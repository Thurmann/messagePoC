package no.thurmann.messagepoc.chat

internal object JdbcUrls {
    /** Adds `tcpKeepAlive=true` unless the URL already sets tcpKeepAlive, handling URLs with or without a query string. */
    fun withTcpKeepAlive(url: String): String {
        val query = url.substringAfter('?', "")
        if (query.split('&').any { it.startsWith("tcpKeepAlive=", ignoreCase = true) }) return url
        return when {
            !url.contains('?') -> "$url?tcpKeepAlive=true"
            url.endsWith('?') || url.endsWith('&') -> "${url}tcpKeepAlive=true"
            else -> "$url&tcpKeepAlive=true"
        }
    }
}
