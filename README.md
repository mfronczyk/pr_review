# pr-review

[![standard-readme compliant](https://img.shields.io/badge/readme%20style-standard-brightgreen.svg?style=flat-square)](https://github.com/RichardLitt/standard-readme)
[![node](https://img.shields.io/badge/node-%3E=18.0.0-green.svg)](https://nodejs.org/)  
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
  - [Server Configuration \& Integrations](#server-configuration--integrations)
    - [1. Point to a Repository](#1-point-to-a-repository)
    - [2. Override the LLM Model](#2-override-the-llm-model)
    - [3. GitHub Authentication (Required)](#3-github-authentication-required)
    - [4. Opencode Integration (Required)](#4-opencode-integration-required)

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

- [Node.js](https://nodejs.org/) >=18.0.0
- [npm](https://www.npmjs.com/) >=7 (workspaces enabled)

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

## Server Configuration & Integrations

The server requires additional setup for repository targeting, LLM model overrides, and authentication with GitHub and Opencode.

### 1. Point to a Repository

By default, the server uses the current directory as its repository root. To target a different repository, set the `REPO_PATH` environment variable to the absolute path of a cloned Git repository:

```bash
REPO_PATH=/absolute/path/to/your/repo npm run dev
```
- The path **must** be a local clone of a Git repository with an `origin` remote set.

### 2. Override the LLM Model

You can select a different Large Language Model (LLM) at startup by setting the `LLM_MODEL` environment variable in the format `provider/model`:

```bash
LLM_MODEL=openai/gpt-4-1106-preview npm run dev
```
- Available models are printed on server startup. Examples: `openai/gpt-4-turbo`, `local/my-custom-model`, etc.

### 3. GitHub Authentication (Required)

- The server requires access to a valid GitHub authentication token to fetch repository/pull request data.
- Authentication is automatically managed via the [GitHub CLI](https://cli.github.com/):
  1. Install the `gh` CLI if not already installed.
  2. Run `gh auth login` and follow the prompts to authenticate for your target GitHub host (e.g., `github.com`).
  3. The server will use this token at runtime—no need to manually pass it in most cases.

### 4. Opencode Integration (Required)

- The server depends on [Opencode](https://opencode.ai) for LLM integration and must be installed/configured on the host machine.
- If Opencode is missing or not configured properly, the server startup will fail with an explanatory error.
- Please refer to [Opencode docs](https://opencode.ai) for installation and configuration instructions.
