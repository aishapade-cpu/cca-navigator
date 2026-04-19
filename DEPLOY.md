# Deploy CCA Navigator in 3 steps

## What you need
- A GitHub account (github.com)
- An Anthropic API key (console.anthropic.com → API Keys → Create key)
- A Railway account (railway.app — free to start, sign in with GitHub)

---

## Step 1 — Put the code on GitHub

1. Go to github.com → click the "+" in the top right → "New repository"
2. Name it `cca-navigator`, leave it private, click "Create repository"
3. On the next page, click "uploading an existing file"
4. Drag ALL the files from this folder into the uploader — make sure to maintain the folder structure:
   - `server.js` (top level)
   - `package.json` (top level)
   - `.gitignore` (top level)
   - `public/index.html`
   - `public/style.css`
   - `public/app.js`
5. Click "Commit changes"

---

## Step 2 — Deploy on Railway

1. Go to railway.app → "New Project" → "Deploy from GitHub repo"
2. Select `cca-navigator`
3. Click on the deployment → go to "Variables" tab
4. Add one variable:
   - Key: `ANTHROPIC_API_KEY`
   - Value: your API key (starts with `sk-ant-...`)
5. Click "Deploy" — Railway will run `npm start` automatically

Railway gives you a public URL like `https://cca-navigator-production.up.railway.app`

---

## Step 3 — Open it

Visit your Railway URL. That's your live app.

---

## Cost

- Railway: free tier covers ~$5/month of usage (plenty for early testing)
- Anthropic API: roughly $0.01–0.02 per search (very cheap)
- ClinicalTrials.gov: completely free, no account needed
