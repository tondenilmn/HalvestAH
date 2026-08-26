# Playwright's own image ships Chromium + every system lib it needs already
# installed, matched to the pinned `playwright` npm version below — avoids
# hunting down apt packages by hand under Railway's default Nixpacks builder.
# Keep this tag's version in sync with package.json's "playwright" dependency.
FROM mcr.microsoft.com/playwright:v1.47.2-jammy

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

CMD ["node", "notify.js"]
