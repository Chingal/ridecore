.PHONY: up down test lint

up:
	docker compose up -d floci

down:
	docker compose down

test:
	npm run typecheck && npm run test:unit

lint:
	npm run lint
