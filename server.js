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
// Render (and most PaaS hosts) put the app behind a reverse proxy. Without this,
// Express can't see the real client IP (everything looks like it comes from the
// proxy), which silently made the rate limiter below share one bucket across
// every user instead of limiting per-device.
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());

const generatePlanLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 100,
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
      weightRoom: {
        type: 'array',
        items: exerciseSchema,
        description: 'Weight room / strength training exercises. Empty array if not requested.',
      },
      cooldown: { type: 'array', items: exerciseSchema, minItems: 1 },
    },
    required: ['title', 'estimatedDurationMinutes', 'warmup', 'exercises', 'weightRoom', 'cooldown'],
    additionalProperties: false,
  },
};

const ON_COURT_SESSION_SCHEMA = {
  type: 'object',
  properties: {
    dayLabel: { type: 'string', description: 'e.g. "On-Court Day 1"' },
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

const ON_COURT_SCHEDULE_TOOL = {
  name: 'create_on_court_schedule',
  description: 'Create a weekly on-court/skill training schedule made of several distinct sessions.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      sessions: { type: 'array', items: ON_COURT_SESSION_SCHEMA, minItems: 1 },
    },
    required: ['sessions'],
    additionalProperties: false,
  },
};

const WEIGHT_ROOM_SESSION_SCHEMA = {
  type: 'object',
  properties: {
    dayLabel: { type: 'string', description: 'e.g. "Weight Room Day 1"' },
    title: { type: 'string' },
    focus: { type: 'string', description: 'The primary strength goal this session emphasizes' },
    estimatedDurationMinutes: { type: 'number' },
    warmup: { type: 'array', items: exerciseSchema, minItems: 1 },
    weightRoom: { type: 'array', items: exerciseSchema, minItems: 1 },
    cooldown: { type: 'array', items: exerciseSchema, minItems: 1 },
  },
  required: ['dayLabel', 'title', 'focus', 'estimatedDurationMinutes', 'warmup', 'weightRoom', 'cooldown'],
  additionalProperties: false,
};

const WEIGHT_ROOM_SCHEDULE_TOOL = {
  name: 'create_weight_room_schedule',
  description: 'Create a weekly weight room / strength training schedule made of several distinct sessions.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      sessions: { type: 'array', items: WEIGHT_ROOM_SESSION_SCHEMA, minItems: 1 },
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

function buildWeightRoomInstruction(weightRoomGoals) {
  if (!Array.isArray(weightRoomGoals) || weightRoomGoals.length === 0) {
    return "The athlete does not want a weight room section. Return an empty array for 'weightRoom'.";
  }

  const lines = [
    `The athlete also wants a dedicated weight room / strength training section, on top of the sport drills, to enhance athletic performance.`,
    'Keep it athletic-performance oriented, not bodybuilding/aesthetics-oriented — favor compound, functional, sport-transfer lifts (squats, deadlifts, presses, Olympic lift variations, plyometrics, sled work, medicine ball throws, etc.) over isolation/machine work, and explain briefly in each description how the lift transfers to the sport.',
    'Include real strength-training exercises tailored to the available equipment in the \'weightRoom\' array. This is separate from the skill drills in \'exercises\'.',
    `Focus on these specific goals: ${weightRoomGoals.join(', ')}.`,
  ];

  return lines.join('\n');
}

function buildPrompt({
  sport,
  skills,
  positions,
  level,
  equipment,
  timeMinutes,
  players,
  weightRoomGoals,
  recentHistory,
}) {
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
    buildWeightRoomInstruction(weightRoomGoals),
  ];

  if (recentHistory) {
    lines.push(
      `Recent training history for this athlete, for context — use it to adapt intelligently (adjust difficulty up or down, avoid repeating the same exercises, keep it motivating): ${recentHistory}`
    );
  }

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

function buildOnCourtSchedulePrompt({ sport, skills, positions, level, equipment, players, timeMinutes, days, recentHistory }) {
  const lines = [
    `Create a weekly ${sport} on-court/skill training schedule for a ${level} athlete, with exactly ${days} distinct sessions across the week.`,
    `Skills to develop overall: ${skills.join(', ')}.`,
    `Available equipment: ${equipment.join(', ')}.`,
    'Only use equipment from that list in any exercise (bodyweight-only exercises are always fine).',
    `Each session should be about ${timeMinutes} minutes total (warm-up + exercises + cool-down).`,
    'Each session must have a genuinely different focus/theme from the others — spread the requested skills across the week rather than repeating the same drills every session (e.g. one day could emphasize one skill, another day a different skill, another day combine skills at game speed).',
    'Warm-up exercises must be on-ball/on-equipment movements specific to the sport — do not include generic cardio like jogging in place, jumping jacks, or arm circles.',
    'Each exercise needs a clear name, a short description, sets/reps or a duration, and the exact equipment it personally needs.',
    'Give each session a short dayLabel like "On-Court Day 1", "On-Court Day 2", etc. in order, plus a one or two word focus label (e.g. "Shooting", "Conditioning"). This is skill/on-court training only — do not include weight room or gym strength work in these sessions.',
  ];

  if (Array.isArray(skills) && skills.some((skill) => /shooting/i.test(skill))) {
    lines.push(
      'Shooting is a top priority skill for this athlete. On the session whose main focus IS shooting, shooting should dominate — most of the exercises that day should be shooting work. On every OTHER session, do NOT add a separate standalone shooting exercise to the list — instead blend shooting into that day\'s existing exercises themselves, so a couple of the normal drills naturally finish into a shot as part of what they already are (e.g. a ball-handling drill\'s description ends with "...then finish with a shot off the dribble"; a defense drill ends with "...then contest and box out as the shot goes up"). The exercise count and names should still read as pure ball-handling/defense/etc. drills — the shot is just folded into how a drill finishes, not called out as its own thing.'
    );
  }

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

  if (recentHistory) {
    lines.push(
      `Recent training history for this athlete, for context — use it to adapt intelligently (adjust difficulty up or down, avoid repeating the same exercises, keep it motivating): ${recentHistory}`
    );
  }

  return lines.join('\n');
}

function buildWeightRoomSchedulePrompt({ sport, level, equipment, players, timeMinutes, days, weightRoomGoals, recentHistory }) {
  const lines = [
    `Create a weekly weight room / strength training schedule for a ${level} ${sport} athlete, with exactly ${days} distinct sessions across the week.`,
    `Available equipment: ${equipment.join(', ')}.`,
    'Only use equipment from that list.',
    `Each session should be about ${timeMinutes} minutes total (warm-up + weight room work + cool-down).`,
    'Keep it athletic-performance oriented, not bodybuilding/aesthetics-oriented — favor compound, functional, sport-transfer lifts (squats, deadlifts, presses, Olympic lift variations, plyometrics, sled work, medicine ball throws, etc.) over isolation/machine work, and explain briefly in each description how the lift transfers to the sport.',
    'Each session must have a genuinely different emphasis from the others (e.g. one day lower-body/power focused, another day upper-body/pulling focused, another day full-body explosive work) rather than repeating identical lifts every session.',
    'Warm-up should be light, dynamic movement prep for lifting (not sport skill drills).',
    'Each exercise needs a clear name, a short description, sets/reps or a duration, and the exact equipment it personally needs.',
    'Give each session a short dayLabel like "Weight Room Day 1", "Weight Room Day 2", etc. in order, plus a one or two word focus label (e.g. "Lower Body", "Power").',
  ];

  if (Array.isArray(weightRoomGoals) && weightRoomGoals.length > 0) {
    lines.push(`Focus on these specific goals across the week: ${weightRoomGoals.join(', ')}.`);
  }

  if (Array.isArray(players) && players.length > 0) {
    lines.push(
      `The athlete wants their physical training to reflect ${players.join(
        ' and '
      )}'s known athletic profile where genuinely relevant. Do not fabricate specific stats, routines, or claims you are not confident are publicly accurate.`
    );
  }

  if (recentHistory) {
    lines.push(
      `Recent training history for this athlete, for context — use it to adapt intelligently (adjust difficulty up or down, avoid repeating the same exercises, keep it motivating): ${recentHistory}`
    );
  }

  return lines.join('\n');
}

app.post('/generate-plan', generatePlanLimiter, async (req, res) => {
  const { sport, skills, positions, level, equipment, timeMinutes, players, weightRoomGoals, recentHistory } = req.body || {};

  if (!sport || !Array.isArray(skills) || skills.length === 0 || !level || !Array.isArray(equipment) || !timeMinutes) {
    return res.status(400).json({ error: 'Missing or invalid request fields.' });
  }

  try {
    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      tools: [PLAN_TOOL],
      tool_choice: { type: 'tool', name: 'create_workout_plan' },
      messages: [
        {
          role: 'user',
          content: buildPrompt({ sport, skills, positions, level, equipment, timeMinutes, players, weightRoomGoals, recentHistory }),
        },
      ],
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
      weightRoom: withIds(plan.weightRoom, 'weightroom'),
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
  const {
    sport,
    skills,
    positions,
    level,
    equipment,
    timeMinutes,
    players,
    onCourtDays,
    weightRoomDays,
    weightRoomGoals,
    recentHistory,
  } = req.body || {};

  if (
    !sport ||
    !Array.isArray(skills) ||
    skills.length === 0 ||
    !level ||
    !Array.isArray(equipment) ||
    !timeMinutes ||
    !onCourtDays
  ) {
    return res.status(400).json({ error: 'Missing or invalid request fields.' });
  }

  const withIds = (list, prefix) =>
    (list || []).map((exercise, index) => ({
      id: `${prefix}_${index}`,
      equipment: [],
      ...exercise,
    }));

  try {
    const sessions = [];

    const onCourtMessage = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 8192,
      tools: [ON_COURT_SCHEDULE_TOOL],
      tool_choice: { type: 'tool', name: 'create_on_court_schedule' },
      messages: [
        {
          role: 'user',
          content: buildOnCourtSchedulePrompt({
            sport,
            skills,
            positions,
            level,
            equipment,
            players,
            timeMinutes,
            days: onCourtDays,
            recentHistory,
          }),
        },
      ],
    });

    const onCourtTool = onCourtMessage.content.find((block) => block.type === 'tool_use');
    if (!onCourtTool) {
      return res.status(502).json({ error: 'Model did not return a structured schedule.' });
    }

    (onCourtTool.input.sessions || []).forEach((session, index) => {
      sessions.push({
        dayLabel: session.dayLabel || `On-Court Day ${index + 1}`,
        title: session.title,
        focus: session.focus,
        sessionType: 'on_court',
        estimatedDurationMinutes: session.estimatedDurationMinutes,
        warmup: withIds(session.warmup, `oc_warmup_${index}`),
        exercises: withIds(session.exercises, `oc_exercise_${index}`),
        weightRoom: [],
        cooldown: withIds(session.cooldown, `oc_cooldown_${index}`),
      });
    });

    if (weightRoomDays > 0) {
      const wrMessage = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 8192,
        tools: [WEIGHT_ROOM_SCHEDULE_TOOL],
        tool_choice: { type: 'tool', name: 'create_weight_room_schedule' },
        messages: [
          {
            role: 'user',
            content: buildWeightRoomSchedulePrompt({
              sport,
              level,
              equipment,
              players,
              timeMinutes,
              days: weightRoomDays,
              weightRoomGoals,
              recentHistory,
            }),
          },
        ],
      });

      const wrTool = wrMessage.content.find((block) => block.type === 'tool_use');
      if (wrTool) {
        (wrTool.input.sessions || []).forEach((session, index) => {
          sessions.push({
            dayLabel: session.dayLabel || `Weight Room Day ${index + 1}`,
            title: session.title,
            focus: session.focus,
            sessionType: 'weight_room',
            estimatedDurationMinutes: session.estimatedDurationMinutes,
            warmup: withIds(session.warmup, `wr_warmup_${index}`),
            exercises: [],
            weightRoom: withIds(session.weightRoom, `wr_weightroom_${index}`),
            cooldown: withIds(session.cooldown, `wr_cooldown_${index}`),
          });
        });
      }
    }

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
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'legal', 'privacy.html')));

const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));
app.use((req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`nextrep-server listening on http://localhost:${PORT}`);
});
