# AgentFlow Kanban

AI-Powered Multi-Agent Task Orchestration — a full-stack kanban board for managing AI agent workflows.

## Architecture

- **Frontend**: Single-page kanban UI (`kanban.html`) with drag-and-drop, real-time WebSocket updates
- **Backend**: Express.js server with REST API + WebSocket for live sync
- **Database**: SQLite via better-sqlite3 for persistent task storage
- **Docker**: Ready to containerize with included Dockerfile

## Quick Start

```bash
# Install dependencies
npm install

# Seed sample data (optional)
node seed-data.js

# Start the server
npm start
```

Then open `http://localhost:3000` in your browser.

## Features

- Drag-and-drop kanban columns (Backlog, In Progress, Review, Done)
- Multi-agent task assignment and orchestration
- Real-time updates via WebSocket
- Task creation, editing, deletion
- Priority levels and status tracking
- Docker-ready deployment

## Tech Stack

- Node.js (>=18)
- Express 4
- better-sqlite3
- WebSocket (ws)
- Vanilla JS frontend with Tailwind CSS

## License

MIT — Thomas Willner
