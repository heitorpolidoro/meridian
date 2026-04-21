# Meridian AI Manager

<div>
<!-- GitHub CI -->
<a href="https://github.com/heitorpolidoro/meridian/actions/workflows/nodejs-test.yml"><img src="https://github.com/heitorpolidoro/meridian/actions/workflows/nodejs-test.yml/badge.svg" alt="CI Status"></a>
<!-- GitHub Sponsors -->
<a href="https://github.com/sponsors/heitorpolidoro"><img src="https://img.shields.io/github/sponsors/heitorpolidoro?color=ea4aaa" alt="GitHub Sponsors"></a>
</div>

<div>
<!-- DeepSource -->
<a href="https://deepsource.io/gh/heitorpolidoro/meridian/"><img src="https://app.deepsource.com/gh/heitorpolidoro/meridian.svg/?label=active+issues&show_all=true" alt="DeepSource Meridian Active Issues"></a>
</div>

<div>
<!-- SonarCloud -->
<a href="https://sonarcloud.io/summary/new_code?id=heitorpolidoro_meridian"><img src="https://sonarcloud.io/api/project_badges/measure?project=heitorpolidoro_meridian&metric=alert_status" alt="SonarCloud Quality Gate"></a>
<a href="https://sonarcloud.io/summary/new_code?id=heitorpolidoro_meridian"><img src="https://sonarcloud.io/api/project_badges/measure?project=heitorpolidoro_meridian&metric=coverage" alt="SonarCloud Coverage"></a>
<a href="https://sonarcloud.io/summary/new_code?id=heitorpolidoro_meridian"><img src="https://sonarcloud.io/api/project_badges/measure?project=heitorpolidoro_meridian&metric=bugs" alt="SonarCloud Bugs"></a>
<a href="https://sonarcloud.io/summary/new_code?id=heitorpolidoro_meridian"><img src="https://sonarcloud.io/api/project_badges/measure?project=heitorpolidoro_meridian&metric=vulnerabilities" alt="SonarCloud Vulnerabilities"></a>
<a href="https://sonarcloud.io/summary/new_code?id=heitorpolidoro_meridian"><img src="https://sonarcloud.io/api/project_badges/measure?project=heitorpolidoro_meridian&metric=code_smells" alt="SonarCloud Code Smells"></a>
<a href="https://sonarcloud.io/summary/new_code?id=heitorpolidoro_meridian"><img src="https://sonarcloud.io/api/project_badges/measure?project=heitorpolidoro_meridian&metric=sqale_rating" alt="SonarCloud Maintainability"></a>
</div>

Meridian: Intelligent Project Manager with Multi-Agent Orchestration

## Overview

Meridian is a powerful, intelligent project management tool designed to orchestrate multi-agent workflows. It provides a robust architecture for managing agents, tracking tasks, monitoring filesystem changes, and gathering telemetry data.

## Features

- **Multi-Agent Orchestration:** Manage and coordinate multiple intelligent agents to handle various project tasks.
- **Context Injection:** Dynamically inject relevant context (like project standards or markdown documents) into agent sessions.
- **Filesystem Monitoring:** Watch for node filesystem changes in real-time to trigger appropriate actions.
- **Telemetry & Compliance:** Collect detailed telemetry data and calculate SDS (Standard Definition Spec) compliance scores to ensure project health and adherence to standards.
- **Markdown Support:** Built-in Markdown viewer component with syntax highlighting.
- **Real-time Communication:** Uses Socket.io for real-time updates between the client and server.

## Tech Stack

- **Backend:** Node.js, Express, Socket.io
- **Frontend:** React, Vite
- **Language:** TypeScript
- **Testing:** Vitest, React Testing Library

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (Version 22.x or 24.x recommended)
- npm (comes with Node.js)

### Installation

1. Clone the repository:
   ```bash
   git clone <repository-url>
   cd meridian
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

### Running the Application

To run both the frontend client and the backend server concurrently in development mode:

```bash
npm run dev
```

Alternatively, you can run them separately:
- **Server only:** `npm run dev:server`
- **Client only:** `npm run dev:client`

### Building for Production

To build the client application for production:

```bash
npm run build
```

To start the production server:

```bash
npm start
```

### Testing

The project uses Vitest for testing. To run the test suite:

```bash
npm test
```

## Architecture highlights

- `AgentRegistryService`: Registers and manages the lifecycle of various agents.
- `BootstrappingService`: Handles project initialization and loading of standards.
- `ContextInjectionService`: Injects context into the agent environments safely.
- `TelemetryCollectorService`: Gathers metrics about system performance and agent actions.
- `NodeFilesystemWatcher`: Monitors the file system for real-time reactivity.
- `SessionManagerService`: Manages user and agent sessions.
