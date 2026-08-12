ALTER TABLE identity_security_events
DROP CONSTRAINT identity_security_events_event_type_check;

ALTER TABLE identity_security_events
ADD CONSTRAINT identity_security_events_event_type_check CHECK (event_type IN (
    'registration_created', 'registration_refused',
    'verification_resent', 'resend_refused',
    'email_verified', 'verification_refused',
    'verification_delivery_failed'
));
