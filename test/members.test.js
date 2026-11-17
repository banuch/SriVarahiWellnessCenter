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

test('coach adds a customer to their own team, counting toward promotion', () => {
  const db = openDb(':memory:');
  m.setPromotionTarget(db, 1);
  const coach = join(db, 'Coach A', 'coach');
  // A role or refCode sent in the form is ignored: it is always a Customer under this coach.
  const cust = m.addCustomer(db, coach, { name: 'Walk In', phone: '9111111111', password: 'secret1', role: 'coach', refCode: 'OTHER' });
  assert.equal(cust.role, 'customer');
  assert.equal(cust.sponsor_id, coach.id);
  assert.equal(m.findById(db, coach.id).role, 'supervisor');
  assert.ok(m.authenticate(db, '9111111111', 'secret1'));
});

test('admin adds a customer under a code or directly under the center', () => {
  const db = openDb(':memory:');
  const admin = { role: 'admin', status: 'active' };
  const coach = join(db, 'Coach A', 'coach');
  const a = m.addCustomer(db, admin, { name: 'Cust A', phone: '9222222222', password: 'secret1', refCode: coach.referral_code.toLowerCase() });
  assert.equal(a.sponsor_id, coach.id);
  const b = m.addCustomer(db, admin, { name: 'Cust B', phone: '9222222223', password: 'secret1', refCode: '' });
  assert.equal(b.sponsor_id, null);
  assert.throws(() => m.addCustomer(db, admin, { name: 'Cust C', phone: '9222222224', password: 'secret1', refCode: 'NOPE' }), /not found/);
});

test('customers cannot add customers', () => {
  const db = openDb(':memory:');
  const coach = join(db, 'Coach A', 'coach');
  const cust = join(db, 'Cust A', 'customer', coach);
  assert.throws(() => m.addCustomer(db, cust, { name: 'X', phone: '9333333333', password: 'secret1' }), m.ValidationError);
});

test('sponsor or admin can make a customer a Coach; others cannot', () => {
  const db = openDb(':memory:');
  const coach = join(db, 'Coach A', 'coach');
  const other = join(db, 'Coach B', 'coach');
  const c1 = join(db, 'C1', 'customer', coach);
  const c2 = join(db, 'C2', 'customer', coach);
  assert.throws(() => m.makeCoach(db, other, c1.id), m.ValidationError);
  assert.throws(() => m.makeCoach(db, c2, c1.id), m.ValidationError);
  const promoted = m.makeCoach(db, coach, c1.id);
  assert.equal(promoted.role, 'coach');
  assert.equal(promoted.sponsor_id, coach.id);
  assert.match(promoted.referral_code, /^SV[A-Z0-9]{6}$/);
  assert.equal(m.countDirectCustomers(db, coach.id), 1);
  // The new Coach can refer people with their code.
  assert.equal(join(db, 'C3', 'customer', promoted).sponsor_id, promoted.id);
  // Admin can promote any customer; coaches cannot be "made Coach" again.
  assert.equal(m.makeCoach(db, { role: 'admin', status: 'active' }, c2.id).role, 'coach');
  assert.throws(() => m.makeCoach(db, coach, c2.id), /Only Customers/);
});

test('blocked customers cannot be made Coaches', () => {
  const db = openDb(':memory:');
  const coach = join(db, 'Coach A', 'coach');
  const c1 = join(db, 'C1', 'customer', coach);
  m.setStatus(db, c1.id, 'blocked');
  assert.throws(() => m.makeCoach(db, coach, c1.id), /Unblock/);
});

test('admin can set any position: customer, coach or supervisor with a level', () => {
  const db = openDb(':memory:');
  const coach = join(db, 'Coach A', 'coach');
  const cust = join(db, 'C1', 'customer', coach);

  const sup = m.setRole(db, cust.id, 'supervisor', 3);
  assert.equal(sup.role, 'supervisor');
  assert.equal(sup.level, 3);
  assert.equal(sup.sponsor_id, coach.id);
  assert.match(sup.referral_code, /^SV[A-Z0-9]{6}$/);
  assert.ok(sup.promoted_at);

  const back = m.setRole(db, cust.id, 'coach');
  assert.equal(back.role, 'coach');
  assert.equal(back.level, null);
  assert.equal(back.referral_code, sup.referral_code);

  const c = m.setRole(db, cust.id, 'customer');
  assert.equal(c.role, 'customer');
  assert.equal(c.referral_code, null);
  assert.throws(() => m.setRole(db, cust.id, 'admin'), m.ValidationError);
  assert.throws(() => m.setRole(db, cust.id, 'supervisor', 0), /Level/);
});

test('members with people under them cannot be made Customers', () => {
  const db = openDb(':memory:');
  const coach = join(db, 'Coach A', 'coach');
  join(db, 'C1', 'customer', coach);
  assert.throws(() => m.setRole(db, coach.id, 'customer'), /directly under them/);
  assert.equal(m.findById(db, coach.id).role, 'coach');
});

test('making a coach a Customer can complete their sponsor’s promotion', () => {
  const db = openDb(':memory:');
  m.setPromotionTarget(db, 1);
  const coach = join(db, 'Coach A', 'coach');
  const coach2 = join(db, 'Coach B', 'coach', coach);
  m.setRole(db, coach2.id, 'customer');
  assert.equal(m.findById(db, coach.id).role, 'supervisor');
});
