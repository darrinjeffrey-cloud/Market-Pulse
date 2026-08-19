---
name: Expo web API origin
description: Why Expo browser previews and native builds must resolve the API origin differently.
---

Expo browser previews must call the API through same-origin `/api` routes. Native builds should continue using the configured backend domain with their persisted Bearer token.

**Why:** The Expo browser login establishes a cookie on the Expo preview origin. Switching later market requests to the separate development domain prevents that cookie from authenticating the stream and polling endpoints, leaving the app stuck in a connecting state even though login succeeded.

**How to apply:** Any shared mobile API base helper must branch on the web platform before consulting the configured domain. Preserve Authorization headers for native requests, and include credentials for browser requests.