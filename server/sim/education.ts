// Education Simulation Engine: schools, university admissions under capacity, tuition,
// graduation and skill formation feeding the labour market.
import type { World, Citizen } from './types';
import { clamp, DAYS_PER_MONTH } from './types';
import { rand, pick } from './rng';
import { isActive, emit, count, remember, separate, pct } from './world';

export function monthlyEducation(w: World) {
  const E = w.edu;
  // school quality from staffing and funding
  let teachers = 0, pupils = 0, sUtil = 0, ns = 0, uniStaff = 0, uUtil = 0, nu = 0;
  const unis = [];
  for (const o of w.orgs) {
    if (!o.alive) continue;
    if (o.type === 'school') { teachers += o.employees.length; sUtil += clamp(o.util / 0.95, 0.3, 1.2); ns++; }
    if (o.type === 'university') { uniStaff += o.employees.length; uUtil += clamp(o.util / 0.95, 0.3, 1.3); nu++; unis.push(o); }
  }
  let enrolled = 0, graduates = 0;
  const applicants: Citizen[] = [];
  for (const c of w.citizens) {
    if (!isActive(c)) continue;
    if (c.age >= 6 && c.age < 18) { pupils++; c.skill = clamp(c.skill + 0.0016 * E.schoolQuality, 0, 0.5); }
    else if (c.status === 'student') {
      enrolled++;
      c.skill = clamp(c.skill + 0.004, 0, 1);
      if (--c.studyLeft <= 0) {
        c.edu = Math.min(4, Math.max(3, c.edu + 1)); c.skill = clamp(c.skill + 0.08, 0, 1);
        if (c.edu === 3 && rand(w) < 0.1 * (0.5 + c.traits.ambition)) { c.studyLeft = 24; c.role = 'Postgraduate student'; }
        else { c.status = 'unemployed'; c.role = 'Graduate job seeker'; c.school = -1; c.seeking = true; c.goal = 'find_job'; c.wage = 0; graduates++; enrolled--; remember(w, c, 'graduated', c.edu >= 4 ? 'Completed a postgraduate degree' : 'Graduated from university', 0.8); }
      }
    } else if (c.wantsUni && c.age >= 18) applicants.push(c);
    else if ((c.status === 'employed' || c.status === 'owner') && c.skill < 0.95) c.skill += 0.0008;
  }
  E.schoolQuality = clamp((teachers / Math.max(1, pupils)) / (1 / 5.5), 0.3, 1.4) * (ns ? sUtil / ns : 1);
  if (!w.mods['edu.ratio']) w.mods['edu.ratio'] = Math.max(1, enrolled + graduates) / Math.max(1, uniStaff * 0.88);
  E.capacity = Math.round(uniStaff * w.mods['edu.ratio']);
  E.enrolled = enrolled; E.graduates = graduates; count(w, 'edu.graduates', graduates);
  // quarterly intake
  if (Math.floor(w.tick / DAYS_PER_MONTH) % 3 === 0 && unis.length) {
    applicants.sort((a, b) => b.skill - a.skill);
    const free = Math.max(0, E.capacity - enrolled);
    let admitted = 0;
    for (const c of applicants) {
      if (admitted >= free) break;
      if (c.employer >= 0) separate(w, w.orgs[c.employer], c, 'resign');
      c.status = 'student'; c.role = 'University student'; c.school = pick(w, unis).id; c.studyLeft = 42; c.wantsUni = false; c.seeking = false; c.unempMonths = 0;
      admitted++; count(w, 'edu.admitted'); count(w, `edu.admitted.t${c.tier}`);
      remember(w, c, 'admitted', `Admitted to ${w.orgs[c.school].name}`, 0.7);
    }
    const rejected = applicants.length - admitted;
    for (let i = admitted; i < applicants.length; i++) { const c = applicants[i]; if (rand(w) < 0.4) c.wantsUni = false; remember(w, c, 'rejected', 'University had no place for me this intake', -0.4); }
    E.applicants = applicants.length; E.rejected = rejected; E.enrolled = enrolled + admitted;
    count(w, 'edu.applicants', applicants.length); count(w, 'edu.rejected', rejected);
    if (rejected > Math.max(20 * (w.mods.scale ?? 1), E.capacity * 0.05)) emit(w, { cat: 'education', type: 'capacity', title: `Universities turn away ${rejected} applicants`, detail: `${applicants.length} applied for ${free} free places (capacity ${E.capacity}).`, sev: 0.4, why: `applications exceed staffed capacity; tuition subsidy is ${pct(w.policy.tuitionSubsidy, 0)}`, district: w.districts.find((d) => d.kind === 'university')!.id });
    // universities respond to demand by opening teaching posts
    if (rejected > 0) for (const o of unis) if (o.cash > -o.expenses && o.openings < 4) o.openings += Math.min(4, 1 + Math.round(rejected / 40));
  }
}
