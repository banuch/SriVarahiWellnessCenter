'use strict';

const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');

class ValidationError extends Error {}

const PUBLIC_COLUMNS =
  'id, name, phone, email, role, level, referral_code, sponsor_id, status, created_at, promoted_at';

const ROLE_LABELS = { admin: 'Admin', supervisor: 'Supervisor', coach: 'Coach', customer: 'Customer' };

function roleLabel(user) {
  if (!user) return '';
  if (user.role === 'supervisor') return `Supervisor L${user.level || 1}`;
  return ROLE_LABELS[user.role] || user.role;
}

// ---------- settings ----------

function getSetting(db, key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(db, key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

function getPromotionTarget(db) {
  return parseInt(getSetting(db, 'promotion_target'), 10) || 5;
}

// ---------- lookups ----------

function findById(db, id) {
  return db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = ?`).get(id);
}

function findByCode(db, code) {
  return db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE referral_code = ?`).get(code);
}

function countDirectCustomers(db, userId) {
  return db
    .prepare("SELECT COUNT(*) AS n FROM users WHERE sponsor_id = ? AND role = 'customer' AND status = 'active'")
    .get(userId).n;
}

function generateReferralCode(db) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    let code = 'SV';
    for (let i = 0; i < 6; i++) code += alphabet[crypto.randomInt(alphabet.length)];
    if (!findByCode(db, code)) return code;
  }
}

// ---------- auth ----------

function authenticate(db, phone, password) {
  const row = db.prepare('SELECT * FROM users WHERE phone = ?').get(String(phone || '').trim());
  if (!row || !bcrypt.compareSync(String(password || ''), row.password_hash)) {
    throw new ValidationError('Wrong phone number or password.');
  }
  if (row.status !== 'active') {
    throw new ValidationError('Your account is blocked. Please contact the center.');
  }
  return findById(db, row.id);
}

// ---------- registration & promotion ----------

function register(db, input) {
  const name = String(input.name || '').trim();
  const phone = String(input.phone || '').trim();
  const email = String(input.email || '').trim() || null;
  const password = String(input.password || '');
  const role = String(input.role || '');
  const refCode = String(input.refCode || '').trim().toUpperCase();

  if (name.length < 2) throw new ValidationError('Please enter your full name.');
  if (!/^\d{10}$/.test(phone)) throw new ValidationError('Phone number must be 10 digits.');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ValidationError('Please enter a valid email.');
  if (password.length < 6) throw new ValidationError('Password must be at least 6 characters.');
  if (!['customer', 'coach'].includes(role)) throw new ValidationError('Please choose Customer or Coach.');
  if (db.prepare('SELECT 1 FROM users WHERE phone = ?').get(phone)) {
    throw new ValidationError('This phone number is already registered.');
  }

  let sponsor = null;
  if (refCode) {
    sponsor = findByCode(db, refCode);
    if (!sponsor || !['coach', 'supervisor'].includes(sponsor.role)) {
      throw new ValidationError('Referral code not found.');
    }
    if (sponsor.status !== 'active') throw new ValidationError('This referral code is not active.');
  }

  db.exec('BEGIN');
  try {
    const code = role === 'customer' ? null : generateReferralCode(db);
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO users (name, phone, email, password_hash, role, referral_code, sponsor_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(name, phone, email, bcrypt.hashSync(password, 10), role, code, sponsor ? sponsor.id : null);
    if (sponsor && role === 'customer') checkPromotion(db, sponsor.id);
    db.exec('COMMIT');
    return findById(db, Number(lastInsertRowid));
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * A Coach, Supervisor or Admin adds a Customer on their behalf.
 * Coaches and Supervisors always add the Customer to their own team.
 * Admins may name a sponsor by referral code, or leave it empty to add directly under the center.
 */
function addCustomer(db, staff, input) {
  if (!staff || staff.status !== 'active' || !['coach', 'supervisor', 'admin'].includes(staff.role)) {
    throw new ValidationError('Only Coaches, Supervisors and Admins can add customers.');
  }
  const refCode = staff.role === 'admin' ? input.refCode : staff.referral_code;
  return register(db, { ...input, role: 'customer', refCode });
}

/** Promote a Coach to Supervisor L1 once they reach the direct-customer target. */
function checkPromotion(db, userId) {
  const user = findById(db, userId);
  if (!user || user.role !== 'coach' || user.status !== 'active') return false;
  if (countDirectCustomers(db, userId) < getPromotionTarget(db)) return false;
  db.prepare(
    "UPDATE users SET role = 'supervisor', level = 1, promoted_at = datetime('now') WHERE id = ?"
  ).run(userId);
  return true;
}

function promoteEligibleCoaches(db) {
  const coaches = db.prepare("SELECT id FROM users WHERE role = 'coach' AND status = 'active'").all();
  let promoted = 0;
  for (const c of coaches) if (checkPromotion(db, c.id)) promoted++;
  return promoted;
}

/** Whether `actor` may turn this Customer into a Coach: the Admin, or the Customer's own sponsor. */
function canMakeCoach(actor, customer) {
  if (!actor || !customer || customer.role !== 'customer' || customer.status !== 'active') return false;
  if (actor.role === 'admin') return true;
  return ['coach', 'supervisor'].includes(actor.role) && actor.status === 'active' && customer.sponsor_id === actor.id;
}

/**
 * Promote a Customer to Coach. They keep their sponsor (so they stay in the same team as a Coach),
 * get a referral code, and can start referring people. The sponsor's earlier promotion is never undone.
 */
function makeCoach(db, actor, customerId) {
  const customer = findById(db, customerId);
  if (!customer || customer.role !== 'customer') throw new ValidationError('Only Customers can be made Coaches.');
  if (customer.status !== 'active') throw new ValidationError('Unblock this member before making them a Coach.');
  if (!canMakeCoach(actor, customer)) {
    throw new ValidationError('Only the Admin or the Customer’s own Coach/Supervisor can make them a Coach.');
  }
  db.prepare("UPDATE users SET role = 'coach', referral_code = ? WHERE id = ?").run(generateReferralCode(db), customerId);
  return findById(db, customerId);
}

// ---------- admin actions ----------

/**
 * Admin sets any member's position: Customer, Coach, or Supervisor (with a level).
 * The member keeps their sponsor and their place in the team.
 * Someone with people directly under them cannot become a Customer, because Customers have no team.
 */
function setRole(db, userId, role, level) {
  const user = findById(db, userId);
  if (!user || user.role === 'admin') throw new ValidationError('Member not found.');
  if (!['customer', 'coach', 'supervisor'].includes(role)) throw new ValidationError('Please choose Customer, Coach or Supervisor.');

  let n = null;
  if (role === 'supervisor') {
    n = level === undefined || level === '' ? user.level || 1 : parseInt(level, 10);
    if (!Number.isInteger(n) || n < 1) throw new ValidationError('Level must be 1 or higher.');
  }

  if (role === 'customer') {
    const { count } = db.prepare('SELECT COUNT(*) AS count FROM users WHERE sponsor_id = ?').get(userId);
    if (count > 0) {
      throw new ValidationError(
        `${user.name} has ${count} member(s) directly under them, and Customers cannot have a team.`
      );
    }
  }

  db.exec('BEGIN');
  try {
    const code = role === 'customer' ? null : user.referral_code || generateReferralCode(db);
    const promotedAt =
      role !== 'supervisor' ? null : user.role === 'supervisor' ? user.promoted_at : new Date().toISOString().slice(0, 19).replace('T', ' ');
    db.prepare('UPDATE users SET role = ?, level = ?, referral_code = ?, promoted_at = ? WHERE id = ?').run(
      role,
      n,
      code,
      promotedAt,
      userId
    );
    // A new Customer may complete their sponsor's promotion target.
    if (role === 'customer' && user.sponsor_id) checkPromotion(db, user.sponsor_id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return findById(db, userId);
}

function setLevel(db, userId, level) {
  const user = findById(db, userId);
  if (!user || user.role !== 'supervisor') throw new ValidationError('Only Supervisors have levels.');
  const n = parseInt(level, 10);
  if (!Number.isInteger(n) || n < 1) throw new ValidationError('Level must be 1 or higher.');
  db.prepare('UPDATE users SET level = ? WHERE id = ?').run(n, userId);
}

function setStatus(db, userId, status) {
  if (!['active', 'blocked'].includes(status)) throw new ValidationError('Invalid status.');
  const user = findById(db, userId);
  if (!user || user.role === 'admin') throw new ValidationError('Member not found.');
  db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, userId);
  // An unblocked customer may complete a Coach's target.
  if (status === 'active' && user.sponsor_id) checkPromotion(db, user.sponsor_id);
}

function setPromotionTarget(db, value) {
  const n = parseInt(value, 10);
  if (!Number.isInteger(n) || n < 1 || n > 1000) throw new ValidationError('Target must be between 1 and 1000.');
  setSetting(db, 'promotion_target', n);
  return promoteEligibleCoaches(db);
}

function listMembers(db, { q = '', role = '' } = {}) {
  const where = ["u.role != 'admin'"];
  const params = [];
  if (q) {
    where.push('(u.name LIKE ? OR u.phone LIKE ? OR u.referral_code LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  if (role) {
    where.push('u.role = ?');
    params.push(role);
  }
  return db
    .prepare(
      `SELECT u.id, u.name, u.phone, u.email, u.role, u.level, u.referral_code, u.status, u.created_at,
              s.name AS sponsor_name,
              (SELECT COUNT(*) FROM users c WHERE c.sponsor_id = u.id AND c.role = 'customer' AND c.status = 'active') AS direct_customers
         FROM users u LEFT JOIN users s ON s.id = u.sponsor_id
        WHERE ${where.join(' AND ')}
        ORDER BY u.id DESC`
    )
    .all(...params);
}

// ---------- team ----------

/** True when `memberId` sits somewhere below `ancestorId` in the referral tree. */
function isInDownline(db, ancestorId, memberId) {
  const getSponsor = db.prepare('SELECT sponsor_id FROM users WHERE id = ?');
  let current = getSponsor.get(memberId);
  const seen = new Set();
  while (current && current.sponsor_id != null && !seen.has(current.sponsor_id)) {
    if (current.sponsor_id === ancestorId) return true;
    seen.add(current.sponsor_id);
    current = getSponsor.get(current.sponsor_id);
  }
  return false;
}

/**
 * Team chart for a member (or the whole center when rootId is null).
 *
 * - Supervisors: everyone with role supervisor below the root, grouped by line.
 *   Line = number of supervisors on the path from the root (exclusive) down to
 *   that supervisor (inclusive). So the nearest supervisors are the 1st line,
 *   supervisors inside their teams are the 2nd line, and so on.
 * - Coaches / Customers: only the ones referred directly by the root.
 */
function buildTeam(db, rootId) {
  const all = db
    .prepare(
      `SELECT id, name, phone, role, level, status, sponsor_id, created_at
         FROM users WHERE role != 'admin' ORDER BY id`
    )
    .all();
  const children = new Map();
  for (const u of all) {
    const key = u.sponsor_id ?? 0;
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(u);
  }

  const rootKey = rootId ?? 0;
  const lines = new Map();
  const coaches = [];
  const customers = [];
  let total = 0;
  const seen = new Set();
  const stack = [[rootKey, 0]];

  while (stack.length) {
    const [id, supCount] = stack.pop();
    for (const child of children.get(id) || []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      total++;
      let depth = supCount;
      if (child.role === 'supervisor') {
        depth = supCount + 1;
        if (!lines.has(depth)) lines.set(depth, []);
        lines.get(depth).push(child);
      } else if (id === rootKey) {
        (child.role === 'coach' ? coaches : customers).push(child);
      }
      stack.push([child.id, depth]);
    }
  }

  const byId = (a, b) => a.id - b.id;
  return {
    supervisorLines: [...lines.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([line, members]) => ({ line, members: members.sort(byId) })),
    coaches: coaches.sort(byId),
    customers: customers.sort(byId),
    total,
  };
}

module.exports = {
  ValidationError,
  roleLabel,
  getSetting,
  setSetting,
  getPromotionTarget,
  findById,
  findByCode,
  countDirectCustomers,
  authenticate,
  register,
  addCustomer,
  canMakeCoach,
  makeCoach,
  checkPromotion,
  promoteEligibleCoaches,
  setLevel,
  setRole,
  setStatus,
  setPromotionTarget,
  listMembers,
  isInDownline,
  buildTeam,
};
