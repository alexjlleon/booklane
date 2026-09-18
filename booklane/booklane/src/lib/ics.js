'use strict';
const fmt = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const escTxt = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
function fold(line) { const out = []; while (line.length > 74) { out.push(line.slice(0, 74)); line = ' ' + line.slice(74); } out.push(line); return out.join('\r\n'); }

function buildIcs({ uid, start, end, summary, description, location, organizerName, organizerEmail, attendeeName, attendeeEmail, method = 'REQUEST', sequence = 0, cancelled = false, url }) {
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Booklane//Scheduling//EN', 'CALSCALE:GREGORIAN', `METHOD:${cancelled ? 'CANCEL' : method}`,
    'BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${fmt(Date.now())}`, `DTSTART:${fmt(start)}`, `DTEND:${fmt(end)}`, `SEQUENCE:${sequence}`,
    `SUMMARY:${escTxt(summary)}`, `DESCRIPTION:${escTxt(description)}`, location ? `LOCATION:${escTxt(location)}` : null,
    url ? `URL:${escTxt(url)}` : null,
    organizerEmail ? `ORGANIZER;CN=${escTxt(organizerName)}:mailto:${organizerEmail}` : null,
    attendeeEmail ? `ATTENDEE;CN=${escTxt(attendeeName)};ROLE=REQ-PARTICIPANT;RSVP=FALSE:mailto:${attendeeEmail}` : null,
    `STATUS:${cancelled ? 'CANCELLED' : 'CONFIRMED'}`,
    'BEGIN:VALARM', 'TRIGGER:-PT15M', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ].filter(Boolean);
  return lines.map(fold).join('\r\n') + '\r\n';
}

function googleCalendarLink({ start, end, summary, description, location }) {
  const p = new URLSearchParams({ action: 'TEMPLATE', text: summary, dates: `${fmt(start)}/${fmt(end)}`, details: description || '', location: location || '' });
  return `https://calendar.google.com/calendar/render?${p}`;
}

module.exports = { buildIcs, googleCalendarLink };
