'use strict';
// Loads demo members that match the center's reference picture (Vasalakshmi Ramesh's team).
// Usage: npm run seed:demo   (all demo passwords are "demo123")

const path = require('node:path');
const { openDb, ensureAdmin } = require('../src/db');
const m = require('../src/members');

const db = openDb(process.env.DB_PATH || path.join(__dirname, '..', 'data', 'wellness.db'));
ensureAdmin(db, { phone: process.env.ADMIN_PHONE || '9999999999', password: process.env.ADMIN_PASSWORD || 'admin123' });

if (db.prepare("SELECT 1 FROM users WHERE phone = '8000000001'").get()) {
  console.log('Demo data already loaded.');
  process.exit(0);
}

const target = m.getPromotionTarget(db);
m.setSetting(db, 'promotion_target', 1); // so each demo supervisor is promoted by one customer
let phone = 8000000001;
const join = (name, role, sponsor) =>
  m.register(db, { name, phone: String(phone++), password: 'demo123', role, refCode: sponsor ? m.findById(db, sponsor.id).referral_code : '' });
const makeSupervisor = (name, sponsor) => {
  const s = join(name, 'coach', sponsor);
  join(`${name}'s customer`, 'customer', s);
  return s;
};

const root = join('Vasalakshmi Ramesh', 'coach');
['Ekambaram', 'Dilli Priya', 'Rajesh', 'Saradhamma'].forEach((n) => join(n, 'customer', root));
const line1 = ['Krubanidhi', 'Parameswari', 'Subramanyam', 'Prameela'].map((n) => makeSupervisor(n, root));
const vasudha = makeSupervisor('Vasudha', line1[0]);
makeSupervisor('Suguna', line1[1]);
makeSupervisor('Bhuvaneswari', vasudha);
['Shivaranjani', 'Hemalatha', 'Ranjitha', 'Divya', 'Prasad', 'Yuvaraj'].forEach((n) => join(n, 'coach', root));

m.setSetting(db, 'promotion_target', target);
console.log('Demo data loaded. Log in as Vasalakshmi Ramesh: phone 8000000001, password demo123');
