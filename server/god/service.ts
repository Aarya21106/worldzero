// GOD MODE Conversation Service: Understand -> Classify -> Decompose -> Validate -> Execute/Experiment -> Evolve -> Report.
// Everything in the report is read back from the engine. AI-written text is labelled separately.
import type { World, SimEvent, Citizen, Org } from '../sim/types';
import { dateOf } from '../sim/types';
import { tick, cloneWorld } from '../sim/tick';
import { computeMetrics } from '../sim/metrics';
import { emit, isActive, money, pct, typeLabel } from '../sim/world';
import { interpret, llmConfig, llmComplete } from './interpret';
import { validatePlan, applyOp, matchOrgs, matchCitizens, type Plan, type OpResult, type PlanOp } from './ops';

export interface Host {
  world: World;
  snapshot(label: string, kind: string): string;
  addTimeline(w: World, name: string, kind: string, note: string): string;
  touched(): void;
}
export interface Delta { key: string; label: string; unit: string; before: number; after: number; control?: number }
export interface GodResult {
  id: string; text: string; mode: 'direct' | 'hypothetical' | 'query'; source: 'llm' | 'fallback'; model?: string; llmError?: string; status: 'executed' | 'partial' | 'not_executed' | 'answered';
  summary: string; assumptions: string[]; notes: string[]; unsupported: { text: string; reason: string }[];
  operations: OpResult[]; horizonDays: number; tickBefore: number; tickAfter: number; dateAfter: string;
  deltas: Delta[]; reactions: { label: string; value: number; control?: number; detail?: string }[]; groups: { label: string; low: number; middle: number; high: number }[];
  events: SimEvent[]; causal: string[]; narrative: string; aiNarrative?: string; answer?: any;
  timeline?: { id: string; name: string }; snapshotId?: string; focus?: string; ms: number;
}

const KEYS: [string, string, string][] = [
  ['gdp', 'Economic output (annual)', 'currency'], ['unemployment', 'Unemployment', 'pct'], ['inflation', 'Inflation', 'pct'], ['cpi', 'Consumer price level', 'index'], ['avgHouseholdWealth', 'Avg household wealth', 'currency'], ['medianIncome', 'Median household income', 'currency'], ['purchasingPower', 'Purchasing power (income ÷ essentials)', 'ratio'], ['purchasingPowerLow', 'Purchasing power, low-income', 'ratio'], ['povertyRate', 'Households unable to cover essentials', 'pct'], ['foodShareLow', 'Food share of low incomes', 'pct'],
  ['marketIndex', 'Stock market index', 'index'], ['confidence', 'Market confidence', 'ratio'], ['businesses', 'Private businesses', 'int'], ['startups', 'Startups', 'int'], ['startupFunding', 'Startup funding', 'currency'], ['employed', 'People employed', 'int'], ['avgWage', 'Average wage', 'currency'], ['realWage', 'Real wage', 'currency'],
  ['publicTrust', 'Public trust in government', 'pct'], ['stability', 'Social stability', 'pct'], ['happiness', 'Happiness', 'pct'], ['protestShare', 'Adults protesting', 'pct'], ['crime', 'Crime level', 'pct'], ['population', 'Population', 'int'],
  ['students', 'University students', 'int'], ['infected', 'Currently infected', 'int'], ['hospitalLoad', 'Hospital load', 'pct'], ['avgRent', 'Rent index', 'index'], ['homelessRate', 'Homeless households', 'pct'], ['govBalance', 'Government balance (annual)', 'currency'], ['interestRate', 'Interest rate', 'pct'], ['techLevel', 'Technology level', 'ratio'], ['gini', 'Inequality (Gini)', 'ratio'],
];
const REACT: [string, string][] = [['decision.cutback', 'Citizens who cut discretionary spending'], ['decision.ask_raise', 'Workers who demanded a raise'], ['decision.raise_won', '…raises granted'], ['decision.job_search', 'Workers who started looking for a better job'], ['decision.apply_university', 'University applications'], ['decision.dropout', 'Students who dropped out'], ['decision.start_business', 'Citizens who founded a business'], ['decision.panic_sell', 'Investors who panic-sold'], ['decision.invest', 'Citizens who invested savings'], ['decision.protest', 'Citizens who joined protests'], ['decision.emigrate', 'Households that decided to emigrate'], ['org.layoffs', 'Workers laid off'], ['org.hires', 'Workers hired'], ['org.closed', 'Organisations closed'], ['org.founded', 'Organisations founded'], ['org.funding_round', 'Startup funding rounds'], ['org.freeze', 'Companies that froze hiring'], ['org.wage_raise', 'Employer wage increases'], ['org.loans', 'Emergency business loans'], ['housing.evictions', 'Evictions'], ['hardship.t0', 'Low-income household-months in hardship'], ['health.infections', 'New infections'], ['health.epidemic_deaths', 'Epidemic deaths'], ['pop.immigrated', 'People who immigrated'], ['pop.emigrated', 'People who emigrated'], ['edu.admitted', 'University admissions'], ['edu.rejected', 'Applicants turned away'], ['gov.actions', 'Autonomous government decisions']];
const GROUPS: [string, string][] = [['decision.cutback', 'Cut spending'], ['decision.ask_raise', 'Demanded a raise'], ['decision.protest', 'Joined protests'], ['layoff', 'Were laid off'], ['hardship', 'Months in hardship'], ['decision.apply_university', 'Applied to university'], ['decision.panic_sell', 'Panic-sold investments']];

const fmt = (unit: string, v: number) => unit === 'currency' ? money(v) : unit === 'pct' ? pct(v) : unit === 'int' ? Math.round(v).toLocaleString('en-US') : unit === 'index' ? (v >= 50 ? v.toFixed(0) : v.toFixed(2)) : v.toFixed(2);
async function run(w: World, days: number, onProgress?: (f: number) => void) { for (let i = 0; i < days; i++) { tick(w); if (i % 15 === 14) { onProgress?.(i / days); await new Promise((r) => setImmediate(r)); } } computeMetrics(w); }
const diffCounters = (a: Record<string, number>, b: Record<string, number>, k: string) => (b[k] || 0) - (a[k] || 0);

function buildDeltas(before: Record<string, number>, after: Record<string, number>, control?: Record<string, number>): Delta[] {
  const out: Delta[] = [];
  for (const [key, label, unit] of KEYS) {
    const b = before[key] ?? 0, a = after[key] ?? 0, c = control ? control[key] ?? 0 : undefined;
    const ref = c ?? b, scale = Math.max(Math.abs(ref), unit === 'pct' ? 0.02 : 1e-9);
    const rel = Math.abs(a - ref) / scale;
    out.push({ key, label, unit, before: b, after: a, control: c, ...( { rel } as any) });
  }
  const head = new Set(['gdp', 'unemployment', 'inflation', 'avgHouseholdWealth', 'publicTrust', 'stability']);
  return out.filter((d: any) => head.has(d.key) || d.rel > 0.015).sort((x: any, y: any) => (head.has(y.key) ? 1 : 0) - (head.has(x.key) ? 1 : 0) || y.rel - x.rel).slice(0, 18).map(({ rel, ...d }: any) => d);
}

function narrate(mode: string, ops: OpResult[], deltas: Delta[], reactions: GodResult['reactions'], groups: GodResult['groups'], days: number, events: SimEvent[]): { text: string; causal: string[] } {
  const L: string[] = [], vs = mode === 'hypothetical';
  const done = ops.filter((o) => o.ok);
  if (done.length) L.push(`${vs ? 'In an isolated branch the engine applied' : 'The engine applied'} ${done.length} operation${done.length > 1 ? 's' : ''} and simulated ${days} days${vs ? ', alongside a control run of the unchanged world over the same period' : ''}.`);
  const mv = deltas.filter((d) => { const ref = d.control ?? d.before; return Math.abs(d.after - ref) / Math.max(Math.abs(ref), d.unit === 'pct' ? 0.02 : 1e-9) > 0.03; }).slice(0, 6);
  if (mv.length) L.push(`Largest calculated changes${vs ? ' versus the control world' : ''}: ` + mv.map((d) => `${d.label.toLowerCase()} ${fmt(d.unit, d.control ?? d.before)} → ${fmt(d.unit, d.after)}`).join('; ') + '.');
  else if (done.length) L.push('No headline indicator moved by more than 3% over this window — the effect is small, slow, or absorbed.');
  const top = reactions.filter((r) => Math.abs(r.value - (r.control ?? 0)) >= 3).slice(0, 5);
  if (top.length) L.push('How people and organisations reacted: ' + top.map((r) => `${r.label.toLowerCase()}: ${r.value.toLocaleString('en-US')}${r.control !== undefined ? ` (control ${r.control.toLocaleString('en-US')})` : ''}`).join('; ') + '.');
  const g = groups.find((x) => x.low + x.middle + x.high > 20 && Math.max(x.low, x.high) > 1.5 * Math.max(1, Math.min(x.low, x.high)));
  if (g) L.push(`Reactions differed by income: “${g.label.toLowerCase()}” — ${g.low} per 100 low-income adults, ${g.middle} per 100 middle-income, ${g.high} per 100 high-income.`);
  const causal = events.filter((e) => e.why && e.sev >= 0.3).slice(-8).map((e) => `${e.title} ← ${e.why}`);
  return { text: L.join(' '), causal };
}

function tierSizes(w: World) { const n = [0, 0, 0]; for (const c of w.citizens) if (isActive(c) && c.age >= 18) n[Math.min(2, c.tier)]++; return n; }

export async function handleGod(host: Host, text: string, onStage: (stage: string, detail?: string) => void): Promise<GodResult> {
  const t0 = Date.now(), w = host.world;
  const id = `g${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  onStage('understand', 'Interpreting the instruction');
  const { plan: raw, llmError } = await interpret(text, w);
  onStage('classify', raw.mode);
  onStage('validate', 'Checking the plan against the world');
  const { plan, notes, rejected } = validatePlan(w, raw);
  const unsupported = [...plan.unsupported, ...rejected.map((r) => ({ text: `${r.op.op} ${JSON.stringify(r.op.args)}`, reason: r.error }))];
  const base: GodResult = { id, text, mode: plan.mode, source: plan.source, model: plan.model, llmError, status: 'not_executed', summary: plan.summary, assumptions: plan.assumptions, notes, unsupported, operations: [], horizonDays: 0, tickBefore: w.tick, tickAfter: w.tick, dateAfter: dateOf(w.tick), deltas: [], reactions: [], groups: [], events: [], causal: [], narrative: '', ms: 0 };
  if (llmError) notes.push(`AI interpreter unavailable (${llmError}); the deterministic interpreter was used instead.`);
  else if (plan.source === 'fallback') notes.push('No AI provider is configured: the deterministic interpreter handled this instruction. It understands parameters, entities, events and magnitudes, but not arbitrary novel concepts.');

  // ---------------- queries
  if (plan.mode === 'query' || (plan.operations.length > 0 && plan.operations.every((o) => o.op === 'query'))) {
    onStage('execute', 'Reading the world state');
    const answers = plan.operations.filter((o) => o.op === 'query').map((o) => runQuery(w, o.args));
    base.mode = 'query'; base.status = 'answered'; base.answer = answers; base.focus = answers.find((a) => a.focus)?.focus;
    base.narrative = answers.map((a) => a.text).join('\n');
    if (plan.source === 'llm') { try { base.aiNarrative = (await llmComplete('You answer questions about a fictional simulated city using ONLY the JSON data provided. Be concise (max 120 words). Do not invent numbers.', `Question: ${text}\nData: ${JSON.stringify(answers).slice(0, 6000)}`, 400)).trim(); } catch { /* optional */ } }
    base.ms = Date.now() - t0; onStage('report'); return base;
  }
  const ops = plan.operations.filter((o) => o.op !== 'query');
  if (!ops.length) {
    base.status = 'not_executed';
    base.narrative = unsupported.length ? 'Nothing was changed. I could not translate this instruction into operations the simulation supports — see the reasons below.' : 'Nothing was changed: the instruction contained no actionable change.';
    base.ms = Date.now() - t0; onStage('report'); return base;
  }
  const hypo = plan.mode === 'hypothetical';
  const horizon = plan.horizonDays && plan.horizonDays > 0 ? plan.horizonDays : hypo ? 180 : 30;
  if (!plan.horizonDays) base.assumptions.push(hypo ? 'No time horizon given: simulated 180 days (6 months).' : 'No time horizon given: the world was advanced 30 days so citizens and organisations could react.');
  base.horizonDays = horizon;
  computeMetrics(w);
  const before = { ...w.metrics };
  let target: World, control: World | null = null;
  if (hypo) {
    onStage('execute', 'Creating an isolated experimental branch');
    target = cloneWorld(w); control = cloneWorld(w);
  } else {
    onStage('execute', 'Snapshotting, then applying operations to the active world');
    base.snapshotId = host.snapshot(`Before: ${text.slice(0, 60)}`, 'pre');
    target = w;
  }
  const c0 = { ...target.counters }, ev0 = target.nextEventId;
  const systems = [...new Set(ops.flatMap((o) => (o.op === 'trigger_event' ? ['all'] : [])).concat(['economy']))];
  const iv = emit(target, { cat: 'intervention', type: hypo ? 'experiment' : 'intervention', title: `GOD MODE: ${text.slice(0, 90)}`, detail: hypo ? 'Hypothetical experiment (isolated branch).' : 'Direct intervention on the active world.', sev: 0.6, causes: [] });
  const results: OpResult[] = [];
  for (const o of ops) { const r = applyOp(target, o, { eventId: iv.id }); results.push(r); for (const s of r.systems) if (!systems.includes(s)) systems.push(s); }
  target.interventions.push({ id: target.nextIds.intervention++, t: target.tick, text, systems, eventId: iv.id });
  if (target.interventions.length > 40) target.interventions.shift();
  computeMetrics(target);
  base.operations = results; base.focus = results.find((r) => r.focus)?.focus;
  onStage('evolve', `Simulating ${horizon} days`);
  await run(target, horizon, (f) => onStage('evolve', `Simulating ${horizon} days — ${Math.round(f * (control ? 50 : 100))}%`));
  let cc0: Record<string, number> | null = null;
  if (control) { cc0 = { ...control.counters }; await run(control, horizon, (f) => onStage('evolve', `Simulating control world — ${50 + Math.round(f * 50)}%`)); }
  onStage('report', 'Measuring consequences');
  base.tickAfter = target.tick; base.dateAfter = dateOf(target.tick);
  base.deltas = buildDeltas(before, target.metrics, control?.metrics);
  base.reactions = REACT.map(([k, label]) => ({ label, value: Math.round(diffCounters(c0, target.counters, k)), control: control ? Math.round(diffCounters(cc0!, control.counters, k)) : undefined })).filter((r) => r.value !== 0 || (r.control ?? 0) !== 0).sort((a, b) => Math.abs(b.value - (b.control ?? 0)) - Math.abs(a.value - (a.control ?? 0))).slice(0, 14);
  const sizes = tierSizes(target);
  base.groups = GROUPS.map(([k, label]) => { const v = [0, 1, 2].map((t) => diffCounters(c0, target.counters, `${k}.t${t}`) + (t === 2 ? diffCounters(c0, target.counters, `${k}.t3`) : 0)); return { label, low: Math.round((100 * v[0]) / Math.max(1, sizes[0])), middle: Math.round((100 * v[1]) / Math.max(1, sizes[1])), high: Math.round((100 * v[2]) / Math.max(1, sizes[2])) }; }).filter((g) => g.low + g.middle + g.high > 0);
  base.events = target.events.filter((e) => e.id >= ev0 && e.cat !== 'intervention' && e.sev >= 0.2).sort((a, b) => b.sev - a.sev).slice(0, 14).sort((a, b) => a.t - b.t);
  const n = narrate(plan.mode, results, base.deltas, base.reactions, base.groups, horizon, base.events);
  base.narrative = n.text; base.causal = n.causal;
  const okN = results.filter((r) => r.ok).length;
  base.status = okN === 0 ? 'not_executed' : unsupported.length || okN < results.length ? 'partial' : 'executed';
  if (hypo) {
    const name = `What if: ${text.replace(/^\s*(what if|what happens if|what would happen if|suppose|imagine)\s*/i, '').slice(0, 48)}`;
    base.timeline = { id: host.addTimeline(target, name, 'experiment', text), name };
  } else host.touched();
  if (plan.source === 'llm') { try { base.aiNarrative = (await llmComplete('You explain results of a fictional civilisation simulation. Use ONLY the numbers in the JSON. Explain plausible causal mechanisms in under 140 words. Never invent figures.', JSON.stringify({ instruction: text, mode: plan.mode, operations: results.map((r) => r.summary), deltas: base.deltas, reactions: base.reactions, events: base.events.map((e) => e.title) }).slice(0, 7000), 450)).trim(); } catch { /* optional */ } }
  base.ms = Date.now() - t0;
  return base;
}

// ---------------------------------------------------------------- queries
const wealthOf = (w: World, c: Citizen) => c.savings + (c.equity * w.market.index) / w.market.indexBase - c.debt;
const valuation = (o: Org) => (o.listed ? o.price * o.shares : Math.max(0, o.profitAvg * 12 * 8) + Math.max(0, o.cash) + o.funding);

export function runQuery(w: World, a: any): { kind: string; text: string; rows?: any[]; focus?: string } {
  const m = w.metrics;
  switch (a?.kind) {
    case 'rank': {
      const lim = Math.min(50, Math.max(1, Number(a.limit) || 5)), desc = a.order !== 'asc';
      if (a.entity === 'orgs') {
        const f: Record<string, (o: Org) => number> = { employees: (o) => o.employees.length, revenue: (o) => o.revenue, profit: (o) => o.profit, cash: (o) => o.cash, funding: (o) => o.funding, valuation };
        const fn = f[a.by] || f.employees; const rows = matchOrgs(w, a.filter || {}).sort((x, y) => (desc ? fn(y) - fn(x) : fn(x) - fn(y))).slice(0, lim).map((o) => ({ ref: `org:${o.id}`, name: o.name, type: typeLabel(o.type), sector: o.sector, employees: o.employees.length, value: fn(o), display: a.by === 'employees' || !a.by ? `${o.employees.length} employees` : money(fn(o)) }));
        return { kind: 'rank', text: `Organisations by ${a.by || 'employees'} (${desc ? 'highest' : 'lowest'} first): ` + rows.map((r, i) => `${i + 1}. ${r.name} — ${r.display}`).join('; '), rows, focus: rows[0]?.ref };
      }
      if (a.entity === 'districts') { const k = ['pop', 'unemp', 'avgIncome', 'crime', 'rentIdx', 'happy'].includes(a.by) ? a.by : 'pop'; const rows = [...w.districts].filter((d) => d.pop > 0 || k !== 'unemp').sort((x: any, y: any) => (desc ? y[k] - x[k] : x[k] - y[k])).slice(0, lim).map((d: any) => ({ ref: `district:${d.id}`, name: d.name, value: d[k], display: k === 'unemp' || k === 'crime' || k === 'happy' ? pct(d[k]) : k === 'avgIncome' ? money(d[k]) : k === 'rentIdx' ? d[k].toFixed(2) : String(d[k]) })); return { kind: 'rank', text: `Districts by ${k}: ` + rows.map((r, i) => `${i + 1}. ${r.name} — ${r.display}`).join('; '), rows, focus: rows[0]?.ref }; }
      const f: Record<string, (c: Citizen) => number> = { wealth: (c) => wealthOf(w, c), income: (c) => c.income, wage: (c) => c.wage, age: (c) => c.age, happiness: (c) => c.happy, trustGov: (c) => c.trustGov, debt: (c) => c.debt };
      const fn = f[a.by] || f.wealth; const pctF = a.by === 'happiness' || a.by === 'trustGov';
      const rows = matchCitizens(w, { minAge: 18, ...(a.filter || {}) }).sort((x, y) => (desc ? fn(y) - fn(x) : fn(x) - fn(y))).slice(0, lim).map((c) => ({ ref: `citizen:${c.id}`, name: c.name, role: c.role, age: c.age, value: fn(c), display: a.by === 'age' ? `${c.age} years` : pctF ? pct(fn(c), 0) : money(fn(c)) }));
      return { kind: 'rank', text: `Citizens by ${a.by || 'wealth'} (${desc ? 'highest' : 'lowest'} first): ` + rows.map((r, i) => `${i + 1}. ${r.name} (${r.role}, ${r.age}) — ${r.display}`).join('; '), rows, focus: rows[0]?.ref };
    }
    case 'entity': {
      const nm = String(a.name || '').toLowerCase();
      const o = w.orgs.find((x) => x.name.toLowerCase() === nm) || w.orgs.find((x) => x.alive && x.name.toLowerCase().includes(nm));
      if (o && nm) return { kind: 'entity', focus: `org:${o.id}`, text: `${o.name} — ${typeLabel(o.type)} in ${o.sector}, ${w.districts[o.district]?.name}. ${o.alive ? `${o.employees.length} employees, revenue ${money(o.revenue)}/month, profit ${money(o.profit)}/month, cash ${money(o.cash)}${o.type === 'startup' ? `, funding ${money(o.funding)} (${o.stage})` : ''}${o.listed ? `, share price ${o.price.toFixed(2)}` : ''}, running at ${pct(o.util, 0)} of capacity.` : `Closed on ${dateOf(o.closed)}: ${o.closeReason}.`}${o.log.length ? ` Recent decisions: ${o.log.slice(-3).map((l) => l.d).join(' · ')}` : ''}` };
      const d = w.districts.find((x) => x.name.toLowerCase().includes(nm));
      if (d && nm) return { kind: 'entity', focus: `district:${d.id}`, text: `${d.name} — ${d.kind} district. Population ${d.pop}, unemployment ${pct(d.unemp)}, average income ${money(d.avgIncome)}, crime ${pct(d.crime, 0)}, rent index ${d.rentIdx.toFixed(2)}.` };
      const c = w.citizens.find((x) => x.name.toLowerCase() === nm) || w.citizens.find((x) => isActive(x) && x.name.toLowerCase().includes(nm));
      if (c && nm) return { kind: 'entity', focus: `citizen:${c.id}`, text: `${c.name}, ${c.age}, ${c.role}${c.employer >= 0 ? ` at ${w.orgs[c.employer].name}` : ''}. Net worth ${money(wealthOf(w, c))}, income ${money(c.income)}/month, happiness ${pct(c.happy, 0)}, trust in government ${pct(c.trustGov, 0)}. Goal: ${c.goal.replace(/_/g, ' ')}.${c.mem.length ? ` Recent memory: “${c.mem[c.mem.length - 1].d}”.` : ''}` };
      return { kind: 'entity', text: `I could not find a citizen, organisation or district named “${a.name}”.` };
    }
    case 'events': {
      const since = w.tick - (Number(a.sinceDays) || 180);
      const rows = w.events.filter((e) => e.t >= since && (!a.category || e.cat === a.category) && e.sev >= 0.25).slice(-14).map((e) => ({ date: dateOf(e.t), title: e.title, why: e.why, cat: e.cat }));
      return { kind: 'events', rows, text: rows.length ? `Notable events: ` + rows.map((r) => `[${r.date}] ${r.title}${r.why ? ` (because: ${r.why})` : ''}`).join('; ') : 'No notable events in that period.' };
    }
    case 'count': { const n = a.entity === 'orgs' ? matchOrgs(w, a.filter || {}).length : matchCitizens(w, a.filter || {}).length; return { kind: 'count', text: `${n.toLocaleString('en-US')} ${a.entity === 'orgs' ? 'organisations' : 'citizens'} match (${Object.entries(a.filter || {}).map(([k, v]) => `${k}: ${v}`).join(', ') || 'all'}).`, rows: [{ count: n }] }; }
    default: {
      const keys: string[] = (Array.isArray(a?.keys) ? a.keys : []).filter((k: string) => k in m);
      const ks = keys.length ? keys : ['population', 'gdp', 'unemployment', 'inflation', 'publicTrust', 'stability'];
      const meta = new Map(KEYS.map(([k, l, u]) => [k, { l, u }]));
      const guess = (k: string, v: number) => (meta.get(k) ? fmt(meta.get(k)!.u, v) : Math.abs(v) <= 1.5 && !Number.isInteger(v) ? pct(v) : Math.abs(v) > 5000 ? money(v) : (Math.round(v * 100) / 100).toLocaleString('en-US'));
      const rows = ks.map((k) => ({ key: k, label: meta.get(k)?.l || k.replace(/([A-Z])/g, ' $1').toLowerCase(), value: m[k], display: guess(k, m[k]) }));
      return { kind: 'metrics', rows, text: `As of ${dateOf(w.tick)}: ` + rows.map((r) => `${r.label}: ${r.display}`).join('; ') + '.' };
    }
  }
}
export { llmConfig };
export type { Plan, PlanOp };
