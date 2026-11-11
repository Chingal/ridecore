/**
 * Names shared by the CDK stack, the functions, the scripts and the docs (ADR 0004). Plain data, no
 * imports, so CDK can load it with Node native type stripping.
 */
export const EVENT_BUS_NAME = 'ridecore';
export const EVENT_SOURCE = 'ridecore.trips';
export const OFFERS_TOPIC_NAME = 'ridecore-driver-offers';
export const NOTIFICATIONS_QUEUE_NAME = 'ridecore-notifications';
