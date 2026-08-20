# How to change the Convoy demo

A short guide for anyone who needs to edit the **Convoy App** (TomTom × Vantor demo)
and push the change to the live site. No deep knowledge of the codebase required.

**Two important facts up front:**

1. **Local and live are two separate copies.** Editing on your laptop (`localhost`)
   does **not** change the public site. You must **redeploy** to update the live URL.
2. **Live URL:** <https://convoy-demo-tomtom-vantor.azurewebsites.net> — open to anyone,
   no login.

---

## 0. What you need first

- **Git** and **Node.js 20+** installed.
- Access to the **GitHub repo** (`AnastasiiaGnypa-TomTom/convoy-app-demo`).
- The two **API keys** (ask Anastasiia): `TOMTOM_API_KEY`, `VANTOR_API_KEY`.
- To deploy: **Azure access** to the `product-maps-dev` subscription (Contributor —
  activate it in the Azure portal via PIM), and the Azure CLI (`az`) installed.

---

## 1. Get the code

```bash
git clone <repo-url>        # AnastasiiaGnypa-TomTom/convoy-app-demo
cd convoy-app
npm install
```

## 2. Add the keys

```bash
cp .env.example .env
```
Open `.env` and paste the two keys:
```
TOMTOM_API_KEY=...
VANTOR_API_KEY=...
```
⚠️ **Never commit `.env`** — it's git-ignored on purpose. Keys must never go into GitHub.

## 3. Run it locally

**Simple way** (build once, then serve):
```bash
npm run build      # builds the app into server/public
npm start          # http://localhost:8080
```

**Live-editing way** (auto-refresh while you edit the frontend):
```bash
npm start                     # terminal 1 — API on :8080
npm --prefix client run dev   # terminal 2 — app on :5173 (edits refresh instantly)
```
Use **:5173** while editing; it proxies data calls to :8080.

## 4. Make your change

Rough map of where things live:

| You want to change… | Look in… |
| --- | --- |
| The map, layers, route line, 3D, terrain | `client/src/components/MapView.jsx`, `client/src/lib/` |
| The left panel / controls / lists | `client/src/components/` (`Sidebar.jsx`, `RoutePanel.jsx`, …) |
| Colours, fonts, spacing | `client/src/styles.css` |
| Routing / POIs / imagery logic (server) | `server/routes/`, `server/lib/` |
| Vehicle profiles & constraints | `server/lib/profiles.js` |

You can edit by hand, or with **Claude Code** (`claude` in the repo folder).

## 5. Test locally

Reload the browser and confirm your change looks right at `localhost`. Optional checks:
```bash
npm run verify:pois   # confirms POI categories are valid
npm run test:pois     # POI layer tests
```

## 6. Save your work (git)

```bash
git add -A
git commit -m "describe what you changed"
git push
```
💡 For anything non-trivial, work on a **branch** (`git checkout -b my-change`) so `main`
stays safe and your change is easy to review/revert.

## 7. Deploy to the live site

Pick **one**:

**A. Auto-deploy (easiest):** just `git push` to `main` — GitHub Actions builds and
deploys automatically (needs the `AZURE_WEBAPP_PUBLISH_PROFILE` secret to be set, which
it already is). Watch it under the repo's **Actions** tab.

**B. Manual deploy from your laptop:**
```bash
az login                 # sign in to Azure (activate Contributor in the portal first)
./deploy.sh              # builds + deploys to Azure App Service
```

Either way, after it finishes, check the live URL:
<https://convoy-demo-tomtom-vantor.azurewebsites.net>

*(Azure details, if asked: subscription `product-maps-dev`, resource group
`rg-convoy-demo`, app `convoy-demo-tomtom-vantor`, region West Europe. The keys live in
Azure → App Service → Configuration → Application settings — not in the repo.)*

---

## Reverting a change

Every commit is a save point. To undo the last deployed change:
```bash
git revert <commit>      # or reset to a known-good commit
git push                 # (auto-deploys) — or run ./deploy.sh
```

## Golden rules

- **Local ≠ live** — always redeploy to update the public site.
- **Never commit `.env` or API keys.**
- **Branch + commit** so changes are reviewable and reversible.
- **One person edits a file at a time** — avoid two people (or two Claude Code agents)
  editing the same file at once, or you'll get conflicts.
- **Don't overclaim** in the demo — if data isn't real (e.g. Vantor elevation is an
  open-source placeholder), keep it labelled honestly.

## Who to ask

- **Owner:** Anastasiia Gnypa.
- Keys / Azure access / TomTom routing questions → ask Anastasiia.
