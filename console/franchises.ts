/**
 * franchises.ts
 * The ten franchises' colours, and which of them each player was in the
 * IPL 2026 squad of.
 *
 * COLOURS
 * =======
 *
 * Two per franchise: the primary, which tints a card or a seat, and an accent
 * for the glint at its edge. Brighter than the `color` values the auction
 * room sends (useAuctionEngine.ts DEFAULT_TEAMS), which were chosen for the
 * white console and read as mud on the night theme. Used as a hint only -- a
 * low wash and a hairline -- never as a fill, so a board of ten still reads as
 * one product rather than ten kits.
 *
 * SQUADS
 * ======
 *
 * Transcribed from Wisden, "IPL 2026 squads: complete team lists after the
 * Indian Premier League mini auction":
 * https://www.wisden.com/series/ipl-2026/cricket-news/ipl-2026-squads-complete-team-lists-after-the-indian-premier-league-mini-auction
 *
 * Mapped onto this app's city codes (CSK -> CHE, GT -> AHM, KKR -> KOL,
 * LSG -> LKO, MI -> MUM, PBKS -> PBK, RR -> RAJ, RCB -> BLR, SRH -> HYD).
 * Matched to the pool by normalised name, with ALIASES for the seven players
 * the two sources spell differently. 179 of the 284 pool players match; the
 * rest were in no 2026 squad and get no tint, rather than a guessed one.
 */

export type FranchiseCode =
  | "MUM" | "CHE" | "BLR" | "KOL" | "DEL"
  | "PBK" | "RAJ" | "HYD" | "LKO" | "AHM";

export interface Franchise {
  code: FranchiseCode;
  name: string;
  /** The IPL side whose colours it borrows, for tooltips. */
  side: string;
  primary: string;
  accent: string;
}

export const FRANCHISES: Record<FranchiseCode, Franchise> = {
  MUM: { code: "MUM", name: "Mumbai", side: "Mumbai Indians", primary: "#3B82F6", accent: "#D4AF37" },
  CHE: { code: "CHE", name: "Chennai", side: "Chennai Super Kings", primary: "#FACC15", accent: "#3B82F6" },
  BLR: { code: "BLR", name: "Bengaluru", side: "Royal Challengers Bengaluru", primary: "#DC2626", accent: "#D4AF37" },
  KOL: { code: "KOL", name: "Kolkata", side: "Kolkata Knight Riders", primary: "#8B5CF6", accent: "#EAB308" },
  DEL: { code: "DEL", name: "Delhi", side: "Delhi Capitals", primary: "#2563EB", accent: "#EF4444" },
  PBK: { code: "PBK", name: "Punjab", side: "Punjab Kings", primary: "#EF4444", accent: "#E5E7EB" },
  RAJ: { code: "RAJ", name: "Rajasthan", side: "Rajasthan Royals", primary: "#EC4899", accent: "#3B82F6" },
  HYD: { code: "HYD", name: "Hyderabad", side: "Sunrisers Hyderabad", primary: "#F97316", accent: "#FBBF24" },
  LKO: { code: "LKO", name: "Lucknow", side: "Lucknow Super Giants", primary: "#06B6D4", accent: "#F97316" },
  AHM: { code: "AHM", name: "Ahmedabad", side: "Gujarat Titans", primary: "#64748B", accent: "#D4AF37" },
};

/** The IPL 2026 squads, by this app's franchise code. Source in the header. */
const SQUADS_2026: Record<FranchiseCode, string[]> = {
  CHE: [
    "MS Dhoni",
    "Sanju Samson",
    "Ruturaj Gaikwad",
    "Ayush Mhatre",
    "Dewald Brevis",
    "Urvil Patel",
    "Kartik Sharma",
    "Matthew Short",
    "Sarfaraz Khan",
    "Anshul Kamboj",
    "Gurjapneet Singh",
    "Mukesh Choudhary",
    "Nathan Ellis",
    "Noor Ahmad",
    "Khaleel Ahmed",
    "Matt Henry",
    "Rahul Chahar",
    "Zak Foulkes",
    "Jamie Overton",
    "Ramakrishna Ghosh",
    "Shivam Dube",
    "Shreyas Gopal",
    "Akeal Hosein",
    "Prashant Veer",
    "Aman Khan",
  ],
  DEL: [
    "Abishek Porel",
    "Ashutosh Sharma",
    "Karun Nair",
    "KL Rahul",
    "Nitish Rana",
    "Sameer Rizvi",
    "Tristan Stubbs",
    "David Miller",
    "Ben Duckett",
    "Pathum Nissanka",
    "Sahil Parakh",
    "Prithvi Shaw",
    "Dushmantha Chameera",
    "Kuldeep Yadav",
    "Mitchell Starc",
    "Mukesh Kumar",
    "T. Natarajan",
    "Tripurana Vijay",
    "Auqib Nabi",
    "Kyle Jamieson",
    "Ajay Mandal",
    "Axar Patel",
    "Madhav Tiwari",
    "Vipraj Nigam",
  ],
  AHM: [
    "Anuj Rawat",
    "Jos Buttler",
    "Kumar Kushagra",
    "Sai Sudharsan",
    "Shubman Gill",
    "Tom Banton",
    "Gurnoor Brar",
    "Ishant Sharma",
    "Kagiso Rabada",
    "Mohammed Siraj",
    "Arshad Khan",
    "Prasidh Krishna",
    "Sai Kishore",
    "Rashid Khan",
    "Ashok Sharma",
    "Prithvi Raj Yarra",
    "Luke Wood",
    "Glenn Phillips",
    "Jayant Yadav",
    "Manav Suthar",
    "Nishant Sindhu",
    "Rahul Tewatia",
    "Shahrukh Khan",
    "Washington Sundar",
    "Jason Holder",
  ],
  KOL: [
    "Ajinkya Rahane",
    "Angkrish Raghuvanshi",
    "Manish Pandey",
    "Rinku Singh",
    "Rovman Powell",
    "Finn Allen",
    "Tejasvi Singh",
    "Rahul Tripathi",
    "Tim Seifert",
    "Harshit Rana",
    "Umran Malik",
    "Vaibhav Arora",
    "Varun Chakravarthy",
    "Matheesha Pathirana",
    "Kartik Tyagi",
    "Prashant Solanki",
    "Mustafizur Rahman",
    "Akash Deep",
    "Anukul Roy",
    "Ramandeep Singh",
    "Sunil Narine",
    "Cameron Green",
    "Sarthak Ranjan",
    "Daksh Kamra",
    "Rachin Ravindra",
  ],
  LKO: [
    "Abdul Samad",
    "Himmat Singh",
    "Matthew Breetzke",
    "Nicholas Pooran",
    "Rishabh Pant",
    "Mukul Choudhary",
    "Akshat Raghuwanshi",
    "Josh Inglis",
    "Akash Singh",
    "Arjun Tendulkar",
    "Avesh Khan",
    "Digvesh Rathi",
    "Manimaran Siddharth",
    "Mayank Yadav",
    "Mohammed Shami",
    "Mohsin Khan",
    "Prince Yadav",
    "Anrich Nortje",
    "Naman Tiwari",
    "Aiden Markram",
    "Arshin Kulkarni",
    "Ayush Badoni",
    "Mitchell Marsh",
    "Shahbaz Ahmed",
    "Wanindu Hasaranga",
  ],
  MUM: [
    "Robin Minz",
    "Rohit Sharma",
    "Ryan Rickelton",
    "Sherfane Rutherford",
    "Suryakumar Yadav",
    "Tilak Varma",
    "Quinton de Kock",
    "Danish Malewar",
    "Allah Ghazanfar",
    "Ashwani Kumar",
    "Deepak Chahar",
    "Jasprit Bumrah",
    "Raghu Sharma",
    "Shardul Thakur",
    "Trent Boult",
    "Mohammad Izhar",
    "Mayank Markande",
    "Corbin Bosch",
    "Hardik Pandya",
    "Mitchell Santner",
    "Naman Dhir",
    "Raj Angad Bawa",
    "Will Jacks",
    "Atharva Ankolekar",
    "Mayank Rawat",
  ],
  PBK: [
    "Harnoor Singh Pannu",
    "Nehal Wadhera",
    "Prabhsimran Singh",
    "Priyansh Arya",
    "Pyla Avinash",
    "Shashank Singh",
    "Shreyas Iyer",
    "Vishnu Vinod",
    "Arshdeep Singh",
    "Lockie Ferguson",
    "Vyshak Vijaykumar",
    "Xavier Bartlett",
    "Yash Thakur",
    "Yuzvendra Chahal",
    "Ben Dwarshuis",
    "Azmatullah Omarzai",
    "Harpreet Brar",
    "Marco Jansen",
    "Marcus Stoinis",
    "Mitchell Owen",
    "Musheer Khan",
    "Suryansh Shedge",
    "Cooper Connolly",
    "Pravin Dubey",
    "Vishal Nishad",
  ],
  RAJ: [
    "Dhruv Jurel",
    "Lhuan-dre Pretorius",
    "Shimron Hetmyer",
    "Shubham Dubey",
    "Vaibhav Suryavanshi",
    "Yashasvi Jaiswal",
    "Ravi Singh",
    "Aman Rao",
    "Jofra Archer",
    "Kwena Maphaka",
    "Nandre Burger",
    "Sandeep Sharma",
    "Tushar Deshpande",
    "Yudhvir Singh Charak",
    "Ravi Bishnoi",
    "Sushant Mishra",
    "Yash Raj Punja",
    "Vignesh Puthur",
    "Brijesh Sharma",
    "Adam Milne",
    "Kuldeep Sen",
    "Donovan Ferreira",
    "Ravindra Jadeja",
    "Riyan Parag",
    "Sam Curran",
  ],
  BLR: [
    "Devdutt Padikkal",
    "Jitesh Sharma",
    "Phil Salt",
    "Rajat Patidar",
    "Tim David",
    "Virat Kohli",
    "Jordan Cox",
    "Vihaan Malhotra",
    "Abhinandan Singh",
    "Bhuvneshwar Kumar",
    "Josh Hazlewood",
    "Nuwan Thushara",
    "Rasikh Dar",
    "Suyash Sharma",
    "Yash Dayal",
    "Jacob Duffy",
    "Vicky Ostwal",
    "Jacob Bethell",
    "Krunal Pandya",
    "Romario Shepherd",
    "Swapnil Singh",
    "Venkatesh Iyer",
    "Satvik Deswal",
    "Mangesh Yadav",
    "Kanishk Chouhan",
  ],
  HYD: [
    "Aniket Verma",
    "Heinrich Klaasen",
    "Ishan Kishan",
    "Smaran Ravichandran",
    "Travis Head",
    "Salil Arora",
    "Brydon Carse",
    "Eshan Malinga",
    "Harshal Patel",
    "Jaydev Unadkat",
    "Pat Cummins",
    "Zeeshan Ansari",
    "Sakib Hassan",
    "Onkar Tarmale",
    "Amit Kumar",
    "Praful Hinge",
    "Abhishek Sharma",
    "Harsh Dubey",
    "Kamindu Mendis",
    "Nitish Kumar Reddy",
    "Shivang Kumar",
    "Krains Fuletra",
    "Liam Livingstone",
    "Shivam Mavi",
    "Jack Edwards",
  ],
};

/** Pool spelling -> squad spelling, where the two sources differ. */
const ALIASES: Record<string, string> = {
  "Abhishek Porel": "Abishek Porel",
  "Gurnoor Singh Brar": "Gurnoor Brar",
  "Md Arshad Khan": "Arshad Khan",
  "Sakib Hussain": "Sakib Hassan",
  "Syed Khaleel Ahmed": "Khaleel Ahmed",
  "Yudhvir Charak": "Yudhvir Singh Charak",
  "M Siddharth": "Manimaran Siddharth",
};

const key = (name: string) => name.toLowerCase().replace(/[^a-z]/g, "");

const BY_NAME: Map<string, FranchiseCode> = (() => {
  const map = new Map<string, FranchiseCode>();
  for (const [code, names] of Object.entries(SQUADS_2026) as [FranchiseCode, string[]][]) {
    for (const name of names) map.set(key(name), code);
  }
  return map;
})();

/** The franchise a player was in the IPL 2026 squad of, or null. */
export function franchiseOf(playerName: string): Franchise | null {
  const code = BY_NAME.get(key(ALIASES[playerName] ?? playerName));
  return code ? FRANCHISES[code] : null;
}

/** A franchise by its code, for the seat board. Unknown codes get null. */
export function franchiseByCode(code: string): Franchise | null {
  return (FRANCHISES as Record<string, Franchise>)[code.toUpperCase()] ?? null;
}
