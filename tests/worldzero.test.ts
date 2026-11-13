// Acceptance tests for the nine critical workflows in the WORLDZERO brief (engine + API level).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime } from '../server/runtime';
import { buildApp } from '../server/index';
import { runTicks, cloneWorld } from '../server/sim/tick';
import { isActive } from '../server/sim/world';
import { interpretFallback } from '../server/god/interpret';

let rt: Runtime; const dir = mkdtempSync(join(tmpdir(), 'wz-')); const dbFile = join(dir, 'world.db');
delete process.env.ANTHROPIC_API_KEY; delete process.env.OPENAI_API_KEY; process.env.LLM_PROVIDER = 'none';
beforeAll(() => { rt = new Runtime(dbFile).init(); rt.running = false; });
afterAll(() => { try { rt.store.close(); rmSync(dir, { recursive: true, force: true }); } catch { /* windows file lock */ } });

describe('Test 1 — population', () => {
  it('generates and stores at least 5,000 distinct citizens', () => {
    const cs = rt.world.citizens.filter(isActive);
    expect(cs.length).toBeGreaterThanOrEqual(5000);
    expect(rt.store.count('citizens')).toBeGreaterThanOrEqual(5000);
    expect(new Set(cs.map((c) => c.id)).size).toBe(cs.length);
    expect(new Set(cs.map((c) => c.name)).size).toBeGreaterThan(2500);
    expect(new Set(cs.map((c) => c.role)).size).toBeGreaterThan(20);
    expect(new Set(cs.map((c) => Math.round(c.traits.ambition * 100))).size).toBeGreaterThan(50);
    expect(rt.world.orgs.filter((o) => o.alive).length).toBeGreaterThan(250);
    expect(cs.filter((c) => c.friends.length > 0).length).toBeGreaterThan(3500);
  });
  it('is deterministic: same state + same seed => same future', () => {
    const a = cloneWorld(rt.world), b = cloneWorld(rt.world);
    runTicks(a, 75); runTicks(b, 75);
    expect(JSON.stringify(a.metrics)).toBe(JSON.stringify(b.metrics));
    expect(a.rng).toEqual(b.rng);
  });
});

describe('Test 2 — direct economic intervention', () => {
  it('“Increase food prices by 200%” changes the active world', async () => {
    const p0 = rt.world.prices.food, pp0 = rt.world.metrics.purchasingPowerLow, t0 = rt.world.tick, food0 = rt.world.orgs.filter((o) => o.alive && o.sector === 'food').reduce((s, o) => s + o.revenue, 0);
    const r = await rt.god('Increase food prices by 200%.');
    expect(r.mode).toBe('direct'); expect(r.status).toBe('executed');
    expect(rt.world.prices.food).toBeGreaterThan(p0 * 2.5);
    expect(rt.world.tick).toBeGreaterThan(t0);
    expect(rt.world.metrics.purchasingPowerLow).toBeLessThan(pp0 * 0.9);
    expect(rt.world.orgs.filter((o) => o.alive && o.sector === 'food').reduce((s, o) => s + o.revenue, 0)).not.toBeCloseTo(food0, 0);
    expect(rt.world.events.some((e) => e.cat === 'intervention' && e.title.includes('food prices'))).toBe(true);
    expect(r.deltas.find((d) => d.key === 'purchasingPowerLow')).toBeTruthy();
    const dash = await buildApp(rt).inject({ url: '/api/dashboard' });
    expect(JSON.parse(dash.body).prices.food).toBeCloseTo(rt.world.prices.food, 5);
  });
});

describe('Test 5 — autonomous behaviour differs by circumstance', () => {
  it('low-income citizens react more strongly to the food shock than high-income ones', () => {
    const c = rt.world.counters;
    const adults = rt.world.citizens.filter((x) => isActive(x) && x.age >= 18);
    const low = adults.filter((x) => x.tier === 0), high = adults.filter((x) => x.tier >= 2);
    const lowRate = ((c['decision.cutback.t0'] || 0) + (c['hardship.t0'] || 0)) / low.length, highRate = ((c['decision.cutback.t2'] || 0) + (c['decision.cutback.t3'] || 0) + (c['hardship.t2'] || 0)) / high.length;
    expect(lowRate).toBeGreaterThan(highRate * 1.5);
    const modeLow = low.reduce((s, x) => s + x.spendMode, 0) / low.length, modeHigh = high.reduce((s, x) => s + x.spendMode, 0) / high.length;
    expect(modeLow).toBeLessThan(modeHigh);
    expect(adults.some((x) => x.mem.some((m) => m.k === 'cutback' || m.k === 'hardship'))).toBe(true);
    expect((c['org.layoffs'] || 0) + (c['org.hires'] || 0)).toBeGreaterThan(0);
  });
});

describe('Test 3 — hypothetical experiment', () => {
  it('“What if all startup funding disappeared?” runs in a branch and leaves the active world untouched', async () => {
    const before = JSON.stringify(rt.world), fund0 = rt.world.metrics.startupFunding;
    const r = await rt.god('What if all startup funding disappeared?');
    expect(r.mode).toBe('hypothetical'); expect(r.timeline).toBeTruthy();
    expect(JSON.stringify(rt.world)).toBe(before);
    const branch = rt.store.loadTimeline(r.timeline!.id)!;
    expect(branch.tick).toBe(rt.world.tick + r.horizonDays);
    expect(branch.metrics.startupFunding).toBeLessThan(fund0 * 0.5);
    const su = r.deltas.find((d) => d.key === 'startups')!;
    expect(su.after).toBeLessThan(su.control!);
    expect(r.deltas.some((d) => d.key === 'unemployment' && d.control !== undefined)).toBe(true);
    expect(rt.timelines().timelines.some((t) => t.id === r.timeline!.id)).toBe(true);
  });
});

describe('Test 4 — multi-step instruction', () => {
  it('applies both policies and simulates one year under them', async () => {
    const mw = rt.world.policy.minWage, ct = rt.world.policy.corporateTax, t0 = rt.world.tick;
    const r = await rt.god('Increase minimum wages by 20%, reduce corporate taxes by 5 percentage points, and simulate one year.');
    expect(r.operations.filter((o) => o.ok).length).toBe(2);
    expect(r.horizonDays).toBe(360); expect(rt.world.tick).toBe(t0 + 360);
    expect(rt.world.policy.corporateTax).toBeCloseTo(ct - 0.05, 6);
    expect(rt.world.policy.minWage).toBeGreaterThanOrEqual(mw * 1.2 - 1);
    const paid = rt.world.citizens.filter((c) => isActive(c) && c.status === 'employed');
    expect(paid.every((c) => c.wage >= Math.round(mw * 1.2) - 1)).toBe(true);
  });
});

describe('Test 6 — alternate timelines', () => {
  it('two branches with opposite policies evolve independently and can be compared', async () => {
    const snap = rt.snapshot('fork point', 'manual');
    const a = rt.branch(snap, 'High tax', true);
    await rt.god('Increase income tax by 15 percentage points and simulate six months');
    const b = rt.branch(snap, 'Low tax', true);
    await rt.god('Reduce income tax by 10 percentage points and simulate six months');
    const cmp = rt.compare(a, b) as any;
    expect(cmp.a.tick).toBe(cmp.b.tick);
    expect(cmp.a.metrics.govRevenue).not.toBe(cmp.b.metrics.govRevenue);
    expect(rt.store.loadTimeline(a)!.policy.incomeTax).toBeGreaterThan(rt.world.policy.incomeTax + 0.2);
    rt.switchTimeline('main');
    expect(rt.timelineId).toBe('main');
  });
  it('rewind restores the actual stored state', () => {
    const id = rt.snapshot('rewind point', 'manual'); const tick = rt.world.tick, pop = rt.world.metrics.population, rng = [...rt.world.rng];
    rt.stepDays(45); expect(rt.world.tick).toBe(tick + 45);
    rt.restore(id);
    expect(rt.world.tick).toBe(tick); expect(rt.world.metrics.population).toBe(pop); expect(rt.world.rng).toEqual(rng);
  });
});

describe('Test 9 — novel instructions', () => {
  it('decomposes an unseen instruction into operations', async () => {
    const plan = interpretFallback('Make this city the world’s largest technology hub', rt.world);
    expect(plan.operations.length).toBeGreaterThan(4); expect(plan.assumptions.length).toBeGreaterThan(0);
    const r = await rt.god('Triple research funding, open two new hospitals and give the poor 5000 each');
    expect(r.operations.filter((o) => o.ok).length).toBe(3);
    expect(rt.world.orgs.filter((o) => o.alive && o.type === 'hospital').length).toBeGreaterThanOrEqual(5);
  });
  it('never pretends: unsupported instructions are reported and change nothing', async () => {
    const t = rt.world.tick, r = await rt.god('Make every citizen telepathic');
    expect(r.status).toBe('not_executed'); expect(r.unsupported.length).toBeGreaterThan(0); expect(rt.world.tick).toBe(t);
  });
  it('answers inspection questions from real state', async () => {
    const r = await rt.god('Who is the richest person?');
    expect(r.mode).toBe('query'); expect(r.focus).toMatch(/^citizen:/);
  });
});

describe('Test 8 — city data for the 3D view reflects the world', () => {
  it('serves buildings, citizens and inspectable entities; interventions appear on the map', async () => {
    const app = buildApp(rt);
    const city = JSON.parse((await app.inject({ url: '/api/city' })).body);
    expect(city.dynamic.citizens.st.length).toBe(rt.world.citizens.length);
    expect(city.static.districts.length).toBe(20);
    const c = JSON.parse((await app.inject({ url: '/api/citizen/42' })).body);
    expect(c.name).toBe(rt.world.citizens[42].name); expect(c.traits).toBeTruthy();
    const nb = rt.world.buildings.length;
    await rt.god('Build a new university');
    const city2 = JSON.parse((await app.inject({ url: '/api/city' })).body);
    expect(city2.dynamic.buildings.length).toBeGreaterThan(nb);
    expect(rt.world.orgs.filter((o) => o.alive && o.type === 'university').length).toBe(3);
  });
});

describe('Test 7 — persistence', () => {
  it('reopening restores the same civilisation', () => {
    rt.save();
    const tick = rt.world.tick, pop = rt.world.metrics.population, name0 = rt.world.citizens[7].name, sav = rt.world.citizens[7].savings, food = rt.world.prices.food, tl = rt.timelineId;
    rt.store.close();
    const again = new Runtime(dbFile).init();
    expect(again.timelineId).toBe(tl); expect(again.world.tick).toBe(tick); expect(again.world.metrics.population).toBe(pop);
    expect(again.world.citizens[7].name).toBe(name0); expect(again.world.citizens[7].savings).toBe(sav); expect(again.world.prices.food).toBe(food);
    expect(again.store.chat().length).toBeGreaterThan(5);
    rt = again;
  });
});
