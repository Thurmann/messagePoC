// Content-Security-Policy for `vite preview` so Playwright exercises the same policy the server sends.
// KEEP IN SYNC with contentSecurityPolicy("") in
// services/message-persistence/src/main/kotlin/no/thurmann/messagepoc/auth/SecurityConfig.kt.
export const CSP = [
  "default-src 'self'",
  "script-src 'self' https://accounts.google.com/gsi/client",
  'frame-src https://accounts.google.com/gsi/',
  "connect-src 'self' https://accounts.google.com/gsi/",
  "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style",
  "img-src 'self' data: https:",
  "object-src 'none'",
  "base-uri 'self'",
].join('; ');
