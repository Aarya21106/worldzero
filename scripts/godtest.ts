import { Runtime } from '../server/runtime';
const rt = new Runtime(':memory:').init();
const cmds = process.argv.slice(2);
for (const c of cmds) {
  const r = await rt.god(c);
  console.log(`\n> ${c}\n[${r.mode}/${r.status}/${r.source}] ${r.horizonDays}d ${r.ms}ms tl=${r.timeline?.name || '-'}`);
  for (const o of r.operations) console.log('  op', o.ok ? '✓' : '✗', o.summary, o.error || '');
  for (const a of r.assumptions) console.log('  assume:', a);
  for (const u of r.unsupported) console.log('  UNSUPPORTED:', u.text, '—', u.reason);
  console.log('  ', r.narrative);
  console.log('  deltas:', r.deltas.slice(0, 8).map((d) => `${d.key} ${(+d.before.toPrecision(4))}${d.control !== undefined ? `|c ${+d.control.toPrecision(4)}` : ''}→${+d.after.toPrecision(4)}`).join(', '));
  console.log('  groups:', JSON.stringify(r.groups.slice(0, 3)));
  console.log('  events:', r.events.slice(0, 5).map((e) => e.title).join(' | '));
}
