# @bmu/api

NestJS API for BMU Hub. Runs on http://localhost:4000.

- `GET /health` reports API and database status
- `GET /catalogue/services` lists services from the active price book
- `POST /leads/enquiry` creates a Lead from the website enquiry form

Database: Prisma 7 with PostgreSQL. Schema in `prisma/schema.prisma`, seed in `prisma/seed.ts`.
See the root README for setup.
