// Natural Language Interpreter. Primary path: an LLM converts the instruction into a typed plan (JSON).
// Fallback path: a deterministic compositional parser (lexicon of parameters + verbs + magnitudes + concepts).
// Both emit the same Plan; neither can touch world state.
import { spawn } from 'node:child_process';
import type { World, Sector } from '../sim/types';
import { SECTORS, ORG_TYPES } from '../sim/types';
import { PARAMS, paramCatalogue, type ParamDef } from './params';
import { opCatalogue, paramSuggestions, type Plan, type PlanOp } from './ops';

// ------------------------------------------------------------------ LLM adapter
export function llmConfig() {
  const e = process.env;
  const provider = e.LLM_PROVIDER || (e.ANTHROPIC_API_KEY ? 'anthropic' : e.OPENAI_API_KEY ? 'openai' : 'none');
  const model = e.LLM_MODEL || (provider === 'anthropic' ? 'claude-sonnet-5-5' : provider === 'openai' ? 'gpt-4o-mini' : provider === 'claude-cli' ? 'claude-cli' : '');
  return { provider, model, available: provider !== 'none' };
}

export async function llmComplete(system: string, user: string, maxTokens = 1800): Promise<string> {
  const { provider, model } = llmConfig(), e = process.env;
  if (provider === 'anthropic') {
    const r = await fetch((e.ANTHROPIC_BASE_URL || 'https://api.anthropic.com') + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': e.ANTHROPIC_API_KEY || '', 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }), signal: AbortSignal.timeout(45000) });
    if (!r.ok) throw new Error(`Anthropic API ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j: any = await r.json(); return j.content?.map((c: any) => c.text || '').join('') || '';
  }
  if (provider === 'openai') {
    const r = await fetch((e.OPENAI_BASE_URL || 'https://api.openai.com/v1') + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${e.OPENAI_API_KEY || ''}` }, body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }), signal: AbortSignal.timeout(45000) });
    if (!r.ok) throw new Error(`LLM API ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j: any = await r.json(); return j.choices?.[0]?.message?.content || '';
  }
  if (provider === 'claude-cli') {
    return await new Promise<string>((res, rej) => {
      const p = spawn('claude', ['-p', '--output-format', 'text'], { shell: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '', err = ''; const t = setTimeout(() => { p.kill(); rej(new Error('claude CLI timed out')); }, 90000);
      p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
      p.on('error', (x) => { clearTimeout(t); rej(x); });
      p.on('close', (c) => { clearTimeout(t); c === 0 ? res(out) : rej(new Error(`claude CLI exited ${c}: ${err.slice(0, 200)}`)); });
      p.stdin.end(`${system}\n\n${user}`);
    });
  }
  throw new Error('no LLM provider configured');
}

function systemPrompt(w: World): string {
  const m = w.metrics;
  return `You are the interpreter of WORLDZERO, a fictional civilisation simulation. Convert the user's instruction into a simulation plan. You never change the world yourself and never invent results; the engine executes your plan and computes all consequences.

Return ONLY a JSON object:
{"mode":"direct"|"hypothetical"|"query","summary":"one sentence","assumptions":["..."],"operations":[{"op":"...","args":{...},"note":"why"}],"horizonDays":number|null,"unsupported":[{"text":"part of the request","reason":"why the engine cannot represent it"}]}

MODE RULES
- "hypothetical": the user asks what would happen ("what if", "what happens if", "suppose", "would", bare "simulate <scenario>"). Runs in an isolated branch; the active world is untouched.
- "direct": an imperative instruction to change the world ("increase", "create", "make", "introduce"...).
- "query": a question about the current or past state of the world; use only "query" operations.
Never confuse hypothetical with direct. If ambiguous prefer hypothetical and say so in assumptions.

OPERATIONS
${opCatalogue()}
- query: args {kind:"metrics", keys:[metric names]} | {kind:"rank", entity:"citizens"|"orgs"|"districts", by: field, order:"desc"|"asc", limit, filter?} | {kind:"entity", name} | {kind:"events", sinceDays?, category?} | {kind:"count", entity:"citizens"|"orgs", filter}
  citizen rank fields: wealth, income, wage, age, happiness, trustGov, debt · org rank fields: employees, revenue, profit, cash, funding, valuation · district fields: pop, unemp, avgIncome, crime, rentIdx
  metric names: ${Object.keys(m).join(', ')}
- Use "horizonDays" for requested durations (1 month = 30 days, 1 year = 360 days).

PARAMETERS (current values)
${paramCatalogue(w)}

SECTORS: ${SECTORS.join(', ')}   ORG TYPES: ${ORG_TYPES.join(', ')}

GUIDELINES
- Decompose novel or abstract ideas into several concrete operations that approximate them, and list each interpretive choice in "assumptions".
- "+200%" means multiply by 3. Percentage-point changes of rates use mode "add" with fractions (5 points = 0.05).
- Put anything that truly cannot be represented into "unsupported" — never pretend. If nothing can be represented, return no operations.
- World now: day ${w.tick}, population ${m.population}, unemployment ${(m.unemployment * 100).toFixed(1)}%, inflation ${(m.inflation * 100).toFixed(1)}%, ${m.startups} startups, ${m.businesses} businesses.`;
}

function extractJson(s: string): any {
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('model returned no JSON');
  return JSON.parse(s.slice(a, b + 1));
}

export async function interpret(text: string, w: World): Promise<{ plan: Plan; llmError?: string }> {
  const cfg = llmConfig();
  if (cfg.available) {
    try {
      const j = extractJson(await llmComplete(systemPrompt(w), `Instruction: ${text}`));
      const plan: Plan = { mode: ['direct', 'hypothetical', 'query'].includes(j.mode) ? j.mode : 'direct', summary: String(j.summary || ''), assumptions: (j.assumptions || []).map(String), operations: Array.isArray(j.operations) ? j.operations : [], horizonDays: typeof j.horizonDays === 'number' ? j.horizonDays : undefined, unsupported: (j.unsupported || []).map((u: any) => ({ text: String(u.text || ''), reason: String(u.reason || '') })), source: 'llm', model: cfg.model };
      return { plan };
    } catch (e: any) { return { plan: interpretFallback(text, w), llmError: String(e?.message || e) }; }
  }
  return { plan: interpretFallback(text, w) };
}

// ------------------------------------------------------------------ deterministic interpreter
const NUMW: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, fifty: 50, hundred: 100, thousand: 1000, dozen: 12, several: 3, few: 3, couple: 2 };
const UP = /\b(increase[sd]?|increasing|rais(e|es|ed|ing)|boost(s|ed|ing)?|hike[sd]?|grow(s|ing)?|lift(s|ed)?|expand(s|ed)?|higher|more|rise[s]?|rising|surge[sd]?|soar(s|ed)?|improve[sd]?|strengthen(s|ed)?|add(s|ed)?|jump(s|ed)?|spike[sd]?|climb(s|ed)?|maximi[sz]e|up|skyrocket(s|ed)?|explode[sd]?|inflate[sd]?|subsidi[sz]e)\b/;
const DOWN = /\b(reduc(e|es|ed|ing)|decreas(e|es|ed|ing)|lower(s|ed|ing)?|cut(s|ting)?|slash(es|ed)?|drop(s|ped)?|fall(s|ing)?|fell|shrink(s)?|less|fewer|declin(e|es|ed|ing)|down|weaken(s|ed)?|halve[sd]?|crash(es|ed)?|collapse[sd]?|plummet(s|ed)?|tank(s|ed)?|los(e|es|t|ing)|minimi[sz]e|dip(s|ped)?|defund(s|ed)?)\b/;
const ZERO = /\b(eliminate[sd]?|abolish(es|ed)?|remove[sd]?|ban(s|ned)?|scrap(s|ped)?|no more|zero|disappear(s|ed)?|vanish(es|ed)?|wipe[sd]? out|end(s|ed)? all|dries up|dry up|gone|nothing)\b/;
const CREATE = /\b(create[sd]?|build(s)?|built|open(s|ed)?|found(s|ed)?|establish(es|ed)?|add(s|ed)?|launch(es|ed)?|construct(s|ed)?|start(s|ed)?|introduce[sd]?|give|make|spawn|set up)\b/;
const SECTOR_ALIASES: [RegExp, Sector][] = [[/\b(tech|technology|software|it)\b/, 'tech'], [/\b(manufactur\w*|factor(y|ies)|industrial)\b/, 'manufacturing'], [/\bretail\w*\b/, 'retail'], [/\b(financ\w*|banking)\b/, 'finance'], [/\b(healthcare|health care|medical)\b/, 'healthcare'], [/\bconstruction\b/, 'construction'], [/\benergy\b/, 'energy'], [/\b(media|news)\b/, 'media'], [/\b(services?|hospitality|tourism)\b/, 'services'], [/\b(food|restaurant\w*|agricultur\w*|farming)\b/, 'food'], [/\bresearch\b/, 'research'], [/\beducation\b/, 'education']];
const ORG_WORDS: [RegExp, string][] = [[/\bstart-?ups?\b/, 'startup'], [/\b(universit(y|ies)|colleges?)\b/, 'university'], [/\bhospitals?\b/, 'hospital'], [/\bschools?\b/, 'school'], [/\bbanks?\b/, 'bank'], [/\b(investment firms?|venture funds?|investors?|hedge funds?)\b/, 'investment_firm'], [/\b(research (lab|laborator|institut|cent)\w*|laborator(y|ies)|labs?)\b/, 'research_lab'], [/\b(small business(es)?|shops?|stores?)\b/, 'small_business'], [/\b(corporations?|large compan(y|ies)|big compan(y|ies)|conglomerates?|factor(y|ies))\b/, 'corporation'], [/\b(newspapers?|media (compan|organi[sz]ation)\w*|tv stations?)\b/, 'media'], [/\b(non-?profits?|charit(y|ies)|ngos?)\b/, 'nonprofit'], [/\b(compan(y|ies)|business(es)?|firms?)\b/, 'corporation']];

function norm(t: string): string { return ' ' + t.toLowerCase().replace(/[“”"]/g, '').replace(/[’‘]/g, "'").replace(/per ?cent/g, '%').replace(/(\d),(\d{3})/g, '$1$2').replace(/\s+/g, ' ').trim() + ' '; }
function numberIn(s: string): number | null { const m = s.match(/(\d+(?:\.\d+)?)\s*(k|thousand|m|million|b|billion|bn|trillion)?\b/); if (m) { const mult = !m[2] ? 1 : /^(k|thousand)$/.test(m[2]) ? 1e3 : /^(m|million)$/.test(m[2]) ? 1e6 : m[2] === 'trillion' ? 1e12 : 1e9; return parseFloat(m[1]) * mult; } for (const k of Object.keys(NUMW)) if (new RegExp(`\\b${k}\\b`).test(s) && !['a', 'an'].includes(k)) return NUMW[k]; return null; }
function durationDays(s: string): number | null {
  const m = s.match(/\b(\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|twelve|eleven|fifteen|twenty|thirty|several|few|couple of)\s+(day|week|month|quarter|year|decade)s?\b/);
  if (!m) return /\b(next|a) decade\b/.test(s) ? 3600 : null;
  const n = isNaN(parseFloat(m[1])) ? NUMW[m[1].replace(' of', '')] ?? 1 : parseFloat(m[1]);
  return Math.round(n * ({ day: 1, week: 7, month: 30, quarter: 90, year: 360, decade: 3600 } as any)[m[2]]);
}
const sectorIn = (s: string): Sector | undefined => { for (const [re, sec] of SECTOR_ALIASES) if (re.test(s)) return sec; return undefined; };
const orgTypeIn = (s: string): string | undefined => { for (const [re, t] of ORG_WORDS) if (re.test(s)) return t; return undefined; };
const sevWord = (s: string, d = 0.55) => (/\b(catastrophic|devastating|deadly|lethal|massive|severe|total|extreme|worst|huge|global)\b/.test(s) ? 0.9 : /\b(mild|minor|small|slight|limited|brief)\b/.test(s) ? 0.25 : /\b(major|serious|big|sudden|unexpected|sharp)\b/.test(s) ? 0.7 : d);

function findParam(s: string): { def: ParamDef; syn: string } | null {
  let best: { def: ParamDef; syn: string } | null = null;
  for (const def of PARAMS) for (const syn of def.synonyms) if (s.includes(' ' + syn + ' ') || s.includes(' ' + syn + ',') || s.includes(' ' + syn + '.') || s.includes(' ' + syn + '?')) if (!best || syn.length > best.syn.length) best = { def, syn };
  return best;
}

interface Mag { mode: 'multiply' | 'add' | 'set'; value: number; note?: string }
function magnitude(s: string, def: ParamDef | null, dir: number): Mag | null {
  const rate = def && (def.unit === 'rate' || def.unit === 'share');
  let m: RegExpMatchArray | null;
  if ((m = s.match(/(\d+(?:\.\d+)?)\s*(percentage points?|pp|points?|pts)\b/))) return { mode: 'add', value: (dir || 1) * parseFloat(m[1]) / 100 };
  if ((m = s.match(/\bto\s+(?:about |around |roughly |just |only )?[ƶ$€]?(\d+(?:\.\d+)?)\s*(%|k|thousand|million|m|billion|b)?/)) && !/\bto \d+ (day|week|month|year)/.test(s)) {
    const v = parseFloat(m[1]); if (m[2] === '%') return { mode: 'set', value: rate || (def && def.unit === 'level') ? v / 100 : def && def.unit === 'index' ? (def.key === 'price.all' ? v / 100 : v / 100) : v / 100 };
    const mult = !m[2] ? 1 : /^(k|thousand)$/.test(m[2]) ? 1e3 : /^(m|million)$/.test(m[2]) ? 1e6 : 1e9; return { mode: 'set', value: v * mult };
  }
  if (/\b(doubl(e|es|ed|ing)|twice)\b/.test(s)) return { mode: 'multiply', value: 2 };
  if (/\btripl(e|es|ed|ing)\b/.test(s)) return { mode: 'multiply', value: 3 };
  if (/\bquadrupl\w+\b/.test(s)) return { mode: 'multiply', value: 4 };
  if (/\b(halv(e|es|ed|ing)|by half|in half)\b/.test(s)) return { mode: 'multiply', value: 0.5 };
  if ((m = s.match(/(\d+(?:\.\d+)?)\s*(x|times|-?fold)\b/)) || (m = s.match(/\bx\s?(\d+(?:\.\d+)?)/))) return { mode: 'multiply', value: dir < 0 ? 1 / parseFloat(m[1]) : parseFloat(m[1]) };
  if (/\btenfold\b/.test(s)) return { mode: 'multiply', value: dir < 0 ? 0.1 : 10 };
  if ((m = s.match(/(\d+(?:\.\d+)?)\s*%/))) {
    const p = parseFloat(m[1]) / 100; if (!dir) return rate ? { mode: 'set', value: p } : null;
    if (rate && !/\bby\b.*%\s*(of|relative)/.test(s) && p <= 0.5 && def!.unit === 'rate') return { mode: 'add', value: dir * p, note: `“${m[1]}%” on ${def!.label.toLowerCase()} interpreted as ${m[1]} percentage points.` };
    return { mode: 'multiply', value: Math.max(0, 1 + dir * p) };
  }
  if ((m = s.match(/\bby\s+[ƶ$€]?(\d+(?:\.\d+)?)\s*(k|thousand|million|m|billion|b)?\b/)) && dir) { const mult = !m[2] ? 1 : /^(k|thousand)$/.test(m[2]) ? 1e3 : /^(m|million)$/.test(m[2]) ? 1e6 : 1e9; return { mode: 'add', value: dir * parseFloat(m[1]) * mult }; }
  if (ZERO.test(s)) return { mode: 'multiply', value: 0 };
  if (!dir) return null;
  const strong = /\b(massively|dramatically|sharply|drastically|hugely|enormously|radically|skyrocket\w*|soar\w*|explode\w*|collapse\w*|crash\w*|plummet\w*|tank\w*)\b/.test(s), weak = /\b(slightly|a bit|a little|modestly|marginally|somewhat)\b/.test(s);
  const f = strong ? (dir > 0 ? 2 : 0.5) : weak ? (dir > 0 ? 1.05 : 0.95) : dir > 0 ? 1.25 : 0.75;
  return { mode: 'multiply', value: f, note: `No amount given for ${def ? def.label.toLowerCase() : 'the change'}; assumed ${dir > 0 ? '+' : '−'}${Math.round(Math.abs(f - 1) * 100)}%.` };
}

type Ctx = { ops: PlanOp[]; assumptions: string[]; unsupported: { text: string; reason: string }[]; lastDir: number; w: World };
const push = (c: Ctx, op: string, args: any, note?: string) => c.ops.push({ op, args, note });

/** Concept lexicon: abstract ideas mapped onto concrete operations. Extend by adding entries. */
const CONCEPTS: { re: RegExp; run(s: string, c: Ctx): void }[] = [
  { re: /\b(disease|virus|pandemic|epidemic|plague|outbreak|pathogen|contagion|infection)\b/, run(s, c) { push(c, 'trigger_event', { event: 'disease_outbreak', severity: sevWord(s), contagion: /\b(highly|very|extremely) (contagious|infectious)|spreads? (fast|quickly|rapidly)\b/.test(s) ? 0.85 : 0.55 }); c.assumptions.push('The disease is fictional; its severity and contagiousness were chosen from the wording.'); } },
  { re: /\b(technology|tech) (hub|capital|cent(er|re)|powerhouse)|silicon valley\b/, run(_s, c) {
      push(c, 'adjust_parameter', { target: 'policy.spendResearch', mode: 'multiply', value: 2.5 }); push(c, 'adjust_parameter', { target: 'policy.startupSubsidy', mode: 'set', value: 1 }); push(c, 'adjust_parameter', { target: 'market.vc', mode: 'multiply', value: 3 });
      push(c, 'adjust_parameter', { target: 'funding.startups', mode: 'multiply', value: 3, sector: 'tech' }); push(c, 'create_entity', { kind: 'organisation', orgType: 'startup', sector: 'tech', count: Math.round(12 * (c.w.mods.scale ?? 1)) }); push(c, 'create_entity', { kind: 'organisation', orgType: 'research_lab', count: 2 });
      push(c, 'adjust_parameter', { target: 'ext.exportDemand', mode: 'multiply', value: 2, sector: 'tech' }); push(c, 'trigger_event', { event: 'migration_wave', households: Math.round(200 * (c.w.mods.scale ?? 1)), skilled: true, reason: 'tech boom' });
      c.assumptions.push('“Technology hub” was translated into: 2.5× research budget, startup subsidies, 3× venture appetite and tech-startup funding, 12 new tech startups, 2 new research labs, doubled foreign demand for tech and 200 skilled migrant households. Whether it becomes the *largest* hub is up to the simulation.'); } },
  { re: /\b(breakthrough|new technolog\w*|technological|invention|invent(s|ed)?|discover\w*|artificial intelligence|\bagi\b|\bai\b|fusion|robots?|robotics|quantum|cure for|superconduct\w*)\b/, run(s, c) {
      const domain = /\b(ai|agi|artificial intelligence|quantum|software|comput\w*)\b/.test(s) ? 'ai' : /\brobot/.test(s) ? 'robotics' : /\b(fusion|energy|solar|battery|power)\b/.test(s) ? 'energy' : /\b(cure|bio|medic\w*|gene|drug|vaccine)\b/.test(s) ? 'biotech' : /\b(material|superconduct)/.test(s) ? 'materials' : /\b(farm|crop|food)\b/.test(s) ? 'agri' : /\b(fintech|payment|bank)/.test(s) ? 'fintech' : undefined;
      push(c, 'trigger_event', { event: 'tech_breakthrough', domain, magnitude: sevWord(s, 0.5) * 2 }); if (!domain) c.assumptions.push('No technology field was named; the engine picks a domain at random.'); } },
  { re: /\b(war|invasion|armed conflict|military conflict)\b/, run(s, c) { push(c, 'trigger_event', { event: 'war', severity: sevWord(s, 0.6) }); c.assumptions.push('The war is between two fictional foreign countries; the city is affected through trade, import prices, confidence and refugees — not direct combat.'); } },
  { re: /\b(stock market|markets?|stocks?|shares?|equities)\b.*\b(crash\w*|collapse\w*|meltdown|plunge\w*|tank\w*|wipe\w*)\b|\bcrash\w*\b.*\b(stock|market)/, run(s, c) { const m = s.match(/(\d+(?:\.\d+)?)\s*%/); if (m) push(c, 'adjust_parameter', { target: 'market.sharePrices', mode: 'multiply', value: Math.max(0, 1 - parseFloat(m[1]) / 100) }); else { push(c, 'trigger_event', { event: 'market_crash', severity: sevWord(s, 0.5) }); c.assumptions.push('“Crash” without a figure was taken as a fall of roughly 40%.'); } } },
  { re: /\bhousing (crisis|shortage|crunch|emergency)\b/, run(s, c) { push(c, 'trigger_event', { event: 'housing_crisis', severity: sevWord(s, 0.6) }); } },
  { re: /\b(bank run|banking crisis|financial crisis|credit crunch|banks? (fail|collapse)\w*|recession|depression)\b/, run(s, c) { push(c, 'trigger_event', { event: 'financial_crisis', severity: sevWord(s, 0.6) }); } },
  { re: /\b(energy|power|electricity|oil|fuel) (crisis|shortage)|blackouts?\b/, run(s, c) { push(c, 'trigger_event', { event: 'energy_crisis', severity: sevWord(s, 0.6) }); } },
  { re: /\b(earthquake|flood\w*|hurricane|tsunami|wildfire|natural disaster|meteor\w*|asteroid|storm|tornado|volcan\w*)\b/, run(s, c) { const k = s.match(/\b(earthquake|flood|hurricane|tsunami|wildfire|meteor|asteroid|storm|tornado|volcano)/); const d = c.w.districts.find((x) => s.includes(x.name.toLowerCase())); push(c, 'trigger_event', { event: 'natural_disaster', kind: k ? k[1] : 'disaster', severity: sevWord(s, 0.6), district: d?.name }); } },
  { re: /\bdrought|famine|crop failure\b/, run(s, c) { push(c, 'adjust_parameter', { target: 'price.food', mode: 'multiply', value: 1 + sevWord(s, 0.6) * 1.5 }); c.assumptions.push('A food-supply shock was represented as a rise in food prices.'); } },
  { re: /\b(corruption|scandal|bribery|embezzle\w*)\b/, run(s, c) { push(c, 'trigger_event', { event: 'corruption_scandal', severity: sevWord(s, 0.6) }); } },
  { re: /\b(nobody|no one|no-one|none|everyone stops?|people stop|citizens stop|los(e|es|t) (all )?(trust|faith)|stops? trusting|distrust\w*)\b.*\b(government|state|authorit\w*|politicians?|institutions?)\b/, run(_s, c) { push(c, 'adjust_parameter', { target: 'social.trustGov', mode: 'set', value: 0.03 }); c.assumptions.push('“Nobody trusts the government” was set as average trust of 3%; trust then evolves with people’s actual experience.'); } },
  { re: /\b(billionaires?|millionaires?|trillionaires?|tycoon|oligarch)\b/, run(s, c) { const n = Math.min(20, /\b(billionaires|millionaires)\b/.test(s) ? numberIn(s.replace(/\d+\s*(billion|million)/, '')) ?? 3 : 1); const base = /trillionaire/.test(s) ? 1e12 : /millionaire/.test(s) ? 5e6 : 1e9; const m = s.match(/(\d+(?:\.\d+)?)\s*(billion|million|trillion)/); const wealth = m ? parseFloat(m[1]) * (m[2] === 'billion' ? 1e9 : m[2] === 'million' ? 1e6 : 1e12) : base * 1.5; for (let i = 0; i < n; i++) push(c, 'create_entity', { kind: 'citizen', wealth }); if (!m) c.assumptions.push(`Fortune assumed to be Ƶ${(wealth / 1e9).toFixed(wealth >= 1e9 ? 1 : 3)}B; 70% is invested in the stock market, 30% held as cash.`); } },
  { re: /\b(free|costless|tuition-free)\b.*\b(universit\w*|college|tuition|higher education)\b|\b(universit\w*|college|tuition|higher education)\b.*\b(free|costless)\b|\babolish(es)? tuition\b/, run(_s, c) { push(c, 'adjust_parameter', { target: 'policy.tuitionSubsidy', mode: 'set', value: 1 }); c.assumptions.push('“Free university” means the government pays 100% of tuition; universities keep their fee income.'); } },
  { re: /\bfree\b.*\b(healthcare|health care|hospitals?|medicine)\b|\b(healthcare|health care)\b.*\bfree\b/, run(_s, c) { push(c, 'adjust_parameter', { target: 'policy.healthSubsidy', mode: 'set', value: 1 }); } },
  { re: /\bunemployment\b.*?(\d+(?:\.\d+)?)\s*%/, run(s, c) { if (UP.test(s) && /\bby\b/.test(s)) { const cur = c.w.metrics.unemployment; push(c, 'set_unemployment', { rate: cur + parseFloat(s.match(/(\d+(?:\.\d+)?)\s*%/)![1]) / 100 }); } else push(c, 'set_unemployment', { rate: parseFloat(s.match(/unemployment\b.*?(\d+(?:\.\d+)?)\s*%/)![1]) / 100 }); c.assumptions.push('Unemployment was forced by laying off randomly chosen workers across all organisations.'); } },
  { re: /\b(mass unemployment|everyone loses their job|mass layoffs)\b/, run(_s, c) { push(c, 'set_unemployment', { rate: 0.3 }); c.assumptions.push('Mass unemployment assumed to mean 30%.'); } },
  { re: /\b(universal basic income|basic income|ubi)\b/, run(s, c) { const n = numberIn(s); push(c, 'adjust_parameter', { target: 'policy.ubi', mode: 'set', value: ZERO.test(s) ? 0 : n && n >= 50 ? n : 1000 }); if (!n || n < 50) c.assumptions.push('UBI amount assumed to be Ƶ1,000 per adult per month.'); } },
  { re: /\b(snap |early |new |hold an? )election\b|\bcall an election\b/, run(_s, c) { push(c, 'trigger_event', { event: 'snap_election' }); } },
  { re: /\b(start-?ups?)\b.*\b(los(e|es|t)|without|no|disappear\w*|dr(y|ies) up|vanish\w*|pull\w*|withdraw\w*|cut off)\b.*\b(funding|investment|capital|money)\b|\b(start-?up )?funding\b.*\b(disappear\w*|vanish\w*|dr(y|ies|ied) up|collapse\w*|gone|evaporate\w*)\b/, run(s, c) { const m = s.match(/(\d+(?:\.\d+)?)\s*%/); const f = m ? Math.max(0, 1 - parseFloat(m[1]) / 100) : 0; push(c, 'adjust_parameter', { target: 'funding.startups', mode: 'multiply', value: f }); if (!m) { push(c, 'adjust_parameter', { target: 'market.vc', mode: 'set', value: 0.05 }); c.assumptions.push('All existing startup funding is removed and investors stop writing new cheques (venture appetite set near zero).'); } } },
  { re: /\b(refugees?|immigrants?|migrants?|newcomers?|influx of (people|workers))\b/, run(s, c) { const n = numberIn(s); push(c, 'trigger_event', { event: 'migration_wave', households: n ? Math.max(1, Math.round(n / 2.2)) : Math.round(150 * (c.w.mods.scale ?? 1)), skilled: /\b(skilled|engineers?|educated|talent\w*)\b/.test(s) }); if (!n) c.assumptions.push('Size of the migration wave assumed to be 150 households.'); } },
  { re: /\b(exodus|brain drain|people (leave|flee)|emigrat\w*|flee(s|ing)? the city)\b/, run(s, c) { const m = s.match(/(\d+(?:\.\d+)?)\s*%/); push(c, 'trigger_event', { event: 'exodus', fraction: m ? parseFloat(m[1]) / 100 : 0.1, group: /\b(rich|wealthy)\b/.test(s) ? 'high' : /\bpoor\b/.test(s) ? 'low' : undefined }); if (!m) c.assumptions.push('Exodus assumed to be 10% of households.'); } },
];

const CIT_GROUPS: [RegExp, any][] = [[/\b(the rich|rich people|wealthy|the wealthy|upper class|high earners)\b/, { group: 'high' }], [/\b(the poor|poor people|low-income|low income|poorest|working class)\b/, { group: 'low' }], [/\b(middle class|middle-income)\b/, { group: 'middle' }], [/\b(top 1%|the 1%|billionaires|millionaires|richest)\b/, { group: 'top' }], [/\bunemployed\b/, { status: 'unemployed' }], [/\bstudents?\b/, { status: 'student' }], [/\b(retirees|pensioners|retired|elderly)\b/, { status: 'retired' }], [/\bdoctors?\b/, { occupation: 'doctor' }], [/\bnurses?\b/, { occupation: 'nurse' }], [/\bteachers?\b/, { occupation: 'teacher' }], [/\b(engineers?|programmers?|developers?)\b/, { occupation: 'engineer' }], [/\b(researchers?|scientists?)\b/, { occupation: 'research' }], [/\b(civil servants|government (employees|workers)|public (employees|workers))\b/, { employerType: 'gov_department' }], [/\b(everyone|everybody|every citizen|all citizens|every person|all people|the population)\b/, {}]];
const CIT_FIELD: [RegExp, string][] = [[/\b(savings|money|wealth|cash|fortunes?|bank accounts?)\b/, 'savings'], [/\b(debts?|loans?)\b/, 'debt'], [/\b(wages?|salar(y|ies)|pay|incomes?|earnings)\b/, 'wage'], [/\bhealth\b/, 'health'], [/\b(trust)\b/, 'trustGov'], [/\b(happ\w+|morale)\b/, 'happiness'], [/\b(skills?|training)\b/, 'skill'], [/\b(investments?|portfolios?|stock holdings)\b/, 'equity']];
const ORG_FIELD: [RegExp, string][] = [[/\b(funding|investment|capital)\b/, 'funding'], [/\b(cash|money|reserves)\b/, 'cash'], [/\b(debts?|loans)\b/, 'debt'], [/\b(share prices?|stock prices?|shares|valuations?)\b/, 'sharePrice'], [/\b(wages?|salar(y|ies)|pay)\b/, 'wages'], [/\bproductivity\b/, 'productivity'], [/\breputation\b/, 'reputation'], [/\b(staff|headcount|workforce|employees|jobs|workers)\b/, 'headcount']];

function parseClause(raw: string, c: Ctx) {
  const s = raw;
  if (!s.trim() || /^\s*(please|ok|okay|and|then|also)\s*$/.test(s)) return;
  for (const k of CONCEPTS) if (k.re.test(s)) { k.run(s, c); return; }
  const dirNow = ZERO.test(s) ? -1 : UP.test(s) && !DOWN.test(s) ? 1 : DOWN.test(s) && !UP.test(s) ? -1 : UP.test(s) && DOWN.test(s) ? (s.search(UP) < s.search(DOWN) ? 1 : -1) : 0;
  const dir = dirNow || (/\b(set|make|change|fix|peg|bring)\b/.test(s) ? 0 : c.lastDir);
  if (dirNow) c.lastDir = dirNow;
  const orgType = orgTypeIn(s), sector = sectorIn(s);
  // close organisations
  if (orgType && /\b(close[sd]?|shut(s)? down|bankrupt\w*|ban(s|ned)?|abolish\w*|destroy\w*|dissolve\w*|go(es)? bust|fail(s)?|nationali[sz]e\w*)\b/.test(s) && !/\b(funding|wages?|tax)\b/.test(s)) {
    const m = s.match(/(\d+(?:\.\d+)?)\s*%/); const f: any = {}; if (/compan|business|firm/.test(s) && !/small/.test(s)) f.type = ['corporation', 'small_business', 'startup']; else f.type = orgType; if (sector && orgType !== sector) f.sector = sector;
    push(c, 'close_organisations', { filter: f, fraction: m ? parseFloat(m[1]) / 100 : /\bhalf\b/.test(s) ? 0.5 : 1 }); return;
  }
  // create organisations
  if (orgType && CREATE.test(s) && !/\b(funding|wages?|tax\w*|prices?)\b/.test(s)) { const n = numberIn(s); push(c, 'create_entity', { kind: 'organisation', orgType, sector, count: n && n <= 60 ? n : 1 }); return; }
  // bulk organisation adjustments ("every startup loses 40% of its funding")
  if (orgType) for (const [re, field] of ORG_FIELD) if (re.test(s)) {
    if (field === 'funding' && orgType === 'startup' && !sector) break;
    if (field === 'wages' && /compan|business|firm/.test(s)) break;
    const mag = magnitude(s, null, dir); if (!mag) break; if (mag.note) c.assumptions.push(mag.note.replace('the change', `${orgType} ${field}`));
    const f: any = { type: orgType }; if (sector) f.sector = sector; if (/compan|business|firm/.test(s) && !/small|large|big/.test(s)) f.type = ['corporation', 'small_business', 'startup'];
    push(c, 'adjust_entities', { entity: 'orgs', filter: f, field, mode: mag.mode, value: mag.value }); return;
  }
  // bulk citizen adjustments ("double the savings of the poor", "give the poor 5000 each")
  if (/\b(give|grant|hand|pay|send)\b/.test(s) && numberIn(s) && !CIT_FIELD.some(([re]) => re.test(s))) for (const [gre, filter] of CIT_GROUPS) if (gre.test(s)) { push(c, 'adjust_entities', { entity: 'citizens', filter: { minAge: 18, ...filter }, field: 'savings', mode: 'add', value: numberIn(s)! }); c.assumptions.push('The payment was added once to each matching adult’s savings (not funded from the government budget).'); return; }
  for (const [gre, filter] of CIT_GROUPS) if (gre.test(s)) for (const [fre, field] of CIT_FIELD) if (fre.test(s)) {
    if (field === 'trustGov' && Object.keys(filter).length === 0) break;
    if (Object.keys(filter).length === 0 && (field === 'wage' || field === 'savings' || field === 'debt')) break;
    const mag = magnitude(s, null, dir) || (/\bgive\b/.test(s) && numberIn(s) ? { mode: 'add' as const, value: numberIn(s)! } : null); if (!mag) break; if (mag.note) c.assumptions.push(mag.note.replace('the change', field));
    push(c, 'adjust_entities', { entity: 'citizens', filter, field, mode: mag.mode, value: mag.value }); return;
  }
  // generic parameter adjustment
  const hit = findParam(s);
  if (hit) {
    const mag = magnitude(s, hit.def, dir);
    if (mag) { if (mag.note) c.assumptions.push(mag.note); const args: any = { target: hit.def.key, mode: mag.mode, value: mag.value }; if (hit.def.sectorScoped && sector && !hit.syn.includes(sector)) args.sector = sector; push(c, 'adjust_parameter', args); return; }
    if (durationDays(s) !== null || /\b(simulate|observe|evaluate|watch|see|consequences|effects?)\b/.test(s)) return;
    c.unsupported.push({ text: raw.trim(), reason: `I recognised “${hit.def.label}” but not what should happen to it (say e.g. “increase ${hit.syn} by 20%”).` }); return;
  }
  if (durationDays(s) !== null || /\b(simulate|observe|evaluate|watch|see what|consequences|effects?|impact|happens)\b/.test(s)) return;
  const sug = paramSuggestions(s);
  c.unsupported.push({ text: raw.trim(), reason: `The offline interpreter could not map this to a simulation operation.${sug.length ? ` Closest things I can change: ${sug.join(', ')}.` : ''} Configure an LLM provider for open-ended instructions.` });
}

const HYPO = /^\s*(what if|what happens if|what would happen if|what happens when|what would happen when|what will happen if|suppose|imagine|hypothetically|how would|what would|would |could |should |if )|\bwhat if\b|\bwhat happens if\b|\bwhat would happen\b|\bhypothetical/;
const QUERY = /^\s*(who|whom|which|how many|how much|how is|how are|how's|what is|what's|what are|what was|what were|what happened|show|list|tell me|describe|inspect|find|why|when|where|is |are |does |do |did |compare|rank|top |give me|report|status|summari[sz]e|explain)\b/;
const VERB_START = '(?:increase|reduce|decrease|raise|lower|cut|make|create|introduce|simulate|set|ban|abolish|double|triple|halve|give|remove|build|close|observe|eliminate|boost|slash|add|trigger|cause|start|launch|impose|lift|open|found|establish|let|shut|hike|freeze|tax|subsidi[sz]e|fund|defund)';

export function interpretFallback(text: string, w: World): Plan {
  let s = norm(text);
  const c: Ctx = { ops: [], assumptions: [], unsupported: [], lastDir: 0, w };
  const hypo = HYPO.test(s) || (/^\s*simulate\b/.test(s) && !new RegExp(`\\b(?:and|then|,)\\s+${VERB_START}\\b`).test(s) && !/^\s*simulate (\w+ )?(day|week|month|year)/.test(s));
  const isQuery = !hypo && QUERY.test(s) && !(UP.test(s) && /\bby\b/.test(s));
  if (isQuery) return { mode: 'query', summary: 'Inspect the world', assumptions: [], operations: fallbackQuery(s, w), unsupported: [], source: 'fallback' };
  if (/^\s*simulate\b/.test(s) && hypo) c.assumptions.push('“Simulate …” was treated as a hypothetical experiment in an isolated branch; switch to that timeline to make it real.');
  s = s.replace(/^\s*(what if|what happens if|what would happen if|what happens when|what would happen when|what will happen if|suppose that|suppose|imagine that|imagine|hypothetically,?|simulate what happens if)\s*/, ' ');
  let horizon: number | null = null;
  const parts = s.split(new RegExp(`;|\\.\\s+|\\?\\s*|,?\\s+and then\\s+|,\\s*then\\s+|,\\s*(?=(?:and\\s+)?${VERB_START}\\b)|\\s+and\\s+(?=${VERB_START}\\b)|\\s+while\\s+(?=${VERB_START})`)).map((p) => p.replace(/^\s*and\s+/, ' '));
  for (let p of parts) {
    if (!p || !p.trim()) continue;
    p = ' ' + p.trim() + ' ';
    const d = durationDays(p); if (d !== null) horizon = Math.max(horizon || 0, d);
    const sub = (p.match(/\d+(?:\.\d+)?\s*(%|percentage points?)/g) || []).length >= 2 && / and /.test(p) ? p.split(/\s+and\s+/) : [p];
    for (const q of sub) parseClause(' ' + q.trim().replace(/\b(over|for|during|within|across) (the )?(next |coming )?(\d+(\.\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|twelve) (day|week|month|quarter|year|decade)s?\b/, '') + ' ', c);
  }
  const plan: Plan = { mode: hypo ? 'hypothetical' : 'direct', summary: '', assumptions: c.assumptions, operations: c.ops, unsupported: c.unsupported, source: 'fallback' };
  if (horizon !== null) plan.horizonDays = horizon;
  return plan;
}

const METRIC_WORDS: [RegExp, string[]][] = [[/unemploy|jobless|jobs/, ['unemployment', 'unemployed', 'openings']], [/inflation|prices|cost of living|cpi/, ['inflation', 'cpi', 'priceFood', 'priceEnergy', 'avgRent']], [/gdp|economy|economic output|growth/, ['gdp', 'gdpPerCapita', 'unemployment', 'inflation']], [/population|how many (people|citizens)|residents/, ['population', 'households', 'children', 'retired']], [/trust|approval|government/, ['publicTrust', 'approval', 'govBalance', 'govDebt']], [/stabil|unrest|protest/, ['stability', 'protestShare', 'crime']], [/wealth|rich|savings/, ['avgHouseholdWealth', 'medianIncome', 'gini']], [/inequal|gini/, ['gini', 'povertyRate']], [/crime/, ['crime']], [/rent|housing|homeless/, ['avgRent', 'vacancy', 'homelessRate', 'propertyIndex']], [/wage|salar|income/, ['avgWage', 'realWage', 'medianIncome', 'minWage']], [/stock|market|index|shares/, ['marketIndex', 'confidence', 'credit']], [/poverty|poor/, ['povertyRate', 'purchasingPowerLow', 'foodShareLow']], [/happ|satisf|quality of life/, ['happiness', 'health']], [/interest/, ['interestRate']], [/health|hospital|disease|infect/, ['health', 'infected', 'hospitalLoad', 'hospitalBeds']], [/educat|student|universit/, ['students', 'uniCapacity', 'avgEducation', 'schoolQuality']], [/tech|automation|research/, ['techLevel', 'automation', 'technologies', 'researchOutput']], [/startup|business|compan/, ['startups', 'businesses', 'startupFunding', 'corporateProfits']], [/budget|deficit|debt|tax/, ['govBalance', 'govDebt', 'govRevenue', 'govSpending']]];

function fallbackQuery(s: string, w: World): PlanOp[] {
  const q = (args: any): PlanOp[] => [{ op: 'query', args }];
  const limit = Math.min(25, numberIn(s) && numberIn(s)! <= 50 ? numberIn(s)! : /\b(who is|which is|what is) the\b/.test(s) ? 1 : 5);
  for (const o of w.orgs) if (o.alive && s.includes(o.name.toLowerCase())) return q({ kind: 'entity', name: o.name });
  for (const d of w.districts) if (s.includes(d.name.toLowerCase())) return q({ kind: 'entity', name: d.name });
  const nm = s.match(/\b(?:about|inspect|find|who is|show me|describe)\s+([a-z'\-]+ [a-z'\-]+)\s*[?. ]/);
  if (nm) { const c = w.citizens.find((x) => x.name.toLowerCase() === nm[1]); if (c) return q({ kind: 'entity', name: c.name }); }
  if (/\b(richest|wealthiest)\b/.test(s)) return q({ kind: 'rank', entity: 'citizens', by: 'wealth', order: 'desc', limit });
  if (/\bpoorest\b/.test(s)) return q({ kind: 'rank', entity: 'citizens', by: 'wealth', order: 'asc', limit });
  if (/\b(highest paid|best paid|top earners?)\b/.test(s)) return q({ kind: 'rank', entity: 'citizens', by: 'wage', order: 'desc', limit });
  if (/\b(oldest)\b/.test(s)) return q({ kind: 'rank', entity: 'citizens', by: 'age', order: 'desc', limit });
  if (/\b(unhappiest|most unhappy)\b/.test(s)) return q({ kind: 'rank', entity: 'citizens', by: 'happiness', order: 'asc', limit });
  const t = orgTypeIn(s), filter: any = {}; if (t && !/compan|business|firm|employer/.test(s)) filter.type = t; const sec = sectorIn(s); if (sec && sec !== t) filter.sector = sec;
  if (/\b(largest|biggest|top|major) (\w+ )?(compan|employer|business|firm|organi|startup|bank|corporation)/.test(s)) return q({ kind: 'rank', entity: 'orgs', by: /valuable|valuation/.test(s) ? 'valuation' : 'employees', order: 'desc', limit: Math.max(limit, 5), filter });
  if (/\b(most profitable|highest profit)\b/.test(s)) return q({ kind: 'rank', entity: 'orgs', by: 'profit', order: 'desc', limit: Math.max(limit, 5), filter });
  if (/\b(struggling|losing money|least profitable|at risk|failing)\b/.test(s)) return q({ kind: 'rank', entity: 'orgs', by: 'profit', order: 'asc', limit: Math.max(limit, 5), filter });
  if (/\b(most valuable|highest valuation)\b/.test(s)) return q({ kind: 'rank', entity: 'orgs', by: 'valuation', order: 'desc', limit: Math.max(limit, 5), filter });
  if (/\b(district|neighbou?rhood|area)s?\b/.test(s)) return q({ kind: 'rank', entity: 'districts', by: /crime|danger|safe/.test(s) ? 'crime' : /unemploy/.test(s) ? 'unemp' : /rent|expensive/.test(s) ? 'rentIdx' : /rich|wealth|income|poor/.test(s) ? 'avgIncome' : 'pop', order: /\b(safest|poorest|lowest|least|cheapest)\b/.test(s) ? 'asc' : 'desc', limit: 20 });
  if (/\bhow many\b/.test(s)) { if (t) return q({ kind: 'count', entity: 'orgs', filter }); for (const [re, f] of CIT_GROUPS) if (re.test(s) && Object.keys(f).length) return q({ kind: 'count', entity: 'citizens', filter: f }); }
  if (/\b(what happened|recent|news|events?|history|why|lately|last (month|year|week))\b/.test(s)) { const d = durationDays(s); const cat = /\b(econom|market|price)/.test(s) ? 'economy' : /\b(politic|election|government)/.test(s) ? 'politics' : /\bhealth|disease/.test(s) ? 'health' : /\b(business|compan|closure|bankrupt)/.test(s) ? 'business' : /\b(tech)/.test(s) ? 'technology' : undefined; return q({ kind: 'events', sinceDays: d ?? 180, category: cat }); }
  const keys: string[] = []; for (const [re, ks] of METRIC_WORDS) if (re.test(s)) for (const k of ks) if (!keys.includes(k)) keys.push(k);
  return q({ kind: 'metrics', keys: keys.length ? keys.slice(0, 10) : ['population', 'gdp', 'unemployment', 'inflation', 'avgHouseholdWealth', 'publicTrust', 'stability', 'marketIndex', 'startups', 'povertyRate'] });
}
