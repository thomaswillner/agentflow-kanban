#!/usr/bin/env node
/**
 * AgentFlow — Full-Stack Local Server
 * Node.js + Express + SQLite + WebSocket
 *
 * Usage:
 *   npm install
 *   npm start          # → http://localhost:3000
 *   PORT=8080 npm start # custom port
 */

const express = require('express');
const Database = require('better-sqlite3');
const { WebSocketServer } = require('ws');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const http = require('http');
const fs = require('fs');

const { execSync } = require('child_process');
const os = require('os');

// ─── Config ───────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3000', 10);
// DB goes in a data/ subdirectory (created if needed) to keep things clean
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'agentflow.db');
const isDev = process.argv.includes('--dev');

// ─── Discovery Config ────────────────────────────────
const DISCOVERY_INTERVAL_MS = parseInt(process.env.DISCOVERY_INTERVAL || '30000', 10); // 30s default
const OPENCLAW_HOST = process.env.OPENCLAW_HOST || 'http://127.0.0.1:18789';
const OPENCLAW_TOKEN = process.env.OPENCLAW_TOKEN || ''; // from gateway.auth.token
const CLAUDE_SESSIONS_DIR = process.env.CLAUDE_SESSIONS_DIR ||
  path.join(os.homedir(), '.claude', 'projects');

// ─── Auth Config ──────────────────────────────────────
const AGENTFLOW_TOKEN = process.env.AGENTFLOW_TOKEN || null;

// ─── Helper Functions ─────────────────────────────────

// Check for circular dependencies
function checkDependencyCycle(taskId, deps, allTasks) {
  if (!deps || deps.length === 0) return false;
  const visited = new Set();
  const visiting = new Set();

  function hasCycle(id) {
    if (visited.has(id)) return false;
    if (visiting.has(id)) return true;

    visiting.add(id);
    const task = allTasks.find(t => t.id === id);
    if (task && task.deps) {
      for (const depId of task.deps) {
        if (hasCycle(depId)) return true;
      }
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  }

  return hasCycle(taskId);
}

// Token auth middleware
function validateToken(req, res, next) {
  // Health check always open
  if (req.path === '/api/health') return next();

  // GET endpoints are open (no auth required) - optional protection below
  if (req.method === 'GET') return next();

  // If token is not configured, allow all mutations
  if (!AGENTFLOW_TOKEN) return next();

  // Require token on POST/PUT/DELETE
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '').trim();

  if (token !== AGENTFLOW_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SYSTEM 1: AGENT CAPABILITY REGISTRY
// Defines what each agent/sub-agent IS and what it CAN DO
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const AgentRegistry = {
  // Default capability profiles for known agent types
  profiles: {
    'openclaw': {
      description: 'Multi-agent orchestrator with specialized sub-agents for different task types',
      capabilities: ['code-generation', 'research', 'analysis', 'file-operations', 'web-search'],
      canHandle: ['coding', 'research', 'analysis', 'documentation', 'testing'],
      maxConcurrent: 5,
      subAgentDefaults: {
        'Researcher': { purpose: 'Web research, data gathering, fact-checking', skills: ['web-search', 'analysis'], taskTypes: ['research', 'analysis'] },
        'Coder':      { purpose: 'Code generation, debugging, refactoring, testing', skills: ['code-generation', 'file-operations'], taskTypes: ['coding', 'testing', 'bugfix'] },
        'Analyst':    { purpose: 'Data analysis, visualization, reporting', skills: ['analysis', 'visualization'], taskTypes: ['analysis', 'reporting'] },
        'Planner':    { purpose: 'Task planning, decomposition, dependency analysis', skills: ['planning', 'analysis'], taskTypes: ['planning', 'architecture'] },
        'Executor':   { purpose: 'General task execution with tool access', skills: ['file-operations', 'code-generation'], taskTypes: ['coding', 'automation'] },
        'Validator':  { purpose: 'Testing, validation, quality assurance', skills: ['testing', 'analysis'], taskTypes: ['testing', 'review', 'qa'] },
      }
    },
    'claude-code': {
      description: 'AI pair programmer with full-stack coding, analysis, and debugging capabilities',
      capabilities: ['code-generation', 'file-operations', 'analysis', 'debugging', 'refactoring'],
      canHandle: ['coding', 'testing', 'bugfix', 'refactoring', 'documentation', 'architecture', 'review'],
      maxConcurrent: 1,
      subAgentDefaults: {
        'Coder':     { purpose: 'Write and modify code across languages', skills: ['code-generation', 'file-operations'], taskTypes: ['coding', 'bugfix'] },
        'Reviewer':  { purpose: 'Code review, best practices, security analysis', skills: ['analysis', 'testing'], taskTypes: ['review', 'qa'] },
        'Architect': { purpose: 'System design, architecture decisions, tech stack', skills: ['planning', 'analysis'], taskTypes: ['architecture', 'planning'] },
      }
    },
    'human': {
      description: 'Human team member — handles approvals, creative decisions, and manual tasks',
      capabilities: ['approval', 'creative', 'manual', 'decision-making'],
      canHandle: ['approval', 'creative', 'manual', 'decision', 'review'],
      maxConcurrent: 3,
      subAgentDefaults: {}
    }
  },

  // Resolve agent profile (from DB actor + defaults)
  resolve(actor) {
    if (!actor || typeof actor !== 'object' || !actor.id || !actor.type) {
      return { description: 'Unknown actor', capabilities: [], canHandle: [], maxConcurrent: 1, subAgents: {} };
    }

    const baseType = actor.type === 'ai' ? (
      actor.endpoint?.includes('18789') ? 'openclaw' :
      actor.name?.toLowerCase().includes('claude') ? 'claude-code' : 'generic'
    ) : actor.type;

    const profile = this.profiles[baseType] || this.profiles['human'];
    const subAgents = {};

    // Merge stored sub-agents with default profiles
    const storedSubs = actor.subAgents || actor.agents || [];
    for (const sa of storedSubs) {
      const name = typeof sa === 'string' ? sa : sa.name;
      const defaults = profile.subAgentDefaults?.[name] || {};
      subAgents[name] = {
        name,
        purpose: sa.fn || sa.purpose || defaults.purpose || 'General-purpose agent',
        skills: sa.skills || defaults.skills || [],
        taskTypes: sa.taskTypes || defaults.taskTypes || [],
        status: 'unknown',
        currentTask: null,
      };
    }

    return {
      id: actor.id,
      name: actor.name,
      type: baseType,
      description: actor.description || profile.description,
      capabilities: actor.capabilities || profile.capabilities,
      canHandle: profile.canHandle,
      maxConcurrent: profile.maxConcurrent,
      subAgents,
    };
  },

  // Match a task to the best agent/sub-agent
  suggestAssignment(task, actors) {
    const taskTags = task.tags || [];
    const taskTitle = (task.title || '').toLowerCase();
    const scores = [];

    for (const actor of actors) {
      if (actor.type === 'human' && actor.status !== 'online') continue;
      const profile = this.resolve(actor);

      // Score based on tag/taskType overlap
      let score = 0;
      for (const tag of taskTags) {
        if (profile.canHandle.includes(tag)) score += 10;
        if (profile.capabilities.includes(tag)) score += 5;
      }

      // Keyword matching on title
      const keywords = {
        coding: ['implement', 'build', 'create', 'code', 'write', 'develop', 'fix', 'bug'],
        review: ['review', 'audit', 'check', 'validate', 'verify'],
        research: ['research', 'investigate', 'analyze', 'study', 'explore'],
        testing: ['test', 'qa', 'load test', 'integration test', 'e2e'],
        architecture: ['architect', 'design', 'system', 'infrastructure'],
        documentation: ['doc', 'readme', 'guide', 'tutorial'],
      };

      for (const [type, words] of Object.entries(keywords)) {
        if (words.some(w => taskTitle.includes(w))) {
          if (profile.canHandle.includes(type)) score += 8;
        }
      }

      // Best sub-agent for this task
      let bestSub = null, bestSubScore = 0;
      for (const [name, sa] of Object.entries(profile.subAgents)) {
        let subScore = 0;
        for (const tag of taskTags) {
          if (sa.taskTypes.includes(tag)) subScore += 10;
          if (sa.skills.includes(tag)) subScore += 5;
        }
        for (const [type, words] of Object.entries(keywords)) {
          if (words.some(w => taskTitle.includes(w)) && sa.taskTypes.includes(type)) subScore += 8;
        }
        if (subScore > bestSubScore) { bestSubScore = subScore; bestSub = name; }
      }

      scores.push({ actorId: actor.id, actorName: actor.name, score: score + bestSubScore, subAgent: bestSub, profile });
    }

    return scores.sort((a, b) => b.score - a.score);
  }
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SYSTEM 2: TASK STATE MACHINE
// Formal state transitions with triggers and guards
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const TaskStateMachine = {
  // All valid states (= kanban columns)
  states: ['inbox', 'todo', 'in_progress', 'review', 'pending_human', 'failed', 'done'],

  // All valid transitions: from → to → { trigger, guard, effect }
  transitions: {
    // ── FROM INBOX ──
    'inbox→todo':         { trigger: 'manual|auto_route|deps_met', guard: null, effect: 'setStatus:ready' },
    'inbox→in_progress':  { trigger: 'dispatch|agent_pickup|manual', guard: 'hasAssignee', effect: 'setStarted' },
    'inbox→done':         { trigger: 'manual', guard: null, effect: 'setCompleted' },

    // ── FROM TODO (Ready) ──
    'todo→in_progress':   { trigger: 'dispatch|agent_pickup|session_detected|manual', guard: 'hasAssignee', effect: 'setStarted' },
    'todo→inbox':         { trigger: 'manual|unassign', guard: null, effect: 'clearStart' },
    'todo→done':          { trigger: 'manual', guard: null, effect: 'setCompleted' },

    // ── FROM IN_PROGRESS ──
    'in_progress→review':        { trigger: 'agent_completed|manual', guard: null, effect: 'setReviewRequested' },
    'in_progress→done':          { trigger: 'manual|auto_complete', guard: null, effect: 'setCompleted' },
    'in_progress→failed':        { trigger: 'agent_error|timeout|manual', guard: null, effect: 'setFailed' },
    'in_progress→pending_human': { trigger: 'agent_needs_input|clarification|approval_needed', guard: null, effect: 'setWaitingHuman' },
    'in_progress→todo':          { trigger: 'agent_paused|manual', guard: null, effect: 'clearStart' },
    'in_progress→inbox':         { trigger: 'manual|unassign', guard: null, effect: 'clearStart' },

    // ── FROM REVIEW ──
    'review→done':           { trigger: 'approved|manual', guard: null, effect: 'setCompleted' },
    'review→in_progress':    { trigger: 'changes_requested|manual', guard: null, effect: 'setStatus:active' },
    'review→failed':         { trigger: 'rejected|manual', guard: null, effect: 'setFailed' },
    'review→pending_human':  { trigger: 'needs_human_review', guard: null, effect: 'setWaitingHuman' },

    // ── FROM PENDING_HUMAN ──
    'pending_human→in_progress': { trigger: 'human_responded|input_provided|manual', guard: null, effect: 'setStatus:active' },
    'pending_human→done':        { trigger: 'manual', guard: null, effect: 'setCompleted' },
    'pending_human→failed':      { trigger: 'timeout|manual', guard: null, effect: 'setFailed' },
    'pending_human→todo':        { trigger: 'manual', guard: null, effect: 'setStatus:ready' },

    // ── FROM FAILED ──
    'failed→todo':          { trigger: 'retry|manual', guard: 'retryAvailable', effect: 'incrementRetry' },
    'failed→in_progress':   { trigger: 'auto_retry|manual', guard: 'retryAvailable', effect: 'incrementRetry;setStarted' },
    'failed→inbox':         { trigger: 'manual|reassign', guard: null, effect: 'clearStart;clearAssignee' },
    'failed→done':          { trigger: 'manual', guard: null, effect: 'setCompleted' },

    // ── FROM DONE ──
    'done→in_progress':     { trigger: 'reopen|manual', guard: null, effect: 'clearCompleted;setStarted' },
    'done→todo':            { trigger: 'reopen|manual', guard: null, effect: 'clearCompleted' },
  },

  // Check if a transition is valid
  canTransition(fromCol, toCol, task, trigger) {
    const key = `${fromCol}→${toCol}`;
    const rule = this.transitions[key];
    if (!rule) return { allowed: false, reason: `No transition ${key} defined` };

    // Check trigger is one of the allowed triggers
    const triggers = rule.trigger.split('|');
    if (trigger && !triggers.includes(trigger) && !triggers.includes('manual')) {
      return { allowed: false, reason: `Trigger "${trigger}" not valid for ${key}. Expected: ${rule.trigger}` };
    }

    // Check guard
    if (rule.guard) {
      const guards = rule.guard.split(';');
      for (const g of guards) {
        if (g === 'hasAssignee' && !task.assignee) {
          return { allowed: false, reason: 'Task must have an assignee to move to this column' };
        }
        if (g === 'retryAvailable' && task.retryCount >= (task.maxRetries || 3)) {
          return { allowed: false, reason: `Max retries (${task.maxRetries || 3}) exceeded` };
        }
      }
    }

    return { allowed: true, rule, triggers };
  },

  // Apply a transition's effects to a task
  applyEffects(task, rule) {
    if (!rule || !rule.effect) return;
    const effects = rule.effect.split(';');
    const now = Date.now();

    for (const effect of effects) {
      if (effect === 'setStarted') { if (!task.startedAt) task.startedAt = now; task.status = 'active'; }
      else if (effect === 'setCompleted') { task.completedAt = now; task.status = 'completed'; }
      else if (effect === 'setFailed') { task.status = 'failed'; task.failedAt = now; }
      else if (effect === 'setReviewRequested') { task.status = 'in_review'; task.reviewRequestedAt = now; }
      else if (effect === 'setWaitingHuman') { task.status = 'waiting_human'; }
      else if (effect === 'clearStart') { task.startedAt = null; task.status = 'ready'; }
      else if (effect === 'clearCompleted') { task.completedAt = null; task.status = 'active'; }
      else if (effect === 'clearAssignee') { task.assignee = null; task.assigneeAgent = null; }
      else if (effect === 'incrementRetry') { task.retryCount = (task.retryCount || 0) + 1; }
      else if (effect.startsWith('setStatus:')) { task.status = effect.split(':')[1]; }
    }
    task.updated = now;
  },

  // Execute a state transition
  transition(task, toCol, trigger, auditFn) {
    const fromCol = task.column;
    if (fromCol === toCol) return { moved: false, reason: 'Already in target column' };

    const check = this.canTransition(fromCol, toCol, task, trigger);
    if (!check.allowed) return { moved: false, reason: check.reason };

    // Apply
    task.column = toCol;
    this.applyEffects(task, check.rule);

    if (auditFn) {
      auditFn(Date.now(), 'TASK_TRANSITION',
        `Task #${task.num} ${fromCol}→${toCol} [trigger:${trigger}]`,
        task.id, task.assignee, null);
    }

    return { moved: true, from: fromCol, to: toCol, trigger, effects: check.rule.effect };
  }
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SYSTEM 3: ORCHESTRATION ENGINE
// Watches agent activity → applies state machine transitions
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const Orchestrator = {
  // Process discovery results and auto-transition tasks
  processDiscoveryResults(discoveryResults, allTasks, allActors, stmtsRef, broadcastFn) {
    const changes = [];
    const r = discoveryResults;

    // ── 1. Agent went ONLINE → move assigned tasks inbox/todo → in_progress ──
    for (const actor of allActors) {
      const profile = AgentRegistry.resolve(actor);

      if (actor.status === 'online' && actor.type === 'ai') {
        const assignedTasks = allTasks.filter(t =>
          t.assignee === actor.id && (t.column === 'todo' || t.column === 'inbox')
        );

        for (const task of assignedTasks) {
          // Only auto-move if agent has an active session that could be working on this
          const hasActiveSession = this.taskHasActiveSession(task, actor, r);

          if (hasActiveSession) {
            const result = TaskStateMachine.transition(task, 'in_progress', 'agent_pickup', stmtsRef.addAudit.run.bind(stmtsRef.addAudit));
            if (result.moved) {
              const persisted = this.persistTask(task, stmtsRef);
              if (!persisted) continue; // skip if persist failed
              changes.push({ taskId: task.id, taskNum: task.num, ...result, reason: 'Agent online with active session' });
            }
          }
        }
      }

      // ── 2. Agent went OFFLINE → move in_progress tasks to pending or failed ──
      if (actor.status === 'offline' && actor.type === 'ai') {
        const activeTasks = allTasks.filter(t =>
          t.assignee === actor.id && t.column === 'in_progress'
        );

        for (const task of activeTasks) {
          // Don't immediately fail — move to pending_human for human decision
          const result = TaskStateMachine.transition(task, 'pending_human', 'agent_needs_input', stmtsRef.addAudit.run.bind(stmtsRef.addAudit));
          if (result.moved) {
            task.humanReqDoc = {
              what: `Agent "${actor.name}" went offline while working on this task`,
              urgency: 'medium',
              context: 'The agent disconnected. You can: reassign, wait for reconnect, or move to failed.',
              ts: Date.now()
            };
            this.persistTask(task, stmtsRef);
            changes.push({ taskId: task.id, taskNum: task.num, ...result, reason: 'Agent went offline' });
          }
        }
      }
    }

    // ── 3. Session-based detection (OpenClaw sessions → match to tasks) ──
    if (r.openclaw?.sessions?.length > 0) {
      for (const session of r.openclaw.sessions) {
        const matched = this.matchSessionToTask(session, allTasks, allActors);
        if (matched && (matched.column === 'todo' || matched.column === 'inbox')) {
          const result = TaskStateMachine.transition(matched, 'in_progress', 'session_detected', stmtsRef.addAudit.run.bind(stmtsRef.addAudit));
          if (result.moved) {
            matched.meta = matched.meta || {};
            matched.meta.linkedSession = session.key;
            matched.meta.sessionModel = session.model;
            this.persistTask(matched, stmtsRef);
            changes.push({ taskId: matched.id, taskNum: matched.num, ...result, reason: `Linked to session ${session.key}` });
          }
        }
      }
    }

    // ── 4. Claude Code session files → detect activity ──
    if (r.claudeCode?.sessions?.length > 0) {
      for (const session of r.claudeCode.sessions) {
        // Check if any task title appears in the session's project path
        for (const task of allTasks) {
          if (task.column !== 'todo' && task.column !== 'inbox') continue;
          const actor = allActors.find(a => a.id === task.assignee);
          if (!actor || !actor.name?.toLowerCase().includes('claude')) continue;

          // Heuristic: if session was active in last 5 min and task title keywords match project path
          const sessionAge = Date.now() - new Date(session.lastActive).getTime();
          if (sessionAge < 300000) { // 5 min
            const result = TaskStateMachine.transition(task, 'in_progress', 'session_detected', stmtsRef.addAudit.run.bind(stmtsRef.addAudit));
            if (result.moved) {
              task.meta = task.meta || {};
              task.meta.linkedSession = session.sessionId;
              task.meta.sessionProject = session.project;
              this.persistTask(task, stmtsRef);
              changes.push({ taskId: task.id, taskNum: task.num, ...result, reason: `Claude Code session active: ${session.project}` });
            }
          }
        }
      }
    }

    // ── 5. Timeout detection → move stale in_progress tasks ──
    const staleTimeout = 3600000; // 1 hour
    for (const task of allTasks) {
      if (task.column !== 'in_progress') continue;
      if (!task.startedAt) continue;

      const elapsed = Date.now() - task.startedAt;
      const actor = allActors.find(a => a.id === task.assignee);

      // If task has been in_progress for > 1 hour and agent is offline
      if (elapsed > staleTimeout && actor && actor.status === 'offline') {
        const result = TaskStateMachine.transition(task, 'failed', 'timeout', stmtsRef.addAudit.run.bind(stmtsRef.addAudit));
        if (result.moved) {
          task.failureDoc = {
            reason: 'timeout',
            detail: `Task stale for ${Math.round(elapsed / 60000)}min while agent "${actor?.name}" is offline`,
            ts: Date.now()
          };
          this.persistTask(task, stmtsRef);
          changes.push({ taskId: task.id, taskNum: task.num, ...result, reason: 'Stale timeout (agent offline)' });
        }
      }
    }

    // ── 6. Auto-retry failed tasks if retries available ──
    for (const task of allTasks) {
      if (task.column !== 'failed') continue;
      if (!task.assignee) continue;

      const actor = allActors.find(a => a.id === task.assignee);
      if (!actor || actor.status !== 'online') continue;

      const retryCount = task.retryCount || 0;
      const maxRetries = task.maxRetries || 3;
      if (retryCount >= maxRetries) continue;

      // Only auto-retry if failure was recent (< 10 min) and auto-retry is not disabled
      const failedAge = Date.now() - (task.failedAt || 0);
      if (failedAge < 600000 && task.meta?.autoRetry !== false) {
        const result = TaskStateMachine.transition(task, 'in_progress', 'auto_retry', stmtsRef.addAudit.run.bind(stmtsRef.addAudit));
        if (result.moved) {
          task.meta = task.meta || {};
          task.meta.lastRetryAt = Date.now();
          this.persistTask(task, stmtsRef);
          changes.push({ taskId: task.id, taskNum: task.num, ...result, reason: `Auto-retry ${retryCount + 1}/${maxRetries}` });
        }
      }
    }

    // ── 7. Dependency resolution → unblock tasks ──
    for (const task of allTasks) {
      if (task.column !== 'inbox') continue;
      if (!task.deps || task.deps.length === 0) continue;

      const allDepsDone = task.deps.every(depId => {
        const dep = allTasks.find(t => t.id === depId);
        return dep && dep.column === 'done';
      });

      if (allDepsDone) {
        const result = TaskStateMachine.transition(task, 'todo', 'deps_met', stmtsRef.addAudit.run.bind(stmtsRef.addAudit));
        if (result.moved) {
          this.persistTask(task, stmtsRef);
          changes.push({ taskId: task.id, taskNum: task.num, ...result, reason: 'All dependencies completed' });
        }
      }
    }

    return changes;
  },

  // Check if a task has a corresponding active agent session
  taskHasActiveSession(task, actor, discoveryResults) {
    const r = discoveryResults;

    // OpenClaw: check sessions
    if (actor.endpoint?.includes('18789') && r.openclaw?.sessions) {
      return r.openclaw.sessions.some(s =>
        (s.key && task.remoteId && s.key.includes(task.remoteId)) ||
        (s.agentId && task.assigneeAgent && s.agentId === task.assigneeAgent) ||
        (s.key && s.key.includes(task.id))
      );
    }

    // Claude Code: check running process
    if (actor.name?.toLowerCase().includes('claude') && r.claudeCode?.running) {
      return true; // Claude Code is running, could be working on anything
    }

    return false;
  },

  // Match an OpenClaw session to a board task
  matchSessionToTask(session, allTasks, allActors) {
    for (const task of allTasks) {
      if (task.remoteId && session.key === task.remoteId) return task;
      if (session.key === task.id) return task;
      if (task.assigneeAgent && session.agentId === task.assigneeAgent) {
        const actor = allActors.find(a => a.id === task.assignee);
        if (actor?.endpoint?.includes('18789')) return task;
      }
    }
    return null;
  },

  // Persist task changes to DB
  persistTask(task, stmtsRef) {
    try {
      stmtsRef.upsertTask.run({
        id: task.id, num: task.num, data: JSON.stringify(task),
        column_id: task.column, priority: task.priority,
        assignee: task.assignee, created_at: task.created, updated_at: task.updated
      });
      return true;
    } catch (e) {
      console.error(`  Orchestrator: failed to persist task #${task.num}:`, e.message);
      return false;
    }
  }
};

// ─── Express + HTTP Server ────────────────────────────
const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Token authentication middleware
app.use(validateToken);

// Serve the frontend
app.use(express.static(__dirname));

// ─── SQLite Database ──────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function initDB() {
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

  // Ensure main state row exists
  const row = db.prepare('SELECT id FROM state WHERE id = ?').get('main');
  if (!row) {
    const defaultState = {
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
      taskCounter: 0,
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
    db.prepare('INSERT INTO state (id, data, updated_at) VALUES (?, ?, ?)').run('main', JSON.stringify(defaultState), Date.now());
  }
}

initDB();

// ─── Prepared Statements ──────────────────────────────
const stmts = {
  getState: db.prepare('SELECT data FROM state WHERE id = ?'),
  setState: db.prepare('UPDATE state SET data = ?, updated_at = ? WHERE id = ?'),

  getAllTasks: db.prepare('SELECT data FROM tasks ORDER BY created_at ASC'),
  getTask: db.prepare('SELECT data FROM tasks WHERE id = ?'),
  upsertTask: db.prepare(`INSERT INTO tasks (id, num, data, column_id, priority, assignee, created_at, updated_at)
    VALUES (@id, @num, @data, @column_id, @priority, @assignee, @created_at, @updated_at)
    ON CONFLICT(id) DO UPDATE SET data=@data, column_id=@column_id, priority=@priority, assignee=@assignee, updated_at=@updated_at`),
  deleteTask: db.prepare('DELETE FROM tasks WHERE id = ?'),
  deleteAllTasks: db.prepare('DELETE FROM tasks'),

  getAllActors: db.prepare('SELECT data FROM actors ORDER BY created_at ASC'),
  getActor: db.prepare('SELECT data FROM actors WHERE id = ?'),
  upsertActor: db.prepare(`INSERT INTO actors (id, type, name, data, status, created_at)
    VALUES (@id, @type, @name, @data, @status, @created_at)
    ON CONFLICT(id) DO UPDATE SET type=@type, name=@name, data=@data, status=@status`),
  deleteActor: db.prepare('DELETE FROM actors WHERE id = ?'),
  deleteAllActors: db.prepare('DELETE FROM actors'),

  addAudit: db.prepare('INSERT INTO audit_log (ts, action, detail, task_id, actor_id, nonce) VALUES (?, ?, ?, ?, ?, ?)'),
  getAuditAll: db.prepare('SELECT * FROM audit_log ORDER BY ts DESC LIMIT ?'),
  getAuditByTask: db.prepare('SELECT * FROM audit_log WHERE task_id = ? ORDER BY ts DESC LIMIT ?'),
  deleteAllAudit: db.prepare('DELETE FROM audit_log'),

  addReasoning: db.prepare('INSERT INTO reasoning (type, text, task_id, ts) VALUES (?, ?, ?, ?)'),
  getReasoningAll: db.prepare('SELECT * FROM reasoning ORDER BY ts DESC LIMIT ?'),
  deleteAllReasoning: db.prepare('DELETE FROM reasoning'),
};

// ─── WebSocket ────────────────────────────────────────
const wss = new WebSocketServer({ server, path: '/ws' });
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.isAlive = true;
  ws.missedPongs = 0;
  if (isDev) console.log(`[WS] Client connected (${clients.size} total)`);

  ws.on('pong', () => {
    ws.isAlive = true;
    ws.missedPongs = 0;
  });

  ws.on('close', () => {
    clients.delete(ws);
    if (isDev) console.log(`[WS] Client disconnected (${clients.size} total)`);
  });

  ws.on('error', () => clients.delete(ws));
});

// WebSocket heartbeat: ping every 30s, track missed pongs
setInterval(() => {
  clients.forEach(ws => {
    if (!ws.isAlive) {
      ws.missedPongs++;
      if (ws.missedPongs >= 2) {
        try {
          ws.terminate();
        } catch (e) {
          // ignore errors when terminating
        }
        clients.delete(ws);
        return;
      }
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch (e) {
      // ignore errors when pinging
    }
  });
}, 30000);

function broadcast(event, data) {
  const msg = JSON.stringify({ event, data, ts: Date.now() });
  clients.forEach(ws => {
    if (ws.readyState === 1) ws.send(msg);
  });
}

// ─── Helper: get full state for frontend ──────────────
function getFullState() {
  const stateRow = stmts.getState.get('main');
  const state = JSON.parse(stateRow.data);
  state.tasks = stmts.getAllTasks.all().map(r => JSON.parse(r.data));
  state.actors = stmts.getAllActors.all().map(r => JSON.parse(r.data));
  state.auditLog = stmts.getAuditAll.all(5000);
  state.reasoning = stmts.getReasoningAll.all(200);
  return state;
}

// ─── API Routes ───────────────────────────────────────

// ── Full State (load/save for frontend sync) ──
app.get('/api/state', (req, res) => {
  try {
    res.json(getFullState());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/state', (req, res) => {
  try {
    const incoming = req.body;
    const now = Date.now();

    // Input validation
    if (incoming.logoUrl && typeof incoming.logoUrl === 'string' && incoming.logoUrl.startsWith('javascript:')) {
      return res.status(400).json({ error: 'logoUrl cannot start with javascript:' });
    }

    // Wrap entire sync in transaction
    const syncState = db.transaction(() => {
      // Save core state (columns, theme, settings, etc.)
      const coreState = {
        title: incoming.title,
        logoUrl: incoming.logoUrl,
        plan: incoming.plan,
        columns: incoming.columns,
        taskCounter: incoming.taskCounter,
        theme: incoming.theme,
        settings: incoming.settings,
        isDemo: incoming.isDemo || false
      };
      stmts.setState.run(JSON.stringify(coreState), now, 'main');

      // Sync tasks
      if (incoming.tasks) {
        const existingIds = new Set(stmts.getAllTasks.all().map(r => JSON.parse(r.data).id));
        const incomingIds = new Set(incoming.tasks.map(t => t.id));

        // Delete tasks not in incoming
        for (const id of existingIds) {
          if (!incomingIds.has(id)) stmts.deleteTask.run(id);
        }

        // Upsert all incoming tasks
        for (const t of incoming.tasks) {
          stmts.upsertTask.run({
            id: t.id,
            num: t.num,
            data: JSON.stringify(t),
            column_id: t.column || 'inbox',
            priority: t.priority || 'medium',
            assignee: t.assignee || null,
            created_at: t.created || now,
            updated_at: t.updated || now
          });
        }
      }

      // Sync actors (preserving discovery metadata)
      if (incoming.actors) {
        // Build lookup of existing actors with discovery metadata
        const existingActors = {};
        stmts.getAllActors.all().forEach(r => {
          const a = JSON.parse(r.data);
          existingActors[a.id] = a;
        });
        const existingIds = new Set(Object.keys(existingActors));
        const incomingIds = new Set(incoming.actors.map(a => a.id));

        for (const id of existingIds) {
          if (!incomingIds.has(id)) stmts.deleteActor.run(id);
        }

        for (const a of incoming.actors) {
          // Merge: keep discovery metadata from server, take everything else from frontend
          const existing = existingActors[a.id];
          if (existing && existing.meta) {
            // Preserve discovery fields the frontend doesn't know about
            const discoveryFields = ['lastProbe', 'lastProbeResult', 'discoveredAgents',
              'activeSessions', 'sessionDetails', 'claudeVersion', 'recentSessions'];
            if (!a.meta) a.meta = {};
            for (const field of discoveryFields) {
              if (existing.meta[field] !== undefined && a.meta[field] === undefined) {
                a.meta[field] = existing.meta[field];
              }
            }
          }

          // Use discovery-determined status if frontend sent stale status
          let status = a.status || 'offline';
          if (existing && existing.meta?.lastProbe) {
            try {
              const probeAge = now - new Date(existing.meta.lastProbe).getTime();
              if (probeAge < 60000) {
                // Discovery probed within last 60s — trust its status over frontend
                status = existing.status || status;
              }
            } catch (e) {
              // Invalid ISO date, ignore
            }
          }

          stmts.upsertActor.run({
            id: a.id,
            type: a.type,
            name: a.name,
            data: JSON.stringify({ ...a, status }),
            status,
            created_at: existing?.created_at || now
          });
        }
      }
    });
    syncState();

    broadcast('state_updated', { ts: now });
    res.json({ ok: true, ts: now });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Tasks CRUD ──
app.get('/api/tasks', (req, res) => {
  try {
    const tasks = stmts.getAllTasks.all().map(r => JSON.parse(r.data));
    if (req.query.column) {
      res.json(tasks.filter(t => t.column === req.query.column));
    } else if (req.query.assignee) {
      res.json(tasks.filter(t => t.assignee === req.query.assignee));
    } else {
      res.json(tasks);
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/tasks/:id', (req, res) => {
  try {
    const row = stmts.getTask.get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Task not found' });
    res.json(JSON.parse(row.data));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/tasks', (req, res) => {
  try {
    // Input validation
    const t = req.body;
    if (!t.title) return res.status(400).json({ error: 'title is required' });
    if (t.title.length >= 500) return res.status(400).json({ error: 'title must be less than 500 characters' });
    if (t.priority && !['low', 'medium', 'high', 'urgent'].includes(t.priority)) {
      return res.status(400).json({ error: 'priority must be one of: low, medium, high, urgent' });
    }
    if (t.tags && (!Array.isArray(t.tags) || !t.tags.every(tag => typeof tag === 'string'))) {
      return res.status(400).json({ error: 'tags must be an array of strings' });
    }

    // Dependency cycle detection
    if (t.deps && t.deps.length > 0) {
      const hasCycle = checkDependencyCycle(t.id, t.deps, stmts.getAllTasks.all().map(r => JSON.parse(r.data)));
      if (hasCycle) return res.status(400).json({ error: 'Circular dependency detected' });
    }

    if (!t.id) t.id = uuidv4();
    if (!t.created) t.created = Date.now();
    t.updated = Date.now();

    // Increment task counter in transaction
    const createTask = db.transaction(() => {
      const stateRow = stmts.getState.get('main');
      const state = JSON.parse(stateRow.data);
      state.taskCounter = (state.taskCounter || 0) + 1;
      t.num = state.taskCounter;
      stmts.setState.run(JSON.stringify(state), Date.now(), 'main');

      stmts.upsertTask.run({
        id: t.id, num: t.num, data: JSON.stringify(t),
        column_id: t.column || 'inbox', priority: t.priority || 'medium',
        assignee: t.assignee || null, created_at: t.created, updated_at: t.updated
      });

      stmts.addAudit.run(Date.now(), 'TASK_CREATED', `Task #${t.num} "${t.title}" created`, t.id, null, null);
    });
    createTask();

    broadcast('task_created', t);
    res.status(201).json(t);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/tasks/:id', (req, res) => {
  try {
    const existing = stmts.getTask.get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Task not found' });

    const t = { ...JSON.parse(existing.data), ...req.body, updated: Date.now() };

    // Input validation
    if (!t.title) return res.status(400).json({ error: 'title is required' });

    // Dependency cycle detection
    if (t.deps && t.deps.length > 0) {
      const allTasks = stmts.getAllTasks.all().map(r => JSON.parse(r.data)).filter(task => task.id !== req.params.id);
      const hasCycle = checkDependencyCycle(t.id, t.deps, allTasks);
      if (hasCycle) return res.status(400).json({ error: 'Circular dependency detected' });
    }

    stmts.upsertTask.run({
      id: t.id, num: t.num, data: JSON.stringify(t),
      column_id: t.column || 'inbox', priority: t.priority || 'medium',
      assignee: t.assignee || null, created_at: t.created, updated_at: t.updated
    });

    stmts.addAudit.run(Date.now(), 'TASK_UPDATED', `Task #${t.num} updated`, t.id, null, null);
    broadcast('task_updated', t);
    res.json(t);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/tasks/:id/move', (req, res) => {
  try {
    const moveTask = db.transaction(() => {
      const existing = stmts.getTask.get(req.params.id);
      if (!existing) return { error: 'Task not found' };

      const t = JSON.parse(existing.data);
      const newCol = req.body.column;
      if (!newCol) return { error: 'column required' };

      // Use TaskStateMachine to validate and apply transition
      const transition = TaskStateMachine.transition(t, newCol, 'manual', stmts.addAudit.run.bind(stmts.addAudit));
      if (!transition.moved) {
        return { error: transition.reason };
      }

      const success = Orchestrator.persistTask(t, stmts);
      if (!success) {
        return { error: 'Failed to persist task' };
      }

      return { ok: true, task: t, transition };
    });

    const result = moveTask();
    if (result.error) {
      return res.status(result.error === 'Task not found' ? 404 : 400).json({ error: result.error });
    }

    broadcast('task_moved', { task: result.task, from: result.transition.from, to: result.transition.to });
    res.json(result.task);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/tasks/:id', (req, res) => {
  try {
    const taskToDelete = stmts.getTask.get(req.params.id);
    if (!taskToDelete) return res.status(404).json({ error: 'Task not found' });

    // Remove this task from all other tasks' deps arrays (orphaned dependencies cleanup)
    const allTasks = stmts.getAllTasks.all().map(r => JSON.parse(r.data));
    for (const task of allTasks) {
      if (task.id === req.params.id) continue;
      if (task.deps && task.deps.includes(req.params.id)) {
        task.deps = task.deps.filter(id => id !== req.params.id);
        Orchestrator.persistTask(task, stmts);
      }
    }

    stmts.deleteTask.run(req.params.id);
    stmts.addAudit.run(Date.now(), 'TASK_DELETED', `Task ${req.params.id} deleted`, req.params.id, null, null);
    broadcast('task_deleted', { id: req.params.id });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Actors CRUD ──
app.get('/api/actors', (req, res) => {
  try {
    res.json(stmts.getAllActors.all().map(r => JSON.parse(r.data)));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/actors', (req, res) => {
  try {
    const a = req.body;
    // Input validation
    if (!a.name) return res.status(400).json({ error: 'name is required' });
    if (!a.type) return res.status(400).json({ error: 'type is required' });

    if (!a.id) a.id = uuidv4();
    stmts.upsertActor.run({
      id: a.id, type: a.type, name: a.name,
      data: JSON.stringify(a), status: a.status || 'offline',
      created_at: Date.now()
    });
    stmts.addAudit.run(Date.now(), 'ACTOR_CREATED', `Actor "${a.name}" (${a.type}) created`, null, a.id, null);
    broadcast('actor_created', a);
    res.status(201).json(a);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/actors/:id', (req, res) => {
  try {
    // Input validation
    const a = req.body;
    if (!a.name) return res.status(400).json({ error: 'name is required' });
    if (!a.type) return res.status(400).json({ error: 'type is required' });

    a.id = req.params.id;

    // Read existing actor to preserve created_at
    const existing = stmts.getActor.get(req.params.id);
    const createdAt = existing ? JSON.parse(existing.data).created_at : Date.now();

    stmts.upsertActor.run({
      id: a.id, type: a.type, name: a.name,
      data: JSON.stringify(a), status: a.status || 'offline',
      created_at: createdAt
    });
    broadcast('actor_updated', a);
    res.json(a);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/actors/:id', (req, res) => {
  try {
    stmts.deleteActor.run(req.params.id);
    broadcast('actor_deleted', { id: req.params.id });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Audit Log ──
app.get('/api/audit', (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '500', 10);
    if (req.query.taskId) {
      res.json(stmts.getAuditByTask.all(req.query.taskId, limit));
    } else {
      res.json(stmts.getAuditAll.all(limit));
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/audit', (req, res) => {
  try {
    const { action, detail, taskId, actorId } = req.body;
    stmts.addAudit.run(Date.now(), action, detail, taskId || null, actorId || null, null);
    res.status(201).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/audit/export/jsonl', (req, res) => {
  try {
    const logs = stmts.getAuditAll.all(99999);
    const lines = logs.map(l => JSON.stringify(l)).join('\n');
    res.setHeader('Content-Type', 'application/jsonl');
    res.setHeader('Content-Disposition', `attachment; filename="agentflow-audit-${new Date().toISOString().slice(0, 10)}.jsonl"`);
    res.send(lines);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Reasoning ──
app.get('/api/reasoning', (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '200', 10);
    res.json(stmts.getReasoningAll.all(limit));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/reasoning', (req, res) => {
  try {
    const { type, text, taskId } = req.body;
    stmts.addReasoning.run(type, text, taskId || null, Date.now());
    broadcast('reasoning_added', { type, text });
    res.status(201).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Clear Demo Data ──
app.post('/api/clear', (req, res) => {
  try {
    const clearAll = db.transaction(() => {
      stmts.deleteAllTasks.run();
      stmts.deleteAllActors.run();
      stmts.deleteAllAudit.run();
      stmts.deleteAllReasoning.run();
      const stateRow = stmts.getState.get('main');
      const state = JSON.parse(stateRow.data);
      state.taskCounter = 0;
      state.isDemo = false;
      stmts.setState.run(JSON.stringify(state), Date.now(), 'main');
    });
    clearAll();
    stmts.addAudit.run(Date.now(), 'DATA_CLEARED', 'All data cleared', null, null, null);
    broadcast('state_cleared', {});
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Agent Dispatch Proxy ──
// Proxies task dispatch through the server (avoids CORS issues on frontend)
app.post('/api/dispatch/:taskId', async (req, res) => {
  try {
    const taskRow = stmts.getTask.get(req.params.taskId);
    if (!taskRow) return res.status(404).json({ error: 'Task not found' });
    const task = JSON.parse(taskRow.data);

    if (!task.assignee) return res.status(400).json({ error: 'Task has no assignee' });

    const actorRow = stmts.getActor.get(task.assignee);
    if (!actorRow) return res.status(404).json({ error: 'Actor not found' });
    const actor = JSON.parse(actorRow.data);

    if (!actor.endpoint) return res.status(400).json({ error: 'Actor has no endpoint configured' });

    // Validate actor endpoint starts with http:// or https://
    if (!actor.endpoint.startsWith('http://') && !actor.endpoint.startsWith('https://')) {
      return res.status(400).json({ error: 'Actor endpoint must start with http:// or https://' });
    }

    // Build request based on API contract
    const contract = actor.apiContract || 'generic';
    let url, body;

    if (contract === 'openclaw') {
      url = actor.endpoint + '/api/tasks';
      body = { task: { id: task.id, title: task.title, description: task.desc, priority: task.priority, tags: task.tags }, agent: task.assigneeAgent || 'default' };
    } else if (contract === 'crewai') {
      url = actor.endpoint + '/crew/tasks';
      body = { objective: task.title, context: task.desc || '', agent_role: task.assigneeAgent || '', priority: task.priority };
    } else {
      url = actor.endpoint + '/tasks';
      body = { id: task.id, title: task.title, description: task.desc, agent: task.assigneeAgent, priority: task.priority };
    }

    // Make the actual HTTP call from the server (no CORS issues)
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
    }

    const data = await resp.json();
    const remoteId = data.taskId || data.task_id || data.id;

    // Update task with remote info
    task.remoteId = remoteId;
    task.remoteStatus = data.status || 'dispatched';
    task.dispatchedAt = Date.now();
    task.updated = Date.now();
    if (task.column === 'todo' || task.column === 'inbox') task.column = 'in_progress';
    if (!task.startedAt) task.startedAt = Date.now();

    stmts.upsertTask.run({
      id: task.id, num: task.num, data: JSON.stringify(task),
      column_id: task.column, priority: task.priority,
      assignee: task.assignee, created_at: task.created, updated_at: task.updated
    });

    stmts.addAudit.run(Date.now(), 'TASK_DISPATCHED', `Task #${task.num} dispatched to ${actor.name} (remote:${remoteId})`, task.id, actor.id, null);
    broadcast('task_dispatched', { task, remoteId });

    res.json({ ok: true, remoteId, status: data.status });
  } catch (e) {
    stmts.addAudit.run(Date.now(), 'DISPATCH_FAILED', `Dispatch failed: ${e.message}`, req.params.taskId, null, null);
    res.status(502).json({ error: e.message });
  }
});

// ── Agent Connection Test ──
app.post('/api/test-connection', async (req, res) => {
  try {
    const { endpoint } = req.body;
    if (!endpoint) return res.status(400).json({ error: 'endpoint required' });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const resp = await fetch(endpoint, { method: 'GET', signal: controller.signal });
    clearTimeout(timeout);

    res.json({ ok: true, status: resp.status, reachable: true });
  } catch (e) {
    res.json({ ok: false, reachable: false, error: e.message });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ── Agent Discovery Engine ──
// Polls OpenClaw + Claude Code to detect live agents
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const discovery = {
  lastPoll: null,
  polling: false,
  intervalHandle: null,
  results: { openclaw: null, claudeCode: null, timestamp: null },

  // ── OpenClaw: Probe gateway health ──
  async probeOpenClaw() {
    const result = { reachable: false, agents: [], sessions: [], error: null };
    const headers = { 'Content-Type': 'application/json' };
    if (OPENCLAW_TOKEN) headers['Authorization'] = `Bearer ${OPENCLAW_TOKEN}`;

    try {
      // 1. Health probe — just try to reach the gateway
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      const healthResp = await fetch(OPENCLAW_HOST, { signal: ctrl.signal, method: 'GET' });
      clearTimeout(t);
      result.reachable = healthResp.status < 500;
    } catch (e) {
      result.error = e.code || e.message;
      return result;
    }

    // 2. List agents via /tools/invoke
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const resp = await fetch(`${OPENCLAW_HOST}/tools/invoke`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ tool: 'agents_list', args: {} }),
        signal: ctrl.signal
      });
      clearTimeout(t);
      if (resp.ok) {
        const data = await resp.json();
        // data = { requester, allowAny, agents: [{id, configured}] }
        if (Array.isArray(data.agents)) {
          result.agents = data.agents.map(a => ({
            id: a.id,
            name: a.id,
            configured: a.configured || false,
            source: 'openclaw'
          }));
        } else if (data.result && Array.isArray(data.result.agents)) {
          result.agents = data.result.agents.map(a => ({
            id: a.id,
            name: a.id,
            configured: a.configured || false,
            source: 'openclaw'
          }));
        }
      }
    } catch (e) {
      // agents_list may be denied by policy — that's ok, gateway is still reachable
    }

    // 3. List active sessions via /tools/invoke
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const resp = await fetch(`${OPENCLAW_HOST}/tools/invoke`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ tool: 'sessions_list', args: { activeMinutes: 60, messageLimit: 0 } }),
        signal: ctrl.signal
      });
      clearTimeout(t);
      if (resp.ok) {
        const data = await resp.json();
        const sessions = data.sessions || data.result?.sessions || data.result || [];
        if (Array.isArray(sessions)) {
          result.sessions = sessions.map(s => ({
            key: s?.key || null,
            agentId: s?.agentId || null,
            model: s?.model || null,
            kind: s?.kind || null,
            updatedAt: s?.updatedAt || null,
            contextTokens: s?.contextTokens || 0,
            source: 'openclaw'
          })).filter(s => s.key != null && s.agentId != null);
        }
      }
    } catch (e) {
      // sessions_list may be denied
    }

    return result;
  },

  // ── Claude Code: Detect via process + session files ──
  async probeClaudeCode() {
    const result = { running: false, sessions: [], version: null, error: null };

    // 1. Check if claude process is running
    try {
      const procs = execSync(
        process.platform === 'darwin'
          ? 'pgrep -fl "claude" 2>/dev/null || true'
          : 'pgrep -a "claude" 2>/dev/null || true',
        { encoding: 'utf8', timeout: 3000 }
      ).trim();

      if (procs) {
        // Filter for actual claude-code processes (not just any "claude" string)
        const lines = procs.split('\n').filter(l =>
          l.includes('claude') && !l.includes('pgrep') && !l.includes('agentflow')
        );
        result.running = lines.length > 0;
      }
    } catch (e) {
      // pgrep not available or failed — not critical
    }

    // 2. Try to get version
    try {
      const ver = execSync('claude --version 2>/dev/null || true', { encoding: 'utf8', timeout: 5000 }).trim();
      if (ver && !ver.includes('not found')) {
        result.version = ver.split('\n')[0];
      }
    } catch (e) {
      // claude CLI not installed
    }

    // 3. Scan recent session files (read-only, SAFE)
    try {
      if (fs.existsSync(CLAUDE_SESSIONS_DIR)) {
        const projectDirs = fs.readdirSync(CLAUDE_SESSIONS_DIR);
        const cutoff = Date.now() - (24 * 60 * 60 * 1000); // last 24h

        for (const dir of projectDirs.slice(-20)) { // limit scan to last 20 project dirs
          const projectPath = path.join(CLAUDE_SESSIONS_DIR, dir);
          let stat;
          try { stat = fs.statSync(projectPath); } catch { continue; }
          if (!stat.isDirectory()) continue;

          const files = fs.readdirSync(projectPath)
            .filter(f => f.endsWith('.jsonl'))
            .map(f => {
              const fp = path.join(projectPath, f);
              try {
                const s = fs.statSync(fp);
                return { name: f, path: fp, mtime: s.mtimeMs, size: s.size };
              } catch { return null; }
            })
            .filter(f => f && f.mtime > cutoff)
            .sort((a, b) => b.mtime - a.mtime);

          for (const file of files.slice(0, 5)) { // up to 5 recent sessions per project
            // Read just the first line to get session metadata
            let firstLine = '';
            let fd = null;
            try {
              fd = fs.openSync(file.path, 'r');
              const buf = Buffer.alloc(2048);
              const bytesRead = fs.readSync(fd, buf, 0, 2048, 0);
              firstLine = buf.toString('utf8', 0, bytesRead).split('\n')[0];
            } catch {
              continue;
            } finally {
              if (fd !== null) {
                try { fs.closeSync(fd); } catch {}
              }
            }

            let meta = {};
            try { meta = JSON.parse(firstLine); } catch { continue; }

            const projectName = dir.replace(/-/g, '/').replace(/^\//, '');
            result.sessions.push({
              sessionId: file.name.replace('.jsonl', ''),
              project: projectName,
              lastActive: new Date(file.mtime).toISOString(),
              sizeKB: Math.round(file.size / 1024),
              model: meta.model || null,
              source: 'claude-code'
            });
          }
        }
      }
    } catch (e) {
      result.error = e.message;
    }

    return result;
  },

  // ── Run full discovery cycle ──
  async poll() {
    if (discovery.polling) return discovery.results;
    discovery.polling = true;

    try {
      const [ocResult, ccResult] = await Promise.allSettled([
        discovery.probeOpenClaw(),
        discovery.probeClaudeCode()
      ]);

      discovery.results = {
        openclaw: ocResult.status === 'fulfilled' ? ocResult.value : { reachable: false, error: ocResult.reason?.message },
        claudeCode: ccResult.status === 'fulfilled' ? ccResult.value : { running: false, error: ccResult.reason?.message },
        timestamp: new Date().toISOString()
      };

      // Update actor statuses in DB based on discovery
      discovery.syncActorStatuses();

      // Run orchestration engine — auto-transition tasks based on agent activity
      try {
        const processWithTx = db.transaction(() => {
          const allTasks = stmts.getAllTasks.all().map(r => JSON.parse(r.data));
          const allActors = stmts.getAllActors.all().map(r => JSON.parse(r.data));
          return Orchestrator.processDiscoveryResults(
            discovery.results, allTasks, allActors, stmts, broadcast
          );
        });
        const changes = processWithTx();
        if (changes.length > 0) {
          console.log(`  Orchestrator: ${changes.length} auto-transition(s)`);
          changes.forEach(c => console.log(`    #${c.taskNum}: ${c.from}→${c.to} [${c.trigger}] — ${c.reason}`));
          broadcast('orchestrator_changes', { changes, timestamp: new Date().toISOString() });
        }
      } catch (e) {
        console.error('  Orchestrator error:', e.message);
      }

      discovery.lastPoll = Date.now();
    } catch (e) {
      console.error('  Discovery error:', e.message);
    } finally {
      discovery.polling = false;
    }

    return discovery.results;
  },

  // ── Sync discovered status into actors table ──
  syncActorStatuses() {
    const r = discovery.results;
    if (!r) return;

    const allActors = stmts.getAllActors.all().map(row => JSON.parse(row.data));
    let changed = false;

    for (const actor of allActors) {
      let newStatus = actor.status;
      let newMeta = { ...(actor.meta || {}) };

      // Match OpenClaw actors
      if ((actor.endpoint && actor.endpoint.includes('127.0.0.1:18789')) || actor.endpoint?.includes('localhost:18789')) {
        if (r.openclaw) {
          const prev = actor.status;
          newStatus = r.openclaw.reachable ? 'online' : 'offline';
          newMeta.lastProbe = r.timestamp;
          newMeta.lastProbeResult = r.openclaw.reachable ? 'reachable' : (r.openclaw.error || 'unreachable');

          // Attach discovered sub-agents
          if (r.openclaw.agents && r.openclaw.agents.length > 0) {
            const discoveredNames = r.openclaw.agents.map(a => a.id);
            newMeta.discoveredAgents = discoveredNames;
            // Merge into subAgents if not already present
            const existing = new Set(actor.subAgents || []);
            for (const name of discoveredNames) {
              if (name !== 'main') existing.add(name);
            }
            actor.subAgents = [...existing];
          }

          // Attach active sessions
          if (r.openclaw.sessions && r.openclaw.sessions.length > 0) {
            newMeta.activeSessions = r.openclaw.sessions.length;
            newMeta.sessionDetails = r.openclaw.sessions.slice(0, 10);
          }

          if (prev !== newStatus) changed = true;
        }
      }

      // Match Claude Code actors
      if (actor.name?.toLowerCase().includes('claude') && actor.type === 'ai') {
        if (r.claudeCode) {
          const prev = actor.status;
          newStatus = r.claudeCode.running ? 'online' : 'idle';
          newMeta.lastProbe = r.timestamp;
          newMeta.claudeVersion = r.claudeCode.version;
          newMeta.recentSessions = r.claudeCode.sessions?.length || 0;

          if (r.claudeCode.sessions && r.claudeCode.sessions.length > 0) {
            newMeta.sessionDetails = r.claudeCode.sessions.slice(0, 5);
          }

          if (prev !== newStatus) changed = true;
        }
      }

      actor.status = newStatus;
      actor.meta = newMeta;

      // Write back
      try {
        stmts.upsertActor.run({
          id: actor.id, type: actor.type, name: actor.name,
          data: JSON.stringify(actor), status: newStatus,
          created_at: Date.now()
        });
      } catch (e) {
        // ignore individual write failures
      }
    }

    // Session→Task linking is now handled by the Orchestrator (System 3)
    // which runs after syncActorStatuses in the poll() method

    if (changed) {
      broadcast('actors_updated', { actors: allActors, discovery: r });
    }
  },

  // ── Start / Stop periodic polling ──
  start() {
    if (discovery.intervalHandle) return;
    console.log(`  → Discovery polling every ${DISCOVERY_INTERVAL_MS / 1000}s`);
    // Initial poll after 2s (let server start first)
    setTimeout(() => discovery.poll(), 2000);
    discovery.intervalHandle = setInterval(() => discovery.poll(), DISCOVERY_INTERVAL_MS);
  },

  stop() {
    if (discovery.intervalHandle) {
      clearInterval(discovery.intervalHandle);
      discovery.intervalHandle = null;
    }
  }
};

// ── Discovery API endpoints ──
app.get('/api/discovery', async (req, res) => {
  try {
    // Return cached results if fresh (< interval), or force poll
    if (req.query.force === 'true' || !discovery.results.timestamp) {
      const results = await discovery.poll();
      res.json(results);
    } else {
      res.json(discovery.results);
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/discovery/openclaw', async (req, res) => {
  try {
    const result = await discovery.probeOpenClaw();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/discovery/claude-code', async (req, res) => {
  try {
    const result = await discovery.probeClaudeCode();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Manual trigger to run discovery and sync actors
app.post('/api/discovery/sync', async (req, res) => {
  try {
    const results = await discovery.poll();
    res.json({ ok: true, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Agent Registry API ──
app.get('/api/registry', (req, res) => {
  try {
    const allActors = stmts.getAllActors.all().map(r => JSON.parse(r.data));
    const profiles = allActors.map(a => AgentRegistry.resolve(a));
    res.json({ profiles, defaults: AgentRegistry.profiles });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/registry/:actorId', (req, res) => {
  try {
    const row = stmts.getActor.get(req.params.actorId);
    if (!row) return res.status(404).json({ error: 'Actor not found' });
    const actor = JSON.parse(row.data);
    res.json(AgentRegistry.resolve(actor));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Suggest best agent for a task
app.post('/api/registry/suggest', (req, res) => {
  try {
    const task = req.body;
    const allActors = stmts.getAllActors.all().map(r => JSON.parse(r.data));
    const suggestions = AgentRegistry.suggestAssignment(task, allActors);
    res.json(suggestions);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── State Machine API ──
app.get('/api/state-machine', (req, res) => {
  res.json({
    states: TaskStateMachine.states,
    transitions: TaskStateMachine.transitions
  });
});

app.post('/api/state-machine/validate', (req, res) => {
  try {
    const { taskId, toColumn, trigger } = req.body;
    const row = stmts.getTask.get(taskId);
    if (!row) return res.status(404).json({ error: 'Task not found' });
    const task = JSON.parse(row.data);
    const result = TaskStateMachine.canTransition(task.column, toColumn, task, trigger);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/state-machine/transition', (req, res) => {
  try {
    const { taskId, toColumn, trigger } = req.body;
    const row = stmts.getTask.get(taskId);
    if (!row) return res.status(404).json({ error: 'Task not found' });
    const task = JSON.parse(row.data);
    const result = TaskStateMachine.transition(task, toColumn, trigger, stmts.addAudit.run.bind(stmts.addAudit));
    if (result.moved) {
      stmts.upsertTask.run({
        id: task.id, num: task.num, data: JSON.stringify(task),
        column_id: task.column, priority: task.priority,
        assignee: task.assignee, created_at: task.created, updated_at: task.updated
      });
      broadcast('task_transitioned', { task, ...result });
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Orchestrator API ──
app.post('/api/orchestrator/run', async (req, res) => {
  try {
    const allTasks = stmts.getAllTasks.all().map(r => JSON.parse(r.data));
    const allActors = stmts.getAllActors.all().map(r => JSON.parse(r.data));
    const dr = discovery.results || { openclaw: { reachable: false }, claudeCode: { running: false } };
    const changes = Orchestrator.processDiscoveryResults(dr, allTasks, allActors, stmts, broadcast);
    if (changes.length > 0) {
      broadcast('orchestrator_changes', { changes });
    }
    res.json({ ok: true, changes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Health Check ──
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '1.1.0',
    uptime: process.uptime(),
    db: DB_PATH,
    clients: clients.size,
    tasks: db.prepare('SELECT COUNT(*) as c FROM tasks').get().c,
    actors: db.prepare('SELECT COUNT(*) as c FROM actors').get().c,
    audit: db.prepare('SELECT COUNT(*) as c FROM audit_log').get().c,
    discovery: {
      enabled: !!discovery.intervalHandle,
      lastPoll: discovery.lastPoll ? new Date(discovery.lastPoll).toISOString() : null,
      openclawReachable: discovery.results?.openclaw?.reachable || false,
      claudeCodeRunning: discovery.results?.claudeCode?.running || false
    }
  });
});

// ── Fallback: serve kanban.html for any unmatched route ──
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'kanban.html'));
});

// ─── Start Server ─────────────────────────────────────
server.listen(PORT, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════════╗');
  console.log('  ║  AgentFlow Server                            ║');
  console.log(`  ║  → http://localhost:${PORT}                    ║`);
  console.log(`  ║  → WebSocket: ws://localhost:${PORT}/ws         ║`);
  console.log(`  ║  → Database: ${path.basename(DB_PATH)}               ║`);
  console.log(`  ║  → OpenClaw: ${OPENCLAW_HOST}        ║`);
  console.log(`  ║  → Discovery: every ${DISCOVERY_INTERVAL_MS / 1000}s                  ║`);
  console.log('  ║  → Press Ctrl+C to stop                     ║');
  console.log('  ╚══════════════════════════════════════════════╝');
  console.log('');

  // Start agent discovery polling
  discovery.start();
});

// ─── Graceful Shutdown ────────────────────────────────
process.on('SIGINT', () => {
  console.log('\n  Shutting down...');
  discovery.stop();
  wss.close();
  db.close();
  server.close(() => process.exit(0));
});
process.on('SIGTERM', () => {
  discovery.stop();
  wss.close();
  db.close();
  server.close(() => process.exit(0));
});
