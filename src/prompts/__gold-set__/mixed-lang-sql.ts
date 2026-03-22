// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

import type { Database, Statement } from 'better-sqlite3';

interface User {
  id: number;
  name: string;
  email: string;
  active: boolean;
}

interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
}

export function getActiveUsers(db: Database): User[] {
  const stmt: Statement = db.prepare(`
    SELECT id, name, email, active
    FROM users
    WHERE active = 1
    ORDER BY name ASC
  `);
  return stmt.all() as User[];
}

export function getUserById(db: Database, id: number): User | undefined {
  const stmt: Statement = db.prepare(`
    SELECT id, name, email, active
    FROM users
    WHERE id = ?
  `);
  return stmt.get(id) as User | undefined;
}

export function searchUsers(
  db: Database,
  query: string,
  page: number,
  pageSize: number,
): PaginatedResult<User> {
  const countStmt: Statement = db.prepare(`
    SELECT COUNT(*) as total
    FROM users
    WHERE name LIKE ? OR email LIKE ?
  `);
  const pattern = `%${query}%`;
  const { total } = countStmt.get(pattern, pattern) as { total: number };

  const dataStmt: Statement = db.prepare(`
    SELECT id, name, email, active
    FROM users
    WHERE name LIKE ? OR email LIKE ?
    ORDER BY name ASC
    LIMIT ? OFFSET ?
  `);
  const offset = (page - 1) * pageSize;
  const data = dataStmt.all(pattern, pattern, pageSize, offset) as User[];

  return { data, total, page, pageSize };
}

export function insertUser(db: Database, name: string, email: string): number {
  const stmt: Statement = db.prepare(`
    INSERT INTO users (name, email, active)
    VALUES (?, ?, 1)
  `);
  const result = stmt.run(name, email);
  return Number(result.lastInsertRowid);
}

export function deactivateUser(db: Database, id: number): boolean {
  const stmt: Statement = db.prepare(`
    UPDATE users
    SET active = 0
    WHERE id = ? AND active = 1
  `);
  const result = stmt.run(id);
  return result.changes > 0;
}

export function deleteInactiveUsers(db: Database, olderThanDays: number): number {
  const stmt: Statement = db.prepare(`
    DELETE FROM users
    WHERE active = 0
      AND updated_at < datetime('now', '-' || ? || ' days')
  `);
  const result = stmt.run(olderThanDays);
  return result.changes;
}
