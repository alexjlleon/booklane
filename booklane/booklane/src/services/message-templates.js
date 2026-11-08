'use strict';
// Ready-made reminder automations, shared by every company on the platform.
//
// They live in code rather than in any one company's data, so every account sees the same
// library and an improvement here reaches everyone. Adding one copies it into that company's own
// automations (tagged with `template_key`), where it can be edited like anything else; editing a
// company's copy never changes the template.
//
// Writing rules for the copy:
//   - Texts use straight quotes and no emoji, so they stay in the cheaper GSM-7 encoding.
//   - Every text says how to opt out.
//   - Nothing names an industry, so the wording suits any business.
//   - Merge fields that can be empty carry a fallback, e.g. {{first_name|there}}.

const TEMPLATES = [
  {
    key: 'call-booked',
    name: 'Looking forward to chatting (when booked)',
    blurb: 'Goes out the moment someone books, so they know the call is set and who it is with.',
    trigger: 'booked', offset_min: 0,
    subject: "You're booked, {{first_name|there}}! Talk to you {{weekday}}",
    body_html: [
      'Hi {{first_name|there}},',
      'Thanks for booking time with us. We are looking forward to chatting with you on {{when}}.',
      'Where: {{location|We will send the details before the call.}}\nWith: {{host|our team}}',
      'If something comes up, you can move or cancel the call with the button below.',
      'Talk soon,\n{{business_name}}',
    ].join('\n\n'),
    sms_body: "Hi {{first_name|there}}, you're booked with {{business_name}} for {{weekday}} at {{time}}. We look forward to chatting with you! Need to change it? {{manage_url}} Reply STOP to opt out.",
  },
  {
    key: 'call-3-days',
    name: 'Call reminder, 3 days before',
    blurb: 'An early heads-up, so there is time to move the call if the day no longer works.',
    trigger: 'before', offset_min: 3 * 1440,
    subject: 'Coming up on {{weekday}}: your call with {{business_name}}',
    body_html: [
      'Hi {{first_name|there}},',
      'Just a heads-up that we have a call with you coming up on {{when}}.',
      'Where: {{location|We will send the details before the call.}}\nWith: {{host|our team}}',
      'If the day no longer works, you can pick a new time with the button below.',
      'Talk soon,\n{{business_name}}',
    ].join('\n\n'),
    sms_body: 'Hi {{first_name|there}}, a heads-up from {{business_name}}: we are chatting with you {{weekday}} at {{time}}. Need a different time? {{manage_url}} Reply STOP to opt out.',
  },
  {
    key: 'call-1-day',
    name: 'Call reminder, 1 day before',
    blurb: 'The classic day-before reminder.',
    trigger: 'before', offset_min: 1440,
    subject: 'Talk to you tomorrow, {{first_name|there}}',
    body_html: [
      'Hi {{first_name|there}},',
      'A quick reminder that we are chatting with you tomorrow, {{when}}.',
      'Where: {{location|We will send the details before the call.}}\nWith: {{host|our team}}',
      'If you have questions you would like us to cover, just reply to this email and we will come ready.',
      'See you then,\n{{business_name}}',
    ].join('\n\n'),
    sms_body: 'Hi {{first_name|there}}, reminder: your call with {{business_name}} is tomorrow at {{time}}. Need to change it? {{manage_url}} Reply STOP to opt out.',
  },
  {
    key: 'call-2-hours',
    name: 'Call reminder, 2 hours before',
    blurb: 'A same-day nudge, which is what cuts no-shows the most.',
    trigger: 'before', offset_min: 120,
    subject: 'We are chatting with you today at {{time}}',
    body_html: [
      'Hi {{first_name|there}},',
      'Just a reminder that we are chatting with you today at {{time}} ({{timezone}}).',
      'Where: {{location|We will send the details shortly.}}\nWith: {{host|our team}}',
      'Running late or need another time? Use the button below and we will make it work.',
      'Talk soon,\n{{business_name}}',
    ].join('\n\n'),
    sms_body: 'Hi {{first_name|there}}, {{business_name}} here. We are chatting with you today at {{time}}. Talk soon! Reply STOP to opt out.',
  },
  {
    key: 'call-15-min',
    name: 'Starting soon, 15 minutes before',
    blurb: 'A last nudge right before the call, so they are ready when we reach out.',
    trigger: 'before', offset_min: 15,
    subject: 'We will be with you in 15 minutes',
    body_html: [
      'Hi {{first_name|there}},',
      'We will be chatting with you in about 15 minutes, at {{time}}.',
      'Where: {{location|We will reach out to you.}}',
      'Talk in a few,\n{{host|The team at}} {{business_name}}',
    ].join('\n\n'),
    sms_body: 'Hi {{first_name|there}}, we will be chatting with you in about 15 minutes ({{time}}). Talk soon! - {{business_name}}. Reply STOP to opt out.',
  },
].map((t) => Object.freeze({
  // Shared by every template: both channels, about the appointment, calls only, and a reminder
  // that would arrive late (booked too close to the call) is skipped rather than sent at once.
  channel: 'both', kind: 'transactional', calls_only: 1, skip_if_late: t.trigger === 'before' ? 1 : 0,
  ...t,
}));

const byKey = (key) => TEMPLATES.find((t) => t.key === key) || null;

module.exports = { TEMPLATES, byKey };
