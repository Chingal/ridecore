.PHONY: up down deploy deploy-stateful deploy-api build package seed dev e2e e2e-local test lint dlq-demo redrive demo-map mcp-token coverage demo load load-teardown

# Floci (local AWS) endpoint and dummy credentials, pinned on every CDK/osls call so a deploy from
# this Makefile can only ever reach Floci, whatever AWS settings the shell exports.
FLOCI_ENV = AWS_ENDPOINT_URL=http://localhost:4567 AWS_ENDPOINT_URL_S3=http://localhost:4567 \
	AWS_S3_FORCE_PATH_STYLE=true AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test \
	AWS_REGION=us-east-1 AWS_DEFAULT_REGION=us-east-1

# The single env policy (scripts/load-env.ts), shared with the npm scripts and the Vitest e2e setup:
# exported env > .env.local (yours) > .env.deploy (generated) > .env.example. Exported values are never overwritten.
LOAD_ENV = eval "$$(node scripts/load-env.ts --print)"

LOCAL_PORT ?= 3000

# Start Floci, deploy the stateful stack (CDK) and the API Lambda (osls), then seed demo data.
# Idempotent: every step can run again on a live Floci.
#
# LOCATION=1 also brings up ridecore-location (Go, in $(LOCATION_DIR)): it adds the location variables
# to .env.local if absent (so the Lambdas are deployed with the switch on), then starts Redis, Kafka and
# the service once the stack's trip-assignments queue exists. Without it, nothing changes.
LOCATION_DIR ?= ../ridecore-location
export LOCATION_DIR
LOCATION_SCRIPT = node --import ./scripts/load-env.ts scripts/location.ts

up:
	$(if $(filter 1,$(LOCATION)),@$(LOCATION_SCRIPT) env)
	docker compose up -d --wait floci
	$(MAKE) deploy
	$(MAKE) seed
	$(if $(filter 1,$(LOCATION)),@$(LOCATION_SCRIPT) start)

deploy: deploy-stateful deploy-api

deploy-stateful:
	$(FLOCI_ENV) npx cdk bootstrap aws://000000000000/us-east-1
	$(FLOCI_ENV) npx cdk deploy RidecoreStateful --require-approval never --outputs-file cdk-outputs.json

# One-way link: table, stream, bus, topic and queues come from the CDK outputs (scripts/cdk-env.ts);
# osls never feeds anything back to CDK. The JWT secret comes from the env policy (dev value in
# .env.example; no default in serverless.yml). Writes the generated .env.deploy with those values and
# RIDECORE_API_URL (Floci's HTTP API path for the stack); .env.local is the user's and never touched.
deploy-api: build
	@set -e; $(LOAD_ENV); \
	cdk_env=$$(node scripts/cdk-env.ts); eval "$$cdk_env"; \
	$(FLOCI_ENV) npx serverless deploy; \
	api_id=$$($(FLOCI_ENV) npx serverless info --verbose | sed -n 's/^ *HttpApiId: *//p'); \
	test -n "$$api_id" || { echo "HttpApiId not found in serverless info" >&2; exit 1; }; \
	url="http://localhost:4567/_aws/execute-api/$$api_id/\$$default"; \
	ws_url=$$($(FLOCI_ENV) npx serverless info --verbose | sed -n 's|^ *ServiceEndpointWebsocket: *wss://\([a-z0-9]*\)\.[^/]*/\(.*\)$$|ws://\1.execute-api.localhost.floci.io:4567/\2|p'); \
	test -n "$$ws_url" || { echo "ServiceEndpointWebsocket not found in serverless info" >&2; exit 1; }; \
	{ printf '%s\n' "$$cdk_env" | sed 's/^export //'; printf "RIDECORE_API_URL='%s'\nRIDECORE_WS_URL='%s'\n" "$$url" "$$ws_url"; } > .env.deploy; \
	curl -s -o /dev/null --max-time 30 "$$url/me/trips" || true; \
	echo "API (Floci Lambda): $$url"; \
	echo "WebSocket (Floci): $$ws_url"; \
	echo "Wrote .env.deploy"

build:
	npm run build

# Packages the Lambdas without any AWS access (dummy credentials, no login, placeholder ARNs).
# serverless.yml has no JWT secret or ARN defaults, so they come from the env policy and cdk-env here.
package: build
	$(LOAD_ENV) && eval "$$(node scripts/cdk-env.ts --dummy)" && AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_REGION=us-east-1 npx serverless package

seed:
	npm run seed

# Local adapter on port $(LOCAL_PORT) (same handler, same Floci table), in the foreground.
dev:
	PORT=$(LOCAL_PORT) npm run dev

# e2e against the Floci-deployed Lambda behind the HTTP API (URL from .env.deploy, written by `make up`).
e2e:
	@test -f .env.deploy || { echo "Run 'make up' first (.env.deploy is missing)" >&2; exit 1; }
	$(LOAD_ENV) && npx vitest run --project e2e $(E2E_ARGS)

# e2e against the local adapter: starts it in the background, runs the test, stops it. Fails if the
# port is already taken or the server exits during startup, so it never tests someone else's server.
e2e-local:
	@set -e; $(LOAD_ENV); \
	url=http://127.0.0.1:$(LOCAL_PORT); \
	if curl -s -o /dev/null "$$url/"; then echo "Port $(LOCAL_PORT) is already in use; stop that server first" >&2; exit 1; fi; \
	PORT=$(LOCAL_PORT) node --import ./scripts/load-env.ts src/local/server.ts & pid=$$!; \
	trap 'kill $$pid 2>/dev/null || true' EXIT; \
	ready=; for i in $$(seq 50); do \
	  kill -0 $$pid 2>/dev/null || { echo "Local server exited during startup" >&2; exit 1; }; \
	  if curl -s -o /dev/null "$$url/"; then ready=1; break; fi; sleep 0.2; \
	done; \
	test -n "$$ready" || { echo "Local server did not answer on $$url" >&2; exit 1; }; \
	RIDECORE_API_URL=$$url npx vitest run --project e2e $(E2E_ARGS)

down:
	-@$(LOCATION_SCRIPT) stop
	docker compose down

test:
	npm run typecheck && npm run test:unit

lint:
	npm run lint

# Watch an event fail 3 times and land in the billing DLQ (about 2-3 minutes; ADR 0004).
dlq-demo:
	@test -f .env.deploy || { echo "Run 'make up' first (.env.deploy is missing)" >&2; exit 1; }
	@$(LOAD_ENV) && node scripts/dlq-demo.ts

# Move a DLQ's messages back to its queue: make redrive QUEUE=billing (or dispatch, driver-offers, notifications).
redrive:
	@test -f .env.deploy || { echo "Run 'make up' first (.env.deploy is missing)" >&2; exit 1; }
	@$(LOAD_ENV) && node scripts/redrive.ts $(QUEUE)

# Live map demo (ADR 0005): prints what to paste into demo/map.html, then drives the seeded cars
# around small loops for SECONDS (default 120). Open the page in a browser while it runs.
SECONDS ?= 120
demo-map:
	@test -f .env.deploy || { echo "Run 'make up' first (.env.deploy is missing)" >&2; exit 1; }
	@$(LOAD_ENV) && \
	echo "Open:            file://$(CURDIR)/demo/map.html" && \
	echo "WebSocket URL:   $$RIDECORE_WS_URL" && \
	echo "Passenger token: $$(node scripts/dev-token.ts passenger passenger-1)" && \
	node scripts/move-drivers.ts --seconds $(SECONDS)

# A passenger token for the MCP server (README, "Use it from an AI agent"): export it as RIDECORE_MCP_TOKEN.
PASSENGER ?= passenger-1
mcp-token:
	@$(LOAD_ENV) && node scripts/dev-token.ts passenger $(PASSENGER)

# Unit-test coverage of src/ (text summary here, coverage/coverage-summary.json for CI).
coverage:
	npm run coverage

# One whole trip through the Floci-deployed API, step by step (README "See it work").
demo:
	@test -f .env.deploy || { echo "Run 'make up' first (.env.deploy is missing)" >&2; exit 1; }
	@$(LOAD_ENV) && node scripts/demo-trip.ts

# Local load test (docs/load-testing.md): PROFILE=smoke|peak|spike|crowded. Floci on a laptop:
# behaviour under concurrency, not AWS capacity. Teardown runs even when a step fails.
PROFILE ?= smoke
load:
	@test -f .env.deploy || { echo "Run 'make up' first (.env.deploy is missing)" >&2; exit 1; }
	@LOCATION=$(LOCATION) node --import ./scripts/load-env.ts scripts/load/run.ts $(PROFILE)

# Ends the load actors' trips and sets their drivers OFFLINE, e.g. after an interrupted run.
load-teardown:
	@node --import ./scripts/load-env.ts scripts/load/actors.ts teardown
