# Sri Varahi Wellness Center – Members & Teams

A web app for the center's Customers, Coaches and Supervisors, with referral codes, automatic promotion and team charts.

## Rules

| Rule | How it works |
|---|---|
| Joining | Anyone can join as a **Customer** or a **Coach**, with an optional referral code. Without a code, they join directly under the center. |
| Referring | Coaches and Supervisors each get a referral code and link. They can refer Customers and Coaches. Customers cannot refer anyone. |
| Promotion | A Coach is promoted to **Supervisor L1** automatically once they have *N* active direct Customers. *N* is 5 by default; Admin → Settings changes it. |
| Levels | The Admin raises or lowers Supervisor levels (L2, L3, …, no limit). |
| Team chart | **Supervisors** are grouped by line. 1st line = the nearest Supervisors in your team, 2nd line = Supervisors in their teams, and so on. **Coaches** and **Customers** show only the people you referred yourself. Supervisors stay in the team that promoted them. |
| Admin | Search and filter members, open anyone's chart, see the whole-center tree, set levels, block or unblock members, and change the promotion target. |

## Run it

Requires Node.js 22.5 or newer, which has SQLite built in.

```bash
npm install
npm start            # http://localhost:3000
npm run seed:demo    # optional: demo team matching the reference picture
npm test
```

Default admin login: phone `9999999999`, password `admin123`. Change these with environment variables **before the first start**.

| Variable | Purpose |
|---|---|
| `PORT` | Port (default 3000) |
| `DB_PATH` | SQLite file (default `data/wellness.db`) |
| `ADMIN_PHONE`, `ADMIN_PASSWORD` | Admin account created on the first start |
| `SESSION_SECRET` | Keeps people logged in across restarts. Set it in production. |

Demo logins (after `npm run seed:demo`): Vasalakshmi Ramesh, phone `8000000001`, password `demo123`.

## Code layout

- `server.js` – Express routes (public, member and admin)
- `src/db.js` – SQLite schema and admin seeding
- `src/members.js` – registration, promotion, levels and team-chart logic
- `views/` – EJS pages (`partials/chart.ejs` is the team chart)
- `public/style.css` – green wellness theme
- `test/` – rule tests (`npm test`)
