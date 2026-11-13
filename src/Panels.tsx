import { useEffect, useState, type ReactNode } from 'react';
import { useStore, api, fmtMoney, fmtPct } from './store';

function Line({ data, color = '#56e0c2', fmt = (v: number) => v.toFixed(2), data2, h = 90 }: { data: number[]; color?: string; fmt?: (v: number) => string; data2?: number[]; h?: number }) {
  const all = [...(data || []), ...(data2 || [])].filter((v) => isFinite(v));
  if (!data || data.length < 2) return <div className="chart empty">Collecting data — advance time</div>;
  const min = Math.min(...all), max = Math.max(...all), span = max - min || Math.abs(max) || 1, W = 300;
  const path = (d: number[]) => d.map((v, i) => `${i ? 'L' : 'M'}${((i / (Math.max(data.length, data2?.length || 0) - 1)) * W).toFixed(1)},${(h - 6 - ((v - min) / span) * (h - 14)).toFixed(1)}`).join('');
  return (<div className="chart"><svg viewBox={`0 0 ${W} ${h}`} preserveAspectRatio="none">{data2 && <path d={path(data2)} fill="none" stroke="#f59e0b" strokeWidth="1.6" vectorEffect="non-scaling-stroke" />}<path d={path(data)} fill="none" stroke={color} strokeWidth="1.8" vectorEffect="non-scaling-stroke" /></svg><span className="hi">{fmt(max)}</span><span className="lo">{fmt(min)}</span><span className="now">{fmt(data[data.length - 1])}</span></div>);
}
const Card = ({ title, children, wide }: { title: string; children: ReactNode; wide?: boolean }) => <div className={`card ${wide ? 'wide' : ''}`}><h4>{title}</h4>{children}</div>;
const Bars = ({ rows, fmt = (v: number) => v.toLocaleString('en-US') }: { rows: { label: string; value: number }[]; fmt?: (v: number) => string }) => { const mx = Math.max(1e-9, ...rows.map((r) => Math.abs(r.value))); return <div className="bars">{rows.map((r) => <div key={r.label}><span>{r.label}</span><div className="bar"><i style={{ width: `${(Math.abs(r.value) / mx) * 100}%` }} /></div><em>{fmt(r.value)}</em></div>)}</div>; };
const cap = (s: string) => s.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());

const TABS = ['Economy', 'Population', 'Businesses', 'Politics', 'Healthcare', 'Education', 'Technology', 'Social'];

export function Dashboards() {
  const set = useStore((s) => s.set), select = useStore((s) => s.select), tick = useStore((s) => s.status?.tick);
  const [d, setD] = useState<any>(null), [tab, setTab] = useState('Economy');
  useEffect(() => { api('/dashboard').then(setD).catch(() => {}); }, [Math.floor((tick || 0) / 15)]);
  const go = (ref: string) => { select(ref); set({ panel: null }); };
  const H = (k: string) => d?.history?.s?.[k] || [];
  const m = d?.metrics || {};
  const Tbl = ({ head, rows }: { head: string[]; rows: (ReactNode[] & { ref?: string })[] }) => <table className="tbl"><thead><tr>{head.map((h) => <th key={h}>{h}</th>)}</tr></thead><tbody>{rows.map((r, i) => <tr key={i} className={(r as any).ref ? 'click' : ''} onClick={() => (r as any).ref && go((r as any).ref)}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody></table>;
  const row = (ref: string | undefined, ...cells: ReactNode[]) => Object.assign(cells, { ref });
  return (<div className="modal" onClick={() => set({ panel: null })}><div className="sheet" onClick={(e) => e.stopPropagation()}>
    <div className="sheethead"><div className="tabs">{TABS.map((t) => <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t}</button>)}</div><span className="dim">{d?.date} · monthly history</span><button className="x" onClick={() => set({ panel: null })}>×</button></div>
    {!d ? <p className="dim">Loading…</p> : <div className="cards">
      {tab === 'Economy' && <>
        <Card title="Economic output (annual)"><Line data={H('gdp')} fmt={fmtMoney} /></Card><Card title="Unemployment"><Line data={H('unemployment')} fmt={fmtPct} color="#fb923c" /></Card><Card title="Inflation (12-month)"><Line data={H('inflation')} fmt={fmtPct} color="#f472b6" /></Card>
        <Card title="Stock market index"><Line data={d.market.indexHist} fmt={(v) => v.toFixed(0)} color="#60a5fa" /></Card><Card title="Real wage"><Line data={H('realWage')} fmt={fmtMoney} /></Card><Card title="Interest rate"><Line data={H('interestRate')} fmt={(v) => fmtPct(v, 2)} color="#a78bfa" /></Card>
        <Card title="Prices (index)"><Bars rows={Object.entries(d.prices).map(([k, v]) => ({ label: cap(k), value: v as number }))} fmt={(v) => v.toFixed(2)} /></Card>
        <Card title="Markets & credit"><Bars rows={[{ label: 'Confidence', value: d.market.confidence }, { label: 'Credit availability', value: d.market.credit }, { label: 'Venture appetite', value: d.market.vc }, { label: 'Energy grid load', value: d.infra.energyUse }, { label: 'Infrastructure quality', value: d.infra.quality }]} fmt={(v) => v.toFixed(2)} /></Card>
        <Card title="Household finances"><Bars rows={[{ label: 'Median household income', value: m.medianIncome }, { label: 'Avg household wealth', value: m.avgHouseholdWealth }, { label: 'Average wage', value: m.avgWage }, { label: 'Minimum wage', value: m.minWage }]} fmt={fmtMoney} /><p className="dim sm">Purchasing power (income ÷ essentials): median {m.purchasingPower?.toFixed(2)}× · low-income {m.purchasingPowerLow?.toFixed(2)}× · {fmtPct(m.povertyRate)} of households cannot cover essentials</p></Card>
        <Card title="Sectors" wide><Tbl head={['Sector', 'Firms', 'Jobs', 'Capacity used', 'Price', 'Wage index', 'Productivity', 'Automation']} rows={d.sectors.map((s: any) => row(undefined, cap(s.sector), s.firms, s.jobs, fmtPct(s.util, 0), s.price.toFixed(2), s.wageIdx.toFixed(2), s.prod.toFixed(2), fmtPct(s.autom, 0)))} /></Card>
      </>}
      {tab === 'Population' && <>
        <Card title="Population"><Line data={H('population')} fmt={(v) => Math.round(v).toLocaleString('en-US')} /></Card><Card title="Age structure"><Bars rows={d.population.ages} /></Card><Card title="Activity"><Bars rows={d.population.status.map((s: any) => ({ label: cap(s.label), value: s.value }))} /></Card>
        <Card title="Since founding"><Bars rows={[{ label: 'Births', value: d.population.births }, { label: 'Deaths', value: d.population.deaths }, { label: 'Immigrated', value: d.population.migIn }, { label: 'Emigrated', value: d.population.migOut }]} /></Card>
        <Card title="Inequality (Gini)"><Line data={H('gini')} color="#f472b6" /></Card><Card title="Average household wealth"><Line data={H('avgHouseholdWealth')} fmt={fmtMoney} /></Card>
        <Card title="Income groups" wide><Tbl head={['Group', 'Adults', 'Avg net worth', 'Avg income', 'Trust in gov', 'Happiness']} rows={d.population.tiers.map((t: any) => row(undefined, t.label, t.people, fmtMoney(t.avgWealth), fmtMoney(t.avgIncome), fmtPct(t.trust, 0), fmtPct(t.happy, 0)))} /></Card>
        <Card title="Wealthiest citizens" wide><Tbl head={['Name', 'Role', 'Net worth']} rows={d.richest.map((c: any) => row(c.ref, c.name, c.role, fmtMoney(c.wealth)))} /></Card>
        <Card title="Neighbourhoods" wide><Tbl head={['District', 'Type', 'Residents', 'Unemployment', 'Avg income', 'Rent', 'Crime', 'Happiness']} rows={d.districts.map((x: any) => row(x.ref, x.name, x.kind, x.pop, fmtPct(x.unemp), fmtMoney(x.income), x.rent.toFixed(2), fmtPct(x.crime, 0), fmtPct(x.happy, 0)))} /></Card>
      </>}
      {tab === 'Businesses' && <>
        <Card title="Private businesses"><Line data={H('businesses')} fmt={(v) => v.toFixed(0)} /></Card><Card title="Startups"><Line data={H('startups')} fmt={(v) => v.toFixed(0)} color="#60a5fa" /></Card><Card title="Startup funding"><Line data={H('startupFunding')} fmt={fmtMoney} color="#a78bfa" /></Card>
        <Card title="Corporate profits (annualised)"><Line data={H('corporateProfits')} fmt={fmtMoney} /></Card><Card title="Open positions"><Line data={H('openings')} fmt={(v) => v.toFixed(0)} color="#fb923c" /></Card>
        <Card title="Organisations by type"><Bars rows={d.orgTypes.map((t: any) => ({ label: `${t.label} (${t.emp} staff)`, value: t.n }))} /></Card>
        <Card title="Largest employers" wide><Tbl head={['Organisation', 'Type', 'Sector', 'Staff', 'Revenue/mo', 'Profit/mo', 'Share price']} rows={d.topOrgs.map((o: any) => row(o.ref, o.name, o.type, o.sector, o.employees, fmtMoney(o.revenue), fmtMoney(o.profit), o.price ? o.price.toFixed(2) : '—'))} /></Card>
        <Card title="Recent closures" wide>{d.recentClosures.length ? <Tbl head={['Organisation', 'Closed', 'Why']} rows={d.recentClosures.map((o: any) => row(o.ref, o.name, o.date, o.reason))} /> : <p className="dim">No closures yet.</p>}</Card>
      </>}
      {tab === 'Politics' && <>
        <Card title="Government"><p>Governing party: <b>{d.gov.party}</b></p><p>Mayor: {d.gov.leader ? <a className="ref" onClick={() => go(d.gov.leader.ref)}>{d.gov.leader.name}</a> : '—'}</p><p>Next election: {d.gov.nextElection}</p><Bars rows={d.gov.parties.map((p: any) => ({ label: p.name, value: p.support }))} fmt={(v) => fmtPct(v, 0)} /></Card>
        <Card title="Approval"><Line data={H('approval')} fmt={(v) => fmtPct(v, 0)} /></Card><Card title="Public trust"><Line data={H('publicTrust')} fmt={(v) => fmtPct(v, 0)} color="#60a5fa" /></Card>
        <Card title="Budget balance (annualised)"><Line data={H('govBalance')} fmt={fmtMoney} color="#f472b6" /><p className="dim sm">Public debt {fmtMoney(d.gov.debt)}</p></Card>
        <Card title="Monthly revenue"><Bars rows={Object.entries(d.gov.rev).map(([k, v]) => ({ label: cap(k), value: v as number }))} fmt={fmtMoney} /></Card><Card title="Monthly spending"><Bars rows={Object.entries(d.gov.out).filter(([, v]) => (v as number) > 0).map(([k, v]) => ({ label: cap(k), value: v as number }))} fmt={fmtMoney} /></Card>
        <Card title="Policy settings" wide><div className="policy">{Object.entries(d.policy).map(([k, v]) => <span key={k} className={d.gov.locks.includes(k) ? 'locked' : ''} title={d.gov.locks.includes(k) ? 'Set by GOD MODE decree — locked' : ''}>{cap(k)} <b>{(v as number) > 5 ? fmtMoney(v as number) : /Tax|Rate|Subsidy|Benefit|rentControl|restrictions/.test(k) && k !== 'childBenefit' ? fmtPct(v as number) : `${(v as number).toFixed(2)}×`}</b></span>)}</div></Card>
        <Card title="Autonomous government decisions" wide>{d.gov.actions.length ? d.gov.actions.map((a: any, i: number) => <div key={i} className="mem"><time>{a.date}</time>{a.text}</div>) : <p className="dim">No decisions yet.</p>}</Card>
      </>}
      {tab === 'Healthcare' && <>
        <Card title="Population health"><Line data={H('health')} fmt={(v) => fmtPct(v, 0)} /></Card><Card title="Currently infected"><Line data={H('infected')} fmt={(v) => v.toFixed(0)} color="#ef4444" /></Card><Card title="Hospital load"><Line data={H('hospitalLoad')} fmt={(v) => fmtPct(v, 0)} color="#fb923c" /></Card>
        <Card title="Capacity"><Bars rows={[{ label: 'Hospital beds', value: d.health.beds }, { label: 'Occupied', value: d.health.occupied }]} /><p className="dim sm">Care quality {d.health.careQuality.toFixed(2)} · public coverage {fmtPct(d.policy.healthSubsidy, 0)}</p></Card>
        <Card title="Hospitals" wide><Tbl head={['Hospital', 'Staff', 'Funding level']} rows={d.health.hospitals.map((h: any) => row(h.ref, h.name, h.staff, fmtPct(h.util, 0)))} /></Card>
        <Card title="Diseases (fictional)" wide>{d.health.diseases.length ? <Tbl head={['Disease', 'Started', 'Status', 'Total infected', 'Deaths']} rows={d.health.diseases.map((x: any) => row(undefined, x.name, x.startedDate, x.active ? 'Active' : 'Ended', x.totalInfected, x.deaths))} /> : <p className="dim">No outbreaks recorded.</p>}</Card>
      </>}
      {tab === 'Education' && <>
        <Card title="University students"><Line data={H('students')} data2={H('uniCapacity')} fmt={(v) => v.toFixed(0)} /><p className="dim sm">Orange = capacity</p></Card><Card title="Average education level"><Line data={H('avgEducation')} /></Card><Card title="School quality"><Line data={H('schoolQuality')} color="#60a5fa" /></Card>
        <Card title="Access"><Bars rows={[{ label: 'Tuition / month', value: d.tuition * d.prices.education }, { label: 'Paid by households', value: d.tuition * d.prices.education * (1 - d.policy.tuitionSubsidy) }]} fmt={fmtMoney} /><p className="dim sm">Last intake: {d.edu.applicants} applicants, {d.edu.rejected} turned away</p></Card>
        <Card title="Adult education levels"><Bars rows={d.edu.eduLevels} /></Card>
        <Card title="Universities" wide><Tbl head={['University', 'Staff', 'Students']} rows={d.edu.universities.map((u: any) => row(u.ref, u.name, u.staff, u.students))} /></Card>
      </>}
      {tab === 'Technology' && <>
        <Card title="Technology level"><Line data={H('techLevel')} /></Card><Card title="Research output"><Line data={H('researchOutput')} fmt={(v) => v.toFixed(0)} color="#60a5fa" /></Card><Card title="Average automation"><Line data={H('automation')} fmt={(v) => fmtPct(v, 0)} color="#a78bfa" /></Card>
        <Card title="Next discovery"><Bars rows={[{ label: 'Research progress', value: d.tech.progress }, { label: 'Discovery threshold', value: d.tech.nextAt }]} fmt={(v) => v.toFixed(0)} /></Card>
        <Card title="Technologies" wide>{d.tech.items.length ? <Tbl head={['Technology', 'Field', 'Emerged', 'Adoption', 'Origin']} rows={d.tech.items.map((t: any) => row(undefined, t.name, t.domain, t.emergedDate, fmtPct(t.adoption, 0), t.origin))} /> : <p className="dim">No breakthroughs yet — research is accumulating.</p>}</Card>
      </>}
      {tab === 'Social' && <>
        <Card title="Social stability"><Line data={H('stability')} fmt={(v) => fmtPct(v, 0)} /></Card><Card title="Happiness"><Line data={H('happiness')} fmt={(v) => fmtPct(v, 0)} color="#facc15" /></Card><Card title="Adults protesting"><Line data={H('protestShare')} fmt={fmtPct} color="#e879f9" /></Card>
        <Card title="Crime"><Line data={H('crime')} fmt={(v) => fmtPct(v, 0)} color="#ef4444" /></Card><Card title="Households in poverty"><Line data={H('povertyRate')} fmt={fmtPct} color="#fb923c" /></Card><Card title="Rent index"><Line data={H('avgRent')} color="#60a5fa" /></Card>
        <Card title="Housing"><Bars rows={[{ label: 'Vacancy', value: d.housing.vacancy }, { label: 'Homeless households', value: m.homelessRate }]} fmt={fmtPct} /><p className="dim sm">Property index {d.housing.propertyIdx.toFixed(2)} · usable stock {fmtPct(d.housing.supplyMult, 0)}</p></Card>
        {d.shocks.length > 0 && <Card title="External shocks">{d.shocks.map((s: any) => <p key={s.name}>{cap(s.name)} — until {s.until}</p>)}</Card>}
      </>}
    </div>}
  </div></div>);
}

const CMP: [string, string, (v: number) => string][] = [['gdp', 'Economic output', fmtMoney], ['unemployment', 'Unemployment', fmtPct], ['inflation', 'Inflation', fmtPct], ['businesses', 'Businesses surviving', (v) => v.toFixed(0)], ['startups', 'Startups', (v) => v.toFixed(0)], ['avgHouseholdWealth', 'Avg household wealth', fmtMoney], ['medianIncome', 'Median household income', fmtMoney], ['publicTrust', 'Public trust', fmtPct], ['stability', 'Stability', fmtPct], ['povertyRate', 'Poverty', fmtPct], ['marketIndex', 'Market index', (v) => v.toFixed(0)], ['population', 'Population', (v) => v.toFixed(0)], ['happiness', 'Happiness', fmtPct], ['students', 'Students', (v) => v.toFixed(0)], ['govBalance', 'Gov balance', fmtMoney], ['techLevel', 'Tech level', (v) => v.toFixed(2)]];

export function Timelines() {
  const set = useStore((s) => s.set), v = useStore((s) => s.timelinesV), tick = useStore((s) => s.status?.tick);
  const [d, setD] = useState<any>(null), [a, setA] = useState(''), [b, setB] = useState(''), [cmp, setCmp] = useState<any>(null), [err, setErr] = useState('');
  const load = () => api('/timelines').then((x) => { setD(x); setA((p) => p || x.active); setB((p) => p || x.timelines.find((t: any) => t.id !== x.active)?.id || ''); }).catch(() => {});
  useEffect(() => { load(); }, [v]);
  useEffect(() => { if (a && b && a !== b) api(`/compare?a=${a}&b=${b}`).then(setCmp).catch(() => setCmp(null)); else setCmp(null); }, [a, b, v]);
  const act = async (fn: () => Promise<any>) => { setErr(''); try { await fn(); await load(); } catch (e: any) { setErr(e.message); } };
  const day = (t: number) => `day ${t}`;
  return (<div className="modal" onClick={() => set({ panel: null })}><div className="sheet" onClick={(e) => e.stopPropagation()}>
    <div className="sheethead"><h3>Timelines, snapshots & alternate realities</h3><button className="x" onClick={() => set({ panel: null })}>×</button></div>
    {err && <p className="alert">{err}</p>}
    {!d ? <p className="dim">Loading…</p> : <div className="cards">
      <div className="card wide"><h4>Timelines</h4>
        <table className="tbl"><thead><tr><th>Name</th><th>Kind</th><th>Time</th><th>Unemployment</th><th>Output</th><th /></tr></thead><tbody>{d.timelines.map((t: any) => <tr key={t.id} className={t.id === d.active ? 'active' : ''}><td><b>{t.name}</b>{t.note && <div className="dim sm">{t.note}</div>}</td><td>{t.kind}</td><td>{day(t.id === d.active ? tick : t.tick)}</td><td>{fmtPct(t.metrics.unemployment)}</td><td>{fmtMoney(t.metrics.gdp)}</td><td className="r">{t.id === d.active ? <span className="badge direct">ACTIVE</span> : <><button className="btn sm" onClick={() => act(() => api(`/timelines/${t.id}/switch`, {}))}>Switch to</button>{t.id !== 'main' && <button className="btn sm" onClick={() => act(() => api(`/timelines/${t.id}`, undefined, 'DELETE'))}>Delete</button>}</>}</td></tr>)}</tbody></table>
        <div className="row"><button className="btn" onClick={() => { const n = prompt('Name for the new branch', 'Alternate timeline'); if (n) act(() => api('/timelines/branch', { name: n, switch: false })); }}>⑂ Branch from the live world</button><button className="btn" onClick={() => act(() => api('/snapshots', { label: prompt('Snapshot label', 'Manual snapshot') || 'Manual snapshot' }))}>⦿ Save snapshot</button></div>
      </div>
      <div className="card wide"><h4>Snapshots (complete saved world states)</h4>
        <div className="snaps"><table className="tbl"><thead><tr><th>Label</th><th>Timeline</th><th>Time</th><th>Type</th><th /></tr></thead><tbody>{[...d.snapshots].reverse().map((s: any) => <tr key={s.id}><td>{s.label}</td><td>{d.timelines.find((t: any) => t.id === s.timeline)?.name || s.timeline}</td><td>{day(s.tick)}</td><td>{s.kind === 'pre' ? 'before intervention' : s.kind}</td><td className="r"><button className="btn sm" title="Restore the actual world state" onClick={() => confirm(`Rewind the world to “${s.label}”?`) && act(() => api(`/snapshots/${s.id}/restore`, {}))}>↶ Rewind here</button><button className="btn sm" onClick={() => { const n = prompt('Name for the branch', `Branch from ${s.label}`); if (n) act(() => api(`/snapshots/${s.id}/branch`, { name: n, switch: false })); }}>⑂ Branch</button></td></tr>)}</tbody></table></div>
      </div>
      <div className="card wide"><h4>Compare timelines</h4>
        <div className="row"><select value={a} onChange={(e) => setA(e.target.value)}>{d.timelines.map((t: any) => <option key={t.id} value={t.id}>{t.name}</option>)}</select><span className="dim">vs</span><select value={b} onChange={(e) => setB(e.target.value)}><option value="">— choose —</option>{d.timelines.map((t: any) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></div>
        {cmp ? <><table className="tbl"><thead><tr><th>Indicator</th><th style={{ color: '#56e0c2' }}>{cmp.a.name} ({day(cmp.a.tick)})</th><th style={{ color: '#f59e0b' }}>{cmp.b.name} ({day(cmp.b.tick)})</th><th>Difference</th></tr></thead><tbody>{CMP.map(([k, l, f]) => { const x = cmp.a.metrics[k] ?? 0, y = cmp.b.metrics[k] ?? 0, pctU = f === fmtPct; return <tr key={k}><td>{l}</td><td>{f(x)}</td><td>{f(y)}</td><td className={Math.abs(y - x) < 1e-9 ? '' : y > x ? 'up' : 'down'}>{pctU ? `${((y - x) * 100).toFixed(1)} pts` : Math.abs(x) > 1e-9 ? `${(((y - x) / Math.abs(x)) * 100).toFixed(1)}%` : '—'}</td></tr>; })}</tbody></table>
          <div className="cmpcharts">{[['unemployment', 'Unemployment', fmtPct], ['gdp', 'Output', fmtMoney], ['publicTrust', 'Public trust', fmtPct], ['businesses', 'Businesses', (x: number) => x.toFixed(0)]].map(([k, l, f]: any) => <div key={k}><h5>{l}</h5><Line data={cmp.a.history.s[k] || []} data2={cmp.b.history.s[k] || []} fmt={f} /></div>)}</div></> : <p className="dim">{d.timelines.length < 2 ? 'Create a branch or ask GOD MODE a “what if…” question to get a second timeline.' : 'Choose two different timelines.'}</p>}
      </div>
    </div>}
  </div></div>);
}
