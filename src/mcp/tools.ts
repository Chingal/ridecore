import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { LatLng, Trip, TripState } from '../domain/trip.ts';
import { type ApiClient, ApiError } from './api-client.ts';

/** What the API returns for `GET /me/trips`: the newest trips of the passenger. */
export const LIST_LIMIT = 20;

/** The trip as an agent sees it (ADR 0003): no other person's id, no internals. */
export type TripSummary = {
  tripId: string;
  state: TripState;
  origin: LatLng;
  destination: LatLng;
  fareEstimate: number;
  finalFare?: number;
  currency: 'COP';
  driverAssigned: boolean;
  cancelledBy?: 'passenger' | 'driver';
  createdAt: string;
  timestamps: Partial<Record<TripState, string>>;
};

export function summarize(trip: Trip): TripSummary {
  return {
    tripId: trip.id,
    state: trip.state,
    origin: trip.origin,
    destination: trip.destination,
    fareEstimate: trip.fareEstimate,
    ...(trip.finalFare === undefined ? {} : { finalFare: trip.finalFare }),
    currency: 'COP',
    driverAssigned: trip.driverId !== undefined,
    ...(trip.cancellation === undefined ? {} : { cancelledBy: trip.cancellation.by }),
    createdAt: trip.createdAt,
    timestamps: trip.timestamps,
  };
}

const STATES = ['REQUESTED', 'ACCEPTED', 'DRIVER_ARRIVED', 'IN_PROGRESS', 'COMPLETED', 'RATED', 'CANCELLED'] as const;
const latLng = z.object({
  lat: z.number().min(-90).max(90).describe('Latitude in degrees'),
  lng: z.number().min(-180).max(180).describe('Longitude in degrees'),
});
const tripId = z.string().min(1).max(128).describe('The trip id returned by request_trip or list_my_trips');
const summarySchema = z.object({
  tripId: z.string(),
  state: z.enum(STATES),
  origin: latLng,
  destination: latLng,
  fareEstimate: z.number(),
  finalFare: z.number().optional(),
  currency: z.literal('COP'),
  driverAssigned: z.boolean(),
  cancelledBy: z.enum(['passenger', 'driver']).optional(),
  createdAt: z.string(),
  timestamps: z.partialRecord(z.enum(STATES), z.string()),
});

const FARES = 'Fares are whole Colombian pesos (COP), estimated from the straight-line distance.';
const STATES_TEXT = 'States: REQUESTED -> ACCEPTED -> DRIVER_ARRIVED -> IN_PROGRESS -> COMPLETED -> RATED, or CANCELLED.';

type ToolResult = { content: { type: 'text'; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

const success = (body: Record<string, unknown>): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(body) }],
  structuredContent: body,
});

/** API errors keep their code and message; anything else is logged to stderr and stays opaque to the model. */
function failure(err: unknown): ToolResult {
  if (err instanceof ApiError) return { isError: true, content: [{ type: 'text', text: `${err.code}: ${err.message}` }] };
  console.error('ridecore-mcp: unexpected tool error', err);
  return { isError: true, content: [{ type: 'text', text: 'INTERNAL: unexpected error' }] };
}

const run = async (work: () => Promise<Record<string, unknown>>): Promise<ToolResult> => {
  try {
    return success(await work());
  } catch (err) {
    return failure(err);
  }
};

const VERSION = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;

/** The ridecore MCP server: four passenger tools over the HTTP API (ADR 0003). */
export function createMcpServer(api: ApiClient): McpServer {
  const server = new McpServer({ name: 'ridecore', version: VERSION });

  server.registerTool(
    'request_trip',
    {
      title: 'Request a trip',
      description: [
        'Request a STANDARD trip for the passenger from origin to destination. A driver nearby gets the offer; the trip starts in state REQUESTED.',
        'A passenger can have only one active trip: a second request while one is active fails with ACTIVE_TRIP_EXISTS.',
        FARES,
        'Example: {"origin":{"lat":2.4448,"lng":-76.6147},"destination":{"lat":2.4594,"lng":-76.5996}}',
      ].join('\n'),
      inputSchema: { origin: latLng.describe('Pickup point'), destination: latLng.describe('Drop-off point') },
      outputSchema: summarySchema.shape,
    },
    ({ origin, destination }) => run(async () => summarize(await api.requestTrip({ origin, destination }))),
  );

  server.registerTool(
    'get_trip_status',
    {
      title: 'Get trip status',
      description: [
        "Get the current state of one of the passenger's trips, whether a driver is assigned, the fare and the time of each state.",
        STATES_TEXT,
        'Example: {"trip_id":"7f9c2b1e-4d3a-4c55-9a51-0e8f2d6b9c10"}',
      ].join('\n'),
      inputSchema: { trip_id: tripId },
      outputSchema: summarySchema.shape,
    },
    ({ trip_id }) => run(async () => summarize(await api.getTrip(trip_id))),
  );

  server.registerTool(
    'cancel_trip',
    {
      title: 'Cancel a trip',
      description: [
        'Cancel one of the passenger\'s trips. Only possible while it is REQUESTED, ACCEPTED or DRIVER_ARRIVED; once IN_PROGRESS it cannot be cancelled (INVALID_TRANSITION).',
        'Example: {"trip_id":"7f9c2b1e-4d3a-4c55-9a51-0e8f2d6b9c10","reason":"changed plans"}',
      ].join('\n'),
      inputSchema: { trip_id: tripId, reason: z.string().trim().min(1).max(200).optional().describe('Optional reason, up to 200 characters') },
      outputSchema: summarySchema.shape,
    },
    ({ trip_id, reason }) => run(async () => summarize(await api.cancelTrip(trip_id, reason))),
  );

  server.registerTool(
    'list_my_trips',
    {
      title: 'List my trips',
      description: [`List the passenger's ${LIST_LIMIT} most recent trips, newest first.`, STATES_TEXT, FARES].join('\n'),
      outputSchema: { trips: z.array(summarySchema) },
    },
    () => run(async () => ({ trips: (await api.listMyTrips()).map(summarize) })),
  );

  return server;
}
