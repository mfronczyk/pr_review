# pr-review

[![standard-readme compliant](https://img.shields.io/badge/readme%20style-standard-brightgreen.svg?style=flat-square)](https://github.com/RichardLitt/standard-readme)
[![node](https://img.shields.io/badge/node-%3E=24.9.0-green.svg)](https://nodejs.org/)
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
  - [Production Deployment](#production-deployment)
  - [Key Features](#key-features)
  - [Server Configuration \& Integrations](#server-configuration--integrations)
    - [1. Point to a Repository](#1-point-to-a-repository)
    - [2. GitHub Authentication (Required)](#2-github-authentication-required)
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

- [Node.js](https://nodejs.org/) >=24.9.0

No native dependencies or C++ build tools are required. The server uses Node.js's built-in `node:sqlite` module (`DatabaseSync`) for data storage, so SQLite is available out of the box — no compilation step, no platform-specific binaries, and no extra flags needed.

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
- *Server*: Express, TS, node:sqlite (DatabaseSync), Octokit
- *Shared*: Common types/modules reused on client and server

All apps follow strict TypeScript, formatting and style guidelines (see [AGENTS.md](./AGENTS.md) for further details).

## Production Deployment

The server has no native dependencies — only pure JavaScript packages — so it runs on any platform with Node.js >=24.9.0 without build tools.

```bash
# Install production dependencies only (skips test/dev tooling)
npm install --omit=dev

# Build all packages
npm run build

# Start the server
REPO_PATH=/path/to/your/repo node packages/server/dist/index.js
```

The production dependency footprint for the server is minimal:

| Package | Purpose |
|---|---|
| `express` | HTTP server |
| `@octokit/rest` | GitHub API client |
| `@pr-review/shared` | Shared types (workspace package) |
| *(built-in)* `node:sqlite` | SQLite database via `DatabaseSync` |

## Key Features

- **Tag-based review** -- the LLM (or the reviewer manually) splits a PR's diff into thematic tags (e.g., "database", "birthdate-validation-fix", "tests") so the reviewer can examine one concern at a time instead of reviewing files linearly.
- **Branch metadata** -- the dashboard and review page display source/target branch, commit count, and last sync time for each PR.
- **SHA-based git operations** -- diffs and logs are computed from exact commit SHAs fetched from GitHub, without creating local branches. This ensures reproducibility even when the target branch advances.
- **Manual LLM workflow** -- download a self-contained tagging prompt, paste it into any LLM (e.g., VS Code Copilot Chat, ChatGPT), and upload the JSON result back into the app. See [Manual LLM Workflow](#manual-llm-workflow) for details.

## Server Configuration & Integrations

The server requires additional setup for repository targeting and GitHub authentication.

### 1. Point to a Repository

By default, the server uses the current directory as its repository root. To target a different repository, set the `REPO_PATH` environment variable to the absolute path of a cloned Git repository:

```bash
REPO_PATH=/absolute/path/to/your/repo npm run dev
```
- The path **must** be a local clone of a Git repository with an `origin` remote set.
- The repository does **not** need to be checked out at any particular branch. The app fetches exact PR commit SHAs from GitHub and retrieves them from `origin` as needed — no local branches are created or required, and the working tree state does not matter.
- The SQLite database is automatically created at `<REPO_PATH>/.pr-review/data.db` inside the target repository folder.

### 2. GitHub Authentication (Required)

- The server requires access to a valid GitHub authentication token to fetch repository/pull request data.
- Authentication is automatically managed via the [GitHub CLI](https://cli.github.com/):
  1. Install the `gh` CLI if not already installed.
  2. Run `gh auth login` and follow the prompts to authenticate for your target GitHub host (e.g., `github.com`).
  3. The server will use this token at runtime—no need to manually pass it in most cases.

## Manual LLM Workflow

To analyze a PR with an LLM, use the manual workflow:

1. **Download the prompt** -- on the review page, click "Download Prompt" in the toolbar. This downloads a self-contained `.txt` file with the full tagging prompt and all diff chunks included.
2. **Paste into your LLM** -- open the `.txt` file and paste its contents into your preferred LLM chat interface.
3. **Get the JSON response** -- the LLM will respond with a JSON object containing tag definitions and chunk assignments. Save this as a `.json` file, or ask your LLM agent to save the output directly as a JSON file.
4. **Upload the results** -- back on the review page, click "Upload Results" and select the `.json` file. The system validates the structure and stores the tags, replacing any existing tags for the affected chunks.

The imported JSON must match the `RawTaggingResult` format (snake_case fields). The system requires at least 50% of chunks to match by file path and chunk index.
