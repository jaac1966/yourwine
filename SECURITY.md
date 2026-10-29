# Security Policy

YourWine is a hackathon project (Meta Global AI Developer Hackathon, Oct–Nov 2026).

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for this repository
(Security tab → "Report a vulnerability"). Do not open a public issue
for security problems.

## Scope

- API keys never live in this repository or in any client. The backend
  (Cloudflare Worker) is the only component that holds credentials.
- Taste profiles are stored on the user's device.
- Label photos are sent to the Meta Model API for identification and are
  not stored by the backend.

Reports are reviewed by the author; there is no bug bounty.