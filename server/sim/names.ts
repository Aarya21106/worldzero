// Synthetic name pools. Every person and organisation in WORLDZERO is fictional.
import type { World, OrgType, Sector } from './types';
import { pick, rand } from './rng';

const F = ['Amara', 'Lena', 'Sofia', 'Yuki', 'Priya', 'Zara', 'Mei', 'Ines', 'Nadia', 'Freya', 'Aiko', 'Leila', 'Chloe', 'Imani', 'Rosa', 'Tess', 'Noor', 'Elena', 'Kira', 'Maya', 'Anya', 'Dalia', 'Esme', 'Farah', 'Greta', 'Hana', 'Isla', 'Jada', 'Kavya', 'Lucia', 'Mira', 'Nia', 'Oona', 'Petra', 'Rhea', 'Sana', 'Talia', 'Uma', 'Vera', 'Wren', 'Xenia', 'Yara', 'Zofia', 'Bianca', 'Carmen', 'Delphine', 'Ebele', 'Fatima', 'Giulia', 'Hoa', 'Ingrid', 'Jun', 'Keiko', 'Linnea', 'Marisol', 'Nkechi', 'Odette', 'Paloma', 'Renata', 'Siobhan'];
const M = ['Arjun', 'Mateo', 'Kenji', 'Omar', 'Lukas', 'Tariq', 'Dmitri', 'Kwame', 'Felix', 'Ravi', 'Hugo', 'Idris', 'Jonas', 'Kai', 'Leon', 'Marco', 'Nico', 'Oskar', 'Pavel', 'Quentin', 'Rafael', 'Soren', 'Theo', 'Uri', 'Viktor', 'Wei', 'Xavier', 'Yusuf', 'Zane', 'Anders', 'Bashir', 'Cyrus', 'Dario', 'Emeka', 'Farid', 'Gael', 'Hiro', 'Ivo', 'Jamal', 'Kofi', 'Lior', 'Milan', 'Naveen', 'Otto', 'Piotr', 'Rohan', 'Stefan', 'Tomas', 'Ulrich', 'Vikram', 'Wyatt', 'Yohan', 'Zoran', 'Andrei', 'Bao', 'Caspian', 'Desmond', 'Elio', 'Finn', 'Goran'];
const S = ['Okafor', 'Lindqvist', 'Tanaka', 'Moreau', 'Haddad', 'Novak', 'Castillo', 'Rao', 'Bergstrom', 'Adeyemi', 'Kowalski', 'Nakamura', 'Ferreira', 'Aziz', 'Volkov', 'Mensah', 'Schmidt', 'Iyer', 'Dubois', 'Rahman', 'Petrov', 'Osei', 'Larsen', 'Sato', 'Mendes', 'Khoury', 'Horvat', 'Vargas', 'Menon', 'Nyberg', 'Abara', 'Wojcik', 'Kimura', 'Costa', 'Farouk', 'Sokolov', 'Boateng', 'Keller', 'Pillai', 'Lefevre', 'Chowdhury', 'Dragan', 'Asante', 'Holm', 'Ito', 'Ribeiro', 'Nasser', 'Kovac', 'Reyes', 'Varma', 'Ekström', 'Onyeka', 'Zielinski', 'Mori', 'Teixeira', 'Saleh', 'Orlov', 'Darko', 'Weiss', 'Nair', 'Girard', 'Hossain', 'Babic', 'Owusu', 'Dahl', 'Fujita', 'Pinto', 'Mansour', 'Jovanovic', 'Salazar', 'Desai', 'Halvorsen', 'Eze', 'Mazur', 'Hayashi', 'Cardoso', 'Qasim', 'Ivanov', 'Agyeman', 'Brandt', 'Kapoor', 'Marchand', 'Sarkar', 'Vukovic', 'Achebe', 'Strand', 'Ueda', 'Barros', 'Hamdan', 'Popov', 'Navarro', 'Bose', 'Lund', 'Chukwu', 'Sikora', 'Arai', 'Lobo', 'Yilmaz', 'Markovic', 'Quist'];

export function personName(w: World, sex: 'F' | 'M', surname?: string): string {
  return `${pick(w, sex === 'F' ? F : M)} ${surname || pick(w, S)}`;
}
export const surnameOf = (name: string) => name.split(' ').slice(1).join(' ');
export const randomSurname = (w: World) => pick(w, S);

const PRE = ['Axiom', 'Helix', 'Meridian', 'Nova', 'Vertex', 'Lumen', 'Orbit', 'Kestrel', 'Zenith', 'Cobalt', 'Aurora', 'Pinnacle', 'Quanta', 'Solace', 'Tessera', 'Umbra', 'Verity', 'Halcyon', 'Ember', 'Fathom', 'Glacier', 'Ionic', 'Juniper', 'Krona', 'Lattice', 'Mosaic', 'Nimbus', 'Onyx', 'Prism', 'Quill', 'Raven', 'Sable', 'Tidal', 'Unity', 'Vanta', 'Willow', 'Xylo', 'Yonder', 'Zephyr', 'Atlas', 'Beacon', 'Cinder', 'Drift', 'Echo', 'Flint', 'Garnet', 'Harbor', 'Indigo', 'Jasper', 'Kite', 'Alder', 'Basalt', 'Cascade', 'Delta', 'Elara', 'Falcon', 'Granite', 'Horizon', 'Iris', 'Jade', 'Keystone', 'Lyra', 'Monarch', 'Northwind', 'Opal', 'Pioneer', 'Quartz', 'Redwood', 'Summit', 'Tundra', 'Ursa', 'Vector', 'Westbrook', 'Yarrow', 'Zinnia', 'Amber', 'Bluebird', 'Copper', 'Dune', 'Evergreen', 'Fable', 'Golden', 'Hearth', 'Ivy', 'Juno', 'Kindred', 'Lantern', 'Meadow', 'Nectar', 'Orchard', 'Pebble', 'Ripple', 'Saffron', 'Thistle', 'Umber', 'Velvet', 'Wildflower', 'Arbor', 'Brightwater', 'Crescent'];
const SUF: Record<Sector, string[]> = {
  tech: ['Systems', 'Labs', 'AI', 'Robotics', 'Cloud', 'Software', 'Dynamics', 'Compute'], manufacturing: ['Works', 'Industries', 'Fabrication', 'Motors', 'Materials'], retail: ['Mart', 'Outfitters', 'Goods', 'Emporium', 'Stores'], food: ['Foods', 'Bakery', 'Kitchen', 'Grocers', 'Farms', 'Bistro', 'Cafe'], finance: ['Capital', 'Financial', 'Trust', 'Holdings'], healthcare: ['Clinic', 'Health', 'Biotech', 'Care', 'Pharma'], education: ['Academy', 'Learning'], construction: ['Builders', 'Construction', 'Developments'], energy: ['Energy', 'Power', 'Grid'], media: ['Media', 'Dispatch', 'Broadcast', 'Herald'], services: ['Services', 'Studio', 'Consulting', 'Salon', 'Logistics', 'Repairs', 'Travel'], government: ['Office'], research: ['Institute', 'Research'],
};
const used = (w: World, n: string) => w.orgs.some((o) => o.name === n);

export function orgName(w: World, type: OrgType, sector: Sector, ownerSurname?: string): string {
  for (let i = 0; i < 30; i++) {
    let n: string;
    const p = pick(w, PRE);
    switch (type) {
      case 'bank': n = `${p} Bank`; break;
      case 'investment_firm': n = `${p} ${pick(w, ['Ventures', 'Capital Partners', 'Investments', 'Equity'])}`; break;
      case 'university': n = `${p} University`; break;
      case 'school': n = `${p} School`; break;
      case 'hospital': n = `${p} ${pick(w, ['General Hospital', 'Memorial Hospital', 'Medical Center'])}`; break;
      case 'research_lab': n = `${p} ${pick(w, ['Research Institute', 'Laboratory', 'Science Center'])}`; break;
      case 'media': n = `The ${p} ${pick(w, ['Herald', 'Dispatch', 'Broadcast Network', 'Chronicle'])}`; break;
      case 'nonprofit': n = `${p} ${pick(w, ['Foundation', 'Community Trust', 'Relief Network', 'Alliance'])}`; break;
      case 'small_business': n = ownerSurname && rand(w) < 0.45 ? `${ownerSurname}'s ${pick(w, SUF[sector])}` : `${p} ${pick(w, SUF[sector])}`; break;
      default: n = `${p} ${pick(w, SUF[sector])}`;
    }
    if (!used(w, n)) return n;
  }
  return `${pick(w, PRE)} ${pick(w, SUF[sector])} ${w.orgs.length}`;
}

export const GOV_DEPTS = ['City Council', 'Treasury Department', 'Public Health Authority', 'Education Board', 'Police Service', 'Housing & Infrastructure Agency', 'Social Welfare Office', 'Energy & Environment Agency'];
export const DISEASE_NAMES = ['Veridian Flu', 'Ashlung Fever', 'Korvath Syndrome', 'Blue Meridian Virus', 'Sable Pox', 'Halden Cough'];
export const TECH_NAMES: Record<string, string[]> = {
  ai: ['Cognitive Automation Engines', 'Autonomous Reasoning Systems', 'Synthetic Workforce AI'],
  energy: ['Compact Fusion Cells', 'Solid-State Grid Storage', 'Ambient Solar Film'],
  biotech: ['Programmable Cell Therapy', 'Rapid Gene Diagnostics', 'Regenerative Tissue Printing'],
  materials: ['Self-Healing Composites', 'Room-Temperature Superconductors', 'Carbon Lattice Fabrication'],
  fintech: ['Instant Settlement Ledgers', 'Algorithmic Credit Networks'],
  agri: ['Vertical Protein Farms', 'Precision Crop Synthesis'],
  robotics: ['General-Purpose Service Robots', 'Swarm Construction Robotics'],
};
