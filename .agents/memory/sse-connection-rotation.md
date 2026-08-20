---
name: SSE connection rotation
description: The proxy lifetime constraint for the browser market-data event stream.
---

The market SSE endpoint must end and let EventSource reconnect before the
proxied request lifetime reaches roughly five minutes. Ten-second heartbeats
prevent idle disconnections but do not bypass this absolute request limit.

**Why:** The server logs show otherwise healthy `/market/stream` responses
being aborted at about 300 seconds. The hard proxy termination can surface as a
visible disconnected state even though the upstream market feed is live.

**How to apply:** Keep regular heartbeat comments and rotate the SSE response
before the limit using EventSource's normal retry behavior. Clear all stream
listeners and timers when the request closes.