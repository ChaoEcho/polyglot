FROM oven/bun:1.3.9-slim@sha256:8ca06c7812d9050ccc4b80799685f395d6a0d051d3b7207dfd120e2b437b1ec9
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
EXPOSE 3220
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD bun -e "if (!(await fetch('http://127.0.0.1:3220/ping')).ok) process.exit(1)"
USER bun
CMD ["bun", "index.ts"]
