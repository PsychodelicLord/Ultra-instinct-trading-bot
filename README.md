# Ultra-instinct-trading-bot

Development setup for a local runnable bot service.

## Prerequisites

- Node.js 22+
- npm 10+

## Install

npm install

## Run (development)

npm run dev

The service starts on `http://localhost:3000` with endpoints:

- `GET /health`
- `GET /config`
- `PATCH /config`
- `GET /state`

## Build and run production bundle

npm run build
npm start
