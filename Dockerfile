FROM node:22-alpine AS base

FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM base AS package
WORKDIR /app
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
RUN find . -type f \( -name "*.map" -o -name "*.d.ts" -o -name "README*" -o -name "CHANGELOG*" -o -name ".npmignore" -o -name "package-lock.json" -o -name "tsconfig.json" \) -exec rm -f '{}' + \
  && find . -type d \( -name "__tests__" -o -name "test" -o -name "tests" -o -name "docs" -o -name "example" -o -name "examples" -o -name ".github" \) -prune -exec rm -rf '{}' +

FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

COPY --from=package /app ./

EXPOSE 3000

CMD ["node", "server.js"]
