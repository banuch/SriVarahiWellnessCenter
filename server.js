'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const session = require('express-session');
const { openDb, ensureAdmin } = require('./src/db');
const m = require('./src/members');

function createApp(db, { sessionSecret = crypto.randomBytes(32).toString('hex') } = {}) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));

  app.use(express.urlencoded({ extended: false }));
  app.use(express.static(path.join(__dirname, 'public')));
  app.use(
    session({
      secret: sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 12 },
    })
  );

  // Load the logged-in user and flash message for every request.
  app.use((req, res, next) => {
    res.locals.currentUser = null;
    res.locals.flash = req.session.flash || null;
    delete req.session.flash;
    res.locals.roleLabel = m.roleLabel;
    if (req.session.userId) {
      const user = m.findById(db, req.session.userId);
      if (user && user.status === 'active') {
        req.user = user;
        res.locals.currentUser = user;
      } else {
        delete req.session.userId;
      }
    }
    next();
  });

  const flash = (req, type, text) => {
    req.session.flash = { type, text };
  };
  const requireLogin = (req, res, next) => (req.user ? next() : res.redirect('/login'));
  const requireAdmin = (req, res, next) =>
    req.user && req.user.role === 'admin' ? next() : res.status(403).render('error', { message: 'Admins only.' });
  const baseUrl = (req) => `${req.protocol}://${req.get('host')}`;

  // ---------- public ----------

  app.get('/', (req, res) => (req.user ? res.redirect('/dashboard') : res.render('home')));

  app.get('/login', (req, res) => res.render('login', { phone: '' }));
  app.post('/login', (req, res) => {
    try {
      const user = m.authenticate(db, req.body.phone, req.body.password);
      req.session.regenerate(() => {
        req.session.userId = user.id;
        res.redirect(user.role === 'admin' ? '/admin' : '/dashboard');
      });
    } catch (err) {
      if (!(err instanceof m.ValidationError)) throw err;
      res.status(400).render('login', { phone: req.body.phone || '', error: err.message });
    }
  });

  app.get('/register', (req, res) => {
    const ref = String(req.query.ref || '').toUpperCase();
    const sponsor = ref ? m.findByCode(db, ref) : null;
    res.render('register', { form: { refCode: ref, role: 'customer' }, sponsor });
  });
  app.post('/register', (req, res) => {
    const form = { ...req.body };
    try {
      const user = m.register(db, form);
      req.session.regenerate(() => {
        req.session.userId = user.id;
        flash(req, 'success', `Welcome, ${user.name}! You have joined as a ${m.roleLabel(user)}.`);
        res.redirect('/dashboard');
      });
    } catch (err) {
      if (!(err instanceof m.ValidationError)) throw err;
      const sponsor = form.refCode ? m.findByCode(db, String(form.refCode).toUpperCase()) : null;
      delete form.password;
      res.status(400).render('register', { form, sponsor, error: err.message });
    }
  });

  app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/')));

  // ---------- members ----------

  app.get('/dashboard', requireLogin, (req, res) => {
    if (req.user.role === 'admin') return res.redirect('/admin');
    const sponsor = req.user.sponsor_id ? m.findById(db, req.user.sponsor_id) : null;
    res.render('dashboard', {
      member: req.user,
      sponsor,
      team: m.buildTeam(db, req.user.id),
      directCustomers: m.countDirectCustomers(db, req.user.id),
      target: m.getPromotionTarget(db),
      referralLink: req.user.referral_code ? `${baseUrl(req)}/register?ref=${req.user.referral_code}` : null,
    });
  });

  // Coaches, Supervisors and Admins add a Customer without logging out.
  const requireStaff = (req, res, next) =>
    req.user && ['coach', 'supervisor', 'admin'].includes(req.user.role)
      ? next()
      : res.status(403).render('error', { message: 'Only Coaches, Supervisors and Admins can add customers.' });

  app.get('/customers/new', requireLogin, requireStaff, (req, res) => {
    res.render('add-customer', { form: {} });
  });
  app.post('/customers', requireLogin, requireStaff, (req, res) => {
    const form = { ...req.body };
    try {
      const customer = m.addCustomer(db, req.user, form);
      const sponsor = customer.sponsor_id ? m.findById(db, customer.sponsor_id) : null;
      flash(
        req,
        'success',
        `${customer.name} was added as a Customer ${sponsor ? `under ${sponsor.name}` : 'directly under the center'}. ` +
          `They can log in with phone ${customer.phone} and the password you set.`
      );
      res.redirect(req.user.role === 'admin' ? '/admin' : '/dashboard');
    } catch (err) {
      if (!(err instanceof m.ValidationError)) throw err;
      delete form.password;
      res.status(400).render('add-customer', { form, error: err.message });
    }
  });

  app.post('/members/:id/make-coach', requireLogin, requireStaff, (req, res) => {
    try {
      const coach = m.makeCoach(db, req.user, Number(req.params.id));
      flash(req, 'success', `${coach.name} is now a Coach. Their referral code is ${coach.referral_code}.`);
    } catch (err) {
      if (!(err instanceof m.ValidationError)) throw err;
      flash(req, 'error', err.message);
    }
    const back = req.get('referer');
    res.redirect(back && back.startsWith(baseUrl(req)) ? back : req.user.role === 'admin' ? '/admin' : '/dashboard');
  });

  app.get('/members/:id', requireLogin, (req, res) => {
    const id = Number(req.params.id);
    const member = m.findById(db, id);
    const isAdmin = req.user.role === 'admin';
    if (!member || member.role === 'admin') return res.status(404).render('error', { message: 'Member not found.' });
    if (id === req.user.id && !isAdmin) return res.redirect('/dashboard');
    if (!isAdmin && !m.isInDownline(db, req.user.id, id)) {
      return res.status(403).render('error', { message: 'You can only view members of your own team.' });
    }
    res.render('member', {
      member,
      sponsor: member.sponsor_id ? m.findById(db, member.sponsor_id) : null,
      team: m.buildTeam(db, id),
      directCustomers: m.countDirectCustomers(db, id),
      target: m.getPromotionTarget(db),
      canMakeCoach: m.canMakeCoach(req.user, member),
    });
  });

  // ---------- admin ----------

  app.get('/admin', requireAdmin, (req, res) => {
    const q = String(req.query.q || '').trim();
    const role = ['supervisor', 'coach', 'customer'].includes(req.query.role) ? req.query.role : '';
    const counts = db
      .prepare("SELECT role, COUNT(*) AS n FROM users WHERE role != 'admin' GROUP BY role")
      .all()
      .reduce((acc, r) => ({ ...acc, [r.role]: r.n }), {});
    res.render('admin/members', { members: m.listMembers(db, { q, role }), q, role, counts });
  });

  app.get('/admin/tree', requireAdmin, (req, res) => {
    res.render('admin/tree', { team: m.buildTeam(db, null) });
  });

  const adminAction = (fn) => (req, res) => {
    try {
      fn(req);
    } catch (err) {
      if (!(err instanceof m.ValidationError)) throw err;
      flash(req, 'error', err.message);
    }
    const back = req.get('referer');
    res.redirect(back && back.startsWith(baseUrl(req)) ? back : '/admin');
  };

  app.post(
    '/admin/members/:id/level',
    requireAdmin,
    adminAction((req) => {
      m.setLevel(db, Number(req.params.id), req.body.level);
      flash(req, 'success', 'Level updated.');
    })
  );

  app.post(
    '/admin/members/:id/role',
    requireAdmin,
    adminAction((req) => {
      const u = m.setRole(db, Number(req.params.id), req.body.role, req.body.level);
      flash(req, 'success', `${u.name} is now ${m.roleLabel(u)}.${u.referral_code ? ` Referral code: ${u.referral_code}.` : ''}`);
    })
  );

  app.post(
    '/admin/members/:id/status',
    requireAdmin,
    adminAction((req) => {
      m.setStatus(db, Number(req.params.id), req.body.status);
      flash(req, 'success', req.body.status === 'blocked' ? 'Member blocked.' : 'Member unblocked.');
    })
  );

  app.get('/admin/settings', requireAdmin, (req, res) => {
    res.render('admin/settings', { target: m.getPromotionTarget(db) });
  });
  app.post(
    '/admin/settings',
    requireAdmin,
    adminAction((req) => {
      const promoted = m.setPromotionTarget(db, req.body.promotion_target);
      flash(req, 'success', `Settings saved.${promoted ? ` ${promoted} Coach(es) promoted to Supervisor L1.` : ''}`);
    })
  );

  // ---------- errors ----------

  app.use((req, res) => res.status(404).render('error', { message: 'Page not found.' }));
  app.use((err, req, res, _next) => {
    console.error(err);
    res.status(500).render('error', { message: 'Something went wrong. Please try again.' });
  });

  return app;
}

if (require.main === module) {
  const db = openDb(process.env.DB_PATH || path.join(__dirname, 'data', 'wellness.db'));
  const adminPhone = process.env.ADMIN_PHONE || '9999999999';
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
  if (ensureAdmin(db, { phone: adminPhone, password: adminPassword })) {
    console.log(`Created admin account: phone ${adminPhone} (change the password via ADMIN_PASSWORD).`);
  }
  if (!process.env.SESSION_SECRET) {
    console.warn('SESSION_SECRET not set; logins will reset whenever the server restarts.');
  }
  const app = createApp(db, process.env.SESSION_SECRET ? { sessionSecret: process.env.SESSION_SECRET } : {});
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => console.log(`Sri Varahi Wellness Center running at http://localhost:${port}`));
}

module.exports = { createApp };
