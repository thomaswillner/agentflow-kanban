#!/usr/bin/env node
/**
 * AgentFlow — Seed Data Script
 * Populates the database with real AgentFlow project tasks.
 *
 * Usage:
 *   node seed-data.js          # seed the database
 *   node seed-data.js --clear  # clear all data first, then seed
 *   node seed-data.js --reset  # alias for --clear
 */

const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'agentflow.db');

const shouldClear = process.argv.includes('--clear') || process.argv.includes('--reset');

console.log('');
console.log('  AgentFlow — Seed Data');
console.log('  ─────────────────────');
console.log(`  Database: ${DB_PATH}`);
console.log('');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Ensure tables exist (matching server.js schema exactly)
db.exec(`
  CREATE TABLE IF NOT EXISTS state (
    id TEXT PRIMARY KEY DEFAULT 'main',
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    num INTEGER NOT NULL,
    data TEXT NOT NULL,
    column_id TEXT NOT NULL DEFAULT 'inbox',
    priority TEXT NOT NULL DEFAULT 'medium',
    assignee TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS actors (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    data TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'offline',
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    action TEXT NOT NULL,
    detail TEXT,
    task_id TEXT,
    actor_id TEXT,
    nonce TEXT
  );

  CREATE TABLE IF NOT EXISTS reasoning (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    text TEXT NOT NULL,
    task_id TEXT,
    ts INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_tasks_column ON tasks(column_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee);
  CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);
  CREATE INDEX IF NOT EXISTS idx_audit_task ON audit_log(task_id);
  CREATE INDEX IF NOT EXISTS idx_reasoning_ts ON reasoning(ts);
`);

if (shouldClear) {
  console.log('  Clearing existing data...');
  db.exec('DELETE FROM tasks');
  db.exec('DELETE FROM actors');
  db.exec('DELETE FROM audit_log');
  db.exec('DELETE FROM reasoning');
  db.exec('DELETE FROM state');
  console.log('  Done.\n');
}

const now = Date.now();
const daysAgo = (d) => now - (d * 86400000);

// ─── Actors ──────────────────────────────────────────

const actors = [
  {
    id: 'actor-thomas',
    name: 'Thomas',
    type: 'human',
    status: 'online',
    endpoint: '',
    model: '',
    subAgents: [],
    role: 'Project Lead',
    avatar: 'TW'
  },
  {
    id: 'actor-claude-code',
    name: 'Claude Code',
    type: 'ai',
    status: 'online',
    endpoint: 'local://claude-code',
    model: 'claude-opus-4-6',
    subAgents: ['Coder', 'Reviewer', 'Architect'],
    role: 'AI Pair Programmer',
    avatar: 'CC'
  },
  {
    id: 'actor-openclaw',
    name: 'OpenClaw Gateway',
    type: 'ai',
    status: 'offline',
    endpoint: 'http://127.0.0.1:18789',
    model: 'openclaw-v1',
    subAgents: ['Planner', 'Executor', 'Validator'],
    role: 'Multi-Agent Orchestrator',
    avatar: 'OC'
  }
];

const upsertActor = db.prepare(`
  INSERT OR REPLACE INTO actors (id, type, name, data, status, created_at)
  VALUES (@id, @type, @name, @data, @status, @created_at)
`);

console.log('  Seeding actors...');
for (const a of actors) {
  upsertActor.run({
    id: a.id,
    type: a.type,
    name: a.name,
    data: JSON.stringify(a),
    status: a.status,
    created_at: now
  });
  console.log(`    + ${a.name} (${a.type}, ${a.status})`);
}
console.log('');

// ─── Tasks ───────────────────────────────────────────

let taskNum = 0;

const taskDefs = [
  // ── DONE ──
  {
    title: 'Build Kanban board frontend',
    description: 'Create the single-file HTML Kanban board with drag & drop, dark/light themes, and responsive layout.',
    column: 'done',
    priority: 'high',
    assignee: 'Claude Code',
    tags: ['frontend', 'core'],
    created: daysAgo(14)
  },
  {
    title: 'Implement drag & drop with pointer tracking',
    description: 'Fix HTML5 DnD click vs drag conflict using mousedown/mouseup position + time thresholds (dx<6, dy<6, dt<400ms).',
    column: 'done',
    priority: 'high',
    assignee: 'Claude Code',
    tags: ['frontend', 'bugfix'],
    created: daysAgo(10)
  },
  {
    title: 'Add state-aware drop validation',
    description: 'Color-coded drop zones (green/yellow/red) based on task state transitions. getDropValidation() returns {allowed, level, reason}.',
    column: 'done',
    priority: 'medium',
    assignee: 'Claude Code',
    tags: ['frontend', 'ux'],
    created: daysAgo(9)
  },
  {
    title: 'Create Express + SQLite backend',
    description: 'Full REST API with Express, better-sqlite3, WebSocket broadcast. Endpoints for tasks, actors, audit, reasoning, dispatch.',
    column: 'done',
    priority: 'high',
    assignee: 'Claude Code',
    tags: ['backend', 'core'],
    created: daysAgo(7)
  },
  {
    title: 'Add real agent dispatch engine',
    description: 'API_CONTRACTS for OpenClaw/CrewAI/Generic. dispatchToAgent(), pollAgentStatus(), testAgentConnection() with server-side proxy.',
    column: 'done',
    priority: 'high',
    assignee: 'Claude Code',
    tags: ['backend', 'agents'],
    created: daysAgo(6)
  },
  {
    title: 'Competitive analysis vs existing tools',
    description: 'RAG deep-dive on Vibe Kanban, KaibanJS, AgentsBoard, etc. Confirmed AgentFlow reasoning transparency panel is unique differentiator.',
    column: 'done',
    priority: 'medium',
    assignee: 'Thomas',
    tags: ['research', 'strategy'],
    created: daysAgo(8)
  },

  // ── IN REVIEW ──
  {
    title: 'Safe deployment script (setup.sh)',
    description: 'Pre-flight checks (no sudo, port available, disk space), auto-detects Node.js/Docker, interactive setup with start/stop scripts.',
    column: 'review',
    priority: 'high',
    assignee: 'Claude Code',
    tags: ['devops', 'deployment'],
    created: daysAgo(2)
  },

  // ── IN PROGRESS ──
  {
    title: 'Docker deployment option',
    description: 'Dockerfile with node:22-alpine, health check, non-root user. Volume mount for data persistence.',
    column: 'in_progress',
    priority: 'medium',
    assignee: 'Claude Code',
    tags: ['devops', 'docker'],
    created: daysAgo(1)
  },

  // ── TO DO (Ready) ──
  {
    title: 'Add user authentication (optional)',
    description: 'Simple token-based auth for multi-user setups. Local-only mode should still work without auth. Consider JWT or session cookies.',
    column: 'todo',
    priority: 'low',
    assignee: '',
    tags: ['backend', 'security'],
    created: daysAgo(3)
  },
  {
    title: 'Reasoning panel visualization',
    description: 'Render CoT/ToT/RAG reasoning traces in the task detail panel. Tree view for ToT branches, timeline for CoT steps, source cards for RAG.',
    column: 'todo',
    priority: 'high',
    assignee: 'Claude Code',
    tags: ['frontend', 'reasoning', 'core'],
    created: daysAgo(4)
  },
  {
    title: 'WebSocket reconnect with state sync',
    description: 'When WS reconnects after disconnect, fetch full state delta from server to catch up on missed mutations. Show reconnect indicator in UI.',
    column: 'todo',
    priority: 'medium',
    assignee: 'Claude Code',
    tags: ['frontend', 'backend', 'reliability'],
    created: daysAgo(3)
  },
  {
    title: 'OpenClaw Gateway integration test',
    description: 'Set up OpenClaw locally, verify dispatch/poll cycle works end-to-end. Document required OpenClaw config for AgentFlow compatibility.',
    column: 'todo',
    priority: 'high',
    assignee: 'Thomas',
    tags: ['agents', 'testing'],
    created: daysAgo(2)
  },
  {
    title: 'Mobile-responsive layout improvements',
    description: 'Kanban columns should stack vertically on small screens. Swipe gestures for column navigation. Touch-friendly drag & drop.',
    column: 'todo',
    priority: 'low',
    assignee: '',
    tags: ['frontend', 'mobile', 'ux'],
    created: daysAgo(1)
  },

  // ── BACKLOG (Inbox) ──
  {
    title: 'Task templates & presets',
    description: 'Save common task configurations as templates. One-click creation of bug report, feature request, agent task, etc.',
    column: 'inbox',
    priority: 'low',
    assignee: '',
    tags: ['frontend', 'productivity'],
    created: daysAgo(5)
  },
  {
    title: 'Gantt chart view',
    description: 'Alternative view showing tasks on a timeline with dependencies. Toggle between Kanban and Gantt. Use lightweight canvas rendering.',
    column: 'inbox',
    priority: 'low',
    assignee: '',
    tags: ['frontend', 'visualization'],
    created: daysAgo(4)
  },
  {
    title: 'Agent cost tracking',
    description: 'Track API token usage and estimated cost per agent task. Show cumulative cost in actor detail panel. Budget alerts.',
    column: 'inbox',
    priority: 'medium',
    assignee: '',
    tags: ['backend', 'agents', 'analytics'],
    created: daysAgo(3)
  },
  {
    title: 'Export board as PDF report',
    description: 'One-click export of current board state as a formatted PDF. Include task counts, agent status, audit summary, and reasoning highlights.',
    column: 'inbox',
    priority: 'low',
    assignee: '',
    tags: ['frontend', 'export'],
    created: daysAgo(2)
  },
  {
    title: 'Plugin system for custom agent types',
    description: 'Allow registering new agent API contracts via plugin files. Hot-reload plugins without server restart. Plugin marketplace concept.',
    column: 'inbox',
    priority: 'medium',
    assignee: '',
    tags: ['backend', 'agents', 'extensibility'],
    created: daysAgo(1)
  }
];

const upsertTask = db.prepare(`
  INSERT OR REPLACE INTO tasks (id, num, data, column_id, priority, assignee, created_at, updated_at)
  VALUES (@id, @num, @data, @column_id, @priority, @assignee, @created_at, @updated_at)
`);

const insertAudit = db.prepare(`
  INSERT INTO audit_log (ts, action, detail, task_id, actor_id)
  VALUES (@ts, @action, @detail, @task_id, @actor_id)
`);

console.log('  Seeding tasks...');
const seedTasks = db.transaction(() => {
  for (const def of taskDefs) {
    taskNum++;
    const id = uuidv4();
    const task = {
      id,
      num: taskNum,
      title: def.title,
      description: def.description,
      column: def.column,
      priority: def.priority,
      assignee: def.assignee,
      tags: def.tags,
      created: def.created,
      updated: def.created,
      subtasks: [],
      attachments: [],
      reasoning: [],
      retryCount: 0,
      nextTask: null
    };

    upsertTask.run({
      id,
      num: taskNum,
      data: JSON.stringify(task),
      column_id: def.column,
      priority: def.priority,
      assignee: def.assignee || null,
      created_at: def.created,
      updated_at: def.created
    });

    insertAudit.run({
      ts: def.created,
      action: 'task_created',
      detail: JSON.stringify({ title: def.title, column: def.column }),
      task_id: id,
      actor_id: def.assignee || 'system'
    });

    const colLabel = {
      inbox: 'Inbox',
      todo: 'Ready',
      in_progress: 'In Progress',
      review: 'Review',
      pending_human: 'Pending',
      failed: 'Failed',
      done: 'Done'
    };
    console.log(`    + [${(colLabel[def.column] || def.column).padEnd(11)}] #${taskNum} ${def.title}`);
  }
});

seedTasks();

// ─── Save state for frontend compatibility ───────────

const allTasks = db.prepare('SELECT data FROM tasks ORDER BY created_at ASC').all().map(r => JSON.parse(r.data));
const allActors = db.prepare('SELECT data FROM actors ORDER BY created_at ASC').all().map(r => JSON.parse(r.data));

const stateData = {
  title: 'AgentFlow',
  logoUrl: '',
  plan: 'free',
  columns: [
    { id: 'inbox', name: 'Inbox / Queued', color: '#8b949e', wipLimit: 0 },
    { id: 'todo', name: 'Ready', color: '#d29922', wipLimit: 0 },
    { id: 'in_progress', name: 'In Progress', color: '#00b4d8', wipLimit: 5 },
    { id: 'review', name: 'Review', color: '#7c3aed', wipLimit: 3 },
    { id: 'pending_human', name: 'Pending (Human)', color: '#f0883e', wipLimit: 0 },
    { id: 'failed', name: 'Failed', color: '#da3633', wipLimit: 0 },
    { id: 'done', name: 'Done', color: '#2ea043', wipLimit: 0 }
  ],
  taskCounter: taskNum,
  theme: { accent: '#00b4d8', secondary: '#7c3aed', bg: '#06090f', card: '#161b22', text: '#e6edf3', border: '#21262d' },
  settings: {
    autoRetryOnRateLimit: true,
    rateLimitCooldownSec: 60,
    maxAutoRetries: 3,
    requireCompletionDoc: true,
    enablePolling: true,
    pollingIntervalSec: 30
  }
};

db.prepare(`
  INSERT OR REPLACE INTO state (id, data, updated_at) VALUES ('main', ?, ?)
`).run(JSON.stringify(stateData), now);

console.log('');
console.log(`  Seeded ${taskDefs.length} tasks, ${actors.length} actors`);
console.log(`  State saved (task counter: ${taskNum})`);
console.log('');

// ─── Summary ─────────────────────────────────────────

const counts = {};
for (const t of taskDefs) {
  counts[t.column] = (counts[t.column] || 0) + 1;
}
console.log('  Board summary:');
console.log(`    Inbox:       ${counts.inbox || 0}`);
console.log(`    Ready:       ${counts.todo || 0}`);
console.log(`    In Progress: ${counts.in_progress || 0}`);
console.log(`    Review:      ${counts.review || 0}`);
console.log(`    Done:        ${counts.done || 0}`);
console.log('');

db.close();
console.log('  Database closed. Ready to start AgentFlow!');
console.log('');
