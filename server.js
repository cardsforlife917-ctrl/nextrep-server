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

const SCHEDULE_SESSION_SCHEMA = {
  type: 'object',
  properties: {
    dayLabel: { type: 'string', description: 'e.g. "Day 1"' },
    title: { type: 'string' },
    focus: { type: 'string', description: 'The primary skill or theme this session emphasizes' },
    estimatedDurationMinutes: { type: 'number' },
    warmup: { type: 'array', items: exerciseSchema, minItems: 1 },
    exercises: { type: 'array', items: exerciseSchema, minItems: 1 },
    cooldown: { type: 'array', items: exerciseSchema, minItems: 1 },
  },
  required: ['dayLabel', 'title', 'focus', 'estimatedDurationMinutes', 'warmup', 'exercises', 'cooldown'],
  additionalProperties: false,
};

const SCHEDULE_TOOL = {
  name: 'create_weekly_schedule',
  description: 'Create a weekly training schedule made of several distinct workout sessions.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      sessions: { type: 'array', items: SCHEDULE_SESSION_SCHEMA, minItems: 1 },
    },
    required: ['sessions'],
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

function buildSchedulePrompt({ sport, skills, positions, level, equipment, players, timeMinutes, daysPerWeek }) {
  const lines = [
    `Create a weekly ${sport} training schedule for a ${level} athlete, with exactly ${daysPerWeek} distinct workout sessions across the week.`,
    `Skills to develop overall: ${skills.join(', ')}.`,
    `Available equipment: ${equipment.join(', ')}.`,
    'Only use equipment from that list in any exercise (bodyweight-only exercises are always fine).',
    `Each session should be about ${timeMinutes} minutes total (warm-up + exercises + cool-down).`,
    'Each session must have a genuinely different focus/theme from the others — spread the requested skills across the week rather than repeating the same drills every session (e.g. one day could emphasize one skill, another day a different skill, another day combine skills at game speed).',
    'Warm-up exercises must be on-ball/on-equipment movements specific to the sport — do not include generic cardio like jogging in place, jumping jacks, or arm circles.',
    'Each exercise needs a clear name, a short description, sets/reps or a duration, and the exact equipment it personally needs.',
    'Give each session a short dayLabel like "Day 1", "Day 2", etc. in order, plus a one or two word focus label (e.g. "Shooting", "Conditioning").',
  ];

  if (Array.isArray(positions) && positions.length > 0) {
    lines.push(`The athlete plays ${positions.join(' and ')}. Tailor drills to that position's responsibilities within ${sport}.`);
  }

  if (Array.isArray(players) && players.length > 0) {
    lines.push(
      `The athlete wants to model their training after ${players.join(
        ' and '
      )}. Where genuinely relevant, mirror their known signature moves and playing style across the sessions. Do not fabricate stats or claims you are not confident are publicly accurate.`
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
    return res.status(502).json({ error: 'Failed to generate plan.' });
  }
});

app.post('/generate-schedule', generatePlanLimiter, async (req, res) => {
  const { sport, skills, positions, level, equipment, timeMinutes, players, daysPerWeek } = req.body || {};

  if (
    !sport ||
    !Array.isArray(skills) ||
    skills.length === 0 ||
    !level ||
    !Array.isArray(equipment) ||
    !timeMinutes ||
    !daysPerWeek
  ) {
    return res.status(400).json({ error: 'Missing or invalid request fields.' });
  }

  try {
    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 8192,
      tools: [SCHEDULE_TOOL],
      tool_choice: { type: 'tool', name: 'create_weekly_schedule' },
      messages: [
        {
          role: 'user',
          content: buildSchedulePrompt({ sport, skills, positions, level, equipment, players, timeMinutes, daysPerWeek }),
        },
      ],
    });

    const toolUse = message.content.find((block) => block.type === 'tool_use');
    if (!toolUse) {
      return res.status(502).json({ error: 'Model did not return a structured schedule.' });
    }

    const withIds = (list, prefix) =>
      (list || []).map((exercise, index) => ({
        id: `${prefix}_${index}`,
        equipment: [],
        ...exercise,
      }));

    const sessions = (toolUse.input.sessions || []).map((session, index) => ({
      dayLabel: session.dayLabel,
      title: session.title,
      focus: session.focus,
      estimatedDurationMinutes: session.estimatedDurationMinutes,
      warmup: withIds(session.warmup, `warmup_${index}`),
      exercises: withIds(session.exercises, `exercise_${index}`),
      cooldown: withIds(session.cooldown, `cooldown_${index}`),
    }));

    return res.json({ sessions });
  } catch (error) {
    console.error('generate-schedule failed:', error);
    if (error instanceof Anthropic.RateLimitError) {
      return res.status(429).json({ error: 'Rate limited, try again shortly.' });
    }
    if (error instanceof Anthropic.AuthenticationError) {
      return res.status(500).json({ error: 'Server misconfigured (invalid API key).' });
    }
    return res.status(502).json({ error: 'Failed to generate schedule.' });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));
app.use((req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`nextrep-server listening on http://localhost:${PORT}`);
});
