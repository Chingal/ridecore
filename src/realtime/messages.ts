import { z } from 'zod';
import type { TripEvent } from '../domain/events.ts';
import type { LatLng } from '../domain/trip.ts';

const lat = z.number().min(-90).max(90);
const lng = z.number().min(-180).max(180);

/** What a client may send over the socket (ADR 0005). Anything else is answered with an `error`. */
export const clientMessageSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('watch'), lat, lng }),
  z.object({ action: z.literal('position'), lat, lng }),
  z.object({ action: z.literal('ping') }),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;

/** The trip event as pushed to a socket: no correlation id, nothing beyond these fields. */
export type PushedTripEvent = Pick<TripEvent, 'eventId' | 'type' | 'tripId' | 'version' | 'occurredAt' | 'payload'>;

/** What the server pushes. Every message carries `type` and `schemaVersion: 1`. */
export type ServerMessage = { schemaVersion: 1 } & (
  | { type: 'trip'; event: PushedTripEvent }
  | { type: 'offer'; offer: { offerId: string; tripId: string; offeredAt: string } }
  | { type: 'car'; driverId: string; category: string; position: LatLng; at: string }
  | { type: 'car.left'; driverId: string }
  | { type: 'driver_position'; tripId: string; position: LatLng; at: string }
  | { type: 'pong' }
  | { type: 'error'; code: string; message: string }
);

/** The pushed form of a trip event (drops the correlation id and anything else). */
export function tripMessage(event: TripEvent): ServerMessage {
  const { eventId, type, tripId, version, occurredAt, payload } = event;
  return { type: 'trip', schemaVersion: 1, event: { eventId, type, tripId, version, occurredAt, payload } };
}
