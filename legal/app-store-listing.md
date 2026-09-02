# NextRep — App Store Listing Draft

## App name (30 char max)
NextRep

## Subtitle (30 char max)
AI Sports Training Plans

## Promotional text (170 char max, editable anytime without review)
Get a personalized practice plan or full weekly schedule for your sport in seconds — built around your skills, position, equipment, and goals.

## Description

NextRep builds personalized training plans for your sport — instantly, and tailored to exactly what you need.

Pick your sport, the skills you want to work on, your position, your level, the equipment you have, and how much time you've got. NextRep generates a complete session: warm-up, drills, and cool-down — or a full weekly schedule with dedicated on-court skill days and weight room strength days, built specifically for athletic performance.

FEATURES
• Single workout or full weekly schedule generation
• Sport-specific skill and position targeting across basketball, soccer, tennis, football, volleyball, baseball, running, and swimming
• Athletic performance-focused weight room programming (explosive power, max strength, speed & agility, and more) — not bodybuilding
• Model your training after a favorite player's known style and signature moves
• Guided hands-free sessions with optional voice narration and rest countdowns
• Track streaks, workouts, and progress with unlockable challenges
• Log game stats and combine-style performance benchmarks (vertical jump, sprint times, and more) to prove you're improving
• Rate and review past sessions, with full workout history
• Edit any generated plan to make it your own
• Export your full training history as a backup anytime
• No account required — everything stays on your device

Whether you're preparing for a season, working on a specific weakness, or just want a smarter way to train, NextRep adapts to you and gets better the more you use it.

## Keywords (100 char max, comma-separated, no spaces after commas)
workout,training,sports,coach,basketball,soccer,tennis,fitness,schedule,drills,practice,athlete

## Support URL
(needs a real URL you control — e.g. a GitHub repo issues page, or add a /support page like /privacy)

## Marketing URL (optional)
https://nextrep-server.onrender.com

## Privacy Policy URL (required)
https://nextrep-server.onrender.com/privacy

## Category
Primary: Health & Fitness
Secondary: Sports

## Age rating
4+ (no objectionable content; links out to YouTube search results for demos, which may bump this to 12+ depending on how Apple's questionnaire treats "unrestricted web access" — using in-app links rather than an embedded browser keeps this minimal, but review this during the age rating questionnaire in App Store Connect)

## App Privacy (App Store Connect "Privacy Nutrition Label" questionnaire)
Based on how the app actually works:
- Data collected: None that is linked to the user's identity (no accounts, no analytics/tracking SDKs)
- Data used to track you: No
- On-device data (plans, history, ratings, stats) never leaves the device except your own manual export
- Generation requests (sport/skill/equipment selections) are sent to the backend to generate content via the Claude API, but are not stored server-side or tied to an identifier

## What's needed before this can actually be submitted (not something I can do for you)
1. An active Apple Developer Program membership ($99/year) — apple.com/developer
2. App icons/screenshots sized per Apple's current requirements, generated from a real device or simulator build (blocked until Xcode is installed — see below)
3. A support URL you control (a simple page or repo issues link)
4. A build produced via `eas build --platform ios` (or a local Xcode archive) and submitted via `eas submit` or Transporter — both require your Apple ID credentials, which I should not handle on your behalf
