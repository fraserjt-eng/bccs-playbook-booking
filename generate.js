const fs = require('fs');
const path = require('path');
const IcalExpander = require('ical-expander');

// Load .env manually (no dotenv dependency needed)
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const match = line.match(/^([^=]+)=(.*)$/);
    if (match) process.env[match[1].trim()] = match[2].trim();
  });
}

const ICAL_URL = process.env.ICAL_URL;
if (!ICAL_URL) {
  console.error('Missing ICAL_URL in .env');
  process.exit(1);
}

const TIMEZONE = 'America/New_York';
const DATE_END = new Date('2026-04-01T00:00:00Z');

const SESSION_TYPES = {
  'quick-checkin': {
    name: 'Quick Check-in',
    duration: 15,
    buffer: 5,
    days: [1, 2, 3, 4, 5],
    startHour: 8, startMin: 0,
    endHour: 16, endMin: 0,
    maxPerDay: 6,
    leadTimeHours: 4,
    description: 'Quick questions, status updates, or minor clarifications. Get in, get answers, get back to work.'
  },
  'standard-checkin': {
    name: 'Standard Check-in',
    duration: 30,
    buffer: 10,
    days: [1, 2, 3, 4, 5],
    startHour: 8, startMin: 0,
    endHour: 16, endMin: 0,
    maxPerDay: 4,
    leadTimeHours: 4,
    description: 'Regular progress check, discuss next steps, review recent data. The go-to session for most needs.'
  },
  'working-session': {
    name: 'Working Session',
    duration: 60,
    buffer: 15,
    days: [1, 2, 3, 4, 5],
    startHour: 8, startMin: 30,
    endHour: 15, endMin: 0,
    maxPerDay: 2,
    leadTimeHours: 24,
    description: 'Collaborative work on Playbook tasks, deeper problem-solving, or building out a plan together.'
  },
  'deep-dive': {
    name: 'Deep Dive',
    duration: 120,
    buffer: 15,
    days: [2, 3, 4],
    startHour: 9, startMin: 0,
    endHour: 14, endMin: 0,
    maxPerDay: 1,
    leadTimeHours: 48,
    description: 'Comprehensive planning, complex problem-solving, or team facilitation for bigger initiatives.'
  }
};

const DURATION_LABELS = {
  'quick-checkin': '15 min',
  'standard-checkin': '30 min',
  'working-session': '1 hour',
  'deep-dive': '2 hours'
};

// --- Timezone helpers ---

function toEasternParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short'
  }).formatToParts(date);
  const get = (type) => parts.find(p => p.type === type)?.value;
  return {
    year: parseInt(get('year')),
    month: parseInt(get('month')),
    day: parseInt(get('day')),
    hour: parseInt(get('hour')) % 24,
    minute: parseInt(get('minute')),
    weekday: get('weekday'),
    dayOfWeek: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'))
  };
}

function easternDateKey(date) {
  const p = toEasternParts(date);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

function formatTime12(date) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    hour: 'numeric', minute: '2-digit', hour12: true
  }).format(date);
}

function formatDateLong(date) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    weekday: 'long', month: 'long', day: 'numeric'
  }).format(date);
}

function formatWeekOf(date) {
  // Find Monday of this week
  const p = toEasternParts(date);
  const mondayOffset = (p.dayOfWeek === 0 ? -6 : 1) - p.dayOfWeek;
  const monday = new Date(date.getTime() + mondayOffset * 86400000);
  return 'Week of ' + new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    month: 'long', day: 'numeric'
  }).format(monday);
}

function getWeekKey(date) {
  const p = toEasternParts(date);
  const mondayOffset = (p.dayOfWeek === 0 ? -6 : 1) - p.dayOfWeek;
  const monday = new Date(date.getTime() + mondayOffset * 86400000);
  return easternDateKey(monday);
}

// Create a date in Eastern time
function easternDate(year, month, day, hour, minute) {
  // Create a date string and let the formatter figure out the UTC offset
  const guess = new Date(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`);
  // Adjust: figure out what Eastern time this guess corresponds to
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });
  // Use iterative approach: create a UTC date and adjust
  // Start with UTC assumption, then correct
  let d = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  const p = toEasternParts(d);
  const hourDiff = hour - p.hour;
  const minDiff = minute - p.minute;
  d = new Date(d.getTime() + (hourDiff * 60 + minDiff) * 60000);
  // Verify
  const check = toEasternParts(d);
  if (check.hour !== hour || check.minute !== minute) {
    // DST edge case - try one more adjustment
    const hourDiff2 = hour - check.hour;
    const minDiff2 = minute - check.minute;
    d = new Date(d.getTime() + (hourDiff2 * 60 + minDiff2) * 60000);
  }
  return d;
}

function toGoogleDateStr(date) {
  const p = toEasternParts(date);
  return `${p.year}${String(p.month).padStart(2, '0')}${String(p.day).padStart(2, '0')}T${String(p.hour).padStart(2, '0')}${String(p.minute).padStart(2, '0')}00`;
}

// --- Pre-filter iCal data to reduce memory usage ---

function filterIcsData(rawData) {
  // Split into lines, extract VCALENDAR header/footer and individual VEVENTs
  // Keep: VEVENTs with RRULE (recurring - might have future instances)
  // Keep: VEVENTs with DTSTART in 2026 (Jan onwards for safety)
  // Drop: Old non-recurring VEVENTs

  const lines = rawData.split(/\r?\n/);
  const header = []; // Everything before first VEVENT
  const footer = []; // END:VCALENDAR
  const relevantEvents = [];

  let inEvent = false;
  let currentEvent = [];
  let inHeader = true;

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      inEvent = true;
      inHeader = false;
      currentEvent = [line];
    } else if (line === 'END:VEVENT') {
      currentEvent.push(line);
      inEvent = false;

      // Decide whether to keep this event
      const eventText = currentEvent.join('\n');
      const hasRRule = eventText.includes('RRULE:');
      let keep = false;

      if (hasRRule) {
        // Always keep recurring events - they might have instances in our range
        // But check if RRULE has an UNTIL that's before 2026
        const untilMatch = eventText.match(/UNTIL=(\d{8})/);
        if (untilMatch) {
          const untilYear = parseInt(untilMatch[1].substring(0, 4));
          keep = untilYear >= 2026;
        } else {
          keep = true; // No UNTIL = still recurring
        }
      } else {
        // Non-recurring: check DTSTART year
        const dtstartMatch = eventText.match(/DTSTART[^:]*:(\d{4})/);
        if (dtstartMatch) {
          const year = parseInt(dtstartMatch[1]);
          keep = year >= 2026;
        }
      }

      if (keep) {
        relevantEvents.push(currentEvent.join('\r\n'));
      }
      currentEvent = [];
    } else if (inEvent) {
      currentEvent.push(line);
    } else if (inHeader) {
      header.push(line);
    }
  }

  // Rebuild the ICS with only relevant events
  // Make sure we have the VCALENDAR wrapper
  let headerStr = header.join('\r\n');
  if (!headerStr.includes('BEGIN:VCALENDAR')) {
    headerStr = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\n' + headerStr;
  }

  const result = headerStr + '\r\n' +
    relevantEvents.join('\r\n') + '\r\n' +
    'END:VCALENDAR';

  return result;
}

// --- Main ---

async function main() {
  console.log('Fetching calendar data...');
  const response = await fetch(ICAL_URL);
  if (!response.ok) {
    console.error(`Failed to fetch calendar: ${response.status} ${response.statusText}`);
    process.exit(1);
  }
  const rawIcsData = await response.text();
  console.log(`Fetched ${(rawIcsData.length / 1024 / 1024).toFixed(1)} MB of iCal data`);

  // Pre-filter: keep only VEVENTs that could have instances in our date range
  // This drastically reduces memory for large calendars with years of history
  const icsData = filterIcsData(rawIcsData);
  console.log(`Filtered to ${(icsData.length / 1024).toFixed(0)} KB of relevant iCal data`);

  const now = new Date();
  const icalExpander = new IcalExpander({ ics: icsData, maxIterations: 2000 });
  const result = icalExpander.between(now, DATE_END);

  // Build busy times array
  const busyTimes = [
    ...result.events.map(e => ({
      start: e.startDate.toJSDate(),
      end: e.endDate.toJSDate()
    })),
    ...result.occurrences.map(o => ({
      start: o.startDate.toJSDate(),
      end: o.endDate.toJSDate()
    }))
  ].sort((a, b) => a.start - b.start);

  console.log(`Found ${busyTimes.length} calendar events in range`);

  // Generate slots for each session type
  const allSlots = {};

  for (const [typeKey, config] of Object.entries(SESSION_TYPES)) {
    const slots = [];
    const leadCutoff = new Date(now.getTime() + config.leadTimeHours * 3600000);

    // Iterate day by day
    let currentDay = new Date(now);
    // Move to start of today in Eastern
    const todayParts = toEasternParts(currentDay);
    currentDay = easternDate(todayParts.year, todayParts.month, todayParts.day, 0, 0);

    while (currentDay < DATE_END) {
      const dayParts = toEasternParts(currentDay);

      // Check if this day of week is allowed
      if (config.days.includes(dayParts.dayOfWeek)) {
        let dayCount = 0;

        // Generate candidates at 15-min intervals
        let slotHour = config.startHour;
        let slotMin = config.startMin;

        while (dayCount < config.maxPerDay) {
          // Check if slot end time would exceed the window
          const totalMinutes = slotHour * 60 + slotMin + config.duration;
          const endLimitMinutes = config.endHour * 60 + config.endMin;
          if (totalMinutes > endLimitMinutes) break;
          if (slotHour * 60 + slotMin >= endLimitMinutes) break;

          const slotStart = easternDate(dayParts.year, dayParts.month, dayParts.day, slotHour, slotMin);
          const slotEnd = new Date(slotStart.getTime() + config.duration * 60000);

          // Skip if before lead time cutoff
          if (slotStart >= leadCutoff) {
            // Check for conflicts (with buffer)
            const checkStart = new Date(slotStart.getTime() - config.buffer * 60000);
            const checkEnd = new Date(slotEnd.getTime() + config.buffer * 60000);

            const hasConflict = busyTimes.some(busy =>
              checkStart < busy.end && checkEnd > busy.start
            );

            if (!hasConflict) {
              slots.push({
                start: slotStart,
                end: slotEnd,
                label: formatTime12(slotStart),
                dateKey: easternDateKey(slotStart),
                dateLong: formatDateLong(slotStart),
                weekLabel: formatWeekOf(slotStart),
                weekKey: getWeekKey(slotStart),
                googleStart: toGoogleDateStr(slotStart),
                googleEnd: toGoogleDateStr(slotEnd)
              });
              dayCount++;
            }
          }

          // Advance by 15 minutes
          slotMin += 15;
          if (slotMin >= 60) {
            slotHour += Math.floor(slotMin / 60);
            slotMin = slotMin % 60;
          }
        }
      }

      // Next day
      currentDay = new Date(currentDay.getTime() + 86400000);
    }

    allSlots[typeKey] = slots;
    console.log(`${config.name}: ${slots.length} available slots`);
  }

  // Group slots by week and date for each type
  const groupedSlots = {};
  for (const [typeKey, slots] of Object.entries(allSlots)) {
    const weeks = new Map();
    for (const slot of slots) {
      if (!weeks.has(slot.weekKey)) {
        weeks.set(slot.weekKey, { label: slot.weekLabel, dates: new Map() });
      }
      const week = weeks.get(slot.weekKey);
      if (!week.dates.has(slot.dateKey)) {
        week.dates.set(slot.dateKey, { label: slot.dateLong, slots: [] });
      }
      week.dates.get(slot.dateKey).slots.push(slot);
    }
    groupedSlots[typeKey] = weeks;
  }

  // Build slot picker HTML
  let slotPickerHTML = '';
  for (const [typeKey, weeks] of Object.entries(groupedSlots)) {
    let sectionHTML = `<div class="slot-section" data-type="${typeKey}" style="display:none;">`;
    if (weeks.size === 0) {
      sectionHTML += '<p class="no-slots">No available slots for this session type right now.</p>';
    }
    for (const [weekKey, week] of weeks) {
      sectionHTML += `<div class="week-group"><h3 class="week-header">${week.label}</h3>`;
      for (const [dateKey, day] of week.dates) {
        sectionHTML += `<div class="date-group"><h4 class="date-header">${day.label}</h4><div class="slot-buttons">`;
        for (const slot of day.slots) {
          sectionHTML += `<button class="slot-btn" data-start="${slot.googleStart}" data-end="${slot.googleEnd}" data-type="${typeKey}" data-name="${SESSION_TYPES[typeKey].name}" data-date-long="${day.label}" data-time="${slot.label}">${slot.label}</button>`;
        }
        sectionHTML += '</div></div>';
      }
      sectionHTML += '</div>';
    }
    sectionHTML += '</div>';
    slotPickerHTML += sectionHTML;
  }

  // Slot data summary for JSON embed
  const slotCounts = {};
  for (const [k, v] of Object.entries(allSlots)) {
    slotCounts[k] = v.length;
  }

  const generatedAt = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true
  }).format(now);

  // Build full HTML
  const html = buildHTML(slotPickerHTML, generatedAt, slotCounts);

  fs.writeFileSync(path.join(__dirname, 'index.html'), html);
  console.log(`\nGenerated index.html (${(html.length / 1024).toFixed(1)} KB)`);
  console.log(`Slots: Quick=${slotCounts['quick-checkin']}, Standard=${slotCounts['standard-checkin']}, Working=${slotCounts['working-session']}, Deep=${slotCounts['deep-dive']}`);
}

function buildHTML(slotPickerHTML, generatedAt, slotCounts) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>BCCS Playbook Support Sessions</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Oswald:wght@400;500;600;700&family=Open+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
    <style>
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        :root {
            --purple: #7B68EE;
            --dark-purple: #5B4ACF;
            --gold: #FFD700;
            --teal: #2A9D8F;
            --white: #FFFFFF;
            --light-gray: #F8F9FA;
            --gray: #6B7280;
            --dark: #1F2937;
        }

        body { font-family: 'Open Sans', sans-serif; color: var(--dark); line-height: 1.6; background: var(--white); }
        h1, h2, h3, h4, h5, h6 { font-family: 'Oswald', sans-serif; line-height: 1.2; }

        .hero {
            background: linear-gradient(135deg, #7B68EE 0%, #5B4ACF 100%);
            color: var(--white); text-align: center; padding: 4rem 1.5rem;
            position: relative; overflow: hidden;
        }
        .hero::before {
            content: ''; position: absolute; top: -50%; left: -50%; width: 200%; height: 200%;
            background: radial-gradient(circle, rgba(255,255,255,0.05) 0%, transparent 70%); pointer-events: none;
        }
        .hero h1 { font-size: 2.8rem; font-weight: 700; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 1rem; position: relative; }
        .hero p { font-size: 1.2rem; max-width: 600px; margin: 0 auto; opacity: 0.95; position: relative; }
        .hero .badge {
            display: inline-block; background: var(--gold); color: var(--dark);
            font-family: 'Oswald', sans-serif; font-size: 0.85rem; font-weight: 600;
            text-transform: uppercase; letter-spacing: 1px; padding: 0.35rem 1rem;
            border-radius: 50px; margin-bottom: 1.5rem; position: relative;
        }

        .container { max-width: 1100px; margin: 0 auto; padding: 0 1.5rem; }
        section { padding: 4rem 0; }

        .section-title { font-size: 2rem; text-transform: uppercase; letter-spacing: 1px; text-align: center; margin-bottom: 0.5rem; color: var(--dark-purple); }
        .section-subtitle { text-align: center; color: var(--gray); margin-bottom: 3rem; font-size: 1.05rem; }

        .session-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 1.5rem; }
        .session-card {
            background: var(--white); border: 2px solid #E5E7EB; border-radius: 12px;
            padding: 2rem 1.5rem; text-align: center;
            transition: transform 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
            display: flex; flex-direction: column; cursor: pointer;
        }
        .session-card:hover { transform: translateY(-4px); border-color: var(--purple); box-shadow: 0 8px 24px rgba(123, 104, 238, 0.15); }
        .session-card.active { border-color: var(--purple); box-shadow: 0 8px 24px rgba(123, 104, 238, 0.15); }
        .session-card .duration {
            display: inline-block; background: linear-gradient(135deg, #7B68EE 0%, #5B4ACF 100%);
            color: var(--white); font-family: 'Oswald', sans-serif; font-size: 0.85rem; font-weight: 600;
            text-transform: uppercase; letter-spacing: 1px; padding: 0.3rem 0.9rem;
            border-radius: 50px; margin-bottom: 1rem;
        }
        .session-card h3 { font-size: 1.3rem; margin-bottom: 0.75rem; color: var(--dark); }
        .session-card p { color: var(--gray); font-size: 0.95rem; margin-bottom: 1.5rem; flex-grow: 1; }

        .btn {
            display: inline-block; font-family: 'Oswald', sans-serif; font-weight: 600; font-size: 1rem;
            text-transform: uppercase; letter-spacing: 1px; text-decoration: none;
            padding: 0.75rem 2rem; border-radius: 8px;
            transition: transform 0.15s ease, box-shadow 0.15s ease; cursor: pointer; border: none;
        }
        .btn:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0,0,0,0.15); }
        .btn-purple { background: linear-gradient(135deg, #7B68EE 0%, #5B4ACF 100%); color: var(--white); }
        .btn-gold { background: var(--gold); color: var(--dark); }
        .btn-outline { background: transparent; border: 2px solid var(--purple); color: var(--purple); }
        .btn-outline:hover { background: var(--purple); color: var(--white); }

        /* Slot Picker */
        .slot-picker { background: var(--white); }
        .tab-bar { display: flex; flex-wrap: wrap; gap: 0.5rem; justify-content: center; margin-bottom: 2rem; }
        .tab-btn {
            font-family: 'Oswald', sans-serif; font-weight: 500; font-size: 0.95rem;
            text-transform: uppercase; letter-spacing: 0.5px; padding: 0.6rem 1.2rem;
            border-radius: 8px; border: 2px solid var(--purple); background: transparent;
            color: var(--purple); cursor: pointer; transition: all 0.15s ease;
        }
        .tab-btn:hover { background: rgba(123, 104, 238, 0.1); }
        .tab-btn.active { background: linear-gradient(135deg, #7B68EE 0%, #5B4ACF 100%); color: var(--white); border-color: transparent; }

        .week-group { margin-bottom: 2rem; }
        .week-header {
            font-size: 1.2rem; color: var(--dark-purple); text-transform: uppercase; letter-spacing: 1px;
            border-bottom: 2px solid #E5E7EB; padding-bottom: 0.5rem; margin-bottom: 1rem;
        }
        .date-group { margin-bottom: 1.25rem; }
        .date-header { font-size: 1rem; color: var(--dark); margin-bottom: 0.5rem; font-weight: 500; }
        .slot-buttons { display: flex; flex-wrap: wrap; gap: 0.5rem; }
        .slot-btn {
            font-family: 'Open Sans', sans-serif; font-size: 0.85rem; font-weight: 600;
            padding: 0.45rem 0.9rem; border-radius: 6px; border: 1.5px solid var(--purple);
            background: transparent; color: var(--purple); cursor: pointer;
            transition: all 0.15s ease;
        }
        .slot-btn:hover { background: var(--purple); color: var(--white); transform: translateY(-1px); box-shadow: 0 2px 8px rgba(123,104,238,0.25); }
        .no-slots { text-align: center; color: var(--gray); font-style: italic; padding: 2rem 0; }

        /* Modal */
        .modal-overlay {
            display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background: rgba(0,0,0,0.5); z-index: 1000; align-items: center; justify-content: center;
        }
        .modal-overlay.open { display: flex; }
        .modal {
            background: var(--white); border-radius: 12px; padding: 2rem;
            max-width: 480px; width: 90%; max-height: 90vh; overflow-y: auto;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
        }
        .modal h3 { font-size: 1.4rem; margin-bottom: 0.25rem; color: var(--dark-purple); }
        .modal .modal-subtitle { color: var(--gray); margin-bottom: 1.5rem; font-size: 0.95rem; }
        .modal label { display: block; font-weight: 600; font-size: 0.9rem; margin-bottom: 0.3rem; color: var(--dark); }
        .modal label .required { color: #E74C3C; }
        .modal input[type="text"], .modal textarea {
            width: 100%; padding: 0.6rem 0.8rem; border: 1.5px solid #D1D5DB; border-radius: 6px;
            font-family: 'Open Sans', sans-serif; font-size: 0.95rem; margin-bottom: 1rem;
            transition: border-color 0.15s ease;
        }
        .modal input[type="text"]:focus, .modal textarea:focus { outline: none; border-color: var(--purple); }
        .modal textarea { resize: vertical; min-height: 60px; }
        .modal .checkbox-row { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1rem; }
        .modal .checkbox-row input { width: 18px; height: 18px; accent-color: var(--purple); }
        .modal .checkbox-row label { margin-bottom: 0; font-weight: 400; }
        .modal .modal-actions { display: flex; gap: 0.75rem; margin-top: 1.5rem; }
        .modal .modal-actions .btn { flex: 1; text-align: center; }
        .modal .error-msg { color: #E74C3C; font-size: 0.85rem; margin-top: -0.75rem; margin-bottom: 0.75rem; display: none; }

        /* FAQ */
        .faq { background: var(--light-gray); }
        .faq-list { max-width: 750px; margin: 0 auto; }
        .faq-item { background: var(--white); border-radius: 10px; margin-bottom: 1rem; overflow: hidden; box-shadow: 0 1px 4px rgba(0,0,0,0.05); }
        .faq-question {
            width: 100%; background: none; border: none; text-align: left; padding: 1.25rem 1.5rem;
            font-family: 'Oswald', sans-serif; font-size: 1.1rem; font-weight: 500; color: var(--dark);
            cursor: pointer; display: flex; justify-content: space-between; align-items: center;
        }
        .faq-question::after { content: '+'; font-size: 1.4rem; color: var(--purple); transition: transform 0.2s ease; flex-shrink: 0; margin-left: 1rem; }
        .faq-item.open .faq-question::after { content: '\\2212'; }
        .faq-answer { max-height: 0; overflow: hidden; transition: max-height 0.3s ease; }
        .faq-answer-inner { padding: 0 1.5rem 1.25rem; color: var(--gray); font-size: 0.95rem; line-height: 1.7; }
        .faq-item.open .faq-answer { max-height: 300px; }

        footer {
            background: var(--dark); color: rgba(255,255,255,0.7); text-align: center; padding: 2.5rem 1.5rem;
        }
        footer .footer-brand {
            font-family: 'Oswald', sans-serif; font-size: 1.3rem; font-weight: 600; color: var(--white);
            text-transform: uppercase; letter-spacing: 2px; margin-bottom: 0.5rem;
        }
        footer p { font-size: 0.9rem; }
        footer .updated { font-size: 0.8rem; margin-top: 0.5rem; opacity: 0.6; }
        footer .teal-bar { width: 60px; height: 3px; background: var(--teal); margin: 1rem auto 0; border-radius: 2px; }

        @media (max-width: 768px) {
            .hero { padding: 3rem 1.25rem; }
            .hero h1 { font-size: 2rem; }
            .hero p { font-size: 1.05rem; }
            section { padding: 3rem 0; }
            .section-title { font-size: 1.6rem; }
            .session-grid { grid-template-columns: 1fr; max-width: 400px; margin-left: auto; margin-right: auto; }
            .tab-bar { gap: 0.4rem; }
            .tab-btn { font-size: 0.8rem; padding: 0.5rem 0.8rem; }
            .modal { padding: 1.5rem; }
        }
    </style>
</head>
<body>

    <header class="hero">
        <div class="container">
            <div class="badge">BCCS Leadership</div>
            <h1>Playbook Support Sessions</h1>
            <p>Book dedicated time with Josh Fraser to work through your Playbook questions, review progress, and plan next steps.</p>
        </div>
    </header>

    <section class="sessions">
        <div class="container">
            <h2 class="section-title">Session Types</h2>
            <p class="section-subtitle">Choose the session that best fits what you need right now.</p>
            <div class="session-grid">
                <div class="session-card" data-target="quick-checkin">
                    <span class="duration">15 min</span>
                    <h3>Quick Check-in</h3>
                    <p>Quick questions, status updates, or minor clarifications. Get in, get answers, get back to work.</p>
                    <span class="btn btn-outline">Select Times</span>
                </div>
                <div class="session-card" data-target="standard-checkin">
                    <span class="duration">30 min</span>
                    <h3>Standard Check-in</h3>
                    <p>Regular progress check, discuss next steps, review recent data. The go-to session for most needs.</p>
                    <span class="btn btn-outline">Select Times</span>
                </div>
                <div class="session-card" data-target="working-session">
                    <span class="duration">1 hour</span>
                    <h3>Working Session</h3>
                    <p>Collaborative work on Playbook tasks, deeper problem-solving, or building out a plan together.</p>
                    <span class="btn btn-outline">Select Times</span>
                </div>
                <div class="session-card" data-target="deep-dive">
                    <span class="duration">2 hours</span>
                    <h3>Deep Dive</h3>
                    <p>Comprehensive planning, complex problem-solving, or team facilitation for bigger initiatives.</p>
                    <span class="btn btn-outline">Select Times</span>
                </div>
            </div>
        </div>
    </section>

    <section class="slot-picker" id="booking">
        <div class="container">
            <h2 class="section-title">Pick a Time</h2>
            <p class="section-subtitle">Select an available time slot below.</p>
            <div class="tab-bar">
                <button class="tab-btn active" data-type="quick-checkin">Quick Check-in</button>
                <button class="tab-btn" data-type="standard-checkin">Standard Check-in</button>
                <button class="tab-btn" data-type="working-session">Working Session</button>
                <button class="tab-btn" data-type="deep-dive">Deep Dive</button>
            </div>
            ${slotPickerHTML}
        </div>
    </section>

    <div class="modal-overlay" id="bookingModal">
        <div class="modal">
            <h3 id="modalTitle"></h3>
            <p class="modal-subtitle" id="modalSubtitle"></p>
            <form id="bookingForm">
                <label>Playbook Area(s) <span class="required">*</span></label>
                <input type="text" id="fieldPlaybook" placeholder="e.g., Teaching & Learning, Culture" required>
                <div class="error-msg" id="errPlaybook">Please enter the Playbook area(s) you want to discuss.</div>

                <label>Building / Site <span class="required">*</span></label>
                <input type="text" id="fieldBuilding" placeholder="e.g., Lincoln Elementary" required>
                <div class="error-msg" id="errBuilding">Please enter your building or site.</div>

                <div class="checkbox-row">
                    <input type="checkbox" id="fieldFacilitator">
                    <label for="fieldFacilitator">I need a facilitator for my staffing team</label>
                </div>

                <label>Notes (optional)</label>
                <textarea id="fieldNotes" placeholder="Anything else Josh should know beforehand?"></textarea>

                <div class="modal-actions">
                    <button type="button" class="btn btn-outline" id="modalCancel">Cancel</button>
                    <button type="submit" class="btn btn-purple">Open in Google Calendar</button>
                </div>
            </form>
        </div>
    </div>

    <section class="faq">
        <div class="container">
            <h2 class="section-title">Before You Book</h2>
            <p class="section-subtitle">A few things to know.</p>
            <div class="faq-list">
                <div class="faq-item">
                    <button class="faq-question">Which session type should I choose?</button>
                    <div class="faq-answer">
                        <div class="faq-answer-inner">
                            <strong>Quick Check-in (15 min)</strong> - You have a specific question or need a quick status update.<br>
                            <strong>Standard Check-in (30 min)</strong> - You want to review progress, discuss next steps, or talk through a decision. This is the best default choice.<br>
                            <strong>Working Session (1 hour)</strong> - You need to actually build something out together, like drafting a plan or working through a process.<br>
                            <strong>Deep Dive (2 hours)</strong> - You're tackling something complex that needs extended focus, or you want facilitation with your team.
                        </div>
                    </div>
                </div>
                <div class="faq-item">
                    <button class="faq-question">Can I reschedule or cancel?</button>
                    <div class="faq-answer">
                        <div class="faq-answer-inner">
                            Yes. Use the link in your calendar invite to reschedule or cancel. Please give at least 4 hours notice for Quick and Standard sessions, 24 hours for Working Sessions, and 48 hours for Deep Dives so the time can be opened up for others.
                        </div>
                    </div>
                </div>
                <div class="faq-item">
                    <button class="faq-question">What if I don't see any available times?</button>
                    <div class="faq-answer">
                        <div class="faq-answer-inner">
                            Email Josh directly at jfraser@bccs286.org and he'll send you a specific calendar invite.
                        </div>
                    </div>
                </div>
                <div class="faq-item">
                    <button class="faq-question">Will this be virtual or in-person?</button>
                    <div class="faq-answer">
                        <div class="faq-answer-inner">
                            Sessions default to Zoom (link included in the calendar invite). If you'd prefer to meet in person, note that in the booking form and we'll arrange it.
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </section>

    <footer>
        <div class="container">
            <div class="footer-brand">BCCS Playbook Support</div>
            <p>Helping BCCS leaders move the Playbook forward, one session at a time.</p>
            <p class="updated">Availability last updated: ${generatedAt}</p>
            <div class="teal-bar"></div>
        </div>
    </footer>

    <script>
        // Tab switching
        var tabs = document.querySelectorAll('.tab-btn');
        var sections = document.querySelectorAll('.slot-section');

        function activateTab(type) {
            tabs.forEach(function(t) { t.classList.toggle('active', t.getAttribute('data-type') === type); });
            sections.forEach(function(s) { s.style.display = s.getAttribute('data-type') === type ? 'block' : 'none'; });
            // Update card active state
            document.querySelectorAll('.session-card').forEach(function(c) {
                c.classList.toggle('active', c.getAttribute('data-target') === type);
            });
        }

        tabs.forEach(function(tab) {
            tab.addEventListener('click', function() { activateTab(this.getAttribute('data-type')); });
        });

        // Session card clicks
        document.querySelectorAll('.session-card').forEach(function(card) {
            card.addEventListener('click', function() {
                var type = this.getAttribute('data-target');
                activateTab(type);
                document.getElementById('booking').scrollIntoView({ behavior: 'smooth' });
            });
        });

        // Show first tab by default
        activateTab('quick-checkin');

        // Modal
        var modal = document.getElementById('bookingModal');
        var modalTitle = document.getElementById('modalTitle');
        var modalSubtitle = document.getElementById('modalSubtitle');
        var selectedSlot = null;

        document.querySelectorAll('.slot-btn').forEach(function(btn) {
            btn.addEventListener('click', function() {
                selectedSlot = {
                    start: this.getAttribute('data-start'),
                    end: this.getAttribute('data-end'),
                    type: this.getAttribute('data-type'),
                    name: this.getAttribute('data-name'),
                    dateLong: this.getAttribute('data-date-long'),
                    time: this.getAttribute('data-time')
                };
                modalTitle.textContent = 'Book: ' + selectedSlot.name;
                modalSubtitle.textContent = selectedSlot.dateLong + ' at ' + selectedSlot.time;
                modal.classList.add('open');
                document.getElementById('fieldPlaybook').value = '';
                document.getElementById('fieldBuilding').value = '';
                document.getElementById('fieldFacilitator').checked = false;
                document.getElementById('fieldNotes').value = '';
                document.querySelectorAll('.error-msg').forEach(function(e) { e.style.display = 'none'; });
            });
        });

        document.getElementById('modalCancel').addEventListener('click', function() {
            modal.classList.remove('open');
        });

        modal.addEventListener('click', function(e) {
            if (e.target === modal) modal.classList.remove('open');
        });

        document.getElementById('bookingForm').addEventListener('submit', function(e) {
            e.preventDefault();
            var playbook = document.getElementById('fieldPlaybook').value.trim();
            var building = document.getElementById('fieldBuilding').value.trim();
            var facilitator = document.getElementById('fieldFacilitator').checked;
            var notes = document.getElementById('fieldNotes').value.trim();

            var valid = true;
            if (!playbook) { document.getElementById('errPlaybook').style.display = 'block'; valid = false; }
            else { document.getElementById('errPlaybook').style.display = 'none'; }
            if (!building) { document.getElementById('errBuilding').style.display = 'block'; valid = false; }
            else { document.getElementById('errBuilding').style.display = 'none'; }
            if (!valid) return;

            var description = 'Playbook Area: ' + playbook + '\\nBuilding/Site: ' + building;
            if (facilitator) description += '\\nFacilitator Needed: Yes';
            if (notes) description += '\\n\\nNotes: ' + notes;
            description += '\\n\\n---\\nBooked via BCCS Playbook Support';
            description += '\\nJosh will confirm within 1 business day.';

            var params = new URLSearchParams({
                action: 'TEMPLATE',
                text: selectedSlot.name + ': Playbook Support (Josh Fraser)',
                dates: selectedSlot.start + '/' + selectedSlot.end,
                ctz: 'America/New_York',
                details: description,
                location: 'Zoom (link will be shared)',
                add: 'jfraser@bccs286.org'
            });

            window.open('https://calendar.google.com/calendar/render?' + params.toString(), '_blank');
            modal.classList.remove('open');
        });

        // FAQ Accordion
        document.querySelectorAll('.faq-question').forEach(function(btn) {
            btn.addEventListener('click', function() {
                var item = this.parentElement;
                var isOpen = item.classList.contains('open');
                document.querySelectorAll('.faq-item').forEach(function(el) { el.classList.remove('open'); });
                if (!isOpen) item.classList.add('open');
            });
        });
    </script>

</body>
</html>`;
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
