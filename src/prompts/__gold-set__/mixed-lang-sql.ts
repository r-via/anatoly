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

/**
 * Retrieves all active users from the database, ordered alphabetically by name.
 * @param db - The better-sqlite3 database connection.
 * @returns An array of active {@link User} objects sorted by name ascending.
 */
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

/**
 * Searches users by name or email using a LIKE pattern match and returns
 * paginated results. Pages are 1-indexed.
 * @param db - The better-sqlite3 database connection.
 * @param query - The search term; matched against both `name` and `email` with
 *   a surrounding `%` wildcard (i.e. `LIKE '%query%'`).
 * @param page - The 1-indexed page number to retrieve.
 * @param pageSize - The maximum number of results per page.
 * @returns A {@link PaginatedResult} containing the matching users (sorted by
 *   name ascending) and the total count of all matching rows.
 */
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

/**
 * Inserts a new user into the database with `active` set to `1`.
 * @param db - The better-sqlite3 database connection.
 * @param name - The user's display name.
 * @param email - The user's email address.
 * @returns The numeric primary key (row ID) of the newly inserted user.
 */
export function insertUser(db: Database, name: string, email: string): number {
  const stmt: Statement = db.prepare(`
    INSERT INTO users (name, email, active)
    VALUES (?, ?, 1)
  `);
  const result = stmt.run(name, email);
  return Number(result.lastInsertRowid);
}

/**
 * Soft-deletes a user by setting their `active` flag to `0`. Only affects
 * users that are currently active.
 * @param db - The better-sqlite3 database connection.
 * @param id - The primary key of the user to deactivate.
 * @returns `true` if a row was updated (user existed and was active), `false`
 *   if the user was not found or was already inactive.
 */
export function deactivateUser(db: Database, id: number): boolean {
  const stmt: Statement = db.prepare(`
    UPDATE users
    SET active = 0
    WHERE id = ? AND active = 1
  `);
  const result = stmt.run(id);
  return result.changes > 0;
}

/**
 * Permanently deletes inactive users whose `updated_at` timestamp is older
 * than the specified number of days.
 * @param db - The better-sqlite3 database connection.
 * @param olderThanDays - The age threshold in days; inactive users with an
 *   `updated_at` earlier than `now - olderThanDays` are deleted.
 * @returns The number of rows deleted.
 */
export function deleteInactiveUsers(db: Database, olderThanDays: number): number {
  const stmt: Statement = db.prepare(`
    DELETE FROM users
    WHERE active = 0
      AND updated_at < datetime('now', '-' || ? || ' days')
  `);
  const result = stmt.run(olderThanDays);
  return result.changes;
}
