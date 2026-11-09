.PHONY: up down deploy test lint

# Floci (local AWS) endpoint and dummy credentials for CDK.
FLOCI_ENV = AWS_ENDPOINT_URL=http://localhost:4567 AWS_ENDPOINT_URL_S3=http://localhost:4567 \
	AWS_S3_FORCE_PATH_STYLE=true AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test \
	AWS_REGION=us-east-1 AWS_DEFAULT_REGION=us-east-1

# Start Floci, wait until it is healthy, then bootstrap (idempotent) and deploy the stateful stack.
up:
	docker compose up -d --wait floci
	$(MAKE) deploy

deploy:
	$(FLOCI_ENV) npx cdk bootstrap aws://000000000000/us-east-1
	$(FLOCI_ENV) npx cdk deploy RidecoreStateful --require-approval never

down:
	docker compose down

test:
	npm run typecheck && npm run test:unit

lint:
	npm run lint
