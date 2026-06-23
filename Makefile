.PHONY: install setup first-run start start-dev discover stop stop-local kill-port reset open help

help:
	@echo "Jukebox — available commands:"
	@echo ""
	@echo "  make first-run    First-time setup: install deps, create .env, and start the server"
	@echo "  make install      Install npm dependencies"
	@echo "  make setup        Create .env from .env.example (first-time setup)"
	@echo "  make start        Start the server (production mode)"
	@echo "  make start-dev    Start the server with auto-reload (development mode)"
	@echo "  make stop         Stop the server"
	@echo "  make reset        Delete jukebox-state.json to wipe queue/history/play counts"
	@echo "  make open         Open the app in your default browser"
	@echo ""

first-run: install setup start

install:
	npm install

setup:
	@if [ -f .env ]; then \
		echo ".env already exists — skipping. Edit it manually if needed."; \
	else \
		cp .env.example .env; \
		echo ".env created. Edit it to set your TV IP (or use in-app auto-discovery)."; \
	fi

start:
	npm start

start-dev:
	npm run dev

discover:
	node discover.js

stop:
	@lsof -ti :3000 | xargs kill -9 2>/dev/null && echo "Jukebox stopped" || echo "Nothing running on port 3000"

stop-local: stop

kill-port: stop

reset:
	@if [ -f jukebox-state.json ]; then \
		rm jukebox-state.json; \
		echo "jukebox-state.json deleted — queue, history, and play counts have been reset."; \
	else \
		echo "jukebox-state.json not found — nothing to reset."; \
	fi

open:
	open http://localhost:3000
