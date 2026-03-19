# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Clowder AI, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, please email: **security@clowder.ai** (or open a private security advisory on GitHub)

We will acknowledge your report within 48 hours and provide a timeline for a fix.

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest `main` | Yes |
| Older releases | Best effort |

## Security Model

Clowder AI orchestrates AI agents that have access to code, files, and external services. Our security model is built around **Iron Laws** — non-negotiable constraints enforced in code, not just prompts.

### Iron Laws

1. **Data Sanctuary**
   - Production data stores are isolated from development environments
   - Development instances use separate ports/databases (e.g., Redis 6398 for dev, not production 6399)
   - Agents in development mode cannot access production data

2. **No Self-Review**
   - An agent cannot approve its own code changes
   - Cross-model-family review is preferred (e.g., Claude reviews GPT's code)
   - Same-family different-individual is an acceptable fallback

3. **Identity Immutability**
   - Agents cannot impersonate other agents
   - Identity is injected by the system, not self-declared
   - Model family and capabilities are hard constraints

### Security Boundaries

| Boundary | Enforcement |
|----------|------------|
| Agent ↔ Production data | Port isolation + environment checks |
| Agent ↔ Agent identity | System-level injection, not prompt-level |
| Agent ↔ External services | API key management via environment variables |
| User input ↔ Agent execution | Input sanitization + capability restrictions |

### What We Scan For

The sync pipeline (`scripts/sync-to-opensource.sh`) includes a layered security scan:

- **API key values**: Zero tolerance in source code (test files with fake keys are allowed)
- **Personal information**: Checked in all non-test source files
- **Environment variable names**: Warning only (code legitimately reads env vars)
- **Denylist patterns**: `.env`, `.pem`, `.key`, `.p12`, `cookies.json`, `dump.rdb`

### Responsible Disclosure

We follow a 90-day disclosure timeline:
1. You report the vulnerability privately
2. We acknowledge within 48 hours
3. We develop and test a fix
4. We release the fix and credit the reporter (unless anonymity is requested)
5. After 90 days, the vulnerability may be publicly disclosed

## Scope

The following are **in scope** for security reports:

- Authentication/authorization bypasses
- Data leaks (production data accessible in dev mode)
- Agent identity spoofing
- Prompt injection leading to unauthorized actions
- API key or secret exposure in exported/synced code
- Cross-site scripting (XSS) in the Mission Hub UI

The following are **out of scope**:

- Issues in upstream AI provider APIs (report to the provider)
- Social engineering attacks
- Denial of service via API rate limiting (handled by providers)
- Issues requiring physical access to the server

## Dependencies

We monitor dependencies for known vulnerabilities using:
- GitHub Dependabot alerts
- `pnpm audit` in CI pipeline

## Contact

- Security reports: **security@clowder.ai**
- General questions: [GitHub Discussions](https://github.com/zts212653/clowder-ai/discussions)
