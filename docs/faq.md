# Frequently Asked Questions

## What is Clowder AI?

Clowder AI is a **multi-agent collaboration platform** that gives AI agents persistent identity, shared memory, cross-model review, and agent-to-agent (A2A) communication.

It is not a model provider. Think of it as the layer that sits *above* your agent CLI -- Claude Code, Codex CLI, Gemini CLI, opencode, and others -- and turns a collection of independent agents into a coordinated team.

Each agent gets its own identity (a cat persona), long-term memory, and the ability to hand off work, request reviews, and collaborate across model families.

## Do I need Redis?

**No.** Redis is optional.

Run with the `--memory` flag to skip Redis entirely:

```bash
pnpm start --memory
```

In this mode all data is stored in memory and will be lost when the process stops. This is great for trying things out or local development.

For production use, Redis is recommended so that memory, threads, and task state persist across restarts.

## How do I skip the build step?

If you have already built once and have not changed any source code, use:

```bash
pnpm start --quick
```

This skips the full build and gets you running faster. Useful for quick restarts during daily use.

## Where do I add API keys?

You do **not** need to edit `.env` for API keys.

After launching Clowder AI, open the Hub and go to:

> **System Settings --> Account Configuration**
>
> **系统设置 --> 账户配置**

Add your model provider keys there. The UI stores them securely and makes them available to all agents.

## What ports does it use?

| Service  | Default Port | .env Variable      |
|----------|-------------|---------------------|
| Frontend | 3003        | `FRONTEND_PORT`     |
| API      | 3004        | `API_SERVER_PORT`   |
| Redis    | 6399        | `REDIS_PORT`        |
| MCP      | 3011        | `MCP_SERVER_PORT`   |

All ports are configurable in your `.env` file. See the [Environment Variables](configuration/environment.md) reference for details.

## Can I run it on LAN / from my phone?

Yes. Set these in your `.env`:

```env
# Bind to all interfaces so other devices can reach the server
# 绑定到所有网络接口，让局域网内其他设备可以访问
API_SERVER_HOST=0.0.0.0

# Allow private-network requests (phones/tablets on the same Wi-Fi)
# 允许局域网内的私有网络请求（同一 Wi-Fi 下的手机/平板）
CORS_ALLOW_PRIVATE_NETWORK=true
```

Then open `http://<your-machine-ip>:3003` from your phone or tablet.

## What agent CLIs are supported?

Clowder AI works with any agent CLI that supports MCP (Model Context Protocol):

- **Claude Code** (Anthropic)
- **Codex CLI** (OpenAI)
- **Gemini CLI / Antigravity CLI** (Google)
- **opencode** (multi-model)

See the project README for setup instructions for each CLI.

## How does the Bootcamp work?

Bootcamp is a guided onboarding experience where your AI team walks you through a complete feature lifecycle -- from kickoff to review to merge.

To start, launch Clowder AI and open the **Hub**. You will see the Bootcamp option on the home screen. The process is interactive: the cats will guide you step by step.

## Is this open source?

Yes. Clowder AI is released under the **MIT License**. Contributions are welcome.
