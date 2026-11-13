import { useEffect, useRef, useState, type ReactNode } from 'react';
import City from './City';
import { useStore, api, fmtMoney, fmtPct, fmtUnit } from './store';
import { Dashboards, Timelines } from './Panels';

const STAGES = ['understand', 'classify', 'validate', 'execute', 'evolve', 'report'];
const SPEEDS = [1, 2, 5, 10, 30, 100];

function Chip({ label, value, tone }: { label: string; value: string; tone?: string }) { return <div className={`chip ${tone || ''}`}><span>{label}</span><b>{value}</b></div>; }

function TopBar() {
  const st = useStore((s) => s.status), set = useStore((s) => s.set), connected = useStore((s) => s.connected), select = useStore((s) => s.select);
  const [q, setQ] = useState(''), [res, setRes] = useState<any[]>([]);
  useEffect(() => { if (q.length < 2) return setRes([]); const t = setTimeout(() => api(`/search?q=${encodeURIComponent(q)}`).then(setRes).catch(() => {}), 180); return () => clearTimeout(t); }, [q]);
  const m = st?.metrics || {};
  return (<header className="top">
    <div className="brand"><div className="logo" /><div><h1>WORLDZERO</h1><small>{st ? `City of ${st.name} · fictional simulation` : 'connecting…'}</small></div></div>
    <div className="chips">
      <Chip label="Date" value={st?.date || '—'} />
      <Chip label="Population" value={(m.population || 0).toLocaleString('en-US')} />
      <Chip label="Output / yr" value={fmtMoney(m.gdp)} />
      <Chip label="Unemployment" value={fmtPct(m.unemployment)} tone={m.unemployment > 0.1 ? 'bad' : ''} />
      <Chip label="Inflation" value={fmtPct(m.inflation)} tone={Math.abs(m.inflation) > 0.08 ? 'bad' : ''} />
      <Chip label="Avg household wealth" value={fmtMoney(m.avgHouseholdWealth)} />
      <Chip label="Public trust" value={fmtPct(m.publicTrust, 0)} tone={m.publicTrust < 0.35 ? 'bad' : ''} />
      <Chip label="Stability" value={fmtPct(m.stability, 0)} tone={m.stability < 0.45 ? 'bad' : ''} />
    </div>
    <div className="tools">
      <div className="search"><input placeholder="Search people, organisations, districts" value={q} onChange={(e) => setQ(e.target.value)} />
        {res.length > 0 && <div className="results">{res.map((r) => <button key={r.ref} onClick={() => { select(r.ref); setQ(''); }}><b>{r.name}</b><span>{r.sub}</span></button>)}</div>}</div>
      <button className="btn" onClick={() => set({ panel: 'dash' })}>Dashboards</button>
      <button className="btn" onClick={() => set({ panel: 'time' })}>Timelines</button>
      <span className={`dot ${connected ? 'on' : ''}`} title={connected ? 'Live' : 'Disconnected'} />
    </div>
  </header>);
}

function TimeControls() {
  const st = useStore((s) => s.status), control = useStore((s) => s.control), overlay = useStore((s) => s.overlay), colorBy = useStore((s) => s.colorBy), set = useStore((s) => s.set), tl = useStore((s) => s.timelinesV);
  const [name, setName] = useState('');
  useEffect(() => { api('/timelines').then((t) => setName(t.timelines.find((x: any) => x.id === t.active)?.name || '')).catch(() => {}); }, [tl, st?.timeline]);
  if (!st) return null;
  return (<div className="controls">
    <div className="row">
      <button className="btn primary" onClick={() => control(st.running ? 'pause' : 'play')}>{st.running ? '❚❚ Pause' : '▶ Play'}</button>
      <button className="btn" onClick={() => control('step', 1)} title="Advance one day">+1 day</button>
      <button className="btn" onClick={() => control('step', 30)} title="Advance one month">+1 month</button>
      {SPEEDS.map((s) => <button key={s} className={`btn sm ${st.speed === s ? 'on' : ''}`} onClick={() => control('speed', s)}>{s}×</button>)}
      <button className="btn sm" title="Save a snapshot of the whole world" onClick={() => api('/snapshots', { label: `Snapshot ${st.date}` }).then(() => set({ panel: 'time' }))}>⦿ Snapshot</button>
    </div>
    <div className="row dim">
      <span>{st.running ? `${st.speed} day${st.speed > 1 ? 's' : ''}/sec` : 'Paused'} · timeline <b>{name || st.timeline}</b></span>
      <label>Map <select value={overlay} onChange={(e) => set({ overlay: e.target.value })}>{['none', 'density', 'unemployment', 'income', 'rent', 'crime', 'happiness', 'infection'].map((o) => <option key={o} value={o}>{o === 'none' ? 'district type' : o === 'income' ? 'low income' : o === 'happiness' ? 'unhappiness' : o}</option>)}</select></label>
      <label>People <select value={colorBy} onChange={(e) => set({ colorBy: e.target.value })}><option value="status">by status</option><option value="wealth">by income group</option></select></label>
    </div>
    <div className="legend">{colorBy === 'status' ? [['#4ade80', 'employed'], ['#22d3ee', 'owner'], ['#fb923c', 'unemployed'], ['#facc15', 'student'], ['#7dd3fc', 'child'], ['#a1a1aa', 'retired'], ['#ef4444', 'infected'], ['#e879f9', 'protesting']].map(([c, l]) => <span key={l}><i style={{ background: c }} />{l}</span>) : [['#fb923c', 'low'], ['#60a5fa', 'middle'], ['#a78bfa', 'high'], ['#fde047', 'top 1%']].map(([c, l]) => <span key={l}><i style={{ background: c }} />{l}</span>)}</div>
  </div>);
}

function EventFeed() {
  const events = useStore((s) => s.events), select = useStore((s) => s.select);
  const list = events.filter((e) => e.sev >= 0.25).slice(-7).reverse();
  return (<div className="feed"><h4>World events</h4>{list.length === 0 && <p className="dim">Life goes on quietly…</p>}
    {list.map((e) => <button key={e.id} className={`ev ${e.cat}`} title={e.why ? `Why: ${e.why}` : e.detail} onClick={() => e.entity ? select(e.entity) : e.district >= 0 ? select(`district:${e.district}`) : null}><i />{e.title}</button>)}</div>);
}

const Ref = ({ r, children }: { r?: string | null; children: ReactNode }) => { const select = useStore((s) => s.select); return r ? <a className="ref" onClick={() => select(r)}>{children}</a> : <>{children}</>; };
const KV = ({ k, v }: { k: string; v: ReactNode }) => <div className="kv"><span>{k}</span><b>{v}</b></div>;
const Bar = ({ v, tone }: { v: number; tone?: string }) => <div className="bar"><i className={tone} style={{ width: `${Math.max(0, Math.min(1, v)) * 100}%` }} /></div>;

function Inspector() {
  const d = useStore((s) => s.inspector), select = useStore((s) => s.select), tick = useStore((s) => s.status?.tick), refresh = useStore((s) => s.refreshInspector);
  useEffect(() => { if (tick && tick % 10 === 0) refresh(); }, [tick]);
  if (!d) return null;
  return (<aside className="inspector"><button className="x" onClick={() => select(null)}>×</button>
    {d.kind === 'citizen' && <>
      <div className="tag">Citizen #{d.id}{!d.alive ? ' · deceased' : d.left ? ' · emigrated' : ''}</div><h3>{d.name}</h3>
      <p className="dim">{d.age} · {d.role}{d.employer ? <> at <Ref r={d.employer.ref}>{d.employer.name}</Ref></> : d.school ? <> at <Ref r={d.school.ref}>{d.school.name}</Ref></> : ''}</p>
      <div className="grid2"><KV k="Net worth" v={fmtMoney(d.netWorth)} /><KV k="Monthly income" v={fmtMoney(d.income)} /><KV k="Wage / pension" v={fmtMoney(d.wage)} /><KV k="Savings" v={fmtMoney(d.savings)} /><KV k="Investments" v={fmtMoney(d.investments)} /><KV k="Debt" v={fmtMoney(d.debt)} /><KV k="Income group" v={d.tier} /><KV k="Education" v={d.education} /></div>
      <h4>State of mind</h4>
      {[['Happiness', d.happiness], ['Health', d.health], ['Trust in government', d.trustGov], ['Trust in business', d.trustBiz], ['Stress', d.stress, 'warn'], ['Skill', d.skill]].map(([k, v, t]: any) => <div className="meter" key={k}><span>{k}</span><Bar v={v} tone={t} /><em>{fmtPct(v, 0)}</em></div>)}
      <div className="grid2"><KV k="Goal" v={String(d.goal).replace(/_/g, ' ')} /><KV k="Last decision" v={String(d.lastDecision || '—').replace(/_/g, ' ')} /><KV k="Health status" v={d.infection} /><KV k="Spending mode" v={`${Math.round(d.spendMode * 100)}%`} />{d.protesting && <KV k="Activity" v="Protesting" />}{d.stake && <KV k="Owns" v={<Ref r={d.stake.ref}>{d.stake.name}</Ref>} />}</div>
      <h4>Personality</h4><div className="traits">{Object.entries({ Openness: d.traits.open, Conscientious: d.traits.consc, Extraversion: d.traits.extra, Agreeable: d.traits.agree, Neuroticism: d.traits.neuro, 'Risk appetite': d.traits.risk, Ambition: d.traits.ambition, Frugality: d.traits.frugal }).map(([k, v]) => <span key={k}>{k} <b>{Math.round((v as number) * 100)}</b></span>)}</div>
      <h4>Household · <Ref r={d.household.districtRef}>{d.household.district}</Ref></h4>
      <div className="grid2"><KV k="Household income" v={fmtMoney(d.household.income)} /><KV k="Essentials cost" v={fmtMoney(d.household.essentials)} /><KV k="Purchasing power" v={`${d.household.purchasingPower.toFixed(2)}×`} /><KV k="Home" v={d.household.homeless ? 'Homeless' : d.household.owns ? 'Owner' : 'Renter'} /></div>
      {d.household.budget && <p className="dim sm">Monthly essentials: food {fmtMoney(d.household.budget.food)} · housing {fmtMoney(d.household.budget.housing)} · energy {fmtMoney(d.household.budget.energy)} · health {fmtMoney(d.household.budget.health)}{d.household.budget.edu > 0 ? ` · tuition ${fmtMoney(d.household.budget.edu)}` : ''}</p>}
      <div className="links">{d.partner && <Ref r={d.partner.ref}>♥ {d.partner.name}</Ref>}{d.household.members.filter((m: any) => m.ref !== d.partner?.ref).map((m: any) => <Ref key={m.ref} r={m.ref}>{m.name} ({m.age})</Ref>)}</div>
      {d.friends.length > 0 && <><h4>Friends ({d.friends.length})</h4><div className="links">{d.friends.map((m: any) => <Ref key={m.ref} r={m.ref}>{m.name}</Ref>)}</div></>}
      <h4>Memory</h4>{d.memories.length === 0 && <p className="dim sm">Nothing notable yet.</p>}
      {d.memories.map((m: any, i: number) => <div key={i} className={`mem ${m.v < 0 ? 'neg' : 'pos'}`}><time>{m.date}</time>{m.text}</div>)}
      {d.longTerm.length > 0 && <><h4>Defining moments</h4>{d.longTerm.map((m: any, i: number) => <div key={i} className={`mem ${m.v < 0 ? 'neg' : 'pos'}`}><time>{m.date}</time>{m.text}</div>)}</>}
    </>}
    {d.kind === 'org' && <>
      <div className="tag">{d.type} · {d.sector}{!d.alive ? ' · CLOSED' : ''}</div><h3>{d.name}</h3>
      <p className="dim"><Ref r={d.districtRef}>{d.district}</Ref> · founded {d.founded} · objective: {String(d.objective).replace(/_/g, ' ')}</p>
      {!d.alive && <p className="alert">Closed {d.closed}: {d.closeReason}</p>}
      <div className="grid2"><KV k="Employees" v={d.employees} /><KV k="Open positions" v={d.openings} /><KV k="Revenue / month" v={fmtMoney(d.revenue)} /><KV k="Expenses / month" v={fmtMoney(d.expenses)} /><KV k="Profit / month" v={fmtMoney(d.profit)} /><KV k="Cash" v={fmtMoney(d.cash)} /><KV k="Debt" v={fmtMoney(d.debt)} /><KV k="Avg wage" v={fmtMoney(d.avgWage)} />
        {d.funding > 0 && <KV k={`Funding${d.stage ? ` (${d.stage})` : ''}`} v={fmtMoney(d.funding)} />}{d.publicFunding > 0 && <KV k="Public funding" v={fmtMoney(d.publicFunding)} />}{d.listed && <KV k="Share price" v={d.sharePrice.toFixed(2)} />}{d.listed && <KV k="Market cap" v={fmtMoney(d.marketCap)} />}<KV k="Market share" v={fmtPct(d.marketShare)} />{d.hiringFrozen && <KV k="Hiring" v="Frozen" />}</div>
      {[['Capacity used', d.utilisation / 1.2], ['Reputation', d.reputation], ['Productivity', d.productivity / 1.8]].map(([k, v]: any) => <div className="meter" key={k}><span>{k}</span><Bar v={v} /><em>{k === 'Capacity used' ? fmtPct(d.utilisation, 0) : k === 'Productivity' ? d.productivity.toFixed(2) : fmtPct(v, 0)}</em></div>)}
      {d.owner && <p>Owner: <Ref r={d.owner.ref}>{d.owner.name}</Ref></p>}
      {d.managers.length > 0 && <><h4>Management</h4><div className="links">{d.managers.map((m: any) => <Ref key={m.ref} r={m.ref}>{m.name} · {m.role}</Ref>)}</div></>}
      <h4>Recent decisions</h4>{d.decisions.length === 0 && <p className="dim sm">Business as usual.</p>}{d.decisions.map((m: any, i: number) => <div key={i} className="mem"><time>{m.date}</time>{m.text}</div>)}
      {d.partners.length > 0 && <><h4>Partners</h4><div className="links">{d.partners.map((m: any) => <Ref key={m.ref} r={m.ref}>{m.name}</Ref>)}</div></>}
      <h4>Staff</h4><div className="links">{d.staff.map((m: any) => <Ref key={m.ref} r={m.ref}>{m.name} · {m.role} · {fmtMoney(m.wage)}</Ref>)}</div>
    </>}
    {d.kind === 'building' && <>
      <div className="tag">Building · {d.type} · {d.status}</div><h3>{d.name}</h3><p className="dim"><Ref r={d.districtRef}>{d.district}</Ref> · built {d.built}</p>
      {d.type === 'residential' ? <div className="grid2"><KV k="Homes" v={d.units} /><KV k="Occupied" v={d.occupied} /><KV k="Rent index" v={d.rentIndex.toFixed(2)} /><KV k="Households" v={d.households} /></div> : null}
      {d.orgs.length > 0 && <><h4>Organisations here</h4><div className="links">{d.orgs.map((o: any) => <Ref key={o.ref} r={o.ref}>{o.name} · {o.type} · {o.alive ? `${o.employees} staff` : 'closed'}</Ref>)}</div></>}
      {d.residents.length > 0 && <><h4>Residents</h4><div className="links">{d.residents.map((m: any) => <Ref key={m.ref} r={m.ref}>{m.name} ({m.age}) · {m.role}</Ref>)}</div></>}
    </>}
    {d.kind === 'district' && <>
      <div className="tag">Neighbourhood · {d.type} · {d.wealth}</div><h3>{d.name}</h3>
      <div className="grid2"><KV k="Residents" v={d.population} /><KV k="Jobs here" v={d.jobs} /><KV k="Unemployment" v={fmtPct(d.unemployment)} /><KV k="Avg income" v={fmtMoney(d.avgIncome)} /><KV k="Rent index" v={d.rentIndex.toFixed(2)} /><KV k="Crime" v={fmtPct(d.crime, 0)} /><KV k="Happiness" v={fmtPct(d.happiness, 0)} /><KV k="Infected" v={d.infected} /><KV k="Protesters" v={d.protesters} /><KV k="Buildings / free lots" v={`${d.buildings} / ${d.freeLots}`} /></div>
      {d.topOrgs.length > 0 && <><h4>Organisations ({d.organisations})</h4><div className="links">{d.topOrgs.map((o: any) => <Ref key={o.ref} r={o.ref}>{o.name} · {o.employees} staff</Ref>)}</div></>}
      {d.events.length > 0 && <><h4>Recent events</h4>{d.events.map((m: any, i: number) => <div key={i} className="mem"><time>{m.date}</time>{m.title}</div>)}</>}
    </>}
  </aside>);
}

function GodResult({ r }: { r: any }) {
  const set = useStore((s) => s.set), select = useStore((s) => s.select);
  const [busy, setBusy] = useState(false), [open, setOpen] = useState(false);
  const act = async (fn: () => Promise<any>) => { setBusy(true); try { await fn(); } catch (e: any) { alert(e.message); } setBusy(false); };
  const hyp = r.mode === 'hypothetical';
  return (<div className={`msg god ${r.status}`}>
    <div className="badges"><span className={`badge ${r.mode}`}>{r.mode === 'direct' ? 'DIRECT INTERVENTION' : hyp ? 'HYPOTHETICAL · ISOLATED BRANCH' : 'INSPECTION'}</span><span className={`badge st-${r.status}`}>{r.status === 'executed' ? 'Executed' : r.status === 'partial' ? 'Partly executed' : r.status === 'answered' ? 'Answered' : 'Not executed'}</span><span className="badge src" title={r.llmError || ''}>{r.source === 'llm' ? `AI interpreter · ${r.model}` : 'Deterministic interpreter'}</span></div>
    {r.operations?.length > 0 && <div className="ops">{r.operations.map((o: any, i: number) => <div key={i} className={o.ok ? 'op' : 'op fail'}><b>{o.ok ? '✓' : '✗'} {o.summary}</b>{o.error && <em>{o.error}</em>}{o.details?.map((d: string, j: number) => <span key={j}>{d}</span>)}{Object.keys(o.affected || {}).length > 0 && <span className="aff">Affected: {Object.entries(o.affected).filter(([, v]) => v).map(([k, v]) => `${Number(v).toLocaleString('en-US')} ${k.replace(/([A-Z])/g, ' $1').toLowerCase()}`).join(' · ')}</span>}</div>)}</div>}
    {r.unsupported?.length > 0 && <div className="unsup"><b>Not executed</b>{r.unsupported.map((u: any, i: number) => <p key={i}>“{u.text}” — {u.reason}</p>)}</div>}
    {r.narrative && <p className="narr"><span className="lbl">Calculated by the engine</span>{r.narrative}</p>}
    {r.aiNarrative && <p className="narr ai"><span className="lbl">AI-generated interpretation</span>{r.aiNarrative}</p>}
    {r.answer?.map((a: any, i: number) => a.rows && a.kind !== 'metrics' && a.kind !== 'events' && a.kind !== 'count' ? <div key={i} className="links">{a.rows.map((x: any) => <a key={x.ref} className="ref" onClick={() => select(x.ref)}>{x.name} — {x.display}</a>)}</div> : null)}
    {r.deltas?.length > 0 && <table className="deltas"><thead><tr><th>Indicator</th><th>{hyp ? 'Control' : 'Before'}</th><th>{hyp ? 'Experiment' : 'After'}</th><th>Δ</th></tr></thead><tbody>
      {r.deltas.slice(0, open ? 18 : 8).map((d: any) => { const ref = hyp ? d.control : d.before, diff = d.after - ref, rel = Math.abs(ref) > 1e-9 ? diff / Math.abs(ref) : 0; return <tr key={d.key}><td>{d.label}</td><td>{fmtUnit(d.unit, ref)}</td><td>{fmtUnit(d.unit, d.after)}</td><td className={Math.abs(rel) < 0.005 ? '' : diff > 0 ? 'up' : 'down'}>{d.unit === 'pct' ? `${diff >= 0 ? '+' : ''}${(diff * 100).toFixed(1)} pts` : `${rel >= 0 ? '+' : ''}${(rel * 100).toFixed(1)}%`}</td></tr>; })}</tbody></table>}
    {r.deltas?.length > 8 && <a className="more" onClick={() => setOpen(!open)}>{open ? 'Show less' : `Show all ${r.deltas.length} indicators`}</a>}
    {(open || r.deltas?.length <= 8) && r.reactions?.length > 0 && <><h5>How citizens and organisations reacted{r.horizonDays ? ` (${r.horizonDays} days)` : ''}</h5><div className="react">{r.reactions.map((x: any) => <div key={x.label}><span>{x.label}</span><b>{x.value.toLocaleString('en-US')}{x.control !== undefined && <i> vs {x.control.toLocaleString('en-US')}</i>}</b></div>)}</div></>}
    {open && r.groups?.length > 0 && <><h5>Reactions per 100 adults, by income group</h5><table className="deltas"><thead><tr><th /><th>Low</th><th>Middle</th><th>High</th></tr></thead><tbody>{r.groups.map((g: any) => <tr key={g.label}><td>{g.label}</td><td>{g.low}</td><td>{g.middle}</td><td>{g.high}</td></tr>)}</tbody></table></>}
    {open && r.events?.length > 0 && <><h5>Events during the simulation</h5>{r.events.map((e: any) => <div key={e.id} className="mem" title={e.why}><time>day {e.t}</time>{e.title}{e.why && <em> — {e.why}</em>}</div>)}</>}
    {!open && (r.events?.length > 0 || r.groups?.length > 0) && r.deltas?.length <= 8 && <a className="more" onClick={() => setOpen(true)}>Show events and group breakdown</a>}
    {(r.assumptions?.length > 0 || r.notes?.length > 0) && <div className="assume"><b>Assumptions & notes</b>{[...(r.assumptions || []), ...(r.notes || [])].map((a: string, i: number) => <p key={i}>• {a}</p>)}</div>}
    <div className="actions">
      {hyp && r.timeline && <><button className="btn sm" disabled={busy} onClick={() => act(() => api(`/timelines/${r.timeline.id}/switch`, {}))}>Enter this timeline</button><button className="btn sm" onClick={() => set({ panel: 'time' })}>Compare timelines</button><span className="dim sm">The active world was not changed.</span></>}
      {r.mode === 'direct' && r.snapshotId && r.status !== 'not_executed' && <button className="btn sm" disabled={busy} onClick={() => act(() => api(`/snapshots/${r.snapshotId}/restore`, {}))}>↶ Undo (rewind to before)</button>}
      {r.ms > 0 && <span className="dim sm">{(r.ms / 1000).toFixed(1)}s</span>}
    </div>
  </div>);
}

const EXAMPLES = ['What if food prices increased by 200%?', 'Create a new billionaire in this city', 'Make university education free', 'Introduce a fictional disease and simulate six months', 'What happens if nobody trusts the government?', 'Increase the minimum wage by 20% and reduce corporate taxes by 5 percentage points', 'Make this city the world’s largest technology hub', 'Who are the richest people?'];

function GodMode() {
  const chat = useStore((s) => s.chat), busy = useStore((s) => s.godBusy), stage = useStore((s) => s.godStage), send = useStore((s) => s.sendGod), llm = useStore((s) => s.status?.llm);
  const [text, setText] = useState(''), [min, setMin] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { const b = box.current; if (b) b.scrollTo({ top: b.scrollHeight, behavior: 'smooth' }); }, [chat.length, busy]);
  const go = () => { const t = text.trim(); if (!t || busy) return; setText(''); send(t); };
  if (min) return <button className="godmin" onClick={() => setMin(false)}>◉ GOD MODE</button>;
  return (<section className="godpanel">
    <div className="godhead"><div><h2>GOD MODE</h2><small>{llm?.available ? `AI interpreter: ${llm.provider} · ${llm.model}` : 'Deterministic interpreter (no AI key configured)'}</small></div><button className="x" onClick={() => setMin(true)}>–</button></div>
    <div className="msgs" ref={box}>
      {chat.length === 0 && <div className="intro"><p>Describe a change, ask “what if…”, or question the world. Direct instructions change the live civilisation; hypotheticals run in an isolated branch.</p>{EXAMPLES.map((e) => <button key={e} onClick={() => setText(e)}>{e}</button>)}</div>}
      {chat.map((m, i) => m.role === 'user' ? <div key={i} className="msg user">{m.content.text}</div> : m.role === 'error' ? <div key={i} className="msg err">{m.content.text}</div> : <GodResult key={i} r={m.content} />)}
      {busy && <div className="msg god pending"><div className="stages">{STAGES.map((s) => <span key={s} className={stage?.stage === s ? 'cur' : STAGES.indexOf(s) < STAGES.indexOf(stage?.stage || '') ? 'done' : ''}>{s}</span>)}</div><p className="dim sm">{stage?.detail || 'Working…'}</p></div>}
    </div>
    <div className="input"><textarea rows={2} placeholder="Type an instruction, a question, or a what-if…" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go(); } }} /><button className="btn primary" disabled={busy || !text.trim()} onClick={go}>{busy ? '…' : 'Send'}</button></div>
  </section>);
}

export default function App() {
  const init = useStore((s) => s.init), panel = useStore((s) => s.panel), ready = useStore((s) => !!s.city && !!s.status);
  useEffect(() => { init(); }, []);
  return (<div className="app">
    <div className="canvas"><City /></div>
    {!ready && <div className="loading"><div className="logo big" /><p>Waking the civilisation…</p></div>}
    <TopBar /><Inspector /><div className="bl"><EventFeed /><TimeControls /></div><GodMode />
    {panel === 'dash' && <Dashboards />}{panel === 'time' && <Timelines />}
  </div>);
}
