# Security Policy

Security fixes target the current `main` branch. Use GitHub private vulnerability
reporting for credentials, private or team-message disclosure, hidden-role
leaks, unauthorized world actions, path traversal or denial of service.

Include the affected commit, reproduction steps, expected visibility boundary
and impact. Never place a real API key, provider request, private observation or
unredacted model output in a public report.

## Deployment notice

The bundled Express service is local by default and has no authentication. It
keeps rooms and event histories in process memory, and its observer APIs can
include private channels, Agent mind state and hidden roles. Do not expose it
directly to the Internet.

A remote deployment needs authentication, authorization for observer data,
rate limiting, transport security, managed secrets, bounded room creation and
an explicit retention policy. Keep `OPENAI_API_KEY` in the process environment
or a local ignored file; it must never enter a room snapshot, SSE event, log or
commit.
