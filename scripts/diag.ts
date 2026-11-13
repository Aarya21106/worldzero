import { generateWorld } from '../server/sim/generate';
import { tick } from '../server/sim/tick';
import { isPrivateFirm, isActive } from '../server/sim/world';

const w = generateWorld();
const k = (n: number) => (n / 1e3).toFixed(0) + 'k';
function row() {
  let wages = 0, rev = 0, prof = 0, loss = 0, n = 0, cash = 0, emp = 0, open = 0, pubW = 0, pubRev = 0, pubN = 0;
  for (const o of w.orgs) { if (!o.alive) continue; if (isPrivateFirm(o)) { wages += o.wageBill; rev += o.revenue; prof += o.profit; n++; if (o.profit < 0) loss++; cash += o.cash; emp += o.employees.length; open += o.openings; } else { pubW += o.wageBill; pubRev += o.revenue; pubN += o.employees.length; } }
  let inc = 0, sav = 0, lf = 0, un = 0, stud = 0, mode = 0, na = 0;
  for (const c of w.citizens) { if (!isActive(c) || c.age < 18) continue; inc += c.income; sav += c.savings; mode += c.spendMode; na++; if (c.status === 'unemployed') un++; if (c.status === 'employed' || c.status === 'owner') lf++; if (c.status === 'student') stud++; }
  const ex = Object.values(w.sectors).reduce((s, x) => s + x.exports, 0);
  console.log(`t${w.tick} priv: n${n} emp${emp} rev ${k(rev)} wages ${k(wages)} prof ${k(prof)} loss# ${loss} cash ${k(cash)} open ${open} | pub: emp${pubN} rev ${k(pubRev)} wages ${k(pubW)} | hh inc ${k(inc)} sav ${(sav / 1e6).toFixed(1)}M mode ${(mode / na).toFixed(2)} emp ${lf} un ${un} stu ${stud} | gov rev ${k(w.gov.revenue)} sp ${k(w.gov.spending)} | b2b ${k(w.mods['flow.b2b'])} inv ${k(w.mods['flow.invest'])} out ${k(w.mods['flow.output'])} exp0 ${k(ex)} cpi ${w.cpi.toFixed(3)} conf ${w.market.confidence.toFixed(2)}`);
}
row();
for (let i = 0; i < 720; i++) { tick(w); if (w.tick % 60 === 0) row(); }
console.log(Object.entries(w.sectors).map(([s, x]) => `${s} u${x.util.toFixed(2)} p${x.price.toFixed(2)} dem ${k(x.demand)} cap ${k(x.capacity)}`).join('\n'));
