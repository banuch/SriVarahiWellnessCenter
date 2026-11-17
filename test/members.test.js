'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const m = require('../src/members');

let phoneSeq = 9000000000;
function join(db, name, role, sponsor) {
  return m.register(db, {
    name,
    phone: String(phoneSeq++),
    password: 'secret1',
    role,
    refCode: sponsor ? m.findById(db, sponsor.id).referral_code : '',
  });
}

test('coach and customer can join; customers get no referral code', () => {
  const db = openDb(':memory:');
  const coach = join(db, 'Coach A', 'coach');
  const cust = join(db, 'Cust A', 'customer', coach);
  assert.match(coach.referral_code, /^SV[A-Z0-9]{6}$/);
  assert.equal(cust.referral_code, null);
  assert.equal(cust.sponsor_id, coach.id);
});

test('customers cannot refer; coaches can refer coaches', () => {
  const db = openDb(':memory:');
  const coach = join(db, 'Coach A', 'coach');
  const coach2 = join(db, 'Coach B', 'coach', coach);
  assert.equal(coach2.sponsor_id, coach.id);
  assert.throws(() => m.register(db, { name: 'X', phone: '9123456789', password: 'secret1', role: 'customer', refCode: 'NOPE' }), m.ValidationError);
});

test('coach is auto-promoted to Supervisor L1 at the customer target', () => {
  const db = openDb(':memory:');
  m.setPromotionTarget(db, 3);
  const coach = join(db, 'Coach A', 'coach');
  join(db, 'C1', 'customer', coach);
  join(db, 'C2', 'customer', coach);
  assert.equal(m.findById(db, coach.id).role, 'coach');
  join(db, 'C3', 'customer', coach);
  const after = m.findById(db, coach.id);
  assert.equal(after.role, 'supervisor');
  assert.equal(after.level, 1);
});

test('lowering the target promotes coaches who already qualify', () => {
  const db = openDb(':memory:');
  const coach = join(db, 'Coach A', 'coach');
  join(db, 'C1', 'customer', coach);
  join(db, 'C2', 'customer', coach);
  assert.equal(m.setPromotionTarget(db, 2), 1);
  assert.equal(m.findById(db, coach.id).role, 'supervisor');
});

test('team chart groups supervisors by line and lists only direct coaches/customers', () => {
  const db = openDb(':memory:');
  m.setPromotionTarget(db, 1);
  const root = join(db, 'Vasalakshmi', 'coach');
  join(db, 'RootCust', 'customer', root); // root -> Supervisor L1

  const s1 = join(db, 'Krubanidhi', 'coach', root);
  join(db, 'K-cust', 'customer', s1); // s1 -> supervisor (line 1)
  const s2 = join(db, 'Vasudha', 'coach', s1);
  join(db, 'V-cust', 'customer', s2); // s2 -> supervisor (line 2)
  const plainCoach = join(db, 'Plain coach under Vasudha', 'coach', s2);
  const s3 = join(db, 'Bhuvaneswari', 'coach', plainCoach);
  join(db, 'B-cust', 'customer', s3); // s3 -> supervisor (line 3, a coach in between does not count)
  const myCoach = join(db, 'Shivaranjani', 'coach', root);

  const team = m.buildTeam(db, root.id);
  assert.deepEqual(
    team.supervisorLines.map((l) => [l.line, l.members.map((x) => x.name)]),
    [[1, ['Krubanidhi']], [2, ['Vasudha']], [3, ['Bhuvaneswari']]]
  );
  assert.deepEqual(team.coaches.map((x) => x.id), [myCoach.id]);
  assert.deepEqual(team.customers.map((x) => x.name), ['RootCust']);
  assert.equal(team.total, 9);
  assert.ok(m.isInDownline(db, root.id, s3.id));
  assert.ok(!m.isInDownline(db, s3.id, root.id));
});

test('admin sets supervisor levels with no upper limit', () => {
  const db = openDb(':memory:');
  m.setPromotionTarget(db, 1);
  const coach = join(db, 'Coach A', 'coach');
  join(db, 'C1', 'customer', coach);
  m.setLevel(db, coach.id, 12);
  assert.equal(m.findById(db, coach.id).level, 12);
  assert.throws(() => m.setLevel(db, coach.id, 0), m.ValidationError);
});

test('blocked members cannot log in and their code cannot be used', () => {
  const db = openDb(':memory:');
  const coach = join(db, 'Coach A', 'coach');
  m.setStatus(db, coach.id, 'blocked');
  assert.throws(() => m.authenticate(db, coach.phone, 'secret1'), /blocked/);
  assert.throws(() => join(db, 'C1', 'customer', coach), /not active/);
});
