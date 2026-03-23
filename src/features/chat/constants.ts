type SvgShape =
  | { type: 'path'; d: string; fill?: string; stroke?: string; strokeWidth?: string; transform?: string }
  | { type: 'circle'; cx: string; cy: string; r: string; fill?: string; stroke?: string; strokeWidth?: string };

type BrandSvgDefinition = {
  viewBox: string;
  width: string;
  height: string;
  shapes: readonly SvgShape[];
};

export const BRAND_SVGS: Record<'claude' | 'codex', BrandSvgDefinition> = {
  claude: {
    viewBox: '0 -.01 39.5 39.53',
    width: '18',
    height: '18',
    shapes: [
      {
        type: 'path',
        d: 'm7.75 26.27 7.77-4.36.13-.38-.13-.21h-.38l-1.3-.08-4.44-.12-3.85-.16-3.73-.2-.94-.2-.88-1.16.09-.58.79-.53 1.13.1 2.5.17 3.75.26 2.72.16 4.03.42h.64l.09-.26-.22-.16-.17-.16-3.88-2.63-4.2-2.78-2.2-1.6-1.19-.81-.6-.76-.26-1.66 1.08-1.19 1.45.1.37.1 1.47 1.13 3.14 2.43 4.1 3.02.6.5.24-.17.03-.12-.27-.45-2.23-4.03-2.38-4.1-1.06-1.7-.28-1.02c-.1-.42-.17-.77-.17-1.2l1.23-1.67.68-.22 1.64.22.69.6 1.02 2.33 1.65 3.67 2.56 4.99.75 1.48.4 1.37.15.42h.26v-.24l.21-2.81.39-3.45.38-4.44.13-1.25.62-1.5 1.23-.81.96.46.79 1.13-.11.73-.47 3.05-.92 4.78-.6 3.2h.35l.4-.4 1.62-2.15 2.72-3.4 1.2-1.35 1.4-1.49.9-.71h1.7l1.25 1.86-.56 1.92-1.75 2.22-1.45 1.88-2.08 2.8-1.3 2.24.12.18.31-.03 4.7-1 2.54-.46 3.03-.52 1.37.64.15.65-.54 1.33-3.24.8-3.8.76-5.66 1.34-.07.05.08.1 2.55.24 1.09.06h2.67l4.97.37 1.3.86.78 1.05-.13.8-2 1.02-2.7-.64-6.3-1.5-2.16-.54h-.3v.18l1.8 1.76 3.3 2.98 4.13 3.84.21.95-.53.75-.56-.08-3.63-2.73-1.4-1.23-3.17-2.67h-.21v.28l.73 1.07 3.86 5.8.2 1.78-.28.58-1 .35-1.1-.2-2.26-3.17-2.33-3.57-1.88-3.2-.23.13-1.11 11.95-.52.61-1.2.46-1-.76-.53-1.23.53-2.43.64-3.17.52-2.52.47-3.13.28-1.04-.02-.07-.23.03-2.36 3.24-3.59 4.85-2.84 3.04-.68.27-1.18-.61.11-1.09.66-.97 3.93-5 2.37-3.1 1.53-1.79-.01-.26h-.09l-10.44 6.78-1.86.24-.8-.75.1-1.23.38-.4 3.14-2.16z',
        fill: '#d97757',
      },
    ],
  },
  codex: {
    viewBox: '0 0 1024 1024',
    width: '18',
    height: '18',
    shapes: [
      {
        type: 'path',
        d: 'M0 512c0 282.624 229.376 512 512 512s512-229.376 512-512S794.624 0 512 0 0 229.376 0 512z',
        fill: '#333333',
      },
      {
        type: 'path',
        d: 'M678.4 696.832c-15.36 48.64-56.832 86.016-106.496 96.256-50.176 10.752-102.912-6.144-136.704-44.544-6.144 0.512-12.288 2.048-18.432 2.56-35.84 3.072-72.704-8.192-100.864-30.72-46.592-36.864-67.072-100.352-47.616-157.184-13.312-15.36-24.064-32.768-30.208-52.224-25.6-80.896 24.576-167.936 107.52-184.32 15.872-49.664 58.368-87.552 109.568-96.768s100.352 7.168 134.144 45.056c4.608 0 8.704-1.536 13.312-2.048 61.44-6.656 118.784 24.576 145.92 79.872s19.456 72.192 7.68 107.52c11.776 13.824 21.504 29.184 27.648 46.08 30.72 82.432-19.456 173.568-104.96 190.976zM424.448 532.48V371.2c0-4.096 4.096-10.752 7.168-13.312l118.784-68.608c-10.752-10.24-26.112-17.92-40.448-21.504-68.608-17.92-134.144 33.28-134.656 103.424v131.584l1.536 2.048 47.616 27.648z m25.6-141.824v55.808l2.56-1.024c46.592-26.624 92.672-54.272 139.776-80.384 5.632-2.048 10.752-0.512 15.872 2.56l115.2 66.56c1.024 0 0.512 0 1.024-0.512 1.536-4.096 1.536-15.36 1.536-19.456-1.536-77.312-83.456-126.976-153.088-94.208L452.096 389.12l-2.048 2.048z m-111.616-23.552c-35.84 12.8-62.464 45.568-68.608 82.944s11.776 83.456 47.104 106.496L435.2 625.152h3.584l45.568-26.624 1.024-1.536-138.752-80.384c-4.096-2.048-8.704-9.216-8.704-13.824V366.08z m347.136 289.792c24.064-8.704 45.056-27.136 57.344-49.664 26.112-49.152 10.24-110.592-36.352-140.288l-118.784-68.608h-3.072l-47.104 27.648 1.536 1.536 136.192 78.848c4.096 2.048 9.728 9.216 9.728 13.824v137.216zM573.952 547.84V477.696l-1.024-2.048-58.88-33.792-2.56-1.024-61.44 35.328v71.168l60.416 35.328h2.048L573.44 547.84z m25.6-56.32v161.28c0 5.12-4.608 12.288-9.216 14.336l-117.248 67.584C481.28 742.4 491.52 748.544 501.76 752.64c67.584 26.112 139.776-19.968 145.92-91.136v-140.8l-1.024-1.536L599.04 491.52z m-26.112 86.528l-137.216 78.848c-9.728 4.608-12.8 4.096-22.016-0.512l-113.664-66.048c-1.024 0-1.024 2.048-1.536 3.072-14.848 90.624 90.624 154.624 165.376 103.424l108.544-62.976v-56.32z',
        fill: '#FFFFFF',
      },
    ],
  },
} as const;

export type BrandSvgName = keyof typeof BRAND_SVGS;

/** Random flavor words shown when response completes (e.g., "Baked for 1:23"). */
export const COMPLETION_FLAVOR_WORDS = [
  'Baked',
  'Cooked',
  'Crunched',
  'Brewed',
  'Crafted',
  'Forged',
  'Conjured',
  'Whipped up',
  'Stirred',
  'Simmered',
  'Toasted',
  'Sautéed',
  'Finagled',
  'Marinated',
  'Distilled',
  'Fermented',
  'Percolated',
  'Steeped',
  'Roasted',
  'Cured',
  'Smoked',
  'Cogitated',
] as const;

/** Random flavor texts shown while Claude is thinking. */
export const FLAVOR_TEXTS = [
  // Classic
  'Thinking...',
  'Pondering...',
  'Processing...',
  'Analyzing...',
  'Considering...',
  'Working on it...',
  'Vibing...',
  'One moment...',
  'On it...',
  // Thoughtful
  'Ruminating...',
  'Contemplating...',
  'Reflecting...',
  'Mulling it over...',
  'Let me think...',
  'Hmm...',
  'Cogitating...',
  'Deliberating...',
  'Weighing options...',
  'Gathering thoughts...',
  // Playful
  'Brewing ideas...',
  'Connecting dots...',
  'Assembling thoughts...',
  'Spinning up neurons...',
  'Loading brilliance...',
  'Consulting the oracle...',
  'Summoning knowledge...',
  'Crunching thoughts...',
  'Dusting off neurons...',
  'Wrangling ideas...',
  'Herding thoughts...',
  'Juggling concepts...',
  'Untangling this...',
  'Piecing it together...',
  // Cozy
  'Sipping coffee...',
  'Warming up...',
  'Getting cozy with this...',
  'Settling in...',
  'Making tea...',
  'Grabbing a snack...',
  // Technical
  'Parsing...',
  'Compiling thoughts...',
  'Running inference...',
  'Querying the void...',
  'Defragmenting brain...',
  'Allocating memory...',
  'Optimizing...',
  'Indexing...',
  'Syncing neurons...',
  // Zen
  'Breathing...',
  'Finding clarity...',
  'Channeling focus...',
  'Centering...',
  'Aligning chakras...',
  'Meditating on this...',
  // Whimsical
  'Asking the stars...',
  'Reading tea leaves...',
  'Shaking the magic 8-ball...',
  'Consulting ancient scrolls...',
  'Decoding the matrix...',
  'Communing with the ether...',
  'Peering into the abyss...',
  'Channeling the cosmos...',
  // Action
  'Diving in...',
  'Rolling up sleeves...',
  'Getting to work...',
  'Tackling this...',
  'On the case...',
  'Investigating...',
  'Exploring...',
  'Digging deeper...',
  // Casual
  'Bear with me...',
  'Hang tight...',
  'Just a sec...',
  'Working my magic...',
  'Almost there...',
  'Give me a moment...',
];
