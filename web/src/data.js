// Prototype content. Every answer must be replaced with health-partner-approved
// content (WHO / Ministry of Health guidance) before testing with users.

export const LANGS = [
  { id: 'so', label: 'Soomaali' },
  { id: 'sw', label: 'Kiswahili' },
  { id: 'en', label: 'English' },
  { id: 'om', label: 'Afaan Oromoo' },
]

export const langLabel = (id) => LANGS.find((l) => l.id === id)?.label ?? id

export const SERVICES = [
  'Pregnancy test',
  'Family planning',
  'Period care',
  'Counselling',
  'STI testing',
  'Safety support',
]

export const CLINICS = [
  {
    id: 'a',
    name: '[Health post A]',
    area: '[Block / area]',
    distance: '[distance]',
    tags: ['Free', 'Female nurse on site', 'Open [HOURS]'],
    services: ['Pregnancy test', 'Family planning', 'Period care', 'Counselling', 'STI testing'],
  },
  {
    id: 'b',
    name: '[Health post B]',
    area: '[Block / area]',
    distance: '[distance]',
    tags: ['Free', 'Somali-speaking staff', 'Open [HOURS]'],
    services: ['Pregnancy test', 'Counselling', 'Safety support'],
  },
  {
    id: 'c',
    name: '[Clinic C]',
    area: '[Town]',
    distance: '[distance]',
    tags: ['Free', 'Youth-friendly hours', 'Open [HOURS]'],
    services: ['Family planning', 'Period care', 'STI testing', 'Safety support'],
  },
]

export const clinicById = (id) => CLINICS.find((c) => c.id === id)

const SOURCE = '[approved health partner guide]'

export const TOPICS = [
  {
    id: 'pregnancy',
    label: 'Pregnancy',
    keywords: ['late', 'weeks late', 'days late', 'late period', 'missed', 'pregnan', 'uur', 'mimba'],
    answer: [
      'Thank you for asking. A late period can happen for many reasons, like stress, illness or pregnancy.',
      'A pregnancy test is the quickest way to know. It is free at youth-friendly clinics, and staff there are trained to keep it private.',
      'If you also have strong pain or heavy bleeding, please get care today.',
    ],
    services: ['Pregnancy test', 'Counselling'],
  },
  {
    id: 'period',
    label: 'Periods and pain',
    keywords: ['period', 'cramp', 'menstru', 'pain', 'caado', 'hedhi', 'pad'],
    answer: [
      'Period pain is common. Rest, a warm cloth on your belly and paracetamol can help.',
      'See a nurse soon if the pain stops you walking, or bleeding soaks a pad every hour.',
    ],
    services: ['Period care'],
  },
  {
    id: 'fp',
    label: 'Family planning',
    keywords: ['family planning', 'contracep', 'pill', 'condom', 'implant', 'injection', 'prevent pregnancy'],
    answer: [
      'There are several safe ways to prevent pregnancy, like pills, injections, implants and condoms.',
      'A nurse at a youth-friendly clinic can help you choose what fits you, privately and for free.',
      'Condoms are the only method that also protects against STIs.',
    ],
    services: ['Family planning', 'Counselling'],
  },
  {
    id: 'sti',
    label: 'STIs',
    keywords: ['sti', 'std', 'discharge', 'itch', 'hiv', 'infection', 'burn', 'sore'],
    answer: [
      'Itching, unusual discharge, sores or pain when you pee can be signs of an infection.',
      'Most infections are easy to treat. A clinic can test you privately.',
      'Until you are checked, use a condom or avoid sex.',
    ],
    services: ['STI testing'],
  },
  {
    id: 'safety',
    label: 'Safety and violence',
    keywords: ['hit', 'beat', 'touch me', 'abuse', 'unsafe', 'scared of', 'threat'],
    answer: [
      'You deserve to be safe, and what happened is not your fault.',
      'A trained Dada can talk with you now and help you find safe support.',
    ],
    services: ['Safety support', 'Counselling'],
    handoff: true,
  },
].map((t) => ({ ...t, source: SOURCE }))

export const topicLabel = (id) => TOPICS.find((t) => t.id === id)?.label ?? 'Other'

// Danger signs always go to a trained human, never left to the AI alone.
export const DANGER_SIGNS = [
  {
    sign: 'Heavy bleeding',
    words: ['heavy bleeding', 'bleeding a lot', 'soak', 'dizzy', 'faint', 'passed out'],
    advice: 'If you are bleeding heavily or feel faint, go to the nearest clinic now. Ask someone you trust to go with you.',
  },
  {
    sign: 'Safety concern',
    words: ['not safe', 'hurt me', 'hits me', 'forced', 'rape', 'attacked'],
    advice: 'If you are in danger right now, go to a safe place or a person you trust.',
  },
  {
    sign: 'Self-harm',
    words: ['kill myself', 'end my life', 'hurt myself', 'suicide', 'want to die'],
    advice: 'You are not alone. Please stay with someone you trust while the Dada replies.',
  },
]

export const SUGGESTIONS = [
  'My period is two weeks late',
  'I get strong period pain',
  'How can I prevent pregnancy?',
  'I have itching and discharge',
]

export const DONT_KNOW = [
  "I'm not sure about that, and I don't want to guess.",
  'A trained Dada can answer you. Do you want to talk to one?',
]

const norm = (s) => s.toLowerCase()

export function detectDanger(text) {
  const t = norm(text)
  return DANGER_SIGNS.find((d) => d.words.some((w) => t.includes(w))) ?? null
}

export function matchTopic(text) {
  const t = norm(text)
  let best = null
  let bestScore = 0
  for (const topic of TOPICS) {
    // Longer, more specific phrases outweigh single words.
    const score = topic.keywords.filter((k) => t.includes(k)).reduce((n, k) => n + k.length, 0)
    if (score > bestScore) {
      best = topic
      bestScore = score
    }
  }
  return best
}

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

export function newPassCode() {
  let code = ''
  for (let i = 0; i < 4; i++) code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)]
  return `UB-${code}`
}

export const PASS_DAYS = 7
