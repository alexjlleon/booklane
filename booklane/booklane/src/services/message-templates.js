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
      'Talk in a few,\n{{host|Our team}}\n{{business_name}}',
    ].join('\n\n'),
    sms_body: 'Hi {{first_name|there}}, we will be chatting with you in about 15 minutes ({{time}}). Talk soon! - {{business_name}}. Reply STOP to opt out.',
  },

  // ---------------- They did not show up: get them back on the calendar, or offer a proposal by text.
  {
    key: 'noshow-same-day', group: 'no_show',
    name: 'Sorry we missed you (no-show)',
    blurb: 'Shortly after the call is marked a no-show: no guilt, a link to pick a new time, or a proposal by text instead.',
    trigger: 'no_show', offset_min: 15,
    subject: 'Sorry we missed you, {{first_name|there}}',
    body_html: [
      'Hi {{first_name|there}},',
      'We were looking forward to chatting with you at {{time}} today, but it looks like we missed each other. No worries at all, life happens!',
      'You can grab a new time that works better with the button below, or here: {{rebook_url}}',
      'Prefer not to hop on a call? Just reply to this email (or reply PROPOSAL to our text) and we will send you a proposal so you can look it over on your own time.',
      'Talk soon,\n{{business_name}}',
    ].join('\n\n'),
    sms_body: 'Hi {{first_name|there}}, sorry we missed you today! Pick a new time here: {{rebook_url}} Or reply PROPOSAL and we will text you a proposal instead. - {{business_name}}. Reply STOP to opt out.',
  },
  {
    key: 'noshow-1-day', group: 'no_show',
    name: 'Still want to chat? (no-show, next day)',
    blurb: 'A friendly second try the next day, with both options again.',
    trigger: 'no_show', offset_min: 1440,
    subject: 'Still want to chat, {{first_name|there}}?',
    body_html: [
      'Hi {{first_name|there}},',
      'Just following up since we did not get to connect yesterday. We would still love to help.',
      'Pick any open time here: {{rebook_url}}',
      'Or, if a call is hard to fit in right now, reply PROPOSAL to our text (or just reply to this email) and we will send everything over in writing.',
      'Thanks,\n{{business_name}}',
    ].join('\n\n'),
    sms_body: 'Hi {{first_name|there}}, {{business_name}} here. Still want to chat? Grab a time: {{rebook_url}} or reply PROPOSAL and we will text you one. Reply STOP to opt out.',
  },
  {
    key: 'noshow-4-days', group: 'no_show',
    name: 'Last check-in (no-show, 4 days)',
    blurb: 'A last, low-pressure check-in so they know the door is open.',
    trigger: 'no_show', offset_min: 4 * 1440,
    subject: 'Should we keep your spot open?',
    body_html: [
      'Hi {{first_name|there}},',
      'We have not been able to connect yet, so this is a quick last check-in. If you are still looking, we would be happy to help.',
      'Book a time here: {{rebook_url}}',
      'Or reply PROPOSAL to our text and we will send a proposal your way. If your plans have changed, no reply needed. We wish you the best!',
      '{{business_name}}',
    ].join('\n\n'),
    sms_body: 'Hi {{first_name|there}}, last check-in from {{business_name}}. Still looking? Book here: {{rebook_url}} or reply PROPOSAL for a proposal by text. Reply STOP to opt out.',
  },

  // ---------------- They showed up but have not booked yet: keep the conversation going.
  {
    key: 'notbooked-same-day', group: 'not_booked',
    name: 'Great chatting today (showed up, not booked)',
    blurb: 'An hour after the call: thanks, a recap link if they have a quote, and an easy way to ask questions.',
    trigger: 'not_booked', offset_min: 60,
    subject: 'Great chatting with you today, {{first_name|there}}!',
    body_html: [
      'Hi {{first_name|there}},',
      'Thank you for taking the time to chat with us today. It was great learning about your plans.',
      'Want to look it all over again? {{quote_url|Just reply to this email and we will send your proposal over.}}',
      'If any questions come up as you think it over, reply to this email or text us back. We are happy to help.',
      'Talk soon,\n{{host|Our team}}\n{{business_name}}',
    ].join('\n\n'),
    sms_body: 'Hi {{first_name|there}}, thanks for chatting with {{business_name}} today! Any questions as you think it over, just text us back. Want the proposal by text? Reply PROPOSAL. Reply STOP to opt out.',
  },
  {
    key: 'notbooked-2-days', group: 'not_booked',
    name: 'Any questions? (showed up, not booked, 2 days)',
    blurb: 'Two days later: checks for open questions while the call is still fresh.',
    trigger: 'not_booked', offset_min: 2 * 1440,
    subject: 'Any questions we can answer?',
    body_html: [
      'Hi {{first_name|there}},',
      'Just checking in after our call. Did any questions come up that we can help with?',
      'Happy to hop on another quick call too: {{rebook_url}}',
      'Thanks,\n{{business_name}}',
    ].join('\n\n'),
    sms_body: 'Hi {{first_name|there}}, {{business_name}} checking in. Any questions since our call? Just text back, or reply PROPOSAL and we will text you a proposal. Reply STOP to opt out.',
  },
  {
    key: 'notbooked-5-days', group: 'not_booked',
    name: 'Ready to lock it in? (showed up, not booked, 5 days)',
    blurb: 'A gentle nudge that open dates do not stay open forever.',
    trigger: 'not_booked', offset_min: 5 * 1440,
    subject: 'Ready to lock in your date?',
    body_html: [
      'Hi {{first_name|there}},',
      'We would love to be part of your plans. Our calendar fills up, so if you are ready, we can lock in your date today.',
      'Just reply to this email, text us back, or call us at {{business_phone|the number on our website}}.',
      'Thanks,\n{{business_name}}',
    ].join('\n\n'),
    sms_body: 'Hi {{first_name|there}}, ready to lock in your date with {{business_name}}? Our calendar fills up, so text us back and we will get you set. Reply STOP to opt out.',
  },
  {
    key: 'notbooked-10-days', group: 'not_booked',
    name: 'Still deciding? (showed up, not booked, 10 days)',
    blurb: 'A last friendly check-in that offers a proposal or another call.',
    trigger: 'not_booked', offset_min: 10 * 1440,
    subject: 'Still deciding, {{first_name|there}}?',
    body_html: [
      'Hi {{first_name|there}},',
      'We know there is a lot to decide. If it helps, we can send an updated proposal or set up another quick call to go over anything.',
      'Book a time: {{rebook_url}}',
      'Or simply reply to this email. Either way, we are here when you are ready.',
      '{{business_name}}',
    ].join('\n\n'),
    sms_body: 'Hi {{first_name|there}}, still deciding? {{business_name}} can text you an updated proposal (reply PROPOSAL) or set up a quick call: {{rebook_url}} Reply STOP to opt out.',
  },
].map((t) => Object.freeze({
  // Shared by every template: both channels, calls only. A "before" reminder that would arrive late
  // (booked too close to the call) is skipped rather than sent at once. Follow-ups after the call
  // stop once the customer books another call, and nudges to book are labelled promotional.
  channel: 'both', group: 'before', calls_only: 1,
  kind: t.trigger === 'not_booked' ? 'marketing' : 'transactional',
  skip_if_late: t.trigger === 'before' ? 1 : 0,
  skip_if_rebooked: t.trigger === 'no_show' || t.trigger === 'not_booked' ? 1 : 0,
  ...t,
}));

// How the library is grouped on the Automations screen, in order.
const GROUPS = [
  { id: 'before', name: 'Before the call', desc: 'Reminders so they show up.' },
  { id: 'no_show', name: 'If they did not show up', desc: 'Starts when the call is marked a no-show: asks them to pick a new time, or to reply PROPOSAL for a proposal by text.' },
  { id: 'not_booked', name: 'If they showed up but have not booked yet', desc: 'Starts when the call is marked "not booked yet". Stops on its own if the call is later marked booked, or they book another call.' },
];

const byKey = (key) => TEMPLATES.find((t) => t.key === key) || null;

module.exports = { TEMPLATES, GROUPS, byKey };
