# Security Policy

## Supported branch

Security fixes are applied to the current `main` branch.

## Reporting a vulnerability

Do not open a public issue for vulnerabilities involving:

- credentials or provider authentication;
- access to full/private artifacts;
- hidden-role or scoped-observation disclosure;
- checkpoint, fork, replay, or artifact-integrity bypasses;
- public capability escalation;
- path traversal, symlink, or local artifact-store isolation;
- denial of service against model-backed execution.

Use GitHub private vulnerability reporting for this repository when available.
If private reporting is unavailable, contact the repository maintainers through
a private channel and provide only the minimum information needed to establish
contact before sending exploit details.

Include:

- affected commit and component;
- reproduction steps;
- expected and observed security boundary;
- impact on canonical artifacts, private projections, or environment authority;
- a suggested remediation, if known.

Never include real API keys, provider request payloads, private model output, or
unredacted research artifacts in a report.

## Deployment notice

The bundled Express server is a local research and development service. Its
loopback defaults and request-scoped capability gates are not a substitute for
authentication in an Internet-facing deployment. Remote deployments need an
authenticated and rate-limited reverse proxy, transport security, secret
management, storage isolation, and an explicit artifact-retention policy.
