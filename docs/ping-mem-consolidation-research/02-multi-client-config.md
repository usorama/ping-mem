# Multi-Client MCP Configuration Research

**Date**: 2026-03-17
**Purpose**: Document how to configure MCP servers in every major AI coding IDE/CLI tool, with ping-mem-specific examples.

---

## Table of Contents

1. [MCP Specification Overview](#1-mcp-specification-overview)
2. [Claude Code (Anthropic CLI)](#2-claude-code-anthropic-cli)
3. [Antigravity IDE](#3-antigravity-ide)
4. [VS Code (Copilot, Continue, Cline)](#4-vs-code-copilot-continue-cline)
5. [Codex CLI (OpenAI)](#5-codex-cli-openai)
6. [OpenCode CLI](#6-opencode-cli)
7. [Cursor IDE](#7-cursor-ide)
8. [Windsurf (Codeium)](#8-windsurf-codeium)
9. [Transport Support Matrix](#9-transport-support-matrix)
10. [ping-mem Universal Config Templates](#10-ping-mem-universal-config-templates)

---

## 1. MCP Specification Overview

### Current Specification Version

The MCP specification (as of 2026-03-17) defines **two standard transports**:

| Transport | Status | Description |
|-----------|--------|-------------|
| **stdio** | Current | Client launches server as subprocess; messages over stdin/stdout |
| **Streamable HTTP** | Current | Server as independent process; HTTP POST/GET with optional SSE streaming |
| **HTTP+SSE** | **Deprecated** (was in 2024-11-05 spec) | Replaced by Streamable HTTP |

### Protocol Version Header

HTTP-based transports must include `MCP-Protocol-Version: <version>` header on all requests after initialization. Example: `MCP-Protocol-Version: 2025-06-18`.

### Transport Details

**stdio**: Client launches the MCP server as a subprocess. The server reads JSON-RPC messages from `stdin` and writes responses to `stdout`. Messages are newline-delimited and must not contain embedded newlines. `stderr` is used for logging only.

**Streamable HTTP**: The server exposes a single HTTP endpoint (e.g., `https://example.com/mcp`) supporting both POST and GET methods. POST sends JSON-RPC messages; GET opens an SSE stream for server-initiated communication. Supports session management via `MCP-Session-Id` header. Backwards-compatible with the deprecated HTTP+SSE transport.

**Key security requirements for Streamable HTTP**:
- Servers MUST validate the `Origin` header (prevent DNS rebinding)
- Servers SHOULD bind to localhost only when running locally
- Servers SHOULD implement proper authentication

### MCP Features (Capabilities)

Clients may support varying subsets of MCP features: Resources, Prompts, Tools, Discovery, Instructions, Sampling, Roots, Elicitation, CIMD, DCR, Tasks, Apps.

---

## 2. Claude Code (Anthropic CLI)

### Config File Paths

| Scope | Path | Format |
|-------|------|--------|
| **Global (user)** | `~/.claude/mcp.json` | JSON |
| **Project** | `.claude/mcp.json` (in project root) | JSON |

### JSON Format

```json
{
  "mcpServers": {
    "<server-name>": {
      "command": "<executable>",
      "args": ["<arg1>", "<arg2>"],
      "env": {
        "KEY": "value"
      }
    }
  }
}
```

### Transport Types

| Transport | Supported | Config Key |
|-----------|-----------|------------|
| stdio | Yes | `command` + `args` |
| HTTP (Streamable HTTP) | Yes | `type: "http"` + `url` |
| SSE | Yes (legacy) | `type: "sse"` + `url` |

### ping-mem Configuration Examples

**stdio transport** (recommended for local dev):
```json
{
  "mcpServers": {
    "ping-mem": {
      "command": "bun",
      "args": [
        "run",
        "/Users/umasankr/Projects/ping-mem/dist/mcp/cli.js"
      ],
      "env": {
        "PING_MEM_DB_PATH": "~/.ping-mem/ping-mem.db",
        "NEO4J_URI": "bolt://localhost:7687",
        "NEO4J_USERNAME": "neo4j",
        "NEO4J_PASSWORD": "your-password",
        "QDRANT_URL": "http://localhost:6333",
        "QDRANT_COLLECTION_NAME": "ping-mem-vectors"
      }
    }
  }
}
```

**HTTP transport** (for remote/shared server):
```json
{
  "mcpServers": {
    "ping-mem": {
      "type": "http",
      "url": "http://localhost:3003/mcp"
    }
  }
}
```

### Environment Variable Support

Yes. Defined in the `env` object per server. Variables are passed to the subprocess environment.

### Tool Discovery

Yes. Claude Code calls `tools/list` on connection and discovers all available tools automatically. Tools appear as `mcp__<server-name>__<tool-name>` in the agent context.

### Limitations

- Project-level `.claude/mcp.json` requires `claude` CLI restart to pick up changes.
- Streamable HTTP URL transport did not work reliably with SSE-transport servers (verified 2026-03-15). Use `type: "http"` only with servers running REST/streamable-http transport.
- No `envFile` support (unlike Cursor). Environment variables must be inline.

---

## 3. Antigravity IDE

### Status: Limited Public Documentation

Antigravity (antigravityai.co) is an AI-native IDE. As of 2026-03-17, their public documentation and website are not accessible (ECONNREFUSED). No public documentation was found detailing MCP configuration specifics.

### What Is Known

- Antigravity is listed in MCP ecosystem discussions as an AI IDE with potential MCP support.
- No public config file format, settings path, or MCP integration documentation has been published.
- The IDE appears to be in early access or private beta.

### Recommendation

Monitor the Antigravity documentation at `https://www.antigravityai.co` and their GitHub presence for future MCP configuration announcements. If MCP support exists, it likely follows the standard `mcpServers` JSON format given the ecosystem convergence.

---

## 4. VS Code (Copilot, Continue, Cline)

### 4a. GitHub Copilot (Native VS Code MCP)

VS Code natively supports MCP servers through GitHub Copilot integration.

**Config File Path**: `.vscode/mcp.json` (workspace) or User Profile settings (global)

**JSON Format**:
```json
{
  "servers": {
    "<server-name>": {
      "command": "<executable>",
      "args": ["<arg1>", "<arg2>"]
    }
  }
}
```

Note: The key is `"servers"` (NOT `"mcpServers"` like most other clients).

**Transport Types**:

| Transport | Supported | Config |
|-----------|-----------|--------|
| stdio | Yes | `"command"` + `"args"` |
| HTTP | Yes | `"type": "http"` + `"url"` |

**ping-mem Example (stdio)**:
```json
{
  "servers": {
    "ping-mem": {
      "command": "bun",
      "args": ["run", "/Users/umasankr/Projects/ping-mem/dist/mcp/cli.js"]
    }
  }
}
```

**ping-mem Example (HTTP)**:
```json
{
  "servers": {
    "ping-mem": {
      "type": "http",
      "url": "http://localhost:3003/mcp"
    }
  }
}
```

**Features**:
- IntelliSense support in the mcp.json editor
- Sandboxing option: `"sandboxEnabled": true` (macOS/Linux only)
- Auto-start on config change: `chat.mcp.autoStart` experimental setting
- Tool discovery: Yes, via `tools/list`

**Limitations**:
- Avoid hardcoding API keys; use VS Code input variables instead
- MCP tools are available in Copilot Chat agent mode

### 4b. Continue Extension

**Config File Path**: `.continue/mcpServers/` directory (workspace level)

**Format**: YAML (primary) or JSON (also accepted)

**YAML Format**:
```yaml
name: ping-mem
version: 0.0.1
schema: v1
mcpServers:
  - name: ping-mem
    command: bun
    args:
      - run
      - /Users/umasankr/Projects/ping-mem/dist/mcp/cli.js
    env:
      PING_MEM_DB_PATH: ~/.ping-mem/ping-mem.db
```

**JSON Format** (also supported -- Continue auto-detects Claude/Cursor/Cline JSON configs placed in the mcpServers directory):
```json
{
  "mcpServers": {
    "ping-mem": {
      "command": "bun",
      "args": ["run", "/Users/umasankr/Projects/ping-mem/dist/mcp/cli.js"],
      "env": {
        "PING_MEM_DB_PATH": "~/.ping-mem/ping-mem.db"
      }
    }
  }
}
```

**Transport Types**:

| Transport | Supported | Config |
|-----------|-----------|--------|
| stdio | Yes | `type: stdio` + `command` + `args` |
| SSE | Yes | `type: sse` + `url` |
| Streamable HTTP | Yes | `type: streamable-http` + `url` |

**ping-mem Example (SSE/HTTP)**:
```yaml
name: ping-mem-remote
version: 0.0.1
schema: v1
mcpServers:
  - name: ping-mem
    type: streamable-http
    url: http://localhost:3003/mcp
```

**Tool Discovery**: Yes, via `tools/list`.

**Limitations**:
- MCP tools can only be used in **agent mode** (not autocomplete or chat mode).
- Environment variable support via `env` field per server.

### 4c. Cline Extension

**Config File Path**: Managed via Cline's VS Code settings UI. The internal config is stored at:
- `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json` (macOS)
- `~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json` (Linux)

**JSON Format**:
```json
{
  "mcpServers": {
    "<server-name>": {
      "command": "<executable>",
      "args": ["<arg1>", "<arg2>"],
      "env": {
        "KEY": "value"
      }
    }
  }
}
```

**Transport Types**:

| Transport | Supported | Config |
|-----------|-----------|--------|
| stdio | Yes | `command` + `args` |
| SSE | Yes | `url` field |

**ping-mem Example**:
```json
{
  "mcpServers": {
    "ping-mem": {
      "command": "bun",
      "args": ["run", "/Users/umasankr/Projects/ping-mem/dist/mcp/cli.js"],
      "env": {
        "PING_MEM_DB_PATH": "~/.ping-mem/ping-mem.db"
      }
    }
  }
}
```

**Tool Discovery**: Yes. Cline discovers tools on connection and presents them in the MCP Servers panel.

**Limitations**:
- Configuration is primarily managed through the Cline UI (MCP Servers panel), not by editing files directly.
- Streamable HTTP support status is uncertain; SSE and stdio are confirmed.
- No `envFile` support.

---

## 5. Codex CLI (OpenAI)

### Config File Path

| Scope | Path | Format |
|-------|------|--------|
| **Global** | `~/.codex/config.toml` | TOML |
| **Project** | `.codex/config.toml` | TOML |

### TOML Format

Codex uses TOML format (unique among MCP clients).

**stdio server**:
```toml
[mcp_servers.ping-mem]
command = "bun"
args = ["run", "/Users/umasankr/Projects/ping-mem/dist/mcp/cli.js"]
env = { PING_MEM_DB_PATH = "~/.ping-mem/ping-mem.db" }
```

**Streamable HTTP server**:
```toml
[mcp_servers.ping-mem]
url = "http://localhost:3003/mcp"
```

### CLI Configuration Commands

```bash
# Add stdio server
codex mcp add ping-mem -- bun run /Users/umasankr/Projects/ping-mem/dist/mcp/cli.js

# Interactive TUI
# Type /mcp within Codex session
```

### Transport Types

| Transport | Supported | Config |
|-----------|-----------|--------|
| stdio | Yes | `command` + `args` |
| Streamable HTTP | Yes | `url` |
| SSE | Not documented | |

### Advanced Configuration Options

```toml
[mcp_servers.ping-mem]
command = "bun"
args = ["run", "/Users/umasankr/Projects/ping-mem/dist/mcp/cli.js"]
env = { PING_MEM_DB_PATH = "~/.ping-mem/ping-mem.db" }
startup_timeout_sec = 10
tool_timeout_sec = 60
enabled = true
required = false
# enabled_tools = ["codebase_search", "context_save"]  # whitelist specific tools
# disabled_tools = ["codebase_ingest"]                  # blacklist specific tools
```

**HTTP server with authentication**:
```toml
[mcp_servers.ping-mem-prod]
url = "https://ping-mem.ping-gadgets.com/mcp"
bearer_token_env_var = "PING_MEM_API_KEY"
# http_headers = { "X-Custom-Header" = "value" }
```

### OAuth Support

Codex supports OAuth for MCP servers:
```bash
codex mcp login ping-mem-prod
```
Configurable via `mcp_oauth_callback_port` and `mcp_oauth_callback_url`.

### Tool Discovery

Yes. Codex discovers tools via `tools/list` on server connection.

### AGENTS.md (Related but Separate)

AGENTS.md provides instructions to Codex (similar to CLAUDE.md for Claude Code). It does NOT configure MCP servers, but provides project context and working agreements. Discovery order:
1. `~/.codex/AGENTS.override.md` or `~/.codex/AGENTS.md` (global)
2. `AGENTS.md` files walking from git root toward current directory (project)

Files are concatenated; closer files override earlier ones.

### Limitations

- TOML format is unique to Codex; cannot share config files with other clients directly.
- No `envFile` support; use `env` table or `env_vars` (forwards from shell environment).
- Codex runs in a sandboxed environment; MCP servers launched via stdio run within the sandbox.

---

## 6. OpenCode CLI

### Config File Paths (Precedence Order, Later Overrides Earlier)

| Priority | Path | Description |
|----------|------|-------------|
| 1 | `.well-known/opencode` endpoint | Remote config |
| 2 | `~/.config/opencode/opencode.json` | Global config |
| 3 | `OPENCODE_CONFIG` env var | Custom path |
| 4 | `opencode.json` (project root) | Project config |
| 5 | `.opencode/` directory | Agents, commands, plugins |
| 6 | `OPENCODE_CONFIG_CONTENT` env var | Inline config |

### JSON Format (JSONC supported)

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "ping-mem": {
      "command": "bun",
      "args": ["run", "/Users/umasankr/Projects/ping-mem/dist/mcp/cli.js"],
      "env": {
        "PING_MEM_DB_PATH": "~/.ping-mem/ping-mem.db"
      }
    }
  }
}
```

Note: The top-level key is `"mcp"` (NOT `"mcpServers"`).

### Variable Substitution

```json
{
  "mcp": {
    "ping-mem-prod": {
      "url": "https://ping-mem.ping-gadgets.com/mcp",
      "env": {
        "PING_MEM_API_KEY": "{env:PING_MEM_API_KEY}",
        "SECRET": "{file:~/.creds/ping-mem-key.txt}"
      }
    }
  }
}
```

Supports:
- `{env:VARIABLE_NAME}` -- reference environment variables
- `{file:path/to/file}` -- include file contents (useful for API keys)

### Transport Types

| Transport | Supported | Config |
|-----------|-----------|--------|
| stdio | Yes | `command` + `args` |
| HTTP | Likely (via `url`) | `url` field |

### Tool Discovery

Yes, via standard MCP `tools/list`.

### Limitations

- Documentation for MCP-specific configuration is sparse; the `mcp` config key is documented at a high level.
- Exact transport type field names and HTTP configuration options are not fully documented.
- Supports mDNS service discovery, which could auto-discover local MCP servers.

---

## 7. Cursor IDE

### Config File Paths

| Scope | Path | Format |
|-------|------|--------|
| **Project** | `.cursor/mcp.json` | JSON |
| **Global** | `~/.cursor/mcp.json` | JSON |

### JSON Format

**stdio server**:
```json
{
  "mcpServers": {
    "ping-mem": {
      "command": "bun",
      "args": ["run", "/Users/umasankr/Projects/ping-mem/dist/mcp/cli.js"],
      "env": {
        "PING_MEM_DB_PATH": "~/.ping-mem/ping-mem.db",
        "NEO4J_URI": "bolt://localhost:7687",
        "NEO4J_USERNAME": "neo4j",
        "NEO4J_PASSWORD": "your-password",
        "QDRANT_URL": "http://localhost:6333"
      }
    }
  }
}
```

**HTTP/SSE server**:
```json
{
  "mcpServers": {
    "ping-mem": {
      "url": "http://localhost:3003/mcp",
      "headers": {
        "Authorization": "Bearer your-api-key"
      }
    }
  }
}
```

### Transport Types

| Transport | Supported | Config |
|-----------|-----------|--------|
| stdio | Yes | `command` + `args` |
| SSE | Yes | `url` |
| Streamable HTTP | Yes | `url` |

### Variable Interpolation

Cursor supports rich variable interpolation:

| Syntax | Description |
|--------|-------------|
| `${env:NAME}` | Environment variable |
| `${userHome}` | User home directory |
| `${workspaceFolder}` | Current workspace root |
| `${workspaceFolderBasename}` | Workspace folder name |
| `${pathSeparator}` | OS path separator |

**Example with variables**:
```json
{
  "mcpServers": {
    "ping-mem": {
      "command": "bun",
      "args": ["run", "${userHome}/Projects/ping-mem/dist/mcp/cli.js"],
      "env": {
        "PING_MEM_DB_PATH": "${userHome}/.ping-mem/ping-mem.db"
      }
    }
  }
}
```

### Additional Features

- **envFile support** (stdio only): `"envFile": ".env"` -- loads environment from a dotenv file.
- **OAuth support**: For remote servers, `"auth"` field with Client ID, Secret, scopes.
- **Tool Discovery**: Yes, via `tools/list`.

### Limitations

- `envFile` is only available for stdio servers (not HTTP/SSE).
- Remote servers use `url` field; the `type` field is optional (Cursor auto-detects).

---

## 8. Windsurf (Codeium)

### Config File Path

| Scope | Path | Format |
|-------|------|--------|
| **Global** | `~/.codeium/windsurf/mcp_config.json` | JSON |

### JSON Format

**stdio server**:
```json
{
  "mcpServers": {
    "ping-mem": {
      "command": "bun",
      "args": ["run", "/Users/umasankr/Projects/ping-mem/dist/mcp/cli.js"],
      "env": {
        "PING_MEM_DB_PATH": "~/.ping-mem/ping-mem.db",
        "NEO4J_URI": "bolt://localhost:7687",
        "NEO4J_USERNAME": "neo4j",
        "NEO4J_PASSWORD": "your-password",
        "QDRANT_URL": "http://localhost:6333"
      }
    }
  }
}
```

**HTTP/Streamable HTTP server**:
```json
{
  "mcpServers": {
    "ping-mem": {
      "serverUrl": "http://localhost:3003/mcp",
      "headers": {
        "Authorization": "Bearer your-api-key"
      }
    }
  }
}
```

Note: Windsurf uses `"serverUrl"` (NOT `"url"`) for HTTP servers.

### Transport Types

| Transport | Supported | Config |
|-----------|-----------|--------|
| stdio | Yes | `command` + `args` |
| SSE | Yes | `serverUrl` |
| Streamable HTTP | Yes | `serverUrl` |

### Variable Interpolation

Windsurf supports `${env:VARIABLE_NAME}` syntax in command, args, env, and headers fields.

### Tool Discovery

Yes, via `tools/list`.

### Limitations

- Config is global only; no per-project MCP configuration.
- Uses `serverUrl` instead of `url` (differs from Cursor/Claude Code).
- No `envFile` support documented.

---

## 9. Transport Support Matrix

| Client | stdio | SSE | Streamable HTTP | Config Format | Config Key |
|--------|-------|-----|-----------------|---------------|------------|
| **Claude Code** | Yes | Yes | Yes | JSON | `mcpServers` |
| **Antigravity** | Unknown | Unknown | Unknown | Unknown | Unknown |
| **VS Code Copilot** | Yes | Yes | Yes | JSON | `servers` |
| **Continue** | Yes | Yes | Yes | YAML/JSON | `mcpServers` (list) |
| **Cline** | Yes | Yes | Unconfirmed | JSON | `mcpServers` |
| **Codex CLI** | Yes | No (undoc.) | Yes | TOML | `mcp_servers` |
| **OpenCode** | Yes | Likely | Likely | JSON(C) | `mcp` |
| **Cursor** | Yes | Yes | Yes | JSON | `mcpServers` |
| **Windsurf** | Yes | Yes | Yes | JSON | `mcpServers` |

### Config File Location Quick Reference

| Client | Global Path | Project Path |
|--------|-------------|-------------|
| Claude Code | `~/.claude/mcp.json` | `.claude/mcp.json` |
| VS Code Copilot | User Profile settings | `.vscode/mcp.json` |
| Continue | N/A | `.continue/mcpServers/*.yaml` |
| Cline | `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json` | N/A (UI managed) |
| Codex CLI | `~/.codex/config.toml` | `.codex/config.toml` |
| OpenCode | `~/.config/opencode/opencode.json` | `opencode.json` |
| Cursor | `~/.cursor/mcp.json` | `.cursor/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | N/A |

### HTTP URL Field Name Differences

| Client | Field Name | Example |
|--------|------------|---------|
| Claude Code | `url` | `"url": "http://localhost:3003/mcp"` |
| VS Code Copilot | `url` | `"url": "http://localhost:3003/mcp"` |
| Continue | `url` | `url: http://localhost:3003/mcp` |
| Cline | `url` | `"url": "http://localhost:3003/mcp"` |
| Codex CLI | `url` | `url = "http://localhost:3003/mcp"` |
| OpenCode | `url` | `"url": "http://localhost:3003/mcp"` |
| Cursor | `url` | `"url": "http://localhost:3003/mcp"` |
| **Windsurf** | **`serverUrl`** | `"serverUrl": "http://localhost:3003/mcp"` |

---

## 10. ping-mem Universal Config Templates

### Template: stdio (Local Development)

Works for: Claude Code, Cursor, Windsurf, Cline, VS Code Copilot

```json
{
  "mcpServers": {
    "ping-mem": {
      "command": "bun",
      "args": [
        "run",
        "/Users/umasankr/Projects/ping-mem/dist/mcp/cli.js"
      ],
      "env": {
        "PING_MEM_DB_PATH": "~/.ping-mem/ping-mem.db",
        "NEO4J_URI": "bolt://localhost:7687",
        "NEO4J_USERNAME": "neo4j",
        "NEO4J_PASSWORD": "your-password",
        "QDRANT_URL": "http://localhost:6333",
        "QDRANT_COLLECTION_NAME": "ping-mem-vectors"
      }
    }
  }
}
```

Adaptation notes:
- **VS Code Copilot**: Change `mcpServers` to `servers`
- **Continue**: Convert to YAML and wrap in `mcpServers` list (with `name`, `version`, `schema` metadata)
- **Codex CLI**: Convert to TOML under `[mcp_servers.ping-mem]`
- **OpenCode**: Change `mcpServers` to `mcp`

### Template: HTTP (Remote/Shared Server)

**Claude Code / Cursor / Cline / VS Code Copilot / OpenCode**:
```json
{
  "url": "http://localhost:3003/mcp"
}
```

**Windsurf** (uses `serverUrl`):
```json
{
  "serverUrl": "http://localhost:3003/mcp"
}
```

**Codex CLI** (TOML):
```toml
[mcp_servers.ping-mem]
url = "http://localhost:3003/mcp"
bearer_token_env_var = "PING_MEM_API_KEY"
```

### Template: Production (ping-mem.ping-gadgets.com)

**Claude Code**:
```json
{
  "mcpServers": {
    "ping-mem-prod": {
      "type": "http",
      "url": "https://ping-mem.ping-gadgets.com/mcp"
    }
  }
}
```

**Cursor** (with auth headers):
```json
{
  "mcpServers": {
    "ping-mem-prod": {
      "url": "https://ping-mem.ping-gadgets.com/mcp",
      "headers": {
        "Authorization": "Bearer ${env:PING_MEM_API_KEY}"
      }
    }
  }
}
```

**Windsurf**:
```json
{
  "mcpServers": {
    "ping-mem-prod": {
      "serverUrl": "https://ping-mem.ping-gadgets.com/mcp",
      "headers": {
        "Authorization": "Bearer ${env:PING_MEM_API_KEY}"
      }
    }
  }
}
```

---

## Key Findings and Recommendations

### 1. Near-Universal JSON Format Convergence

Six of the seven documented clients use JSON for MCP configuration. The `mcpServers` key is the de facto standard (used by Claude Code, Cursor, Windsurf, Cline). Exceptions:
- **VS Code Copilot**: Uses `servers` (not `mcpServers`)
- **Codex CLI**: Uses TOML with `mcp_servers`
- **OpenCode**: Uses `mcp` key

### 2. stdio Is the Universal Transport

Every client supports stdio. This is the safest choice for maximum compatibility. ping-mem's `bun run dist/mcp/cli.js` entry point works with all clients.

### 3. HTTP Transport Fragmentation

While most clients now support HTTP-based transports, there are subtle differences:
- Windsurf uses `serverUrl` instead of `url`
- Codex uses TOML syntax with `bearer_token_env_var` for auth
- Authentication header names and mechanisms vary

### 4. Recommended ping-mem Strategy

For maximum reach:
1. **Always support stdio** -- universal compatibility, zero config friction
2. **Support Streamable HTTP** on the REST server at `/mcp` endpoint -- covers remote/shared use cases
3. **Document per-client config snippets** in ping-mem installation guide
4. **Ship a `ping-mem config generate <client>` CLI command** that outputs the correct config for each client

### 5. Variable Interpolation Is Client-Specific

Each client has its own variable syntax:
- Cursor: `${env:NAME}`, `${userHome}`, `${workspaceFolder}`
- Windsurf: `${env:NAME}`
- OpenCode: `{env:NAME}`, `{file:path}`
- Codex: Environment variables via `env_vars` forwarding

There is no universal variable interpolation standard.
