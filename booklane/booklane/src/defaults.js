'use strict';
// Default settings for businesses and event types. Stored settings are deep-merged over these.

const BUSINESS_SETTINGS = {
  tagline: 'Book a quick call or build your own quote in minutes.',
  about: '',
  urgency_text: '',
  trust_points: ['Instant confirmation', 'No pressure', 'Your info is safe'],
  sms_consent_text: 'I agree to receive text messages about my inquiry. Msg & data rates may apply. Reply STOP to opt out.',
  privacy_note: 'We never share your details.',
  leads: {
    abandoned_after_min: 30,
    notify_team_on_partial: true,
    partial_requires_contact: true,
    send_recovery_email: false,
    recovery_delay_min: 60,
  },
  notifications: { team_emails: [], notify_on_booking: true, notify_on_contract: true, notify_on_callback: true, notify_on_quote: true },
  quote: {
    enabled: true,
    title: 'Build your quote',
    intro: 'Pick the services you want and see your price instantly. No hidden fees.',
    currency: 'USD',
    tax_rate: 0,
    deposit_type: 'percent',
    deposit_value: 30,
    bundle_discounts: [],
    expires_days: 14,
    contact_step_position: 'before_review',
    event_types: ['Wedding', 'Corporate event', 'Birthday / Celebration', 'Other'],
    guest_ranges: ['Under 50', '50-100', '100-150', '150-250', '250+'],
    cities: [],
    require_event_date: true,
    call_event_type_id: null,
    next_steps: { contract: true, book_call: true, callback: true },
    terms: 'This quote is an estimate based on the selections above. Final pricing is confirmed in your contract. A deposit secures your date.',
    contract_fields: { billing_address: true, event_start_time: true, event_end_time: true, venue_address: true, planner_name: false },
  },
  integrations: {
    boothbook: {
      enabled: false,
      url: '',
      key: '',
      secret: '',
      format: 'form',
      push_on: ['contract.requested'],
      field_map: {
        first_name: 'first_name', last_name: 'last_name', email: 'email', phone: 'telephone',
        event_date: 'event_date', event_type: 'event_type', venue: 'venue_name', notes: 'notes',
      },
      static_fields: {},
    },
    webhook: { enabled: false, url: '', secret: '', events: ['lead.partial', 'lead.completed', 'booking.created', 'booking.cancelled', 'quote.submitted', 'contract.requested', 'callback.requested'] },
  },
};

const DEFAULT_STEPS = () => [
  { key: 'schedule', type: 'schedule', title: 'Pick a time that works for you', subtitle: '' },
  {
    key: 'contact', type: 'contact', title: 'Who are we talking to?', subtitle: 'So we can confirm your call.',
    fields: { first_name: 'required', last_name: 'required', email: 'required', phone: 'required', sms_consent: 'optional' },
  },
  {
    key: 'interests', type: 'questions', title: 'What are you interested in?', subtitle: 'Pick all that apply.',
    questions: [{ id: 'services', label: 'Services', type: 'multi', options: ['Not sure yet'], required: false, display: 'cards' }],
  },
  {
    key: 'details', type: 'questions', title: 'Tell us about your event', subtitle: 'Anything helps. All optional.',
    questions: [
      { id: 'event_date', label: 'Event date', type: 'date', required: false },
      { id: 'venue', label: 'Venue or city', type: 'text', required: false, placeholder: 'e.g. The Grand Ballroom, Houston' },
      { id: 'notes', label: 'Anything else we should know?', type: 'textarea', required: false },
    ],
  },
];

const LOCATION_TYPES = {
  phone: 'Phone call (we call you)',
  google_meet: 'Google Meet',
  teams: 'Microsoft Teams',
  zoom: 'Zoom / video link',
  in_person: 'In person',
  custom: 'Custom',
};

module.exports = { BUSINESS_SETTINGS, DEFAULT_STEPS, LOCATION_TYPES };
