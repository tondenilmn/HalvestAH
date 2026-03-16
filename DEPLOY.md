# Deploying the Game State Betting Tool to Cloudflare Pages

This is a **100% static site** — plain HTML, CSS, and JavaScript with no backend. All CSV processing happens in the browser. Cloudflare Pages hosts it for free.

---

## Running locally

### With Wrangler (recommended — enables the `/api/scrape` auto-fill feature)

```bash
npm install -g wrangler   # once
node build.js             # regenerate manifest.json
wrangler pages dev static --port 8788
```

Open **http://localhost:8788**

### Plain HTTP server (no Node/Wrangler required — scrape feature unavailable)

```bash
node build.js
npx serve static
```

Open the URL printed by `serve` (default **http://localhost:3000**).

> If you don't have `npx`, any static server works: `python -m http.server 3000 --directory static`

---

## Option A — Drag & Drop (fastest, no CLI needed)

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com) → **Pages** → **Create a project** → **Direct Upload**
2. Name your project (e.g. `ah-betting-tool`)
3. Drag the **`static/`** folder onto the upload area (or click to browse and select it)
4. Click **Deploy site**
5. Done — your site is live at `https://ah-betting-tool.pages.dev`

To redeploy after changes: go to your project → **Deployments** → **Upload assets** again.

---

## Option B — Git + Auto-Deploy (recommended for ongoing use)

Every push to your repo automatically redeploys the site.

### Step 1 — Push to GitHub/GitLab

Put the `static/` folder (or the whole `webapp/` folder) in a Git repository and push it.

```
webapp/
├── static/
│   ├── index.html
│   ├── app.js
│   └── style.css
└── DEPLOY.md
```

### Step 2 — Connect to Cloudflare Pages

1. [dash.cloudflare.com](https://dash.cloudflare.com) → **Pages** → **Create a project** → **Connect to Git**
2. Authorise Cloudflare to access your GitHub/GitLab account
3. Select the repository
4. Configure the build:

| Setting | Value |
|---------|-------|
| **Framework preset** | None |
| **Build command** | `node build.js` |
| **Build output directory** | `static` |
| **Root directory** | `webapp` *(if the repo root is the AH_Python_tool folder)* |

5. Click **Save and Deploy**

From now on: push to `main` → Cloudflare rebuilds in ~10 seconds.

---

## Option C — Wrangler CLI

Install once, then deploy from the terminal.

```bash
# Install Wrangler
npm install -g wrangler

# Log in to your Cloudflare account
wrangler login

# Deploy from inside the webapp folder
cd webapp
wrangler pages deploy static --project-name ah-betting-tool
```

On first run it creates the project. Subsequent runs update it.

---

## Custom Domain (optional)

1. In your Pages project → **Custom domains** → **Set up a custom domain**
2. Enter your domain (e.g. `tool.yourdomain.com`)
3. Cloudflare adds the DNS record automatically if your domain is already on Cloudflare

---

## Adding / updating the dataset

Just drop CSV files into `static/data/` — no need to edit anything else. The build script (`build.js`) scans the folder and generates `manifest.json` automatically before each deploy.

### Folder layout
```
webapp/
├── build.js                 ← auto-generates manifest.json
├── static/
│   ├── index.html
│   ├── app.js
│   ├── style.css
│   └── data/
│       ├── manifest.json    ← auto-generated, do not edit manually
│       ├── pinnacle_2023.csv
│       └── pinnacle_2024.csv
```

### Workflow
1. Copy your CSVs into `static/data/`
2. Push to Git (or redeploy) — done

Cloudflare runs `node build.js` automatically before publishing, which regenerates `manifest.json` from whatever CSVs are in the folder.

### Running the build locally (optional)
```bash
cd webapp
node build.js
```

> **Note:** files inside `static/data/` are publicly accessible — anyone with the URL can download them. Do not include sensitive data you want to keep private.

## Other notes

- **No server required.** The app runs entirely in the visitor's browser — CSV files are parsed client-side with PapaParse.
- **No environment variables or secrets** to configure.
- **Free tier limits** are generous (500 deployments/month, unlimited bandwidth) and more than sufficient for personal use.
