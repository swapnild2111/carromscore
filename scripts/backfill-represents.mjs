/**
 * Backfills the `represents` field for TDCA tournament players.
 *
 * Source: Main_TDCA_File.xlsx — each tab (excluding FIXTURE, MEN SINGLES,
 * WOMEN SINGLES) is a club name; all players listed in that tab belong to
 * that club.
 *
 * Strategy: normalise both sides (lowercase, collapse spaces, strip
 * punctuation) for comparison. If a player name normalises to an exact
 * match, patch their /players/{id} record with represents = <club>.
 * If a normalised name matches multiple Firebase records, skip and warn.
 * Print a final report of unmatched names for manual follow-up.
 *
 * Safety: uses PATCH (merge) — only writes the `represents` field.
 *         Skips players who already have the correct represents value.
 *
 * Run: node scripts/backfill-represents.mjs [--dry-run]
 */

import { execSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const DRY_RUN = process.argv.includes('--dry-run');
const DB_URL = 'https://carrom-score-default-rtdb.firebaseio.com';

// ---------------------------------------------------------------------------
// Club → player list extracted from Main_TDCA_File.xlsx
// ---------------------------------------------------------------------------
const CLUB_PLAYERS = {
  'Breaktime': [
    'Ajinkya Shirsale', 'Apoorva Shirsale', 'Hemant Bale', 'Ashok Athave', 'Aniket Mishra',
  ],
  'Bhiwandi': [
    'Zaid Ahmad', 'Javed Ansari', 'Sameer Ansari', 'Abuzar Ansari', 'Ismail Ansari',
  ],
  'Anantam': [
    'Jayesh Sethia', 'Satish Nair', 'Rakesh Bhoir', 'Sunil Sawant', 'Indrapal Chauhan',
    'Ashok Parde', 'Arnav Mhatre', 'Nitin Rahate', 'Rajkumar Darade', 'Vighnesh Ganpathy',
    'Aniket Mhatre', 'Rejith Rajendra', 'Mahesh Bhandari', 'Kamalesh Kadam',
    'Vijay Mamunkar', 'Ritesh Buva', 'Hemant Shinde', 'Vishwanath Jadhav', 'Vinay kamble',
  ],
  'CCA': [
    'Ashok Raicha', 'Jayesh Buddhadev', 'Mukesh Dey', 'Harsh Shah', 'Mohd Oves',
    'Ibrahim Ali', 'Ashok Gada', 'Pankaj Pawar',
  ],
  'Carrom Katta': [
    'Aditya Mali', 'Satish Bhosale', 'Milind Panchal', 'Dayanand Chouthe', 'Gautam Sonawane',
    'Ashok Ahire', 'Amol Wategaonkar', 'Rajesh Kamble', 'Pramod Walavalkar', 'Saras Prabhu',
    'Arun Kumar', 'Shubham Sawant', 'Shashikant Shelar', 'Sandesh Jadhav', 'Satish Salvi',
    'Sujit Pednekar', 'Harshad Mahajan', 'Faizal Sayyed', 'Sushant Jadhav',
  ],
  'Vishwa Carrom': [
    'Chetan Jadhav', 'Abhishek Bharambe', 'Pramod Shelke', 'Manoj Parikh', 'Fardeen Shaikh',
    'Kaustubh Ghadi', 'Amol Bhagat', 'Dnyaneshwar Kadam', 'Sanjay Pol', 'Jay Patel',
    'Salim Shaikh', 'Prashant Nandwalkar', 'Sanju Pandagale', 'Vivek Shimpi', 'Irfan Shaikh',
    'Kanifnath Khairnar', 'Rakesh Mishra', 'Mangesh Kadam', 'Shekhar Jadhav',
    'Rajaram Kadam', 'Vinod Jawale',
  ],
  'Smruti': [
    'Rajesh Deshmukh', 'Amit Mohe', 'Sudhir Shinde', 'Kiran Soman', 'Kunal Shinde',
    'Avadhut Kiledar', 'Lalit Khairnar', 'Vaibhav Korgaonkar', 'Amit Poddar',
    'Vinayak Wakankar',
  ],
  'SKCA': [
    'Ayush Jadhav', 'Dinesh Shrivardhankar', 'Chetan Pawar', 'Adi Moolam',
    'Chaturbhuj Mishra', 'Vaubhav Joil', 'Sushat Kachare', 'Sachin Tuplondhe',
    'Karan Sonar', 'Akash Yadav', 'Anand Pawar', 'Vijay Marpelli', 'Satyaprakash Gupta',
    'Ansh Jadhav', 'Raju Kamble', 'Atul Hinganekar', 'Aditya Belekar', 'Arya Kumbhar',
    'Vedant Salvi', 'Harish Varadkar', 'Sunil khanse', 'Rajesh Shende',
  ],
  'Shakti': [
    'Jayesh Kadam', 'Santosh Balinge', 'Mohd.Javed Yakub Khan', 'Manish Patil',
    'Kunal Katalkar', 'Devendra Ghosalkar', 'Dinesh Shah', 'Sanjay Jadhav',
    'Sarfaraz Shaikh', 'Amol Pednekar', 'Naushad Shaikh', 'Sameer Nerekar',
    'AnilKumar Singh', 'Shoaib Hodekar', 'Satya Arekar', 'Saurabh Ghulathi',
    'Nikhil Bhoir', 'Akshay Bansode', 'Rahul Surve', 'Nahush Naroliya',
    'Rahul Kalasekar', 'Akshay Deshmukh',
  ],
  'Sai Thane': [
    'Mukesh Mandodare', 'Nitin Dandekar', 'Ajikkumar Dede', 'Prathamesh Pawar',
    'Premkumar Mishra', 'Mahesh Ganaria', 'Vishal Salvi', 'Sanjay Kamble',
    'Shridhar Kanchan', 'Sameer Shinde', 'Narendra Shirdhankar',
  ],
  'Sai Dom': [
    'Kamalesh Jaiswal', 'Rajesh Joshi', 'Bobby Thakur', 'Rupesh Sakpal',
    'Shekhar Kasale', 'Rahul Jogadiya',
  ],
  'MRCC': [
    'Dasharath Kadam', 'Pradeep Satam', 'Prasad Mukadam', 'Bharat Makwana', 'Arnav Gawade',
    'Yogesh Kadam', 'Nandkumar Guram', 'Shreyas Katalkar', 'Mahesh Shetye', 'Ganesh Kadam',
    'Vishal Shirsat', 'Manoj Kamble', 'Prasad Mane', 'Shankar Shinde', 'Anil Kokul',
    'Girish Pawar', 'Satyam Tiwari', 'Nitin Bhanushali', 'Jagdish Shirsat',
    'Gaurang Manjarekar', 'Narendra Dhawale', 'Ganesh salvi', 'Neel Mhatre',
    'Vilas Prabhudesai', 'Avinash Deshpande', 'Sunil Khude', 'Narendra Dani',
    'Rohit Khude', 'Ayush Katalkar', 'Dattaprasad Shembekar', 'Kshitij Hadwale',
    'Kunal Baing', 'Amit Ahire',
  ],
  'Lodha': [
    'Pankaj Ukarde', 'Sameer Sapkal', 'Pramod Pawar', 'Shantanu Rozekar',
    'Vinay Adhikari', 'Sachin Dongare',
  ],
  'HCC': [
    'Manoj Shinde', 'Prabhakar Chavan', 'Tejas Ravanekar', 'Kanhaiya Wakode',
    'Divesh Payara', 'Harsh Nivatkar', 'Siddhant Patil', 'Kiran Pawar', 'Shailesh Jadhav',
    'Mulal Tungare', 'Vishal Bhore', 'Alag Potdar', 'Sandip Dive', 'Amod Gangal',
    'Suresh Jadhav', 'Sudhir Ganika', 'Prasad Poddar', 'Ashok Gaikwad', 'Romit Bagade',
    'Amey Amberkar', 'Dipak Ganika', 'Kirit Goel',
  ],
  'DUM': [
    'Swaresh Panashikar', 'Bhushan Parab', 'Bhikan Chavan', 'Dayanand Etam',
    'Arman Kapadiya', 'Arjun Pichad', 'Shirish Tambe', 'Anand Bhandar', 'Sanjay Patil',
    'Vijay Lagad', 'Bharat Kunder', 'Tushar Basutkar', 'Onkar Kale', 'Ramnath Shinde',
    'Sushant Deorukhkar', 'Parag Kulkarni',
  ],
  'Dr. Vaze': [
    'Abhijit Nene', 'Amol Ranade', 'Vishwajeet Bhave', 'Omkar Mhaskar',
  ],
  'DKM': [
    'Robert Swamy', 'Vilas Ambavle', 'Yogesh Makwana', 'Kunal Raut',
    'Sameer Shendage', 'Nikhil Hankare',
  ],
  'Champions': [
    'Atiq Shaikh', 'Iqbal Shaikh', 'Parag Darde', 'Salman Isaf', 'Asif Khan',
    'Jaffar Sitapuri', 'Nasir ansari', 'A. Kayyum Siddique', 'Ibrahim Khan',
    'Zuber Shaikh', 'Javed Patni', 'Ganesh Shrimali', 'Wasim Shaikh', 'Aslam Chikte',
    'Ayaz Khan', 'Milan Panchal', 'Zharik Khan', 'Talib Khan', 'Zahir Sayyed',
    'Fazal Riyaz Skaikh', 'Arif Shaikh', 'Danish Khan', 'Alimuddin Pathan',
    'Irfan Azam Shaikh', 'Azhar Sayyed', 'Abdulla Khan', 'Furqaun Momin',
    'Naeem Shekhani', 'Mukim Siddiqui', 'Mithun Singh', 'Ronald Chauhan',
    'Zulfiqar Shaikh',
  ],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function norm(s) {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

function getToken() {
  return execSync('gcloud auth print-access-token', { encoding: 'utf8' }).trim();
}

function fbGet(path, token) {
  const url = `${DB_URL}${path}.json?access_token=${token}`;
  const out = execSync(`curl -s "${url}"`, { encoding: 'utf8' });
  return JSON.parse(out);
}

function fbPatch(path, data, token) {
  const url = `${DB_URL}${path}.json?access_token=${token}`;
  const tmp = join(tmpdir(), `fb-patch-${Date.now()}.json`);
  writeFileSync(tmp, JSON.stringify(data));
  try {
    const out = execSync(
      `curl -s -X PATCH -H "Content-Type: application/json" --data-binary "@${tmp}" "${url}"`,
      { encoding: 'utf8' }
    );
    const parsed = JSON.parse(out);
    if (parsed?.error) throw new Error(parsed.error);
    return parsed;
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
console.log(DRY_RUN ? '=== DRY RUN — no writes ===' : '=== LIVE RUN ===');
console.log('Fetching /players from Firebase…');

const token = getToken();
const allPlayers = fbGet('/players', token);
if (!allPlayers || typeof allPlayers !== 'object') {
  console.error('Failed to fetch players'); process.exit(1);
}

// Build normalised-name → [{id, canonicalName, represents}] index
const normIndex = new Map();
for (const [id, p] of Object.entries(allPlayers)) {
  const key = norm(p.canonicalName ?? '');
  if (!key) continue;
  if (!normIndex.has(key)) normIndex.set(key, []);
  normIndex.get(key).push({ id, canonicalName: p.canonicalName, represents: p.represents ?? null });
}

console.log(`Loaded ${Object.keys(allPlayers).length} players from Firebase.\n`);

let patched = 0, skipped = 0, ambiguous = 0;
const unmatched = [];
const warnings = [];

for (const [club, names] of Object.entries(CLUB_PLAYERS)) {
  console.log(`--- ${club} (${names.length} players) ---`);
  for (const name of names) {
    const key = norm(name);
    const matches = normIndex.get(key);

    if (!matches || matches.length === 0) {
      console.log(`  ✗ NO MATCH: "${name}"`);
      unmatched.push({ club, name });
      continue;
    }

    if (matches.length > 1) {
      const ids = matches.map(m => m.id).join(', ');
      console.log(`  ⚠ AMBIGUOUS: "${name}" → [${ids}]`);
      warnings.push({ club, name, ids });
      ambiguous++;
      continue;
    }

    const { id, canonicalName, represents: current } = matches[0];

    if (current === club) {
      console.log(`  ✓ already set: "${canonicalName}" → ${club}`);
      skipped++;
      continue;
    }

    if (DRY_RUN) {
      console.log(`  ~ would patch: "${canonicalName}" (${id}): "${current ?? '(none)'}" → "${club}"`);
      patched++;
    } else {
      try {
        fbPatch(`/players/${id}`, { represents: club }, token);
        console.log(`  ✓ patched: "${canonicalName}" (${id}): "${current ?? '(none)'}" → "${club}"`);
        patched++;
      } catch (e) {
        console.error(`  ✗ error patching "${canonicalName}" (${id}):`, e.message);
      }
    }
  }
  console.log();
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log('=== SUMMARY ===');
console.log(`  Patched  : ${patched}`);
console.log(`  Skipped  : ${skipped} (already correct)`);
console.log(`  Ambiguous: ${ambiguous} (multiple DB entries — manual review needed)`);
console.log(`  Unmatched: ${unmatched.length} (not found in DB)`);

if (warnings.length) {
  console.log('\nAMBIGUOUS (manual fix needed):');
  for (const w of warnings) console.log(`  [${w.club}] "${w.name}" → IDs: ${w.ids}`);
}

if (unmatched.length) {
  console.log('\nUNMATCHED (not in Firebase — check spelling or create player):');
  for (const u of unmatched) console.log(`  [${u.club}] "${u.name}"`);
}
