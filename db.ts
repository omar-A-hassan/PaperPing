import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

let db: Database | null = null;

function getDB(): Database {
  if (!db) throw new Error("DB not initialized — call initDB() first.");
  return db;
}

export function initDB(path?: string): void {
  const dbPath = path ?? join(homedir(), ".scholar", "scholar.db");
  if (dbPath !== ":memory:") {
    mkdirSync(join(homedir(), ".scholar"), { recursive: true });
  }
  db = new Database(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS papers (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      type         TEXT NOT NULL,
      ref_id       TEXT NOT NULL UNIQUE,
      title        TEXT NOT NULL,
      authors      TEXT NOT NULL DEFAULT '',
      digest       TEXT NOT NULL,
      topics       TEXT NOT NULL DEFAULT '',
      read_at      TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS subscriptions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      topic        TEXT NOT NULL UNIQUE,
      keywords     TEXT NOT NULL DEFAULT '',
      added_at     TEXT NOT NULL,
      last_checked TEXT
    );
    CREATE TABLE IF NOT EXISTS config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS briefing_config (
      sender      TEXT PRIMARY KEY,
      hour        INTEGER NOT NULL DEFAULT 7,
      minute      INTEGER NOT NULL DEFAULT 0,
      paper_count INTEGER NOT NULL DEFAULT 5,
      updated_at  TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      sender          TEXT NOT NULL PRIMARY KEY,
      running_summary TEXT NOT NULL DEFAULT '',
      messages        TEXT NOT NULL DEFAULT '[]',
      started_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS session_summaries (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      sender     TEXT NOT NULL,
      summary    TEXT NOT NULL,
      topics     TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS session_summaries_fts USING fts5(
      summary, topics,
      content='session_summaries', content_rowid='id',
      tokenize='porter ascii'
    );
    CREATE TABLE IF NOT EXISTS user_profiles (
      sender     TEXT PRIMARY KEY,
      profile    TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS active_papers (
      sender    TEXT NOT NULL,
      ref_id    TEXT NOT NULL,
      title     TEXT NOT NULL,
      digest    TEXT NOT NULL,
      pinned_at TEXT NOT NULL,
      PRIMARY KEY (sender, ref_id)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS papers_fts USING fts5(
      ref_id UNINDEXED, title, digest, topics,
      content='papers', content_rowid='id',
      tokenize='porter ascii'
    );
    CREATE TABLE IF NOT EXISTS session_summary_embeddings (
      rowid    INTEGER PRIMARY KEY,
      embedding TEXT NOT NULL
    );
  `);

  // Safe column additions (SQLite throws if column already exists — ignore)
  const safeAlter = (sql: string) => { try { db!.exec(sql); } catch { /* column exists */ } };
  safeAlter(`ALTER TABLE papers ADD COLUMN abstract      TEXT NOT NULL DEFAULT ''`);
  safeAlter(`ALTER TABLE papers ADD COLUMN published_at  TEXT NOT NULL DEFAULT ''`);
  safeAlter(`ALTER TABLE papers ADD COLUMN categories    TEXT NOT NULL DEFAULT ''`);
  safeAlter(`ALTER TABLE papers ADD COLUMN full_text     TEXT NOT NULL DEFAULT ''`);
  safeAlter(`ALTER TABLE papers ADD COLUMN figure_urls   TEXT NOT NULL DEFAULT '[]'`);
  safeAlter(`ALTER TABLE subscriptions ADD COLUMN neighbor_categories TEXT NOT NULL DEFAULT ''`);

  // Populate FTS index if papers exist but FTS is empty (first run after upgrade)
  const papersN = (db.query("SELECT count(*) as n FROM papers").get() as { n: number }).n;
  const ftsN = (db.query("SELECT count(*) as n FROM papers_fts").get() as { n: number }).n;
  if (papersN > 0 && ftsN === 0) {
    db.exec(`INSERT INTO papers_fts(papers_fts) VALUES('rebuild')`);
  }

  // Migrate legacy conversation_history → sessions if needed
  try {
    const hasOldTable = db.query(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_history'`
    ).get();
    if (hasOldTable) {
      db.exec(`
        INSERT OR IGNORE INTO sessions (sender, messages, started_at, updated_at)
        SELECT sender, messages, updated_at, updated_at
        FROM conversation_history
      `);
      db.exec(`DROP TABLE IF EXISTS conversation_history`);
    }
  } catch { /* ignore migration errors */ }
}

// ─── Papers ───────────────────────────────────────────────────────────────────

export function storePaper(p: {
  type: string;
  ref_id: string;
  title: string;
  authors: string;
  digest: string;
  topics: string;
  abstract?: string;
  published_at?: string;
  categories?: string;
}): void {
  const result = getDB()
    .query(
      `INSERT OR IGNORE INTO papers
         (type, ref_id, title, authors, digest, topics, abstract, published_at, categories, read_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      p.type, p.ref_id, p.title, p.authors, p.digest, p.topics,
      p.abstract ?? "", p.published_at ?? "", p.categories ?? "",
      new Date().toISOString()
    ) as any;

  if (result.changes > 0) {
    getDB()
      .query(
        `INSERT INTO papers_fts(rowid, ref_id, title, digest, topics)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(result.lastInsertRowid, p.ref_id, p.title, p.digest, p.topics);
  }
}

export function queryMemory(query: string, limit = 10): Array<{
  ref_id: string;
  title: string;
  digest: string;
  read_at: string;
}> {
  try {
    return getDB()
      .query(
        `SELECT papers.ref_id, papers.title, papers.digest, papers.read_at
         FROM papers_fts
         JOIN papers ON papers.id = papers_fts.rowid
         WHERE papers_fts MATCH ?
         ORDER BY rank
         LIMIT ?`
      )
      .all(query, limit) as any;
  } catch {
    return [];
  }
}

export function isAlreadyRead(ref_id: string): boolean {
  return !!getDB().query(`SELECT 1 FROM papers WHERE ref_id = ?`).get(ref_id);
}

export function getPaperByRefId(ref_id: string): {
  ref_id: string;
  title: string;
  digest: string;
  abstract: string;
  full_text: string;
  figure_urls: string;
  read_at: string;
} | null {
  return (
    getDB()
      .query(
        `SELECT ref_id, title, digest, abstract, full_text, figure_urls, read_at
         FROM papers WHERE ref_id = ?`
      )
      .get(ref_id) as any ?? null
  );
}

export function updatePaperFullText(ref_id: string, full_text: string): void {
  getDB()
    .query(`UPDATE papers SET full_text = ? WHERE ref_id = ?`)
    .run(full_text, ref_id);
}

export function updatePaperFigureUrls(ref_id: string, figure_urls: string[]): void {
  getDB()
    .query(`UPDATE papers SET figure_urls = ? WHERE ref_id = ?`)
    .run(JSON.stringify(figure_urls), ref_id);
}

export function getPaperFigureUrls(ref_id: string): string[] {
  const row = getDB()
    .query(`SELECT figure_urls FROM papers WHERE ref_id = ?`)
    .get(ref_id) as { figure_urls: string } | null;
  if (!row) return [];
  try {
    return JSON.parse(row.figure_urls) as string[];
  } catch {
    return [];
  }
}

export function listRecentPapers(limit = 5, withDigest = false): Array<{
  ref_id: string;
  title: string;
  digest?: string;
  read_at: string;
}> {
  const cols = withDigest ? "ref_id, title, digest, read_at" : "ref_id, title, read_at";
  return getDB()
    .query(`SELECT ${cols} FROM papers ORDER BY read_at DESC, id DESC LIMIT ?`)
    .all(limit) as any;
}

// ─── Subscriptions ────────────────────────────────────────────────────────────

export function addSubscription(topic: string): void {
  getDB()
    .query(`INSERT OR IGNORE INTO subscriptions (topic, added_at) VALUES (?, ?)`)
    .run(topic, new Date().toISOString());
}

export function removeSubscription(topic: string): boolean {
  const result = getDB()
    .query(`DELETE FROM subscriptions WHERE topic = ?`)
    .run(topic) as any;
  return result.changes > 0;
}

export function listSubscriptions(): Array<{
  id: number;
  topic: string;
  added_at: string;
  last_checked: string | null;
}> {
  return getDB()
    .query(`SELECT id, topic, added_at, last_checked FROM subscriptions ORDER BY added_at ASC`)
    .all() as any;
}

export function updateLastChecked(topic: string): void {
  getDB()
    .query(`UPDATE subscriptions SET last_checked = ? WHERE topic = ?`)
    .run(new Date().toISOString(), topic);
}

// ─── Config (watermark, briefing_last_sent, sent_guid) ────────────────────────

function configGet(key: string): string | null {
  const row = getDB()
    .query(`SELECT value FROM config WHERE key = ?`)
    .get(key) as { value: string } | null;
  return row?.value ?? null;
}

function configSet(key: string, value: string): void {
  getDB()
    .query(`INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)`)
    .run(key, value);
}

export function getBriefingLastSent(): string | null {
  return configGet("briefing_last_sent");
}

export function setBriefingLastSent(date: string): void {
  configSet("briefing_last_sent", date);
}

// ─── Sent-GUID echo guard ─────────────────────────────────────────────────────

const SENT_GUID_TTL_MS = 3 * 60 * 1000;

export function recordSentGuid(guid: string): void {
  getDB()
    .query(`INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)`)
    .run(`sent_guid:${guid}`, new Date().toISOString());
}

export function isSentGuid(guid: string): boolean {
  const cutoff = new Date(Date.now() - SENT_GUID_TTL_MS).toISOString();
  const row = getDB()
    .query(`SELECT value FROM config WHERE key = ? AND value > ?`)
    .get(`sent_guid:${guid}`, cutoff);
  return !!row;
}

export function purgeSentGuids(): void {
  const cutoff = new Date(Date.now() - SENT_GUID_TTL_MS * 2).toISOString();
  getDB()
    .query(`DELETE FROM config WHERE key LIKE 'sent_guid:%' AND value < ?`)
    .run(cutoff);
}

// ─── Sent-text echo guard (DB-persisted, survives restarts) ───────────────────
// Secondary defence for cases where iMessage re-queues a "Not Delivered" message
// with a new chat.db row and a new GUID, bypassing the GUID guard.
// Normalizes text (lowercase, collapsed whitespace) so minor iMessage reformatting
// still matches.

const SENT_TEXT_TTL_MS = 30 * 60 * 1000; // 30 min — covers Not Delivered retry window

function normalizeSentText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 500);
}

export function recordSentText(text: string): void {
  const key = `sent_text:${normalizeSentText(text)}`;
  getDB()
    .query(`INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)`)
    .run(key, new Date().toISOString());
}

export function wasSentText(text: string): boolean {
  const cutoff = new Date(Date.now() - SENT_TEXT_TTL_MS).toISOString();
  const key = `sent_text:${normalizeSentText(text)}`;
  const row = getDB()
    .query(`SELECT value FROM config WHERE key = ? AND value > ?`)
    .get(key, cutoff);
  return !!row;
}

export function purgeSentTexts(): void {
  const cutoff = new Date(Date.now() - SENT_TEXT_TTL_MS * 2).toISOString();
  getDB()
    .query(`DELETE FROM config WHERE key LIKE 'sent_text:%' AND value < ?`)
    .run(cutoff);
}

// ─── Briefing Config ──────────────────────────────────────────────────────────

const DEFAULT_BRIEFING_HOUR = 7;
const DEFAULT_BRIEFING_MINUTE = 0;
const DEFAULT_BRIEFING_COUNT = 5;

export function getBriefingConfig(sender: string): {
  hour: number;
  minute: number;
  paper_count: number;
} {
  const row = getDB()
    .query(`SELECT hour, minute, paper_count FROM briefing_config WHERE sender = ?`)
    .get(sender) as { hour: number; minute: number; paper_count: number } | null;
  return row ?? {
    hour: DEFAULT_BRIEFING_HOUR,
    minute: DEFAULT_BRIEFING_MINUTE,
    paper_count: DEFAULT_BRIEFING_COUNT,
  };
}

export function setBriefingConfig(
  sender: string,
  updates: Partial<{ hour: number; minute: number; paper_count: number }>
): void {
  const current = getBriefingConfig(sender);
  const merged = { ...current, ...updates };
  getDB()
    .query(
      `INSERT OR REPLACE INTO briefing_config (sender, hour, minute, paper_count, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(sender, merged.hour, merged.minute, merged.paper_count, new Date().toISOString());
}

// ─── Three-Tier Memory: Sessions (Tier 1 working memory) ─────────────────────

export type MessageTurn = {
  role: "user" | "assistant";
  content: string | Array<{ type: string; [key: string]: any }>;
};

export function getSession(sender: string): {
  running_summary: string;
  messages: MessageTurn[];
  started_at: string;
  updated_at: string;
} | null {
  const row = getDB()
    .query(`SELECT running_summary, messages, started_at, updated_at FROM sessions WHERE sender = ?`)
    .get(sender) as { running_summary: string; messages: string; started_at: string; updated_at: string } | null;
  if (!row) return null;
  return {
    running_summary: row.running_summary,
    messages: JSON.parse(row.messages),
    started_at: row.started_at,
    updated_at: row.updated_at,
  };
}

export function upsertSession(
  sender: string,
  messages: MessageTurn[],
  running_summary?: string
): void {
  const now = new Date().toISOString();
  const existing = getSession(sender);
  getDB()
    .query(
      `INSERT OR REPLACE INTO sessions (sender, running_summary, messages, started_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      sender,
      running_summary ?? existing?.running_summary ?? "",
      JSON.stringify(messages),
      existing?.started_at ?? now,
      now
    );
}

export function clearSession(sender: string): void {
  const now = new Date().toISOString();
  getDB()
    .query(
      `INSERT OR REPLACE INTO sessions (sender, running_summary, messages, started_at, updated_at)
       VALUES (?, '', '[]', ?, ?)`
    )
    .run(sender, now, now);
}

export function getSessionLastActivity(sender: string): string | null {
  const row = getDB()
    .query(`SELECT updated_at FROM sessions WHERE sender = ?`)
    .get(sender) as { updated_at: string } | null;
  return row?.updated_at ?? null;
}

// ─── Three-Tier Memory: Session Summaries (Tier 2 episodic memory) ────────────

// Returns the inserted rowid (used by callers to store embeddings).
export function storeSessionSummary(sender: string, summary: string, topics: string): number {
  const result = getDB()
    .query(
      `INSERT INTO session_summaries (sender, summary, topics, created_at)
       VALUES (?, ?, ?, ?)`
    )
    .run(sender, summary, topics, new Date().toISOString()) as any;

  if (result.changes > 0) {
    getDB()
      .query(`INSERT INTO session_summaries_fts(rowid, summary, topics) VALUES (?, ?, ?)`)
      .run(result.lastInsertRowid, summary, topics);
    return result.lastInsertRowid as number;
  }
  return 0;
}

export function getRecentSessionSummaries(sender: string, limit = 3): Array<{
  summary: string;
  created_at: string;
}> {
  return getDB()
    .query(
      `SELECT summary, created_at FROM session_summaries
       WHERE sender = ? ORDER BY id DESC LIMIT ?`
    )
    .all(sender, limit) as any;
}

// ─── Three-Tier Memory: User Profile (Tier 3 semantic memory) ─────────────────

export interface ScholarUserProfile {
  name?: string;
  timezone?: string;
  role?: string;
  primaryInterests: string[];
  secondaryInterests: string[];
  expertiseDomains: Record<string, "novice" | "intermediate" | "expert">;
  preferredResponseLength: "concise" | "detailed" | "adaptive";
  prefersExamples: boolean;
  formality: "casual" | "professional";
  activeProjects: Array<{
    name: string;
    description: string;
    lastMentioned: string;
  }>;
  knownFacts: Array<{
    fact: string;
    confidence: "stated" | "inferred";
    lastConfirmed: string;
  }>;
  sessionCount: number;
  firstSeen: string;
  lastSeen: string;
}

const DEFAULT_PROFILE: ScholarUserProfile = {
  primaryInterests: [],
  secondaryInterests: [],
  expertiseDomains: {},
  preferredResponseLength: "adaptive",
  prefersExamples: true,
  formality: "casual",
  activeProjects: [],
  knownFacts: [],
  sessionCount: 0,
  firstSeen: new Date().toISOString(),
  lastSeen: new Date().toISOString(),
};

export function getUserProfile(sender: string): ScholarUserProfile {
  const row = getDB()
    .query(`SELECT profile FROM user_profiles WHERE sender = ?`)
    .get(sender) as { profile: string } | null;
  if (!row) return { ...DEFAULT_PROFILE };
  try {
    return { ...DEFAULT_PROFILE, ...JSON.parse(row.profile) };
  } catch {
    return { ...DEFAULT_PROFILE };
  }
}

export function saveUserProfile(sender: string, profile: ScholarUserProfile): void {
  getDB()
    .query(
      `INSERT OR REPLACE INTO user_profiles (sender, profile, updated_at) VALUES (?, ?, ?)`
    )
    .run(sender, JSON.stringify(profile), new Date().toISOString());
}

export function mergeProfileDelta(
  sender: string,
  delta: Partial<ScholarUserProfile>
): void {
  const existing = getUserProfile(sender);
  const merged: ScholarUserProfile = {
    ...existing,
    ...delta,
    // Array fields: merge and deduplicate
    primaryInterests: delta.primaryInterests ?? existing.primaryInterests,
    secondaryInterests: delta.secondaryInterests ?? existing.secondaryInterests,
    expertiseDomains: { ...existing.expertiseDomains, ...(delta.expertiseDomains ?? {}) },
    activeProjects: delta.activeProjects ?? existing.activeProjects,
    knownFacts: delta.knownFacts ?? existing.knownFacts,
    lastSeen: new Date().toISOString(),
    sessionCount: existing.sessionCount + (delta.sessionCount === 1 ? 1 : 0),
  };
  saveUserProfile(sender, merged);
}

// ─── Active Papers (pinned to conversation context) ───────────────────────────

const MAX_PINNED_PAPERS = 3;

export function pinPaper(sender: string, ref_id: string, title: string, digest: string): void {
  const now = new Date().toISOString();
  getDB()
    .query(
      `INSERT OR REPLACE INTO active_papers (sender, ref_id, title, digest, pinned_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(sender, ref_id, title, digest, now);

  // Evict oldest if over limit (use rowid for stable insertion-order eviction)
  const count = (getDB()
    .query(`SELECT count(*) as n FROM active_papers WHERE sender = ?`)
    .get(sender) as { n: number }).n;

  if (count > MAX_PINNED_PAPERS) {
    getDB()
      .query(
        `DELETE FROM active_papers WHERE sender = ? AND rowid NOT IN (
           SELECT rowid FROM active_papers WHERE sender = ?
           ORDER BY rowid DESC LIMIT ?
         )`
      )
      .run(sender, sender, MAX_PINNED_PAPERS);
  }
}

export function getActivePapers(sender: string): Array<{
  ref_id: string;
  title: string;
  digest: string;
  pinned_at: string;
}> {
  return getDB()
    .query(
      `SELECT ref_id, title, digest, pinned_at FROM active_papers
       WHERE sender = ? ORDER BY pinned_at DESC`
    )
    .all(sender) as any;
}

export function unpinPaper(sender: string, ref_id: string): void {
  getDB()
    .query(`DELETE FROM active_papers WHERE sender = ? AND ref_id = ?`)
    .run(sender, ref_id);
}

export function clearActivePapers(sender: string): void {
  getDB()
    .query(`DELETE FROM active_papers WHERE sender = ?`)
    .run(sender);
}

// ─── Session Embeddings (pure-JS cosine similarity, no native extension needed) ─

function cosineSim(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export function storeSessionEmbedding(summaryId: number, embedding: number[]): void {
  getDB()
    .query(`INSERT OR REPLACE INTO session_summary_embeddings(rowid, embedding) VALUES (?, ?)`)
    .run(summaryId, JSON.stringify(embedding));
}

export function findSimilarSessions(
  sender: string,
  queryEmbedding: number[],
  limit = 3
): Array<{ summary: string; created_at: string }> {
  try {
    // Fetch all embeddings joined with their summaries for this sender
    const rows = getDB()
      .query(`
        SELECT ss.id, ss.summary, ss.created_at, sse.embedding
        FROM session_summaries ss
        JOIN session_summary_embeddings sse ON sse.rowid = ss.id
        WHERE ss.sender = ?
      `)
      .all(sender) as Array<{ id: number; summary: string; created_at: string; embedding: string }>;

    if (rows.length === 0) return [];

    // Score and sort by cosine similarity
    return rows
      .map((r) => ({
        summary: r.summary,
        created_at: r.created_at,
        score: cosineSim(queryEmbedding, JSON.parse(r.embedding) as number[]),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ summary, created_at }) => ({ summary, created_at }));
  } catch {
    return [];
  }
}
