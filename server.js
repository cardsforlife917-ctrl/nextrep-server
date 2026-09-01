require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const Anthropic = require('@anthropic-ai/sdk');

const PORT = process.env.PORT || 3000;
const MODEL = 'claude-haiku-4-5';

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Missing ANTHROPIC_API_KEY. Add it to a .env file (see .env.example).');
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const app = express();
app.use(cors());
app.use(express.json());

const generatePlanLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many plan requests from this device. Try again later.' },
});

const exerciseSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    description: { type: 'string' },
    durationMinutes: { type: ['number', 'null'] },
    sets: { type: ['number', 'null'] },
    reps: { type: ['number', 'null'] },
    equipment: {
      type: 'array',
      items: { type: 'string' },
      description:
        "Only the specific equipment this exercise needs, drawn from the user's available equipment. Empty array if none needed.",
    },
  },
  required: ['name', 'description', 'durationMinutes', 'sets', 'reps', 'equipment'],
  additionalProperties: false,
};

const PLAN_TOOL = {
  name: 'create_workout_plan',
  description: 'Create a structured sports training/workout plan.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'A short, motivating title for the plan.' },
      estimatedDurationMinutes: { type: 'number' },
      warmup: { type: 'array', items: exerciseSchema, minItems: 1 },
      exercises: { type: 'array', items: exerciseSchema, minItems: 1 },
      cooldown: { type: 'array', items: exerciseSchema, minItems: 1 },
    },
    required: ['title', 'estimatedDurationMinutes', 'warmup', 'exercises', 'cooldown'],
    additionalProperties: false,
  },
};

const VARIETY_ANGLES = [
  'Emphasize footwork and body mechanics in each drill.',
  'Emphasize game-speed, competitive-tempo execution rather than static repetition.',
  'Emphasize progressive difficulty — start basic and build toward the hardest variation.',
  'Emphasize combining two focus skills together within single drills where sensible.',
  'Emphasize less common, creative variations of standard drills rather than the most textbook version.',
  'Emphasize decision-making and reactive drills over purely mechanical repetition.',
];

function buildPrompt({ sport, skills, positions, level, equipment, timeMinutes, players }) {
  const varietyAngle = VARIETY_ANGLES[Math.floor(Math.random() * VARIETY_ANGLES.length)];

  const lines = [
    `Create a ${timeMinutes}-minute ${sport} training plan for a ${level} athlete.`,
    `Focus skills: ${skills.join(', ')}.`,
    `Available equipment: ${equipment.join(', ')}.`,
    'Only use equipment from that list in any exercise (bodyweight-only exercises are always fine).',
    'Include a warm-up, a main set of drills/exercises targeting the focus skills, and a cool-down.',
    'Warm-up exercises must be on-ball/on-equipment movements specific to the sport (e.g. dribbling, passing, light ball-handling) — do not include generic cardio like jogging in place, jumping jacks, or arm circles.',
    'The total time across warm-up, exercises, and cool-down should roughly add up to the requested duration.',
    'Each exercise needs a clear name, a short description of how to perform it, sets/reps or a duration, and the exact equipment it personally needs (not the full available list).',
    `Style for this session: ${varietyAngle}`,
  ];

  if (Array.isArray(positions) && positions.length > 0) {
    const positionList = positions.join(' and ');
    lines.push(
      positions.length === 1
        ? `The athlete plays ${positionList}. Tailor the drills to the specific responsibilities, movement patterns, and situational demands of that position within ${sport} — not just the sport generally.`
        : `The athlete plays multiple positions: ${positionList}. Tailor the drills to cover the specific responsibilities and movement patterns of each of these positions within ${sport}.`
    );
  }

  if (Array.isArray(players) && players.length > 0) {
    const playerList = players.join(' and ');
    lines.push(
      players.length === 1
        ? `The athlete wants to model their training after ${playerList}. Design drills that mirror ${playerList}'s actual known game — their signature moves, go-to techniques, and the specific way they use these skills in real play — not just generic drills for the sport. Name the real move in the exercise description where it applies (e.g. a specific step-back, a specific footwork pattern) if it's genuinely well known. Do not fabricate specific stats or claims you are not confident are publicly accurate.`
        : `The athlete wants to model their training after multiple players: ${playerList}. Dedicate different drills to different players' known signature moves and techniques — mirror each player's actual known game rather than generic drills, and name the real move in the exercise description where it applies (e.g. a specific step-back, a specific release, a specific footwork pattern) if it's genuinely well known. Do not fabricate specific stats or claims you are not confident are publicly accurate.`
    );
  }

  return lines.join('\n');
}

app.post('/generate-plan', generatePlanLimiter, async (req, res) => {
  const { sport, skills, positions, level, equipment, timeMinutes, players } = req.body || {};

  if (!sport || !Array.isArray(skills) || skills.length === 0 || !level || !Array.isArray(equipment) || !timeMinutes) {
    return res.status(400).json({ error: 'Missing or invalid request fields.' });
  }

  try {
    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      tools: [PLAN_TOOL],
      tool_choice: { type: 'tool', name: 'create_workout_plan' },
      messages: [{ role: 'user', content: buildPrompt({ sport, skills, positions, level, equipment, timeMinutes, players }) }],
    });

    const toolUse = message.content.find((block) => block.type === 'tool_use');
    if (!toolUse) {
      return res.status(502).json({ error: 'Model did not return a structured plan.' });
    }

    const plan = toolUse.input;
    const withIds = (list, prefix) =>
      (list || []).map((exercise, index) => ({
        id: `${prefix}_${index}`,
        equipment: [],
        ...exercise,
      }));

    return res.json({
      title: plan.title,
      estimatedDurationMinutes: plan.estimatedDurationMinutes,
      warmup: withIds(plan.warmup, 'warmup'),
      exercises: withIds(plan.exercises, 'exercise'),
      cooldown: withIds(plan.cooldown, 'cooldown'),
    });
  } catch (error) {
    console.error('generate-plan failed:', error);
    if (error instanceof Anthropic.RateLimitError) {
      return res.status(429).json({ error: 'Rate limited, try again shortly.' });
    }
    if (error instanceof Anthropic.AuthenticationError) {
      return res.status(500).json({ error: 'Server misconfigured (invalid API key).' });
    }
    return res.status(502).json({
      error: 'Failed to generate plan.',
      debugName: error.name,
      debugMessage: error.message,
      debugStatus: error.status,
    });
  }
});

app.get('/health', (req, res) =>
  res.json({ ok: true, nodeVersion: process.version, deployMarker: 'v2-node-pin' })
);

const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));
app.use((req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`nextrep-server listening on http://localhost:${PORT}`);
});
