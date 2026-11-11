# An agent requesting a trip through MCP

A real run, not a mock-up: 2026-11-11, Claude Code 2.1.322 (`claude -p`, model `claude-opus-5-5`), with the ridecore MCP server
as its only MCP server, against the local Floci stack (`make up`). The token belonged to a test passenger, `mcp-demo-passenger`.
The tool calls and results below are copied from the run's `stream-json` output; only the JSON is reformatted.

The CLI ran with the author's Spanish language setting, so the agent answered in Spanish, and it wrote the cancellation reason in Spanish too.

## Setup

The same server as in the README. For this run it was passed with `--mcp-config` and `--strict-mcp-config`, with the four tools allowed; for everyday use:

```bash
claude mcp add ridecore --env RIDECORE_MCP_TOKEN="$(make -s mcp-token)" \
  -- node --import "$PWD/scripts/load-env.ts" "$PWD/src/mcp/main.ts"
```

## Prompt

> I'm at 2.4448, -76.6147 and need to go to 2.4594, -76.5996. Request a trip, tell me its status and the estimated fare, then cancel it because I changed my mind.

## Tool calls

### 1. `request_trip`

```json
{"origin": {"lat": 2.4448, "lng": -76.6147}, "destination": {"lat": 2.4594, "lng": -76.5996}}
```

Result:

```json
{
  "tripId": "33b0ad40-890c-4d17-a3a7-f7e50dff2233",
  "state": "REQUESTED",
  "origin": {
    "lat": 2.4448,
    "lng": -76.6147
  },
  "destination": {
    "lat": 2.4594,
    "lng": -76.5996
  },
  "fareEstimate": 8202,
  "currency": "COP",
  "driverAssigned": false,
  "createdAt": "2026-11-11T16:16:20.017Z",
  "timestamps": {
    "REQUESTED": "2026-11-11T16:16:20.017Z"
  }
}
```

### 2. `get_trip_status`

```json
{"trip_id": "33b0ad40-890c-4d17-a3a7-f7e50dff2233"}
```

Result:

```json
{
  "tripId": "33b0ad40-890c-4d17-a3a7-f7e50dff2233",
  "state": "REQUESTED",
  "origin": {
    "lat": 2.4448,
    "lng": -76.6147
  },
  "destination": {
    "lat": 2.4594,
    "lng": -76.5996
  },
  "fareEstimate": 8202,
  "currency": "COP",
  "driverAssigned": false,
  "createdAt": "2026-11-11T16:16:20.017Z",
  "timestamps": {
    "REQUESTED": "2026-11-11T16:16:20.017Z"
  }
}
```

### 3. `cancel_trip`

```json
{"trip_id": "33b0ad40-890c-4d17-a3a7-f7e50dff2233", "reason": "El pasajero cambió de opinión"}
```

Result:

```json
{
  "tripId": "33b0ad40-890c-4d17-a3a7-f7e50dff2233",
  "state": "CANCELLED",
  "origin": {
    "lat": 2.4448,
    "lng": -76.6147
  },
  "destination": {
    "lat": 2.4594,
    "lng": -76.5996
  },
  "fareEstimate": 8202,
  "currency": "COP",
  "driverAssigned": false,
  "cancelledBy": "passenger",
  "createdAt": "2026-11-11T16:16:20.017Z",
  "timestamps": {
    "REQUESTED": "2026-11-11T16:16:20.017Z",
    "CANCELLED": "2026-11-11T16:16:23.879Z"
  }
}
```

## The agent's answer (verbatim)

> Pedí el viaje, revisé su estado y lo cancelé.
>
> - **ID del viaje:** `33b0ad40-890c-4d17-a3a7-f7e50dff2233`
> - **Ruta:** desde (2.4448, -76.6147) hasta (2.4594, -76.5996)
> - **Estado antes de cancelar:** `REQUESTED`, es decir, solicitado y sin conductor asignado todavía.
> - **Tarifa estimada:** **$8.202 COP**. Se calcula con la distancia en línea recta, así que el precio por la ruta real podría ser algo distinto.
> - **Estado final:** `CANCELLED` a las 16:16:23 UTC. Puse como motivo "El pasajero cambió de opinión".
>
> Como no había conductor asignado cuando lo cancelé, ya puedes pedir otro viaje cuando quieras.
