.PHONY: up down deploy deploy-stateful deploy-api build package seed dev e2e e2e-local test lint

# Floci (local AWS) endpoint and dummy credentials for CDK and osls.
FLOCI_ENV = AWS_ENDPOINT_URL=http://localhost:4567 AWS_ENDPOINT_URL_S3=http://localhost:4567 \
	AWS_S3_FORCE_PATH_STYLE=true AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test \
	AWS_REGION=us-east-1 AWS_DEFAULT_REGION=us-east-1

# Same layering as the npm scripts: .env.example, then .env, then .env.local (later wins).
LOAD_ENV = set -a && . ./.env.example && { [ ! -f .env ] || . ./.env; } && { [ ! -f .env.local ] || . ./.env.local; } && set +a

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

# One-way link: the table name comes from the CDK output; osls never feeds anything back to CDK.
# Writes .env.local with RIDECORE_TABLE and RIDECORE_API_URL (Floci's HTTP API path for the stack).
deploy-api: build
	@set -e; \
	table=$$(node -p "require('./cdk-outputs.json').RidecoreStateful.TableName"); \
	$(FLOCI_ENV) RIDECORE_TABLE="$$table" npx serverless deploy; \
	api_id=$$($(FLOCI_ENV) npx serverless info --verbose | sed -n 's/^ *HttpApiId: *//p'); \
	test -n "$$api_id" || { echo "HttpApiId not found in serverless info" >&2; exit 1; }; \
	url="http://localhost:4567/_aws/execute-api/$$api_id/\$$default"; \
	printf "RIDECORE_TABLE=%s\nRIDECORE_API_URL='%s'\n" "$$table" "$$url" > .env.local; \
	curl -s -o /dev/null --max-time 30 "$$url/me/trips" || true; \
	echo "API (Floci Lambda): $$url"; \
	echo "Wrote .env.local"

build:
	npm run build

# Packages the Lambda without any AWS access (dummy credentials, no login).
package: build
	AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_REGION=us-east-1 npx serverless package

seed:
	npm run seed

# Local adapter on port $(LOCAL_PORT) (same handler, same Floci table), in the foreground.
dev:
	PORT=$(LOCAL_PORT) npm run dev

# e2e against the Floci-deployed Lambda behind the HTTP API (URL from .env.local, written by `make up`).
e2e:
	@test -f .env.local || { echo "Run 'make up' first (.env.local is missing)" >&2; exit 1; }
	$(LOAD_ENV) && npx vitest run --project e2e $(E2E_ARGS)

# e2e against the local adapter: starts it in the background, runs the test, stops it.
e2e-local:
	@set -e; $(LOAD_ENV); \
	PORT=$(LOCAL_PORT) node src/local/server.ts & pid=$$!; \
	trap 'kill $$pid 2>/dev/null || true' EXIT; \
	for i in $$(seq 50); do curl -s -o /dev/null "http://localhost:$(LOCAL_PORT)/" && break; sleep 0.2; done; \
	RIDECORE_API_URL=http://localhost:$(LOCAL_PORT) npx vitest run --project e2e $(E2E_ARGS)

down:
	docker compose down

test:
	npm run typecheck && npm run test:unit

lint:
	npm run lint
