# pr-review

[![standard-readme compliant](https://img.shields.io/badge/readme%20style-standard-brightgreen.svg?style=flat-square)](https://github.com/RichardLitt/standard-readme)
[![node](https://img.shields.io/badge/node-%3E=22.0.0-green.svg)](https://nodejs.org/)
<!-- Add build, coverage, and npm badges here when available -->

> Monorepo for PR Review platform — a modern, best-practices TypeScript/Node.js web application, featuring client, server, and shared workspaces with robust tooling for development and code review automation.

---

## Screenshot

A sample PR Review session in the app:

![Screenshot of PR Review app interface](/assets/README_screenshot.png)

## Table of Contents

- [pr-review](#pr-review)
  - [Screenshot](#screenshot)
  - [Table of Contents](#table-of-contents)
  - [Project Structure](#project-structure)
  - [Prerequisites](#prerequisites)
  - [Installation](#installation)
  - [Scripts](#scripts)
    - [Build](#build)
    - [Development](#development)
    - [Lint \& Format](#lint--format)
    - [Testing](#testing)
  - [Development Usage](#development-usage)
  - [Key Features](#key-features)
  - [Server Configuration \& Integrations](#server-configuration--integrations)
    - [1. Point to a Repository](#1-point-to-a-repository)
    - [2. Override the LLM Model](#2-override-the-llm-model)
    - [3. GitHub Authentication (Required)](#3-github-authentication-required)
    - [4. Opencode Integration (Optional)](#4-opencode-integration-optional)
  - [Manual LLM Workflow](#manual-llm-workflow)

---

## Project Structure

This is a JavaScript/TypeScript monorepo managed with [npm workspaces](https://docs.npmjs.com/cli/v7/using-npm/workspaces). Each package has its own scope and purpose:

```
pr-review/
├── packages
│   ├── client   # React web application (Vite, Tailwind)
│   ├── server   # Express-based API server
│   └── shared   # Shared types and logic (used by both client and server)
├── AGENTS.md    # Contributor/agent guidelines and workflows
├── package.json # Monorepo configs and root scripts
└── ...
```

## Prerequisites

- [Node.js](https://nodejs.org/) >=22.0.0

## Installation

Clone the repository and install dependencies for all workspaces:

```bash
# Clone the repository
git clone https://github.com/your-org/pr-review.git
cd pr-review

# Install dependencies for all packages
npm install
```

## Scripts

All scripts are run from the monorepo root. (See `package.json` for more details.)

### Build

```bash
npm run build          # Build all packages
```

- To build only one package:

```bash
npm run build -w packages/client   # or server, shared
```

### Development

```bash
npm run dev            # Run client and server in watch mode (concurrently)
```

Or run each workspace individually:

```bash
npm run dev -w packages/client     # Start client (Vite)
npm run dev -w packages/server     # Start server (Express)
```

### Lint & Format

```bash
npm run lint           # Lint codebase with Biome
npm run lint:fix       # Auto-fix lint errors
npm run format         # Format codebase
npm run format:check   # Check formatting
```

### Testing

```bash
npm test               # Run all tests with Vitest
npm run test:watch     # Watch mode
npm run test:coverage  # Coverage report
npm run test:ui        # Interactive mode (Vitest UI)
```

## Development Usage

- *Client*: Modern React (18+), Vite, TailwindCSS, React Router, TanStack React Virtual
- *Server*: Express, TS, better-sqlite3, Octokit, OpenCode SDK
- *Shared*: Common types/modules reused on client and server

All apps follow strict TypeScript, formatting and style guidelines (see [AGENTS.md](./AGENTS.md) for further details).

## Key Features

- **Tag-based review** -- the LLM (or the reviewer manually) splits a PR's diff into thematic tags (e.g., "database", "birthdate-validation-fix", "tests") so the reviewer can examine one concern at a time instead of reviewing files linearly.
- **Branch metadata** -- the dashboard and review page display source/target branch, commit count, and last sync time for each PR.
- **SHA-based git operations** -- diffs and logs are computed from exact commit SHAs fetched from GitHub, without creating local branches. This ensures reproducibility even when the target branch advances.
- **Optional LLM** -- the server starts and is fully usable without an LLM configured. Set `LLM_MODEL` to enable automated analysis, or use the manual workflow described below.
- **Manual LLM workflow** -- download a self-contained tagging prompt, paste it into any LLM (e.g., VS Code Copilot Chat), and upload the JSON result back into the app. See [Manual LLM Workflow](#manual-llm-workflow) for details.

## Server Configuration & Integrations

The server requires additional setup for repository targeting and GitHub authentication. LLM integration is optional.

### 1. Point to a Repository

By default, the server uses the current directory as its repository root. To target a different repository, set the `REPO_PATH` environment variable to the absolute path of a cloned Git repository:

```bash
REPO_PATH=/absolute/path/to/your/repo npm run dev
```
- The path **must** be a local clone of a Git repository with an `origin` remote set.

### 2. Override the LLM Model

You can select a Large Language Model (LLM) at startup by setting the `LLM_MODEL` environment variable in the format `provider/model`:

```bash
LLM_MODEL=openai/gpt-4-1106-preview npm run dev
```
- Available models are printed on server startup. Examples: `openai/gpt-4-turbo`, `local/my-custom-model`, etc.
- When `LLM_MODEL` is **not set**, the server starts without LLM capabilities. The "Analyze with LLM" button is hidden in the UI, and the analyze endpoint returns 503. All other functionality (sync, review, manual analysis) works normally.

### 3. GitHub Authentication (Required)

- The server requires access to a valid GitHub authentication token to fetch repository/pull request data.
- Authentication is automatically managed via the [GitHub CLI](https://cli.github.com/):
  1. Install the `gh` CLI if not already installed.
  2. Run `gh auth login` and follow the prompts to authenticate for your target GitHub host (e.g., `github.com`).
  3. The server will use this token at runtime—no need to manually pass it in most cases.

### 4. Opencode Integration (Optional)

- The server uses [Opencode](https://opencode.ai) for LLM integration. It must be installed and configured on the host machine if you want to use the automated "Analyze with LLM" feature.
- If `LLM_MODEL` is not set or Opencode is not available, the server starts without LLM capabilities. You can still use the [manual LLM workflow](#manual-llm-workflow).
- Please refer to [Opencode docs](https://opencode.ai) for installation and configuration instructions.

## Manual LLM Workflow

If you don't have Opencode configured, or prefer to use a different LLM (e.g., VS Code Copilot Chat, ChatGPT), you can analyze PRs manually:

1. **Download the prompt** -- on the review page, click "Download Prompt" in the toolbar. This downloads a self-contained `.txt` file with the full tagging prompt and all diff chunks included.
2. **Paste into your LLM** -- open the `.txt` file and paste its contents into your preferred LLM chat interface.
3. **Get the JSON response** -- the LLM will respond with a JSON object containing tag definitions and chunk assignments. Save this as a `.json` file, or ask your LLM agent to save the output directly as a JSON file.
4. **Upload the results** -- back on the review page, click "Upload Results" and select the `.json` file. The system validates the structure and stores the tags, replacing any existing tags for the affected chunks.

The imported JSON must match the `RawTaggingResult` format (snake_case fields). The system requires at least 50% of chunks to match by file path and chunk index.
