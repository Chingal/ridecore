.PHONY: up down deploy deploy-stateful deploy-api build package seed dev e2e e2e-local test lint

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
up:
	docker compose up -d --wait floci
	$(MAKE) deploy
	$(MAKE) seed

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
	{ printf '%s\n' "$$cdk_env" | sed 's/^export //'; printf "RIDECORE_API_URL='%s'\n" "$$url"; } > .env.deploy; \
	curl -s -o /dev/null --max-time 30 "$$url/me/trips" || true; \
	echo "API (Floci Lambda): $$url"; \
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
	docker compose down

test:
	npm run typecheck && npm run test:unit

lint:
	npm run lint
