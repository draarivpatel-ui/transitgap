# Security policy

## Reporting a vulnerability

Use the private GitHub Security Advisory form at [Report a vulnerability](https://github.com/draarivpatel-ui/transitgap/security/advisories/new). Do not open a public issue, pull request or discussion with exploit details.

Never include a live secret, token, cookie, private key, victim hostname or proprietary payload in a report. Use synthetic values and redacted transcripts.

## Supported versions

| Version | Status |
| --- | --- |
| latest `main` | Supported |

Security fixes are applied to the latest state of the default branch.

## Scope

This policy covers the static TransitGap browser application, including fictional-city model data, plan allocation controls, service worker caching, share links, import and export verification, policy briefs and browser rendering.

In scope:

- A cross-site scripting or HTML injection path through neighborhood data, imported bundles, generated briefs, share links or browser rendering.
- A service worker or cache-control flaw that serves attacker-controlled application code across an update.
- A share-link decoder, digest verifier or serialization flaw that bypasses validation, corrupts another plan, or executes attacker-controlled code.
- A CSV, GeoJSON, Markdown or JSON export flaw that makes generated output execute a formula or script when opened.

Out of scope:

- Browser vulnerabilities, operating system compromise or physical access to the machine.
- Damage caused by modified copies of the static application that do not come from this repository.
- The planning-model limits documented for fictional cities and synthetic costs, unless a report shows a specific validation or output integrity failure.

## Coordinated disclosure

- Acknowledgment: within 3 business days.
- Initial triage: within 14 calendar days.
- Fix or mitigation target: within 90 calendar days for confirmed reports.
- Coordinated public disclosure: up to 90 days by default, adjusted by mutual agreement when exploitation or user risk requires a different date.
