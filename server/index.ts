// WORLDZERO server: REST + Server-Sent Events over the simulation runtime.
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Runtime } from './runtime';
import { dateOf, SECTORS, type World, type Citizen, type Org } from './sim/types';
import { isActive, typeLabel } from './sim/world';
import { infectionLabel } from './sim/health';
import { essentialCost } from './sim/economy';
import { PARAMS, formatValue } from './god/params';
import { OPS, EVENTS } from './god/ops';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (existsSync(resolve(root, '.env'))) for (const line of readFileSync(resolve(root, '.env'), 'utf8').split(/\r?\n/)) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }

export function buildApp(rt: Runtime) {
  const app = Fastify({ logger: false, bodyLimit: 1e6 });
  const W = () => rt.world;
  const idx = () => W().market.index / W().market.indexBase;
  const cRef = (c: Citizen) => ({ ref: `citizen:${c.id}`, name: c.name, role: c.role, age: c.age });
  const oRef = (o: Org) => ({ ref: `org:${o.id}`, name: o.name, type: typeLabel(o.type), alive: o.alive });

  app.get('/api/state', async () => rt.status());
  app.get('/api/city', async () => ({ static: rt.cityStatic(), dynamic: rt.cityDynamic() }));
  app.get('/api/stream', (req, reply) => {
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const send = (m: any) => reply.raw.write(`data: ${JSON.stringify(m)}\n\n`);
    send({ type: 'tick', ...rt.status(), events: [] });
    rt.listeners.add(send);
    const ka = setInterval(() => reply.raw.write(': ka\n\n'), 15000);
    req.raw.on('close', () => { rt.listeners.delete(send); clearInterval(ka); });
  });
  app.post('/api/control', async (req) => {
    const b = (req.body || {}) as any;
    if (b.action === 'play') rt.setRunning(true); else if (b.action === 'pause') rt.setRunning(false);
    else if (b.action === 'speed') rt.setSpeed(Number(b.value) || 1); else if (b.action === 'step') { rt.setRunning(false); rt.stepDays(Math.max(1, Math.min(360, Number(b.value) || 1))); }
    else if (b.action === 'save') rt.save();
    return rt.status();
  });
  app.post('/api/god', async (req, reply) => { const text = String((req.body as any)?.text || '').trim(); if (!text) return reply.code(400).send({ error: 'empty instruction' }); if (text.length > 2000) return reply.code(400).send({ error: 'instruction too long' }); try { return await rt.god(text); } catch (e: any) { return reply.code(409).send({ error: String(e?.message || e) }); } });
  app.get('/api/chat', async () => rt.store.chat(80));
  app.get('/api/capabilities', async () => ({ parameters: PARAMS.map((p) => ({ key: p.key, label: p.label, value: formatValue(p.unit, p.get(W())), desc: p.desc })), operations: Object.values(OPS).map((o) => ({ name: o.name, desc: o.desc })), events: Object.entries(EVENTS).map(([k, e]) => ({ name: k, desc: e.desc })) }));

  app.get('/api/citizen/:id', async (req, reply) => {
    const w = W(), c = w.citizens[Number((req.params as any).id)]; if (!c) return reply.code(404).send({ error: 'not found' });
    const h = w.households[c.hh], e = h.alive ? essentialCost(w, h) : null;
    return { kind: 'citizen', id: c.id, name: c.name, age: c.age, sex: c.sex, alive: c.alive, left: c.left, status: c.status, role: c.role, goal: c.goal, lastDecision: c.lastDecision,
      employer: c.employer >= 0 ? oRef(w.orgs[c.employer]) : null, school: c.school >= 0 ? oRef(w.orgs[c.school]) : null, education: ['None', 'Primary', 'Secondary', 'University degree', 'Postgraduate'][c.edu], skill: c.skill, field: c.field,
      wage: c.wage, income: c.income, savings: c.savings, debt: c.debt, investments: c.equity * idx(), netWorth: c.savings + c.equity * idx() - c.debt, tier: ['Low income', 'Middle income', 'High income', 'Top 1%'][c.tier], stake: c.stakeOrg >= 0 ? oRef(w.orgs[c.stakeOrg]) : null,
      health: c.health, infection: infectionLabel(c), happiness: c.happy, stress: c.stress, trustGov: c.trustGov, trustMedia: c.trustMedia, trustBiz: c.trustBiz, ideology: c.ideology, protesting: c.protest, spendMode: c.spendMode, unempMonths: c.unempMonths,
      traits: c.traits, prefs: c.prefs,
      household: { id: h.id, district: w.districts[h.district]?.name || '—', districtRef: h.district >= 0 ? `district:${h.district}` : null, building: h.building >= 0 ? `building:${h.building}` : null, owns: h.owns, homeless: h.homeless, income: h.income, essentials: h.essential, purchasingPower: h.pp, hardshipMonths: h.hardship, budget: e, members: h.members.filter((i) => i !== c.id).map((i) => ({ ...cRef(w.citizens[i]), alive: isActive(w.citizens[i]) })) },
      partner: c.partner >= 0 ? cRef(w.citizens[c.partner]) : null, friends: c.friends.map((i) => cRef(w.citizens[i])),
      memories: [...c.mem].reverse().map((m) => ({ date: dateOf(Math.max(0, m.t)), text: m.d, v: m.v })), longTerm: [...c.ltm].reverse().map((m) => ({ date: dateOf(Math.max(0, m.t)), text: m.d, v: m.v })) };
  });
  app.get('/api/org/:id', async (req, reply) => {
    const w = W(), o = w.orgs[Number((req.params as any).id)]; if (!o) return reply.code(404).send({ error: 'not found' });
    const emps = o.employees.map((i) => w.citizens[i]);
    return { kind: 'org', id: o.id, name: o.name, type: typeLabel(o.type), sector: o.sector, alive: o.alive, founded: dateOf(Math.max(0, o.founded)), closed: o.closed >= 0 ? dateOf(o.closed) : null, closeReason: o.closeReason, objective: o.objective,
      district: w.districts[o.district]?.name, districtRef: `district:${o.district}`, building: `building:${o.building}`, employees: emps.length, openings: o.openings, owner: o.owner >= 0 ? cRef(w.citizens[o.owner]) : null, managers: o.managers.map((i) => cRef(w.citizens[i])),
      cash: o.cash, debt: o.debt, funding: o.funding, stage: o.stage, revenue: o.revenue, publicFunding: o.budgetRev, expenses: o.expenses, profit: o.profit, wageBill: o.wageBill, utilisation: o.util, marketShare: o.share, productivity: o.productivity, reputation: o.reputation, wageLevel: o.wageLevel, lossMonths: o.lossMonths,
      listed: o.listed, sharePrice: o.price, marketCap: o.listed ? o.price * o.shares : null, hiringFrozen: w.tick < o.freezeUntil, partners: o.partners.map((i) => oRef(w.orgs[i])), decisions: [...o.log].reverse().map((l) => ({ date: dateOf(Math.max(0, l.t)), text: l.d })),
      staff: emps.sort((a, b) => b.wage - a.wage).slice(0, 40).map((c) => ({ ...cRef(c), wage: c.wage })), avgWage: emps.length ? o.wageBill / emps.length : 0 };
  });
  app.get('/api/building/:id', async (req, reply) => {
    const w = W(), b = w.buildings[Number((req.params as any).id)]; if (!b) return reply.code(404).send({ error: 'not found' });
    const hhs = b.kind === 'residential' ? w.households.filter((h) => h.alive && h.building === b.id) : [];
    return { kind: 'building', id: b.id, name: b.name || `${b.kind} building`, type: b.kind, status: b.status, district: w.districts[b.district].name, districtRef: `district:${b.district}`, units: b.units, occupied: b.occupied, built: dateOf(Math.max(0, b.built)), height: b.h,
      orgs: b.orgs.map((i) => ({ ...oRef(w.orgs[i]), employees: w.orgs[i].employees.length })), residents: hhs.flatMap((h) => h.members.map((i) => w.citizens[i]).filter(isActive)).slice(0, 60).map(cRef), households: hhs.length, rentIndex: w.districts[b.district].rentIdx * w.prices.housing };
  });
  app.get('/api/district/:id', async (req, reply) => {
    const w = W(), d = w.districts[Number((req.params as any).id)]; if (!d) return reply.code(404).send({ error: 'not found' });
    const orgs = w.orgs.filter((o) => o.alive && o.district === d.id).sort((a, b) => b.employees.length - a.employees.length);
    return { kind: 'district', id: d.id, name: d.name, type: d.kind, wealth: ['Lower-income', 'Middle-income', 'Affluent'][d.wealth], population: d.pop, unemployment: d.unemp, avgIncome: d.avgIncome, crime: d.crime, rentIndex: d.rentIdx * w.prices.housing, happiness: d.happy, infected: d.infected, protesters: d.protest,
      buildings: w.buildings.filter((b) => b.district === d.id).length, freeLots: d.lots.filter((l) => !l.used).length, organisations: orgs.length, jobs: orgs.reduce((n, o) => n + o.employees.length, 0), topOrgs: orgs.slice(0, 12).map((o) => ({ ...oRef(o), employees: o.employees.length })),
      events: w.events.filter((e) => e.district === d.id).slice(-8).reverse().map((e) => ({ date: dateOf(e.t), title: e.title })) };
  });
  app.get('/api/search', async (req) => {
    const q = String((req.query as any).q || '').toLowerCase().trim(), w = W(); if (q.length < 2) return [];
    const out: any[] = [];
    for (const o of w.orgs) if (o.name.toLowerCase().includes(q)) { out.push({ ref: `org:${o.id}`, name: o.name, sub: `${typeLabel(o.type)} · ${o.employees.length} staff${o.alive ? '' : ' · closed'}` }); if (out.length > 7) break; }
    for (const d of w.districts) if (d.name.toLowerCase().includes(q)) out.push({ ref: `district:${d.id}`, name: d.name, sub: `${d.kind} district` });
    let n = 0; for (const c of w.citizens) if (c.name.toLowerCase().includes(q)) { out.push({ ref: `citizen:${c.id}`, name: c.name, sub: `${c.role}, ${c.age}` }); if (++n > 9) break; }
    return out;
  });
  app.get('/api/events', async (req) => { const q = req.query as any; return rt.world.events.filter((e) => !q.cat || e.cat === q.cat).slice(-(Number(q.limit) || 80)).reverse().map((e) => ({ ...e, date: dateOf(e.t) })); });
  app.get('/api/dashboard', async () => dashboard(W()));

  app.get('/api/timelines', async () => rt.timelines());
  app.post('/api/snapshots', async (req) => { const id = rt.snapshot(String((req.body as any)?.label || `Snapshot ${dateOf(W().tick)}`).slice(0, 80), 'manual'); rt.send({ type: 'timelines' }); return { id }; });
  const guard = (reply: any, fn: () => any) => { if (rt.busy) return reply.code(409).send({ error: 'busy' }); try { return fn() ?? { ok: true }; } catch (e: any) { return reply.code(400).send({ error: String(e?.message || e) }); } };
  app.post('/api/snapshots/:id/restore', async (req, reply) => guard(reply, () => { rt.restore((req.params as any).id); return rt.status(); }));
  app.post('/api/snapshots/:id/branch', async (req, reply) => guard(reply, () => ({ id: rt.branch((req.params as any).id, String((req.body as any)?.name || ''), !!(req.body as any)?.switch) })));
  app.delete('/api/snapshots/:id', async (req) => { rt.store.deleteSnapshot((req.params as any).id); rt.send({ type: 'timelines' }); return { ok: true }; });
  app.post('/api/timelines/branch', async (req, reply) => guard(reply, () => ({ id: rt.branch(null, String((req.body as any)?.name || ''), !!(req.body as any)?.switch) })));
  app.post('/api/timelines/:id/switch', async (req, reply) => guard(reply, () => { rt.switchTimeline((req.params as any).id); return rt.status(); }));
  app.post('/api/timelines/:id/rename', async (req) => { rt.store.renameTimeline((req.params as any).id, String((req.body as any)?.name || 'Timeline').slice(0, 80)); rt.send({ type: 'timelines' }); return { ok: true }; });
  app.delete('/api/timelines/:id', async (req, reply) => guard(reply, () => rt.deleteTimeline((req.params as any).id)));
  app.get('/api/compare', async (req, reply) => guard(reply, () => rt.compare(String((req.query as any).a), String((req.query as any).b))));

  const dist = resolve(root, 'dist');
  if (existsSync(dist)) { app.register(fastifyStatic, { root: dist }); app.setNotFoundHandler((req, reply) => (req.url.startsWith('/api') ? reply.code(404).send({ error: 'not found' }) : reply.sendFile('index.html'))); }
  return app;
}

function dashboard(w: World) {
  const act = w.citizens.filter(isActive), adults = act.filter((c) => c.age >= 18), ix = w.market.index / w.market.indexBase;
  const bucket = (arr: number[], edges: number[]) => edges.map((e, i) => ({ label: i === edges.length - 1 ? `${e}+` : `${e}–${edges[i + 1] - 1}`, value: arr.filter((v) => v >= e && (i === edges.length - 1 || v < edges[i + 1])).length }));
  const statusCount: Record<string, number> = {}; for (const c of act) statusCount[c.status] = (statusCount[c.status] || 0) + 1;
  const tiers = [0, 1, 2, 3].map((t) => { const g = adults.filter((c) => c.tier === t); return { label: ['Low income', 'Middle income', 'High income', 'Top 1%'][t], people: g.length, avgWealth: g.reduce((s, c) => s + c.savings + c.equity * ix - c.debt, 0) / Math.max(1, g.length), avgIncome: g.reduce((s, c) => s + c.income, 0) / Math.max(1, g.length), trust: g.reduce((s, c) => s + c.trustGov, 0) / Math.max(1, g.length), happy: g.reduce((s, c) => s + c.happy, 0) / Math.max(1, g.length) }; });
  const orgs = w.orgs.filter((o) => o.alive);
  const types: Record<string, { n: number; emp: number }> = {}; for (const o of orgs) { const t = (types[typeLabel(o.type)] ||= { n: 0, emp: 0 }); t.n++; t.emp += o.employees.length; }
  return {
    tick: w.tick, date: dateOf(w.tick), metrics: w.metrics, history: w.history, policy: w.policy, prices: w.prices, tuition: w.tuition,
    sectors: SECTORS.map((s) => ({ sector: s, ...w.sectors[s] })),
    gov: { leader: w.gov.leader >= 0 ? { ref: `citizen:${w.gov.leader}`, name: w.citizens[w.gov.leader].name } : null, party: w.gov.parties[w.gov.party].name, parties: w.gov.parties, approval: w.gov.approval, debt: w.gov.debt, rev: w.gov.rev, out: w.gov.out, balance: w.gov.balance, nextElection: dateOf(w.gov.nextElection), actions: [...w.gov.actions].reverse().map((a) => ({ date: dateOf(a.t), text: a.d })), locks: Object.entries(w.gov.locks).filter(([, t]) => t > w.tick).map(([k]) => k) },
    health: { ...w.health, diseases: w.health.diseases.map((d) => ({ ...d, startedDate: dateOf(d.started) })), hospitals: orgs.filter((o) => o.type === 'hospital').map((o) => ({ ref: `org:${o.id}`, name: o.name, staff: o.employees.length, util: o.util })) },
    edu: { ...w.edu, universities: orgs.filter((o) => o.type === 'university').map((o) => ({ ref: `org:${o.id}`, name: o.name, staff: o.employees.length, students: act.filter((c) => c.school === o.id && c.status === 'student').length })), eduLevels: ['None', 'Primary', 'Secondary', 'Degree', 'Postgraduate'].map((label, i) => ({ label, value: adults.filter((c) => c.edu === i).length })) },
    tech: { ...w.tech, items: w.tech.items.map((t) => ({ ...t, emergedDate: dateOf(t.emerged) })) },
    housing: w.housing, infra: w.infra, social: w.social, market: { index: w.market.index, confidence: w.market.confidence, credit: w.market.credit, vc: w.market.vc, indexHist: w.market.indexHist.slice(-180) }, shocks: w.ext.shocks.filter((s) => s.until > w.tick).map((s) => ({ name: s.name, until: dateOf(s.until) })),
    population: { ages: bucket(act.map((c) => c.age), [0, 6, 18, 30, 45, 65, 80]), status: Object.entries(statusCount).map(([label, value]) => ({ label, value })), tiers, births: w.social.births, deaths: w.social.deaths, migIn: w.social.migIn, migOut: w.social.migOut },
    orgTypes: Object.entries(types).map(([label, v]) => ({ label, ...v })),
    topOrgs: [...orgs].sort((a, b) => b.employees.length - a.employees.length).slice(0, 14).map((o) => ({ ref: `org:${o.id}`, name: o.name, type: typeLabel(o.type), sector: o.sector, employees: o.employees.length, revenue: o.revenue, profit: o.profit, price: o.listed ? o.price : null })),
    recentClosures: w.orgs.filter((o) => !o.alive && o.closed >= 0 && o.closeReason !== 'no premises available').sort((a, b) => b.closed - a.closed).slice(0, 10).map((o) => ({ ref: `org:${o.id}`, name: o.name, date: dateOf(o.closed), reason: o.closeReason })),
    districts: w.districts.map((d) => ({ ref: `district:${d.id}`, name: d.name, kind: d.kind, pop: d.pop, unemp: d.unemp, income: d.avgIncome, crime: d.crime, rent: d.rentIdx * w.prices.housing, happy: d.happy })),
    richest: [...adults].sort((a, b) => b.savings + b.equity * ix - (a.savings + a.equity * ix)).slice(0, 8).map((c) => ({ ref: `citizen:${c.id}`, name: c.name, role: c.role, wealth: c.savings + c.equity * ix - c.debt })),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4000);
  const t0 = Date.now();
  const rt = new Runtime(process.env.WORLDZERO_DB || resolve(root, 'data', 'worldzero.db'), { seed: process.env.WORLD_SEED ? Number(process.env.WORLD_SEED) : undefined }).init();
  rt.start();
  const app = buildApp(rt);
  app.listen({ port, host: '127.0.0.1' }).then(() => console.log(`WORLDZERO ready on http://localhost:${port} — ${rt.world.metrics.population} citizens, day ${rt.world.tick} (${Date.now() - t0} ms). Interpreter: ${rt.status().llm.provider}`));
  const bye = () => { rt.stop(); process.exit(0); };
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
}
