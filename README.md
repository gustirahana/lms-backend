# JakIja React LMS — Backend

NestJS API for the JakIja-inspired learning management system. This repository contains the backend only; the React frontend is maintained separately. It is a new implementation inspired by the feature areas in [JakIja](https://github.com/johansantri/jakija), not the upstream repository. This project is for learning and educational purposes.

## Repositories

- Main project index: [gustirahana/jakija-react](https://github.com/gustirahana/jakija-react)
- Frontend: [gustirahana/lms-react-frontend](https://github.com/gustirahana/lms-react-frontend)
- Backend: [gustirahana/lms-backend](https://github.com/gustirahana/lms-backend)
- Upstream project: [johansantri/jakija](https://github.com/johansantri/jakija)

Creator: JakIja — https://github.com/johansantri/jakija

## Requirements

- Node.js 20 or newer
- npm
- A Supabase project

## Getting started

1. Install dependencies and copy .env.example to .env.
2. Configure SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY, and the session encryption settings from .env.example. Keep secret values on the server; never commit .env.
3. Apply supabase/migrations/202610070001_lms_schema.sql to your Supabase project.
4. Start the development API:

~~~sh
npm install
npm run start:dev
~~~

The API listens on http://localhost:4000/api. Liveness is at /api/health and readiness is at /api/health/ready.

## Authentication and security

The API uses Supabase Auth for credential validation and a server-managed session cookie for browser requests. The browser receives a random opaque cookie marked HttpOnly and SameSite=Lax; production also uses Secure and the __Host- cookie prefix. Only a SHA-256 hash of the cookie is stored in the database. Supabase access and refresh tokens are encrypted at rest with AES-256-GCM.

Frontend requests must send credentials and an allowed Origin. VITE_APP_NAME, VITE_APP_VERSION, and VITE_APP_DEVICE are public metadata, not secrets or authentication factors. Authentication is provided by the server-issued session cookie; do not derive bearer credentials from Vite values.

The migration enables row-level security on application tables and does not grant public client write access. Never expose the Supabase secret key or session encryption keys to the frontend.

## Realtime

Socket.IO exposes separate /notifications and /classroom namespaces. Both require the authenticated cookie session and an allowed Origin. Notifications are scoped to the authenticated user's room. Classroom rooms are scoped to courses, and join/message actions check owner, instructor assignment, or enrollment permissions. Messages are persisted before being broadcast to that course room.

## Local checks

- npm run test:auth-session exercises session creation, cookie handling, token encryption, and revocation against a mocked Supabase contract.
- npm run test:realtime exercises HTTP auth and both Socket.IO namespaces with mocked auth.

These local checks do not replace a real Supabase integration check or deployment review.

## Production notes

Use HTTPS, exact frontend origins, production cookie settings, and a correctly configured trusted proxy count. The current rate limiter and Socket.IO adapter are process-local; run a single API replica until shared infrastructure is configured. Review signup policy, account recovery, audited administration, monitoring, and backup/restore before serving real learners.
